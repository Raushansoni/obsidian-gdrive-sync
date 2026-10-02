// ECDSA P-256 / SHA-256 signature verification over the canonical op encoding.
// Device public keys are stored in D1 as base64 SPKI (Web Crypto import format).

import { canonicalOpMessage } from "./op-canonical";
import type { SignedOp } from "./protocol";

function base64ToBytes(b64: string) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Fresh ArrayBuffer-backed copy; keeps BufferSource params happy on every TS lib. */
function toBufferSource(bytes: Uint8Array) {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

/**
 * Verifies `op.sigB64` against the device's SPKI public key.
 * The signed message is the canonical JSON bytes from op-canonical.ts.
 */
export async function verifyOpSignature(pubKeyB64: string, op: SignedOp): Promise<boolean> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "spki",
      base64ToBytes(pubKeyB64),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
  } catch {
    return false; // malformed public key
  }
  let signature: Uint8Array;
  try {
    signature = base64ToBytes(op.sigB64);
  } catch {
    return false; // malformed signature encoding
  }
  // Web Crypto argument order: (algorithm, key, signature, data).
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    toBufferSource(signature),
    toBufferSource(canonicalOpMessage(op))
  );
}
