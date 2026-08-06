import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import type { GDriveSyncSettings, SyncIndex } from "../settings";
import { DriveClient, type DriveFileMeta } from "../drive/drive-client";
import { parseIgnorePatterns, isIgnored } from "./ignore";
import { getEntry, setEntry, removeEntry, renameEntry } from "./index-store";
import { uniqueConflictPath } from "./conflict";
import { sha256Hex } from "../util/hash";
import { normalizeVaultPath, dirname } from "../util/paths";

export type SyncStatus = "idle" | "syncing" | "error" | "offline";

export interface SyncEngineCallbacks {
  onStatus: (status: SyncStatus, detail?: string) => void;
  saveSettings: () => Promise<void>;
}

export class SyncEngine {
  private app: App;
  private settings: GDriveSyncSettings;
  private drive: DriveClient | null = null;
  private callbacks: SyncEngineCallbacks;
  private running = false;
  private queued = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressWatch = false;
  private pendingLocal = new Set<string>();
  private pendingDeletes = new Set<string>();
  private pendingRenames: Array<{ oldPath: string; newPath: string }> = [];

  constructor(app: App, settings: GDriveSyncSettings, callbacks: SyncEngineCallbacks) {
    this.app = app;
    this.settings = settings;
    this.callbacks = callbacks;
  }

  setDrive(drive: DriveClient | null): void {
    this.drive = drive;
  }

  updateSettings(settings: GDriveSyncSettings): void {
    this.settings = settings;
  }

  scheduleSync(delayMs = 1500): void {
    if (!this.settings.autoSync) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.sync();
    }, delayMs);
  }

  onLocalCreateOrModify(file: TAbstractFile): void {
    if (this.suppressWatch) return;
    if (!(file instanceof TFile)) return;
    const path = normalizeVaultPath(file.path);
    if (this.shouldIgnore(path)) return;
    this.pendingLocal.add(path);
    this.scheduleSync();
  }

  onLocalDelete(file: TAbstractFile): void {
    if (this.suppressWatch) return;
    const path = normalizeVaultPath(file.path);
    if (this.shouldIgnore(path)) return;
    this.pendingLocal.delete(path);
    this.pendingDeletes.add(path);
    this.scheduleSync();
  }

  onLocalRename(file: TAbstractFile, oldPath: string): void {
    if (this.suppressWatch) return;
    const from = normalizeVaultPath(oldPath);
    const to = normalizeVaultPath(file.path);
    if (this.shouldIgnore(from) && this.shouldIgnore(to)) return;
    this.pendingRenames.push({ oldPath: from, newPath: to });
    this.pendingLocal.add(to);
    this.pendingDeletes.delete(to);
    this.scheduleSync();
  }

  async sync(): Promise<void> {
    if (this.running) {
      this.queued = true;
      return;
    }
    if (!this.drive) {
      this.callbacks.onStatus("error", "Not connected to Google");
      return;
    }
    if (!this.settings.clientId) {
      this.callbacks.onStatus("error", "Missing Client ID");
      return;
    }

    this.running = true;
    this.callbacks.onStatus("syncing", "Syncing…");

    try {
      const folderName =
        this.settings.remoteFolderName.trim() || this.app.vault.getName() || "Vault";

      let folderId = this.settings.remoteFolderId || this.settings.syncIndex.remoteFolderId;
      if (!folderId) {
        const { rootId, folderId: id } = await this.drive.ensureVaultFolder(folderName);
        folderId = id;
        this.settings.remoteFolderId = id;
        this.settings.remoteFolderName = folderName;
        this.settings.syncIndex.remoteFolderId = id;
        this.settings.syncIndex.remoteRootId = rootId;
        if (!this.settings.syncIndex.changeToken) {
          this.settings.syncIndex.changeToken = await this.drive.getStartPageToken();
        }
        await this.callbacks.saveSettings();
      }

      // Process renames first
      const renames = this.pendingRenames.splice(0);
      for (const { oldPath, newPath } of renames) {
        await this.handleRename(folderId, oldPath, newPath);
      }

      // Deletes
      const deletes = [...this.pendingDeletes];
      this.pendingDeletes.clear();
      for (const path of deletes) {
        await this.pushDelete(path);
      }

      // Full reconcile: remote listing vs local
      await this.reconcile(folderId);

      this.settings.lastSyncAt = Date.now();
      this.settings.lastError = null;
      await this.callbacks.saveSettings();
      this.callbacks.onStatus("idle", "Synced");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.settings.lastError = msg;
      await this.callbacks.saveSettings();
      this.callbacks.onStatus("error", msg);
    } finally {
      this.running = false;
      if (this.queued) {
        this.queued = false;
        this.scheduleSync(500);
      }
    }
  }

  private shouldIgnore(path: string): boolean {
    return isIgnored(path, parseIgnorePatterns(this.settings.ignorePatterns));
  }

  private async handleRename(folderId: string, oldPath: string, newPath: string): Promise<void> {
    if (!this.drive) return;
    const index = this.settings.syncIndex;
    const entry = getEntry(index, oldPath);
    if (entry?.driveFileId) {
      try {
        // Prefer trash+reupload for cross-folder renames (Drive rename is name-only)
        if (dirname(oldPath) === dirname(newPath)) {
          await this.drive.rename(entry.driveFileId, newPath.split("/").pop()!);
          renameEntry(index, oldPath, newPath);
        } else {
          await this.drive.trash(entry.driveFileId);
          removeEntry(index, oldPath);
          this.pendingLocal.add(newPath);
        }
      } catch {
        removeEntry(index, oldPath);
        this.pendingLocal.add(newPath);
      }
    } else {
      this.pendingLocal.add(newPath);
    }
    void folderId;
  }

  private async pushDelete(path: string): Promise<void> {
    if (!this.drive) return;
    const entry = getEntry(this.settings.syncIndex, path);
    if (entry?.driveFileId) {
      try {
        await this.drive.trash(entry.driveFileId);
      } catch {
        // already gone
      }
    }
    removeEntry(this.settings.syncIndex, path);
  }

  private async reconcile(folderId: string): Promise<void> {
    if (!this.drive) return;
    const index = this.settings.syncIndex;
    const remoteMap = await this.drive.listFolderRecursive(folderId);
    const localFiles = this.app.vault.getFiles();
    const localMap = new Map<string, TFile>();
    for (const f of localFiles) {
      const p = normalizeVaultPath(f.path);
      if (!this.shouldIgnore(p)) localMap.set(p, f);
    }

    // Flush explicitly pending local paths first
    const pending = [...this.pendingLocal];
    this.pendingLocal.clear();
    for (const path of pending) {
      const file = localMap.get(path);
      if (file) await this.pushFile(folderId, file, index, remoteMap);
    }

    const allPaths = new Set<string>([
      ...localMap.keys(),
      ...remoteMap.keys(),
      ...Object.keys(index.files),
    ]);

    for (const path of allPaths) {
      if (this.shouldIgnore(path)) continue;
      // Skip sync meta file if we ever store one
      if (path === ".gdrive-sync-meta.json") continue;

      const local = localMap.get(path);
      const remote = remoteMap.get(path);
      const entry = getEntry(index, path);

      if (local && !remote) {
        await this.pushFile(folderId, local, index, remoteMap);
        continue;
      }

      if (!local && remote) {
        if (entry && entry.driveFileId === remote.id) {
          // Deleted locally previously synced → already handled; if still remote, pull? 
          // If index knows it and local missing, user deleted — trash remote
          await this.drive.trash(remote.id);
          removeEntry(index, path);
        } else {
          // New on remote → pull
          await this.pullFile(path, remote, index);
        }
        continue;
      }

      if (!local && !remote) {
        if (entry) removeEntry(index, path);
        continue;
      }

      if (local && remote) {
        await this.mergeFile(folderId, local, remote, index);
      }
    }
  }

  private async readLocal(file: TFile): Promise<{ data: ArrayBuffer; hash: string; mtime: number; size: number }> {
    const data = await this.app.vault.readBinary(file);
    const hash = await sha256Hex(data);
    return {
      data,
      hash,
      mtime: file.stat.mtime,
      size: file.stat.size,
    };
  }

  private async pushFile(
    folderId: string,
    file: TFile,
    index: SyncIndex,
    remoteMap: Map<string, DriveFileMeta>
  ): Promise<void> {
    if (!this.drive) return;
    const path = normalizeVaultPath(file.path);
    const { data, hash, mtime, size } = await this.readLocal(file);
    const mime = this.drive.guessMime(path);
    const props = { vaultPath: path, sha256: hash };
    const entry = getEntry(index, path);
    const remote = remoteMap.get(path);

    if (entry?.driveFileId || remote?.id) {
      const id = entry?.driveFileId || remote!.id;
      if (entry?.hash === hash) {
        // already synced content
        if (!entry.driveFileId && remote) {
          setEntry(index, path, { driveFileId: remote.id, hash, mtime, size });
        }
        return;
      }
      const meta = await this.drive.updateFile(id, data, mime, props);
      setEntry(index, path, {
        driveFileId: meta.id,
        hash,
        mtime,
        size,
      });
      remoteMap.set(path, meta);
      return;
    }

    const parentId = await this.drive.ensureParentPath(folderId, path);
    const name = path.split("/").pop()!;
    const meta = await this.drive.uploadNew(parentId, name, data, mime, props);
    setEntry(index, path, {
      driveFileId: meta.id,
      hash,
      mtime,
      size,
    });
    remoteMap.set(path, meta);
  }

  private async pullFile(path: string, remote: DriveFileMeta, index: SyncIndex): Promise<void> {
    if (!this.drive) return;
    const data = await this.drive.download(remote.id);
    const hash = await sha256Hex(data);
    const mtime = remote.modifiedTime ? Date.parse(remote.modifiedTime) : Date.now();

    this.suppressWatch = true;
    try {
      await this.writeBinaryAtomic(path, data);
    } finally {
      this.suppressWatch = false;
    }

    setEntry(index, path, {
      driveFileId: remote.id,
      hash,
      mtime,
      size: data.byteLength,
    });
  }

  private async mergeFile(
    folderId: string,
    local: TFile,
    remote: DriveFileMeta,
    index: SyncIndex
  ): Promise<void> {
    if (!this.drive) return;
    const path = normalizeVaultPath(local.path);
    const localInfo = await this.readLocal(local);
    const entry = getEntry(index, path);
    const remoteMtime = remote.modifiedTime ? Date.parse(remote.modifiedTime) : 0;
    const remoteHashProp = remote.appProperties?.sha256;

    // Identical to last sync
    if (entry && entry.hash === localInfo.hash && entry.driveFileId === remote.id) {
      if (remoteHashProp && remoteHashProp === localInfo.hash) return;
      // Remote may have same content without prop — still skip if sizes match and mtimes close
      if (remote.md5Checksum && entry.hash === localInfo.hash) return;
    }

    // Fetch remote content hash if needed
    let remoteData: ArrayBuffer | null = null;
    let remoteHash = remoteHashProp ?? "";
    const needRemoteBytes =
      !remoteHash ||
      (entry && entry.hash !== localInfo.hash && (!remoteHash || remoteHash !== entry.hash));

    if (!remoteHash || needRemoteBytes) {
      remoteData = await this.drive.download(remote.id);
      remoteHash = await sha256Hex(remoteData);
    }

    if (localInfo.hash === remoteHash) {
      setEntry(index, path, {
        driveFileId: remote.id,
        hash: localInfo.hash,
        mtime: Math.max(localInfo.mtime, remoteMtime),
        size: localInfo.size,
      });
      return;
    }

    const localChanged = !entry || entry.hash !== localInfo.hash;
    const remoteChanged = !entry || entry.hash !== remoteHash;

    if (localChanged && remoteChanged) {
      // Conflict: keep local, save remote as sibling, then push local
      if (!remoteData) remoteData = await this.drive.download(remote.id);
      const conflict = uniqueConflictPath(path, (p) => !!this.app.vault.getAbstractFileByPath(p));
      this.suppressWatch = true;
      try {
        await this.writeBinaryAtomic(conflict, remoteData);
      } finally {
        this.suppressWatch = false;
      }
      const meta = await this.drive.updateFile(
        remote.id,
        localInfo.data,
        this.drive.guessMime(path),
        { vaultPath: path, sha256: localInfo.hash }
      );
      setEntry(index, path, {
        driveFileId: meta.id,
        hash: localInfo.hash,
        mtime: localInfo.mtime,
        size: localInfo.size,
      });
      // Also upload conflict file
      const conflictFile = this.app.vault.getAbstractFileByPath(conflict);
      if (conflictFile instanceof TFile) {
        await this.pushFile(folderId, conflictFile, index, new Map());
      }
      return;
    }

    if (remoteChanged && !localChanged) {
      if (!remoteData) remoteData = await this.drive.download(remote.id);
      this.suppressWatch = true;
      try {
        await this.writeBinaryAtomic(path, remoteData);
      } finally {
        this.suppressWatch = false;
      }
      setEntry(index, path, {
        driveFileId: remote.id,
        hash: remoteHash,
        mtime: remoteMtime || Date.now(),
        size: remoteData.byteLength,
      });
      return;
    }

    if (localChanged && !remoteChanged) {
      const meta = await this.drive.updateFile(
        remote.id,
        localInfo.data,
        this.drive.guessMime(path),
        { vaultPath: path, sha256: localInfo.hash }
      );
      setEntry(index, path, {
        driveFileId: meta.id,
        hash: localInfo.hash,
        mtime: localInfo.mtime,
        size: localInfo.size,
      });
      return;
    }

    // Fallback: last-write-wins by mtime
    if (localInfo.mtime >= remoteMtime) {
      const meta = await this.drive.updateFile(
        remote.id,
        localInfo.data,
        this.drive.guessMime(path),
        { vaultPath: path, sha256: localInfo.hash }
      );
      setEntry(index, path, {
        driveFileId: meta.id,
        hash: localInfo.hash,
        mtime: localInfo.mtime,
        size: localInfo.size,
      });
    } else {
      if (!remoteData) remoteData = await this.drive.download(remote.id);
      this.suppressWatch = true;
      try {
        await this.writeBinaryAtomic(path, remoteData);
      } finally {
        this.suppressWatch = false;
      }
      setEntry(index, path, {
        driveFileId: remote.id,
        hash: remoteHash || (await sha256Hex(remoteData)),
        mtime: remoteMtime,
        size: remoteData.byteLength,
      });
    }
  }

  private async writeBinaryAtomic(path: string, data: ArrayBuffer): Promise<void> {
    const normalized = normalizePath(path);
    const folder = dirname(normalized);
    if (folder) {
      await this.ensureLocalFolder(folder);
    }

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data);
      return;
    }

    // createBinary requires folder to exist
    await this.app.vault.createBinary(normalized, data);
  }

  private async ensureLocalFolder(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFolder) return;
    if (existing) return;

    const parts = normalized.split("/");
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      const abs = this.app.vault.getAbstractFileByPath(cur);
      if (!abs) {
        await this.app.vault.createFolder(cur);
      }
    }
  }
}
