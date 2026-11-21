/** In-memory Obsidian boundary for test-sync-recovery.mjs; no disk or network access. */
export const Platform = { isMobile: false, isDesktop: true };
export const normalizePath = (value) => String(value).replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/|\/$/g, "");

export class TAbstractFile {
  constructor(path) {
    this.path = normalizePath(path);
    this.name = this.path.split("/").at(-1);
  }
}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}

const copyBytes = (value) => typeof value === "string"
  ? new TextEncoder().encode(value)
  : new Uint8Array(value instanceof ArrayBuffer ? value.slice(0) : value);
const asBuffer = (value) => copyBytes(value).buffer;

export class MemoryVault {
  configDir = ".obsidian";
  files = new Map();
  folders = new Map();
  listeners = new Map();
  failures = new Map();
  writes = [];
  externalMutations = [];
  beforeNextRead = null;
  eisdirOnNonForceFolderDelete = false;
  onNonForceFolderDelete = null;
  clock = 1;

  constructor(initial = {}) {
    for (const [path, content] of Object.entries(initial)) this.store(path, content);
    this.adapter = {
      exists: async (path) => this.files.has(path) || this.folders.has(path),
      readBinary: async (path) => this.read(path),
      writeBinary: async (path, bytes) => { this.maybeFail("write", path); this.store(path, bytes); },
      remove: async (path) => {
        this.maybeFail("delete", path);
        this.auditMutation("delete", path);
        this.files.delete(path);
      },
      mkdir: async (path) => { this.addFolder(path); },
      rmdir: async (path, recursive = false) => {
        const norm = normalizePath(path);
        if (!recursive && this.eisdirOnNonForceFolderDelete) {
          const err = new Error(`Path is a directory: rm returned EISDIR (is a directory) ${norm}`);
          err.code = "ERR_FS_EISDIR";
          throw err;
        }
        const prefix = `${norm}/`;
        const hasChildren = [...this.files.keys()].some((k) => k.startsWith(prefix)) ||
          [...this.folders.keys()].some((k) => k.startsWith(prefix));
        if (hasChildren && !recursive) throw new Error(`Directory not empty: ${norm}`);
        if (recursive) {
          for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
          for (const k of [...this.folders.keys()]) if (k.startsWith(prefix)) this.folders.delete(k);
        }
        this.folders.delete(norm);
      },
      stat: async (path) => {
        const entry = this.files.get(path);
        if (entry) return { type: "file", ...entry.file.stat };
        return this.folders.has(path) ? { type: "folder", mtime: 0, ctime: 0, size: 0 } : null;
      },
      list: async (path) => {
        const norm = normalizePath(path);
        const parent = norm ? `${norm}/` : "";
        const immediate = (key) => parent
          ? key.startsWith(parent) && !key.slice(parent.length).includes("/")
          : !key.includes("/");
        return {
          files: [...this.files.keys()].filter(immediate).sort(),
          folders: [...this.folders.keys()].filter(immediate).sort(),
        };
      },
    };
  }

  failNext(action, path) { this.failures.set(`${action}:${path}`, 1); }
  maybeFail(action, path) {
    const key = `${action}:${path}`;
    if (!this.failures.get(key)) return;
    this.failures.delete(key);
    throw new Error(`Transient vault ${action} failure: ${path}`);
  }

  auditMutation(action, rawPath) {
    // A permissive virtual filesystem, not a security guard: record escapes instead of
    // silently blocking them for the engine. No path ever reaches the real filesystem.
    const path = String(rawPath).replace(/\\/g, "/");
    let depth = 0;
    let outside = path.startsWith("/") || /^[a-z]:/i.test(path);
    for (const part of path.split("/")) {
      if (part === "..") { if (--depth < 0) outside = true; }
      else if (part && part !== ".") depth++;
    }
    if (outside) this.externalMutations.push({ action, path });
  }

  addFolder(path) {
    this.auditMutation("mkdir", path);
    let current = "";
    for (const segment of normalizePath(path).split("/").filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.folders.has(current)) this.folders.set(current, new TFolder(current));
    }
  }

  store(rawPath, content) {
    this.auditMutation("write", rawPath);
    const path = normalizePath(rawPath);
    const slash = path.lastIndexOf("/");
    if (slash >= 0) this.addFolder(path.slice(0, slash));
    const file = this.files.get(path)?.file ?? new TFile(path);
    const bytes = copyBytes(content);
    file.stat = { ctime: file.stat?.ctime ?? this.clock, mtime: this.clock++, size: bytes.length };
    this.files.set(path, { file, bytes });
    this.writes.push({ path, text: new TextDecoder().decode(bytes) });
    return file;
  }

  read(path) {
    const entry = this.files.get(path);
    if (!entry) throw new Error(`No such in-memory file: ${path}`);
    return asBuffer(entry.bytes);
  }

  text(path) {
    const entry = this.files.get(path);
    return entry ? new TextDecoder().decode(entry.bytes) : null;
  }

  isConfig(path) { return path === this.configDir || path.startsWith(`${this.configDir}/`); }
  getName() { return "Sync recovery test"; }
  getFiles() { return [...this.files.values()].map(({ file }) => file).filter((file) => !this.isConfig(file.path)); }
  getAllFolders() { return [...this.folders.values()].filter((folder) => !this.isConfig(folder.path)); }
  getAllLoadedFiles() { return [...this.getAllFolders(), ...this.getFiles()]; }
  getAbstractFileByPath(path) {
    if (this.isConfig(path)) return null; // Obsidian does not index its config directory.
    return this.files.get(path)?.file ?? this.folders.get(path) ?? null;
  }
  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }
  emit(event, ...args) { for (const listener of this.listeners.get(event) ?? []) listener(...args); }
  edit(path, content) {
    const existed = this.files.has(path);
    const file = this.store(path, content);
    if (!this.isConfig(path)) this.emit(existed ? "modify" : "create", file);
    return file;
  }
  async readBinary(file) {
    const before = this.beforeNextRead;
    this.beforeNextRead = null;
    if (before) await before(file);
    return this.read(file.path);
  }
  async createBinary(path, bytes) {
    this.maybeFail("write", path);
    if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
    return this.edit(path, bytes);
  }
  async modifyBinary(file, bytes) { this.maybeFail("write", file.path); this.edit(file.path, bytes); }
  async createFolder(path) {
    const norm = normalizePath(path);
    const existed = this.folders.has(norm);
    this.addFolder(norm);
    const folder = this.folders.get(norm);
    if (!existed && folder && !this.isConfig(norm)) this.emit("create", folder);
    return folder;
  }
  async rename(file, newPath) {
    const oldPath = file.path;
    const normNew = normalizePath(newPath);
    if (file instanceof TFolder) {
      const oldPrefix = `${oldPath}/`;
      const movedFolders = [...this.folders.entries()].filter(([k]) => k === oldPath || k.startsWith(oldPrefix));
      const movedFiles = [...this.files.entries()].filter(([k]) => k.startsWith(oldPrefix));
      for (const [k] of movedFolders) this.folders.delete(k);
      for (const [k] of movedFiles) this.files.delete(k);
      const slash = normNew.lastIndexOf("/");
      if (slash >= 0) this.addFolder(normNew.slice(0, slash));
      for (const [k, folder] of movedFolders) {
        const target = normNew + k.slice(oldPath.length);
        folder.path = target;
        folder.name = target.split("/").at(-1);
        this.folders.set(target, folder);
      }
      for (const [k, entry] of movedFiles) {
        const target = normNew + k.slice(oldPath.length);
        entry.file.path = target;
        entry.file.name = target.split("/").at(-1);
        this.files.set(target, entry);
      }
      this.emit("rename", file, oldPath);
    } else {
      const entry = this.files.get(oldPath);
      if (!entry) return;
      this.files.delete(oldPath);
      const slash = normNew.lastIndexOf("/");
      if (slash >= 0) this.addFolder(normNew.slice(0, slash));
      file.path = normNew;
      file.name = normNew.split("/").at(-1);
      this.files.set(normNew, entry);
      this.emit("rename", file, oldPath);
    }
  }
  async delete(file, force = false) {
    this.maybeFail("delete", file.path);
    this.auditMutation("delete", file.path);
    if (file instanceof TFolder) {
      if (!force && this.eisdirOnNonForceFolderDelete) {
        if (this.onNonForceFolderDelete) await this.onNonForceFolderDelete(file);
        const err = new Error(`Path is a directory: rm returned EISDIR (is a directory) ${file.path}`);
        err.code = "ERR_FS_EISDIR";
        throw err;
      }
      // Deleting a folder in Obsidian removes its descendants, not just an index entry.
      for (const path of this.files.keys()) if (path.startsWith(`${file.path}/`)) this.files.delete(path);
      for (const path of this.folders.keys()) {
        if (path === file.path || path.startsWith(`${file.path}/`)) this.folders.delete(path);
      }
    } else this.files.delete(file.path);
    this.emit("delete", file);
  }
}

export class App {
  constructor(initial) {
    this.vault = new MemoryVault(initial);
    this.workspace = {
      leaves: [],
      iterateAllLeaves(callback) { for (const leaf of this.leaves) callback(leaf); },
    };
    const secrets = new Map();
    this.secretStorage = {
      getSecret: async (name) => secrets.get(name) ?? null,
      setSecret: async (name, value) => { secrets.set(name, value); },
    };
  }
}

let transport = null;
export function setRelayTransport(handler) { transport = handler; }
export async function requestUrl(request) {
  if (!transport) throw new Error("No test relay installed; real network is forbidden");
  return transport(request);
}
