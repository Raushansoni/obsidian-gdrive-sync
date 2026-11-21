import { asAb, b64ToBytes, bytesToB64, randomBytes, utf8 } from "./bytes";
import { hmacSha256 } from "./hkdf";

const AES = "AES-GCM";

async function importAes(key: Uint8Array): Promise<CryptoKey> {
  if (key.byteLength !== 32) throw new Error("AES-256 key required");
  return crypto.subtle.importKey("raw", asAb(key), AES, false, ["encrypt", "decrypt"]);
}

/**
 * Path seals must be deterministic so local and relay merkle roots match.
 * Nonce = HMAC(key, aad || plaintext)[:12] — unique per plaintext, stable for the same path.
 */
export async function sealDeterministic(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: string
): Promise<string> {
  const prefix = utf8(`gcm-nonce:${aad}:`);
  const input = new Uint8Array(prefix.length + plaintext.length);
  input.set(prefix);
  input.set(plaintext, prefix.length);
  const nonce = (await hmacSha256(key, input)).slice(0, 12);
  return sealWithNonce(key, plaintext, nonce, aad);
}

async function sealBytesWithNonce(
  key: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array,
  aad?: string
): Promise<Uint8Array> {
  const cryptoKey = await importAes(key);
  const extra: AesGcmParams = { name: AES, iv: asAb(nonce) };
  if (aad) extra.additionalData = asAb(utf8(aad));
  const ct = new Uint8Array(await crypto.subtle.encrypt(extra, cryptoKey, asAb(plaintext)));
  const packed = new Uint8Array(12 + ct.byteLength);
  packed.set(nonce, 0);
  packed.set(ct, 12);
  return packed;
}

async function sealWithNonce(
  key: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array,
  aad?: string
): Promise<string> {
  return bytesToB64(await sealBytesWithNonce(key, plaintext, nonce, aad));
}

/** nonce(12) || ciphertext+tag as raw bytes. Avoids base64 overhead on binary blobs. */
export async function sealBytes(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: string
): Promise<Uint8Array> {
  return sealBytesWithNonce(key, plaintext, randomBytes(12), aad);
}

/** Decrypt raw nonce(12) || ciphertext+tag bytes without base64 round-trips. */
export async function openBytes(
  key: Uint8Array,
  packed: Uint8Array,
  aad?: string
): Promise<Uint8Array> {
  if (packed.byteLength < 13) throw new Error("ciphertext too short");
  const nonce = packed.subarray(0, 12);
  const ct = packed.subarray(12);
  const cryptoKey = await importAes(key);
  const extra: AesGcmParams = { name: AES, iv: asAb(nonce) };
  if (aad) extra.additionalData = asAb(utf8(aad));
  return new Uint8Array(await crypto.subtle.decrypt(extra, cryptoKey, asAb(ct)));
}

/** nonce(12) || ciphertext+tag as base64. Random nonce — blobs, not paths. */
export async function seal(key: Uint8Array, plaintext: Uint8Array, aad?: string): Promise<string> {
  return sealWithNonce(key, plaintext, randomBytes(12), aad);
}

export async function open(key: Uint8Array, packedB64: string, aad?: string): Promise<Uint8Array> {
  return openBytes(key, b64ToBytes(packedB64), aad);
}

export async function sealJson(key: Uint8Array, obj: unknown, aad?: string): Promise<string> {
  return seal(key, new TextEncoder().encode(JSON.stringify(obj)), aad);
}

export async function openJson<T>(key: Uint8Array, packedB64: string, aad?: string): Promise<T> {
  const pt = await open(key, packedB64, aad);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
