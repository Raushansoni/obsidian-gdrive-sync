import type { PluginData, StatusLogEntry } from "../plugin-data";

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

  /** Live plugin data captured by hydrate(); note() writes into its statusLog. */
  private data: PluginData | null = null;
  /** In-memory mirror of statusLog so snapshotLog() works before/without data. */
  private log: StatusLogEntry[] = [];

  /** Restore lastSyncAt and the statusLog tail from persisted plugin data. */
  hydrate(data: PluginData): void {
    this.data = data;
    this.lastSyncAt = typeof data.lastSyncAt === "number" ? data.lastSyncAt : null;
    const persisted = Array.isArray(data.statusLog) ? data.statusLog : [];
    this.log = persisted.slice(-STATUS_LOG_MAX).map((e) => ({ t: e.t, msg: e.msg }));
    const tail = this.log.length > 0 ? this.log[this.log.length - 1].msg : "";
    if (tail) this.detail = tail;
    this.onChange?.();
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
      this.lastSyncAt = Date.now();
      if (this.data) this.data.lastSyncAt = this.lastSyncAt;
    }
    this.onChange?.();
  }

  /** Push a message into data.statusLog (max 40 entries). Caller saves data. */
  note(msg: string): void {
    const entry: StatusLogEntry = { t: Date.now(), msg };
    this.log.push(entry);
    if (this.log.length > STATUS_LOG_MAX) {
      this.log.splice(0, this.log.length - STATUS_LOG_MAX);
    }
    if (this.data) {
      if (!Array.isArray(this.data.statusLog)) this.data.statusLog = [];
      this.data.statusLog.push(entry);
      if (this.data.statusLog.length > STATUS_LOG_MAX) {
        this.data.statusLog.splice(0, this.data.statusLog.length - STATUS_LOG_MAX);
      }
    }
  }

  /** Copy of the current log tail for display in settings. */
  snapshotLog(): StatusLogEntry[] {
    return this.log.map((e) => ({ t: e.t, msg: e.msg }));
  }
}