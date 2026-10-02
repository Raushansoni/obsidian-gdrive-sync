/** Hybrid logical clock — string form `${wall}:${count}:${deviceId}`. */

export interface Hlc {
  wall: number;
  count: number;
  deviceId: string;
}

export function packHlc(h: Hlc): string {
  return `${h.wall}:${h.count}:${h.deviceId}`;
}

export function parseHlc(s: string): Hlc {
  const parts = s.split(":");
  if (parts.length < 3) throw new Error("bad hlc");
  return {
    wall: Number(parts[0]),
    count: Number(parts[1]),
    deviceId: parts.slice(2).join(":"),
  };
}

export function tickHlc(prev: Hlc | null, deviceId: string, now = Date.now()): Hlc {
  if (!prev) return { wall: now, count: 0, deviceId };
  if (now > prev.wall) return { wall: now, count: 0, deviceId };
  return { wall: prev.wall, count: prev.count + 1, deviceId };
}

export function recvHlc(local: Hlc | null, remote: Hlc, deviceId: string, now = Date.now()): Hlc {
  const lw = local?.wall ?? 0;
  const wall = Math.max(lw, remote.wall, now);
  let count = 0;
  if (wall === lw && wall === remote.wall) count = Math.max(local?.count ?? 0, remote.count) + 1;
  else if (wall === lw) count = (local?.count ?? 0) + 1;
  else if (wall === remote.wall) count = remote.count + 1;
  return { wall, count, deviceId };
}

export function bumpVv(
  vv: Record<string, number>,
  deviceId: string
): Record<string, number> {
  return { ...vv, [deviceId]: (vv[deviceId] ?? 0) + 1 };
}

export function dominates(a: Record<string, number>, b: Record<string, number>): boolean {
  let greater = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av < bv) return false;
    if (av > bv) greater = true;
  }
  return greater;
}

export function concurrent(a: Record<string, number>, b: Record<string, number>): boolean {
  return !dominates(a, b) && !dominates(b, a);
}
