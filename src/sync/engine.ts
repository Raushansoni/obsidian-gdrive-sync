import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import type { PathTip, PluginData } from "../plugin-data";
import type { SignedOp } from "../protocol";
import { MAX_BLOB_BYTES } from "../protocol";
import { seal, sealDeterministic, sealJson, open } from "../crypto/box";
import { b64ToBytes, bytesToB64, fromUtf8, utf8 } from "../crypto/bytes";
import { hkdf } from "../crypto/hkdf";
import {
  bumpVv,
  concurrent,
  dominates,
  packHlc,
  parseHlc,
  recvHlc,
  tickHlc,
} from "../crypto/hlc";
import { canonicalOpMessage } from "../crypto/op-canonical";
import { signBytes } from "../crypto/p256";
import { sha256Hex } from "../util/hash";
import { dirname, normalizeVaultPath } from "../util/paths";
import { isIgnored, parseIgnorePatterns } from "./ignore";
import { uniqueConflictPath } from "./conflict";
import { isConfigPathAllowed, listConfigRelPaths } from "./config-dir";
import type { IdentityStore } from "../identity";
import type { RelayHttp } from "../relay/client";
import type { StatusMachine } from "../status/machine";

const WATCH_DEBOUNCE_MS = 1200;
const PULL_PAGE_LIMIT = 200; // relay returns at most this many ops per pull
const QUEUED_RERUN_MS = 250;

interface OpCtx {
  vaultId: string;
  secret: Uint8Array;
  deviceId: string;
  ecdsaPriv: CryptoKey;
}

/**
 * FlockSyncEngine — end-to-end encrypted vault sync over the Flock relay.
 *
 * Model: every local/remote change is an immutable signed op in a per-vault
 * log. Op paths are AES-GCM sealed with the flock secret (aad = vaultId).
 * File contents are sealed with a per-blob key derived via HKDF from the
 * plaintext's sha256 (`blob:<hash>`), so identical content dedupes on the
 * relay and integrity is verifiable after decryption.
 *
 * Conflict policy (no last-write-wins): when the local tip's version vector
 * is concurrent with an incoming op and the contents actually differ, the
 * incoming bytes are written to a sibling `(conflict …)` file and the local
 * version is kept. If the incoming op dominates, or the local copy is
 * unmodified relative to our own tip, the remote version overwrites local.
 *
 * Note on `document.hidden`: sync() never early-returns for hidden windows —
 * mobile/background sync relies on the plugin calling sync() on
 * visibilitychange and from the interval timer, so an explicit call must
 * always go through.
 */
export class FlockSyncEngine {
  private app: App;
  private identity: IdentityStore;
  private relay: RelayHttp;
  private status: StatusMachine;
  private io: { getData(): PluginData; saveData(): Promise<void> };

  /** One in-flight sync; extra triggers queue exactly one rerun (old engine pattern). */
  private running = false;
  private queued = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Watch suppression is a COUNTER, not a boolean: remote writes can nest
   * (tombstone delete while a conflict copy is written), and a boolean would
   * un-suppress on the innermost finally while an outer write is still going.
   */
  private suppressWatchDepth = 0;

  private pendingLocal = new Set<string>();
  private pendingDeletes = new Set<string>();
  private pendingRenames: Array<{ oldPath: string; newPath: string }> = [];

  private ignoreRaw = "";
  private ignorePatterns: string[] = [];

  /** mtime/size of config files already hashed this session; avoids re-hashing plugins/** every sync. */
  private configStatCache = new Map<string, { mtime: number; size: number }>();

  constructor(
    app: App,
    identity: IdentityStore,
    relay: RelayHttp,
    status: StatusMachine,
    io: { getData(): PluginData; saveData(): Promise<void> }
  ) {
    this.app = app;
    this.identity = identity;
    this.relay = relay;
    this.status = status;
    this.io = io;
    this.refreshIgnore(this.io.getData());
  }

  /** Called whenever the plugin persists data — refresh cached settings. */
  updateFromData(data: PluginData): void {
    this.refreshIgnore(data);
  }

  // ------------------------------------------------------------------ watch

  onLocalCreateOrModify(file: TAbstractFile): void {
    if (this.suppressWatchDepth > 0) return;
    if (!(file instanceof TFile)) return;
    const path = normalizeVaultPath(file.path);
    if (this.isConfigPath(path)) return; // config files are scanned, not evented
    if (this.shouldIgnore(path)) return;
    this.pendingLocal.add(path);
    this.scheduleSync();
  }

  onLocalDelete(file: TAbstractFile): void {
    if (this.suppressWatchDepth > 0) return;
    const path = normalizeVaultPath(file.path);
    if (this.isConfigPath(path)) return;
    if (this.shouldIgnore(path)) return;
    if (file instanceof TFolder) {
      // Children no longer fire events; scanMissingFiles() derives tombstones
      // from pathTips at sync time.
      this.scheduleSync();
      return;
    }
    this.pendingLocal.delete(path);
    this.pendingDeletes.add(path);
    this.scheduleSync();
  }

  onLocalRename(file: TAbstractFile, oldPath: string): void {
    if (this.suppressWatchDepth > 0) return;
    const from = normalizeVaultPath(oldPath);
    const to = normalizeVaultPath(file.path);
    if (this.isConfigPath(from) || this.isConfigPath(to)) return;
    if (this.shouldIgnore(from) && this.shouldIgnore(to)) return;
    if (file instanceof TFolder) {
      // Folder rename cascades to contained files.
      for (const f of this.app.vault.getFiles()) {
        const p = normalizeVaultPath(f.path);
        if (!p.startsWith(to + "/")) continue;
        const oldChild = from + p.slice(to.length);
        if (this.shouldIgnore(oldChild) && this.shouldIgnore(p)) continue;
        this.pendingRenames.push({ oldPath: oldChild, newPath: p });
        this.pendingLocal.add(p);
        this.pendingDeletes.delete(p);
      }
      this.scheduleSync();
      return;
    }
    if (!(file instanceof TFile)) return;
    this.pendingRenames.push({ oldPath: from, newPath: to });
    this.pendingLocal.add(to);
    this.pendingDeletes.delete(to);
    this.scheduleSync();
  }

  private scheduleSync(delayMs = WATCH_DEBOUNCE_MS): void {
    if (!this.io.getData().autoSync) {
      if (this.status.state !== "paused") this.status.set("paused", "Auto-sync is off");
      return;
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.sync();
    }, delayMs);
  }

  // ------------------------------------------------------------------ link

  /** Enroll this vault with the relay under the paired flock. */
  async linkVault(): Promise<void> {
    const data = this.io.getData();
    const secret = this.identity.flockSecret;
    if (!this.identity.hasFlock() || !secret) {
      throw new Error("Pair a device first");
    }
    const alreadyEnrolled = data.enrolled && !!data.vaultId;
    if (!data.vaultId) data.vaultId = crypto.randomUUID();
    if (!alreadyEnrolled) {
      const sealedMetaB64 = await sealJson(secret, {
        name: this.app.vault.getName(),
        createdAt: Date.now(),
      });
      await this.relay.vaultEnroll({ vaultId: data.vaultId, sealedMetaB64 });
      data.enrolled = true;
      this.status.note(`Vault linked — ${this.app.vault.getName()}`);
      this.status.set("waiting", "Vault linked — syncing…");
      await this.io.saveData();
      this.scheduleSync(300);
    } else {
      await this.io.saveData();
    }
  }

  // ------------------------------------------------------------------ sync

  async sync(): Promise<void> {
    if (this.running) {
      this.queued = true;
      return;
    }
    const data = this.io.getData();
    this.refreshIgnore(data);
    if (!data.pathTips) data.pathTips = {};
    if (!data.statusLog) data.statusLog = [];

    if (!this.identity.hasFlock() || !this.identity.flockSecret) {
      this.status.set("waiting", "Pair a device first");
      return;
    }
    if (!data.enrolled || !data.vaultId) {
      this.status.set("waiting", "Link this vault in settings");
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.status.set("waiting", "Offline — will sync when back online");
      return;
    }
    const ctx = this.opCtx();
    if (!ctx) {
      this.status.set("error", "Missing device identity");
      return;
    }

    this.running = true;
    const queuedCount =
      this.pendingLocal.size + this.pendingDeletes.size + this.pendingRenames.length;
    this.status.set("syncing", "Syncing…", queuedCount);

    let appliedCount = 0;
    let pushedCount = 0;
    let conflictCount = 0;

    try {
      const { vaultId, secret, deviceId } = ctx;

      // ---------------- Pull remote ops (seq > localCursor), apply in order
      const pull = await this.relay.opsPull(vaultId, data.localCursor);
      for (const op of pull.ops) {
        if (typeof op.seq === "number" && op.seq > data.localCursor) {
          data.localCursor = op.seq;
        }

        // Keep our hybrid logical clock monotonic against remote ops.
        try {
          const local = data.lastHlc ? parseHlc(data.lastHlc) : null;
          data.lastHlc = packHlc(recvHlc(local, parseHlc(op.hlc), deviceId));
        } catch {
          /* malformed remote hlc — ignore */
        }

        let path: string;
        try {
          path = normalizeVaultPath(fromUtf8(await open(secret, op.pathCipherB64, vaultId)));
        } catch {
          this.status.note("Skipped one op with an undecryptable path");
          continue;
        }
        if (!path) continue;

        const opVv = op.versionVector ?? {};
        if (this.shouldIgnore(path)) continue;
        if (this.isConfigPath(path) && !isConfigPathAllowed(path, this.configDir)) continue;

        const tip: PathTip | null = data.pathTips[path] ?? null;

        if (op.blobHash === null) {
          // Tombstone — delete the local file if it exists.
          if (await this.localPathExists(path)) {
            await this.withWatchSuppressed(() => this.deleteLocalPath(path));
          }
          data.pathTips[path] = { hash: null, vv: mergeVv(tip?.vv, opVv) };
          this.pendingLocal.delete(path);
          this.pendingDeletes.delete(path);
          appliedCount++;
          continue;
        }

        let bytes: Uint8Array;
        try {
          const packed = await this.relay.getBlob(vaultId, op.blobHash);
          const blobKey = await hkdf(secret, `blob:${op.blobHash}`, 32);
          bytes = await open(blobKey, bytesToB64(new Uint8Array(packed)));
        } catch {
          this.status.note(`Could not fetch/decrypt blob for ${path}`);
          continue;
        }
        const contentHash = await sha256Hex(bytes);
        if (contentHash !== op.blobHash) {
          this.status.note(`Checksum mismatch for ${path} — op skipped`);
          continue;
        }

        const localHash = await this.hashLocalPath(path);
        if (localHash === contentHash) {
          // Already identical — record merged knowledge, no write needed.
          data.pathTips[path] = { hash: contentHash, vv: mergeVv(tip?.vv, opVv) };
          this.pendingLocal.delete(path);
          this.pendingDeletes.delete(path);
          appliedCount++;
          continue;
        }

        const incomingDominates = dominates(opVv, tip?.vv ?? {});
        const localUnchanged = !tip || tip.hash === localHash;

        if (incomingDominates || localUnchanged) {
          // Remote wins, or our copy never diverged from the tip — overwrite.
          await this.withWatchSuppressed(async () => {
            await this.writeLocalBytes(path, bytes);
          });
          this.configStatCache.delete(path);
          data.pathTips[path] = { hash: contentHash, vv: mergeVv(tip?.vv, opVv) };
          this.pendingLocal.delete(path);
          this.pendingDeletes.delete(path);
          appliedCount++;
          continue;
        }

        // Local tip outranks the incoming op — keep local; push phase syncs it.
        if (concurrent(tip?.vv ?? {}, opVv)) {
          // True divergence: keep local, save the remote bytes as a sibling
          // conflict copy. Never last-write-wins.
          const conflictTarget = uniqueConflictPath(path, (p) =>
            Boolean(this.app.vault.getAbstractFileByPath(p))
          );
          await this.withWatchSuppressed(async () => {
            await this.writeLocalBytes(conflictTarget, bytes);
          });
          this.configStatCache.delete(conflictTarget);
          if (!this.shouldIgnore(conflictTarget)) this.pendingLocal.add(conflictTarget);
          this.status.note(`Conflict: ${path} — kept local, saved remote as ${conflictTarget}`);
          conflictCount++;
          // Merge the incoming vv into our tip so our next push outranks it.
          data.pathTips[path] = {
            hash: tip ? tip.hash : localHash,
            vv: mergeVv(tip?.vv, opVv),
          };
          appliedCount++;
          continue;
        }
        // Local dominates the incoming op — it is an older version; skip.
      }
      // More pages remain on the relay (pull is limited) — rerun after this pass.
      if (pull.ops.length > 0 && pull.head > data.localCursor) this.queued = true;

      // ---------------- Fold renames into delete+create pairs
      const renames = this.pendingRenames.splice(0);
      for (const { oldPath, newPath } of renames) {
        if (!this.shouldIgnore(oldPath)) this.pendingDeletes.add(oldPath);
        if (!this.shouldIgnore(newPath)) this.pendingLocal.add(newPath);
      }

      // ---------------- Config-dir scan (no vault events fire for these)
      await this.scanConfigChanges(data);

      // ---------------- Universe scan: file keys = getFiles() + config paths
      this.scanAllLocalFiles(data); // full scan only while pathTips is empty
      this.scanMissingFiles(data); // cheap existence check → tombstones

      // ---------------- Push local changes
      const ops: SignedOp[] = [];

      const deletes = [...this.pendingDeletes];
      this.pendingDeletes.clear();
      for (const path of deletes) {
        if (this.shouldIgnore(path)) continue;
        const tip: PathTip | null = data.pathTips[path] ?? null;
        if (!tip || tip.hash === null) continue; // never synced / already tombstoned
        const op = await this.makeOp(ctx, path, null, tip);
        ops.push(op);
        data.pathTips[path] = { hash: null, vv: op.versionVector };
        pushedCount++;
      }

      const locals = [...this.pendingLocal];
      this.pendingLocal.clear();
      for (const path of locals) {
        if (this.shouldIgnore(path)) continue;
        const isConfig = this.isConfigPath(path);
        if (isConfig && !isConfigPathAllowed(path, this.configDir)) continue;
        const tip: PathTip | null = data.pathTips[path] ?? null;

        let bytes: Uint8Array | null;
        if (isConfig) {
          bytes = await this.readLocalBytes(path);
        } else {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) {
            // Vanished mid-queue — fall back to a delete if it was synced.
            if (tip && tip.hash !== null) this.pendingDeletes.add(path);
            continue;
          }
          await this.flushOpenEditors(path);
          bytes = new Uint8Array(await this.app.vault.readBinary(file));
        }
        if (!bytes) {
          if (tip && tip.hash !== null) this.pendingDeletes.add(path);
          continue;
        }

        const hash = await sha256Hex(bytes);
        if (tip && tip.hash === hash) continue; // unchanged vs tip
        if (bytes.byteLength > MAX_BLOB_BYTES) {
          this.status.note(
            `Skipped ${path} — over ${Math.round(MAX_BLOB_BYTES / (1024 * 1024))} MB limit`
          );
          continue;
        }

        const blobKey = await hkdf(secret, `blob:${hash}`, 32);
        const sealedB64 = await seal(blobKey, bytes);
        await this.relay.putBlob(vaultId, hash, toArrayBuffer(b64ToBytes(sealedB64)));

        const op = await this.makeOp(ctx, path, hash, tip);
        ops.push(op);
        data.pathTips[path] = { hash, vv: op.versionVector };
        pushedCount++;
      }

      // Anything re-queued while pushing (vanished files → deletes) reruns once.
      if (
        this.pendingLocal.size > 0 ||
        this.pendingDeletes.size > 0 ||
        this.pendingRenames.length > 0
      ) {
        this.queued = true;
      }

      if (ops.length > 0) {
        const res = await this.relay.opsPush(vaultId, { ops });
        if (typeof res.head === "number" && res.head > data.localCursor) {
          data.localCursor = res.head;
        }
      }

      try {
        const m = await this.relay.merkle(vaultId);
        const localRoot = await this.localMerkleRoot(secret, vaultId, data);
        if (m.root !== localRoot) {
          this.status.note(
            `Drift: merkle mismatch (relay head ${m.head}, cursor ${data.localCursor})`
          );
        }
      } catch {
        /* optional check */
      }

      // ---------------- Finish
      data.lastError = null;
      if (conflictCount > 0) {
        this.status.set(
          "conflict",
          `${conflictCount} conflict file${conflictCount === 1 ? "" : "s"}`,
          conflictCount
        );
      } else {
        this.status.set("synced", "Synced", 0);
      }
      if (pushedCount > 0 || appliedCount > 0) {
        this.status.note(
          `Sync ok — pushed ${pushedCount}, applied ${appliedCount}` +
            (conflictCount > 0 ? `, ${conflictCount} conflict(s)` : "")
        );
      }
      await this.io.saveData();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const data = this.io.getData();
      data.lastError = msg;
      this.status.note(`Error: ${msg}`);
      this.status.set("error", msg);
      try {
        await this.io.saveData();
      } catch {
        /* keep the failure visible via status */
      }
    } finally {
      this.running = false;
      if (this.queued) {
        this.queued = false;
        setTimeout(() => {
          void this.sync();
        }, QUEUED_RERUN_MS);
      }
    }
  }

  // ------------------------------------------------------------- internals

  private get configDir(): string {
    return normalizeVaultPath(this.app.vault.configDir || ".obsidian");
  }

  private isConfigPath(path: string): boolean {
    const cd = this.configDir;
    return cd.length > 0 && (path === cd || path.startsWith(cd + "/"));
  }

  private refreshIgnore(data: PluginData): void {
    if (data.ignorePatterns !== this.ignoreRaw) {
      this.ignoreRaw = data.ignorePatterns;
      this.ignorePatterns = parseIgnorePatterns(data.ignorePatterns);
    }
  }

  private shouldIgnore(path: string): boolean {
    return isIgnored(path, this.ignorePatterns);
  }

  private opCtx(): OpCtx | null {
    const data = this.io.getData();
    const secret = this.identity.flockSecret;
    const deviceId = this.identity.deviceId;
    const keys = this.identity.keys;
    if (!secret || !deviceId || !keys || !data.vaultId) return null;
    return { vaultId: data.vaultId, secret, deviceId, ecdsaPriv: keys.ecdsaPriv };
  }

  /**
   * Build and sign one op. `prevHash` chains to the content hash this op
   * replaces (the previous tip hash; null for new paths) — the only
   * "previous" pointer derivable from the frozen PluginData shape.
   */
  private async makeOp(
    ctx: OpCtx,
    path: string,
    blobHash: string | null,
    prevTip: PathTip | null
  ): Promise<SignedOp> {
    const data = this.io.getData();
    const prevHlc = data.lastHlc ? parseHlc(data.lastHlc) : null;
    const hlc = packHlc(tickHlc(prevHlc, ctx.deviceId));
    data.lastHlc = hlc;
    const unsigned = {
      deviceId: ctx.deviceId,
      pathCipherB64: await sealDeterministic(ctx.secret, utf8(path), ctx.vaultId),
      blobHash,
      prevHash: prevTip ? prevTip.hash : null,
      hlc,
      versionVector: bumpVv(prevTip ? prevTip.vv : {}, ctx.deviceId),
    };
    const sigB64 = await signBytes(ctx.ecdsaPriv, canonicalOpMessage(unsigned));
    return { ...unsigned, sigB64 };
  }

  private async localMerkleRoot(
    secret: Uint8Array,
    vaultId: string,
    data: PluginData
  ): Promise<string> {
    const tips: Record<string, string | null> = {};
    for (const [path, tip] of Object.entries(data.pathTips ?? {})) {
      const cipher = await sealDeterministic(secret, utf8(path), vaultId);
      tips[cipher] = tip.hash;
    }
    const canonical = JSON.stringify(
      Object.fromEntries(Object.keys(tips).sort().map((k) => [k, tips[k]]))
    );
    return sha256Hex(canonical);
  }

  private async withWatchSuppressed<T>(fn: () => Promise<T>): Promise<T> {
    this.suppressWatchDepth++;
    try {
      return await fn();
    } finally {
      this.suppressWatchDepth--;
    }
  }

  private async localPathExists(path: string): Promise<boolean> {
    if (this.isConfigPath(path)) {
      try {
        return await this.app.vault.adapter.exists(path);
      } catch {
        return false;
      }
    }
    return Boolean(this.app.vault.getAbstractFileByPath(path));
  }

  private async readLocalBytes(path: string): Promise<Uint8Array | null> {
    try {
      if (this.isConfigPath(path)) {
        return new Uint8Array(await this.app.vault.adapter.readBinary(path));
      }
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return null;
      return new Uint8Array(await this.app.vault.readBinary(file));
    } catch {
      return null;
    }
  }

  private async hashLocalPath(path: string): Promise<string | null> {
    if (!this.isConfigPath(path)) await this.flushOpenEditors(path);
    const bytes = await this.readLocalBytes(path);
    return bytes ? sha256Hex(bytes) : null;
  }

  private async writeLocalBytes(path: string, bytes: Uint8Array): Promise<void> {
    const ab = toArrayBuffer(bytes);
    if (this.isConfigPath(path)) {
      const dir = dirname(path);
      if (dir) await this.ensureAdapterFolder(dir);
      await this.app.vault.adapter.writeBinary(path, ab);
      return;
    }
    const folder = dirname(path);
    if (folder) await this.ensureLocalFolder(folder);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, ab);
    } else {
      await this.app.vault.createBinary(normalizePath(path), ab);
    }
    this.reloadOpenViews(path);
  }

  private async deleteLocalPath(path: string): Promise<void> {
    this.configStatCache.delete(path);
    try {
      if (this.isConfigPath(path)) {
        await this.app.vault.adapter.remove(path);
        return;
      }
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file) await this.app.vault.delete(file);
    } catch {
      /* already gone */
    }
  }

  private async ensureLocalFolder(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing) return;
    const parts = normalized.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        await this.app.vault.createFolder(cur);
      }
    }
  }

  private async ensureAdapterFolder(dir: string): Promise<void> {
    const parts = normalizeVaultPath(dir).split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      try {
        if (await this.app.vault.adapter.exists(cur)) continue;
      } catch {
        /* ignore */
      }
      try {
        await this.app.vault.adapter.mkdir(cur);
      } catch {
        /* already exists */
      }
    }
  }

  // ------------------------------------------------------------ scan passes

  /**
   * Config files never raise vault events, so every sync scans the config
   * dir. stat mtime/size caching keeps this cheap after the first pass.
   */
  private async scanConfigChanges(data: PluginData): Promise<void> {
    const cd = this.configDir;
    let paths: string[];
    try {
      paths = await listConfigRelPaths(this.app);
    } catch {
      return;
    }
    const listed = new Set(paths);
    for (const path of paths) {
      if (this.shouldIgnore(path)) continue;
      const tip: PathTip | null = data.pathTips[path] ?? null;
      let st: { mtime: number; size: number } | null = null;
      try {
        st = await this.app.vault.adapter.stat(path);
      } catch {
        st = null;
      }
      if (!st) {
        if (tip && tip.hash !== null) this.pendingDeletes.add(path);
        this.configStatCache.delete(path);
        continue;
      }
      const cached = this.configStatCache.get(path);
      if (cached && cached.mtime === st.mtime && cached.size === st.size) continue;
      const bytes = await this.readLocalBytes(path);
      if (!bytes) continue;
      const hash = await sha256Hex(bytes);
      this.configStatCache.set(path, { mtime: st.mtime, size: st.size });
      if (!tip || tip.hash !== hash) this.pendingLocal.add(path);
    }
    // Tips for config paths no longer on disk → deletions to push.
    for (const path of Object.keys(data.pathTips)) {
      if (!this.isConfigPath(path) || !isConfigPathAllowed(path, cd)) continue;
      if (listed.has(path)) continue;
      const tip = data.pathTips[path];
      if (tip && tip.hash !== null) this.pendingDeletes.add(path);
      this.configStatCache.delete(path);
    }
  }

  /** Initial upload: only when no tips exist yet (never full-rescan later). */
  private scanAllLocalFiles(data: PluginData): void {
    if (Object.keys(data.pathTips).length > 0) return;
    for (const f of this.app.vault.getFiles()) {
      const p = normalizeVaultPath(f.path);
      if (this.isConfigPath(p)) continue;
      if (this.shouldIgnore(p)) continue;
      this.pendingLocal.add(p);
    }
  }

  /** Cheap existence check per tip — catches deletes made while offline. */
  private scanMissingFiles(data: PluginData): void {
    for (const path of Object.keys(data.pathTips)) {
      if (this.isConfigPath(path)) continue; // config scan handles these
      if (this.shouldIgnore(path)) continue;
      if (this.pendingLocal.has(path) || this.pendingDeletes.has(path)) continue;
      const tip = data.pathTips[path];
      if (!tip || tip.hash === null) continue;
      if (!this.app.vault.getAbstractFileByPath(path)) this.pendingDeletes.add(path);
    }
  }

  // ------------------------------------------------- editor flush / reload

  /**
   * Ask open editors (esp. Canvas) to flush pending in-memory edits to disk
   * before we read/hash/upload the file. Pattern copied from the old
   * sync-engine.ts (no Drive client involved).
   */
  private async flushOpenEditors(path: string): Promise<void> {
    const target = normalizeVaultPath(path);
    let flushed = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as {
        file?: TFile;
        requestSave?: () => void;
        save?: () => void | Promise<void>;
      };
      const file = view.file;
      if (!file || normalizeVaultPath(file.path) !== target) return;
      try {
        if (typeof view.requestSave === "function") {
          view.requestSave();
          flushed = true;
        } else if (typeof view.save === "function") {
          void view.save();
          flushed = true;
        }
      } catch {
        /* ignore editor-specific save failures */
      }
    });
    if (flushed && target.toLowerCase().endsWith(".canvas")) {
      await sleep(150);
    }
  }

  /** Rebuild open canvas leaves for a path so pulled content shows up. */
  private reloadOpenViews(path: string): void {
    const target = normalizeVaultPath(path);
    if (!target.toLowerCase().endsWith(".canvas")) return;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as { file?: TFile; getViewType?: () => string };
      const file = view.file;
      if (!file || normalizeVaultPath(file.path) !== target) return;
      if ((view.getViewType?.() ?? "") !== "canvas") return;
      try {
        const rebuild = (leaf as { rebuildView?: () => void | Promise<void> }).rebuildView;
        if (typeof rebuild === "function") void rebuild.call(leaf);
      } catch {
        /* ignore */
      }
    });
  }
}

// ------------------------------------------------------------------ helpers

/** Element-wise max of two version vectors. */
function mergeVv(
  a?: Record<string, number>,
  b?: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) out[k] = Math.max(a?.[k] ?? 0, b?.[k] ?? 0);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}