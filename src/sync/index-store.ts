import type { SyncIndex, SyncIndexEntry } from "../settings";

export function emptyIndex(): SyncIndex {
  return { version: 1, files: {} };
}

export function getEntry(index: SyncIndex, path: string): SyncIndexEntry | undefined {
  return index.files[path];
}

export function setEntry(index: SyncIndex, path: string, entry: SyncIndexEntry): void {
  index.files[path] = entry;
}

export function removeEntry(index: SyncIndex, path: string): void {
  delete index.files[path];
}

export function renameEntry(index: SyncIndex, oldPath: string, newPath: string): void {
  const entry = index.files[oldPath];
  if (!entry) return;
  delete index.files[oldPath];
  index.files[newPath] = entry;
}

export function listIndexedPaths(index: SyncIndex): string[] {
  return Object.keys(index.files);
}
