import type { PathTip } from "../plugin-data";
import type { OpsPullResponse, SignedOp } from "../protocol";
import { sha256Hex } from "../util/hash";

export function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isVersionVector(value: unknown): value is Record<string, number> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.entries(value).every(([key, count]) => key.length > 0 &&
      typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
}

export function isHlc(value: unknown): value is string {
  return typeof value === "string" && /^\d+:\d+:.+$/.test(value) &&
    value.split(":").slice(0, 2).every((n) => Number.isSafeInteger(Number(n)));
}

/** Validate before normalization: normalization must not turn traversal into a writable path. */
export function isSyncPath(path: string): boolean {
  return !!path && path.split("/").every((part) => !!part && part !== "." && part !== ".." &&
    !/[\\<>:"|?*\u0000-\u001f\u007f]/.test(part) && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function relayRoot(tips: Record<string, string | null>): Promise<string> {
  return sha256Hex(JSON.stringify(
    Object.fromEntries(Object.keys(tips).sort().map((key) => [key, tips[key]]))
  ));
}

export function pathTipsHash(tips: Record<string, PathTip>): Promise<string> {
  return sha256Hex(JSON.stringify(Object.keys(tips).sort().map((path) => {
    const tip = tips[path];
    return [path, tip.hash, Object.keys(tip.vv).sort().map((key) => [key, tip.vv[key]]), !!tip.pending,
      ...(tip.prevHash ? [tip.prevHash] : []), ...(tip.pendingMerge ? [true] : [])];
  })));
}

export function covers(a: Record<string, number>, b: Record<string, number>): boolean {
  return Object.keys(b).every((key) =>
    (Object.prototype.hasOwnProperty.call(a, key) ? a[key] : 0) >= b[key]);
}

export function validateHead(head: number): void {
  if (!Number.isSafeInteger(head) || head < 0) throw new Error("Invalid relay head");
}

export function validateOp(op: SignedOp): void {
  if (!op || typeof op.pathCipherB64 !== "string" || !op.pathCipherB64 ||
    !(op.blobHash === null || isHash(op.blobHash)) ||
    typeof op.deviceId !== "string" || !op.deviceId || typeof op.sigB64 !== "string" ||
    !isVersionVector(op.versionVector) || !isHlc(op.hlc)) {
    throw new Error("Malformed relay operation");
  }
}

/** A cursor only consumes an ordered, gap-free prefix; a response head is not a receipt. */
export function validatePull(pull: OpsPullResponse, after: number): void {
  validateHead(pull.head);
  if (!Array.isArray(pull.ops)) throw new Error("Malformed relay operations page");
  let cursor = after;
  for (const op of pull.ops) {
    validateOp(op);
    if (op.seq !== cursor + 1 || op.seq > pull.head) throw new Error("Incomplete relay operations page");
    cursor = op.seq;
  }
}
