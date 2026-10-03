import { DEFAULT_RELAY_URL, isEphemeralRelayUrl } from "./flock-url";

export interface StatusLogEntry {
  t: number;
  msg: string;
}

export interface PathTip {
  hash: string | null;
  vv: Record<string, number>;
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

/** Drop Drive-era fields so they never persist again after a Flock save. */
export function sanitizePluginData(raw: unknown): PluginData {
  const r = isRecord(raw) ? raw : {};
  const legacy = looksLikeLegacyDrive(r);
  const interval = Number(r.syncIntervalSeconds);
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
    localCursor: legacy ? 0 : typeof r.localCursor === "number" ? r.localCursor : 0,
    pathTips: legacy ? {} : isRecord(r.pathTips) ? (r.pathTips as Record<string, PathTip>) : {},
    lastHlc: legacy ? null : typeof r.lastHlc === "string" ? r.lastHlc : null,
  };
}
