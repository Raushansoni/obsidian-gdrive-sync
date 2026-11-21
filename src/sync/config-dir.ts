import type { App, ListedFiles } from "obsidian";
import { normalizeVaultPath } from "../util/paths";

/**
 * Vault sync covers the Obsidian config directory (usually `.obsidian`) in
 * addition to visible vault files. Everything goes through the normal
 * op/blob pipeline; paths simply start with the config dir.
 *
 * The vault adapter is only used through the generic DataAdapter interface —
 * never cast to FileSystemAdapter (mobile compatibility).
 */

/** Root-level config files that are safe to sync. */
const ALLOWED_ROOT_FILES = new Set([
  "app.json",
  "appearance.json",
  "community-plugins.json",
  "core-plugins.json",
]);

/** Whole subtrees that are safe to sync. */
const ALLOWED_SUBDIRS = ["snippets", "themes", "plugins"];

/** This plugin's own folder (settings + runtime bundle) must never be synced. */
const SELF_PLUGIN_PREFIX = "plugins/obsidian-gdrive-sync";

/** Obsidian's ephemeral state — denied even though it is not in the allow-list. */
const DENIED_PREFIXES = ["cache", "trash"];

/** Volatile filenames/extensions inside plugins that cause cross-device churn. */
const VOLATILE_BASENAME_RE = /^(?:\.ds_store|thumbs\.db|desktop\.ini)$/i;
const VOLATILE_EXT_RE = /\.(?:log|tmp|bak|lock|sqlite|sqlite-wal|sqlite-shm|db-wal|db-shm)$/i;

/**
 * True when a vault-relative path may be synced as a config file.
 * Deny rules are checked before the allow-list.
 */
export function isConfigPathAllowed(path: string, configDir: string): boolean {
  const cd = normalizeVaultPath(configDir);
  const p = normalizeVaultPath(path);
  if (!cd || !p) return false;
  if (p !== cd && !p.startsWith(cd + "/")) return false;
  const rel = p === cd ? "" : p.slice(cd.length + 1);
  if (!rel) return false;

  const relLower = rel.toLowerCase();

  // Hard denies first.
  if (/^workspace[^/]*\.json$/i.test(rel)) return false; // workspace*.json
  for (const denied of DENIED_PREFIXES) {
    if (relLower === denied || relLower.startsWith(denied + "/")) return false;
  }
  if (relLower === SELF_PLUGIN_PREFIX || relLower.startsWith(SELF_PLUGIN_PREFIX + "/")) return false;

  const segments = relLower.split("/");
  const fileName = segments[segments.length - 1];
  if (VOLATILE_BASENAME_RE.test(fileName) || VOLATILE_EXT_RE.test(fileName)) return false;
  // Deny nested cache/trash directories inside third-party plugins.
  if (segments.length >= 3 && (segments.includes("cache") || segments.includes("trash"))) {
    return false;
  }

  // Allow-list.
  if (ALLOWED_ROOT_FILES.has(rel)) return true;
  const top = segments[0];
  if (ALLOWED_SUBDIRS.includes(top)) return true;
  return false;
}

/**
 * Recursively list syncable config files under app.vault.configDir, returning
 * vault-relative paths (configDir prefix included, e.g. `.obsidian/app.json`).
 */
export async function listConfigRelPaths(app: App): Promise<string[]> {
  const configDir = normalizeVaultPath(app.vault.configDir || ".obsidian");
  if (!configDir) return [];
  const adapter = app.vault.adapter;

  const found: string[] = [];
  const seen = new Set<string>([configDir]);
  const queue: string[] = [configDir];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let listing: ListedFiles;
    try {
      listing = await adapter.list(dir);
    } catch {
      continue; // missing or unreadable directory — skip
    }
    for (const f of listing.files) {
      const p = normalizeVaultPath(f);
      if (p && !found.includes(p)) found.push(p);
    }
    for (const d of listing.folders) {
      const p = normalizeVaultPath(d);
      if (p && !seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return found.filter((p) => isConfigPathAllowed(p, configDir)).sort();
}