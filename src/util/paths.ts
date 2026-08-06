export function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export function dirname(path: string): string {
  const n = normalizeVaultPath(path);
  const i = n.lastIndexOf("/");
  return i === -1 ? "" : n.slice(0, i);
}

export function basename(path: string): string {
  const n = normalizeVaultPath(path);
  const i = n.lastIndexOf("/");
  return i === -1 ? n : n.slice(i + 1);
}

export function joinPath(...parts: string[]): string {
  return parts
    .map((p) => normalizeVaultPath(p))
    .filter(Boolean)
    .join("/");
}

export function parentPaths(path: string): string[] {
  const n = normalizeVaultPath(path);
  if (!n.includes("/")) return [];
  const parts = n.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    out.push(parts.slice(0, i).join("/"));
  }
  return out;
}
