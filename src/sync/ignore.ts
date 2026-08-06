import { normalizeVaultPath } from "../util/paths";

export function parseIgnorePatterns(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => normalizeVaultPath(l.trim()))
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

export function isIgnored(path: string, patterns: string[]): boolean {
  const p = normalizeVaultPath(path);
  if (p.endsWith("(conflict") || / \(conflict \d{4}-\d{2}-\d{2}[^)]*\)/.test(p)) {
    // Still sync conflict files so other devices see them; do not ignore.
  }
  for (const pattern of patterns) {
    if (p === pattern) return true;
    if (p.startsWith(pattern.endsWith("/") ? pattern : pattern + "/")) return true;
    // simple glob: *.ext at end segment
    if (pattern.startsWith("*.") && p.toLowerCase().endsWith(pattern.slice(1).toLowerCase())) {
      return true;
    }
  }
  return false;
}
