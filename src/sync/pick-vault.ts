/**
 * Decide which flock vault a device should enroll in.
 *
 * Two devices that each tap "Link this vault" used to mint a fresh UUID, so
 * they both showed "synced" while uploading into isolated logs — no files
 * ever crossed. Same-name vaults in one flock must collapse to one id.
 */

export interface NamedVault {
  vaultId: string;
  name: string | null;
  createdAt?: number;
}

export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase() && !!(a ?? "").trim();
}

/**
 * First-pass choice without merkle heads:
 * 1. Keep currentId if the flock already knows it
 * 2. Oldest vault whose decrypted name matches the local vault name
 * 3. The only vault in the flock (any name)
 * 4. null → caller mints a new id
 */
export function pickVaultToLink(
  vaults: NamedVault[],
  localName: string,
  currentId: string | null
): string | null {
  if (currentId && vaults.some((v) => v.vaultId === currentId)) {
    const sameName = vaults.filter((v) => namesMatch(v.name, localName));
    // Forks of the same name must not keep a later duplicate just because we
    // already enrolled — caller uses merkle heads to pick the richest.
    if (sameName.length <= 1) return currentId;
  }
  const named = vaults
    .filter((v) => namesMatch(v.name, localName))
    .slice()
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.vaultId.localeCompare(b.vaultId));
  if (named.length > 0) return named[0].vaultId;
  if (vaults.length === 1) return vaults[0].vaultId;
  return null;
}

/** Among same-name forks, keep the log with the most ops. */
export function pickRichestVault(heads: Array<{ vaultId: string; head: number }>): string | null {
  if (!heads.length) return null;
  let best = heads[0];
  for (const h of heads.slice(1)) {
    if (h.head > best.head) best = h;
    else if (h.head === best.head && h.vaultId < best.vaultId) best = h;
  }
  return best.vaultId;
}

/** Local path has never been synced (or was tombstoned) — enqueue for push. */
export function shouldEnqueueLocalPath(tip: { hash: string | null } | null | undefined): boolean {
  return !tip || tip.hash === null;
}

/**
 * Same-name leftover vaults are harmless once this device is already on the
 * canonical (richest) copy. Warn only when this device still needs to switch.
 */
export function forkNeedsJoin(
  vaults: Array<{
    vaultId: string;
    name: string | null;
    current?: boolean;
    canonical?: boolean;
  }>
): boolean {
  const current = vaults.find((v) => v.current);
  if (!current) return false;
  const forks = vaults.filter((v) => namesMatch(v.name, current.name));
  if (forks.length <= 1) return false;
  return current.canonical !== true;
}
