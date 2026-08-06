import { normalizeVaultPath, dirname, basename, joinPath } from "../util/paths";

/** Build a sibling conflict path: Note.md → Note (conflict 2026-08-02).md */
export function conflictPath(originalPath: string, when: Date = new Date()): string {
  const path = normalizeVaultPath(originalPath);
  const dir = dirname(path);
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const date = when.toISOString().slice(0, 10);
  let conflictName: string;
  if (dot > 0) {
    conflictName = `${name.slice(0, dot)} (conflict ${date})${name.slice(dot)}`;
  } else {
    conflictName = `${name} (conflict ${date})`;
  }
  return dir ? joinPath(dir, conflictName) : conflictName;
}

export function uniqueConflictPath(originalPath: string, exists: (p: string) => boolean): string {
  let candidate = conflictPath(originalPath);
  if (!exists(candidate)) return candidate;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = normalizeVaultPath(originalPath);
  const dir = dirname(path);
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const conflictName =
    dot > 0
      ? `${name.slice(0, dot)} (conflict ${stamp})${name.slice(dot)}`
      : `${name} (conflict ${stamp})`;
  candidate = dir ? joinPath(dir, conflictName) : conflictName;
  return candidate;
}
