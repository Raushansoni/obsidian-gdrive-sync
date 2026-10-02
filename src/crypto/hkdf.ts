import { asAb, utf8 } from "./bytes";

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    asAb(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, asAb(data)));
}

/** HKDF-SHA256 extract+expand. */
export async function hkdf(
  ikm: Uint8Array,
  info: string,
  length = 32,
  salt?: Uint8Array
): Promise<Uint8Array> {
  const saltBytes = salt ?? new Uint8Array(32);
  const prk = await hmacSha256(saltBytes, ikm);
  const infoBytes = utf8(info);
  const blocks = Math.ceil(length / 32);
  const okm = new Uint8Array(blocks * 32);
  let prev: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < blocks; i++) {
    const input = new Uint8Array(prev.length + infoBytes.length + 1);
    input.set(prev, 0);
    input.set(infoBytes, prev.length);
    input[input.length - 1] = i + 1;
    prev = await hmacSha256(prk, input);
    okm.set(prev, i * 32);
  }
  return okm.slice(0, length);
}

export async function hmacHex(key: Uint8Array, data: string): Promise<string> {
  const mac = await hmacSha256(key, utf8(data));
  return Array.from(mac)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export { hmacSha256 };
