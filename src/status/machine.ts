import type { PluginData, StatusLogEntry } from "../plugin-data";
import { isErrorLogMsg } from "./view";

export type SyncStatusName =
  | "synced"
  | "syncing"
  | "waiting"
  | "paused"
  | "retrying"
  | "error"
  | "conflict";

const STATUS_LOG_MAX = 40;

/**
 * Small observable status holder shared by the engine, the status bar and
 * settings. All mutations flow through set()/note() so the UI repaints and
 * the persisted log stays consistent.
 */
export class StatusMachine {
  state: SyncStatusName = "waiting";
  detail = "";
  /** Pending ops/conflicts while syncing — shown in the status bar. */
  queue = 0;
  lastSyncAt: number | null = null;
  onChange: (() => void) | null = null;

  /** Live plugin data. Must be a getter — savePluginData() replaces plugin.data. */
  private getData: (() => PluginData | null) | null = null;
  /** In-memory mirror of statusLog so snapshotLog() works before/without data. */
  private log: StatusLogEntry[] = [];

  /** Restore lastSyncAt and the statusLog tail from persisted plugin data. */
  hydrate(dataOrGet: PluginData | (() => PluginData)): void {
    this.getData = typeof dataOrGet === "function" ? dataOrGet : () => dataOrGet;
    const data = this.liveData();
    this.lastSyncAt = data && typeof data.lastSyncAt === "number" ? data.lastSyncAt : null;
    const persisted = data && Array.isArray(data.statusLog) ? data.statusLog : [];
    this.log = persisted.slice(-STATUS_LOG_MAX).map((e) => ({ t: e.t, msg: e.msg }));
    if (data?.lastError) {
      this.state = "error";
      this.detail = data.lastError;
    } else if (this.lastSyncAt) {
      this.state = "synced";
      this.detail = "Synced";
    } else {
      const tail = this.log.length > 0 ? this.log[this.log.length - 1].msg : "";
      if (tail) this.detail = tail;
    }
    this.onChange?.();
  }

  private liveData(): PluginData | null {
    try {
      return this.getData?.() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Transition state. Assigns lastSyncAt (both here and into the live data so
   * the next save persists it) when the state becomes "synced". Calls
   * onChange so the status bar repaints.
   */
  set(state: SyncStatusName, detail?: string, queue?: number): void {
    this.state = state;
    if (detail !== undefined) this.detail = detail;
    if (queue !== undefined) this.queue = queue;
    if (state === "synced") {
      this.dropRecoveredErrors();
      this.lastSyncAt = Date.now();
      const data = this.liveData();
      if (data) {
        data.lastSyncAt = this.lastSyncAt;
        data.lastError = null;
      }
    }
    this.onChange?.();
  }

  /** Push a message into data.statusLog (max 40 entries). Caller saves data. */
  note(msg: string): void {
    const last = this.log[this.log.length - 1];
    if (last && last.msg === msg) {
      last.t = Date.now();
      const data = this.liveData();
      const persisted = data?.statusLog;
      if (persisted && persisted.length > 0 && persisted[persisted.length - 1].msg === msg) {
        persisted[persisted.length - 1].t = last.t;
      }
      return;
    }
    const entry: StatusLogEntry = { t: Date.now(), msg };
    this.log.push(entry);
    if (this.log.length > STATUS_LOG_MAX) {
      this.log.splice(0, this.log.length - STATUS_LOG_MAX);
    }
    const data = this.liveData();
    if (data) {
      if (!Array.isArray(data.statusLog)) data.statusLog = [];
      data.statusLog.push(entry);
      if (data.statusLog.length > STATUS_LOG_MAX) {
        data.statusLog.splice(0, data.statusLog.length - STATUS_LOG_MAX);
      }
    }
  }

  /** Copy of the current log tail for display in settings. */
  snapshotLog(): StatusLogEntry[] {
    return this.log.map((e) => ({ t: e.t, msg: e.msg }));
  }

  /** Successful sync must not keep recovered Error: lines on screen. */
  private dropRecoveredErrors(): void {
    this.log = this.log.filter((e) => !isErrorLogMsg(e.msg));
    const data = this.liveData();
    if (!data) return;
    data.lastError = null;
    if (Array.isArray(data.statusLog)) {
      data.statusLog = data.statusLog.filter((e) => !isErrorLogMsg(e.msg));
    }
  }
}
