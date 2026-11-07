import { DEFAULT_RELAY_URL, isEphemeralRelayUrl } from "./flock-url";
import { isHash, isHlc, isSyncPath, isVersionVector } from "./sync/relay-state";

export interface StatusLogEntry {
  t: number;
  msg: string;
}

export interface PathTip {
  hash: string | null;
  vv: Record<string, number>;
  /** Incoming knowledge retained with local bytes; publish even if the hash is unchanged. */
  pending?: boolean;
}

export interface RelayState {
  cursor: number;
  /** Nonsecret relay/vault/device/flock/key-fingerprint scope for this projection. */
  context: string;
  /** A changed application filter needs reconciliation, not a different wire root. */
  policy: string;
  /** Complete wire projection, including excluded paths and null tombstones. */
  tips: Record<string, string | null>;
  /** Detect missing/corrupt application metadata even at an unchanged relay head. */
  pathTipsHash: string;
}

export interface PluginData {
  relayUrl: string;
  vaultId: string | null;
  enrolled: boolean;
  autoSync: boolean;
  syncIntervalSeconds: number;
  ignorePatterns: string;
  lastSyncAt: number | null;
  lastError: string | null;
  statusLog: StatusLogEntry[];
  localCursor: number;
  pathTips: Record<string, PathTip>;
  relayState: RelayState | null;
  lastHlc: string | null;
}

export const DEFAULT_IGNORE = [
  ".obsidian/workspace",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/workspaces.json",
  ".obsidian/cache",
  ".obsidian/plugins/obsidian-gdrive-sync/data.json",
  ".trash",
  ".git",
  ".DS_Store",
  "desktop.ini",
  "Thumbs.db",
].join("\n");

export const DEFAULT_DATA: PluginData = {
  relayUrl: DEFAULT_RELAY_URL,
  vaultId: null,
  enrolled: false,
  autoSync: true,
  syncIntervalSeconds: 20,
  ignorePatterns: DEFAULT_IGNORE,
  lastSyncAt: null,
  lastError: null,
  statusLog: [],
  localCursor: 0,
  pathTips: {},
  relayState: null,
  lastHlc: null,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksLikeLegacyDrive(raw: Record<string, unknown>): boolean {
  return (
    "tokens" in raw ||
    "syncIndex" in raw ||
    "clientId" in raw ||
    "clientSecret" in raw ||
    "remoteFolderId" in raw ||
    "pendingOAuthRedirectUri" in raw
  );
}

function canonicalRelayUrl(raw: string): string {
  const url = raw.trim();
  if (!url || isEphemeralRelayUrl(url)) return DEFAULT_DATA.relayUrl;
  return url;
}

function isCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readPathTips(raw: unknown): Record<string, PathTip> | null {
  if (!isRecord(raw)) return null;
  const entries: Array<[string, PathTip]> = [];
  for (const [path, tip] of Object.entries(raw)) {
    if (!isSyncPath(path) || !isRecord(tip) ||
      !(tip.hash === null || isHash(tip.hash)) || !isVersionVector(tip.vv) ||
      (tip.pending !== undefined && typeof tip.pending !== "boolean")) return null;
    entries.push([path, {
      hash: tip.hash,
      vv: { ...tip.vv },
      ...(tip.pending === true ? { pending: true } : {}),
    }]);
  }
  return Object.fromEntries(entries);
}

function readRelayState(raw: unknown, cursor: number): RelayState | null {
  if (!isRecord(raw) || raw.cursor !== cursor || !isCursor(raw.cursor) ||
    typeof raw.context !== "string" || !raw.context || typeof raw.policy !== "string" ||
    !isRecord(raw.tips) || !isHash(raw.pathTipsHash)) return null;
  const entries: Array<[string, string | null]> = [];
  for (const [cipher, hash] of Object.entries(raw.tips)) {
    if (!cipher || !(hash === null || isHash(hash))) return null;
    entries.push([cipher, hash]);
  }
  return { cursor, context: raw.context, policy: raw.policy, tips: Object.fromEntries(entries), pathTipsHash: raw.pathTipsHash };
}

/** Drop Drive-era fields so they never persist again after a Flock save. */
export function sanitizePluginData(raw: unknown): PluginData {
  const r = isRecord(raw) ? raw : {};
  const legacy = looksLikeLegacyDrive(r);
  const interval = Number(r.syncIntervalSeconds);
  const validCursor = isCursor(r.localCursor);
  const pathTips = readPathTips(r.pathTips);
  const localCursor = legacy || !validCursor ? 0 : r.localCursor as number;
  return {
    relayUrl: canonicalRelayUrl(typeof r.relayUrl === "string" ? r.relayUrl : ""),
    vaultId: legacy ? null : typeof r.vaultId === "string" ? r.vaultId : null,
    enrolled: legacy ? false : r.enrolled === true,
    autoSync: r.autoSync !== false,
    syncIntervalSeconds: Number.isFinite(interval) && interval >= 15 ? Math.floor(interval) : DEFAULT_DATA.syncIntervalSeconds,
    ignorePatterns: typeof r.ignorePatterns === "string" ? r.ignorePatterns : DEFAULT_DATA.ignorePatterns,
    lastSyncAt: legacy ? null : typeof r.lastSyncAt === "number" ? r.lastSyncAt : null,
    lastError: legacy ? null : typeof r.lastError === "string" ? r.lastError : null,
    statusLog: legacy
      ? []
      : Array.isArray(r.statusLog)
        ? (r.statusLog as StatusLogEntry[]).filter(
            (e) => e && typeof e.t === "number" && typeof e.msg === "string"
          )
        : [],
    localCursor,
    pathTips: legacy ? {} : pathTips ?? {},
    relayState: legacy || !validCursor || !pathTips ? null : readRelayState(r.relayState, localCursor),
    lastHlc: legacy || !isHlc(r.lastHlc) ? null : r.lastHlc,
  };
}
