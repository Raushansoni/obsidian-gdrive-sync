import type { SignedOp } from "../protocol";
import { utf8 } from "./bytes";

export function canonicalOpMessage(
  op: Pick<SignedOp, "deviceId" | "pathCipherB64" | "blobHash" | "prevHash" | "hlc" | "versionVector">
): Uint8Array {
  const vv = Object.fromEntries(
    Object.keys(op.versionVector)
      .sort()
      .map((k) => [k, op.versionVector[k]])
  );
  return utf8(
    JSON.stringify({
      blobHash: op.blobHash,
      deviceId: op.deviceId,
      hlc: op.hlc,
      pathCipherB64: op.pathCipherB64,
      prevHash: op.prevHash,
      versionVector: vv,
    })
  );
}
