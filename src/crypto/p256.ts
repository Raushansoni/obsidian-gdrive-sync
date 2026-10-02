import { asAb, b64ToBytes, bytesToB64, bytesToHex, sha256 } from "./bytes";

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;

export interface DeviceKeys {
  deviceId: string;
  pubKeyB64: string;
  ecdhPriv: CryptoKey;
  ecdhPub: CryptoKey;
  ecdsaPriv: CryptoKey;
  ecdsaPub: CryptoKey;
  /** JWK bundle for SecretStorage / localStorage */
  bundle: KeyBundle;
}

export interface KeyBundle {
  ecdh: JsonWebKey;
  ecdsa: JsonWebKey;
}

async function exportPubSpki(key: CryptoKey): Promise<string> {
  return bytesToB64(new Uint8Array(await crypto.subtle.exportKey("spki", key)));
}

export async function generateDeviceKeys(): Promise<DeviceKeys> {
  const ecdh = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const ecdsa = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  const pubKeyB64 = await exportPubSpki(ecdsa.publicKey);
  const deviceId = bytesToHex((await sha256(b64ToBytes(pubKeyB64))).slice(0, 16));
  const ecdhJwk = await crypto.subtle.exportKey("jwk", ecdh.privateKey);
  const ecdsaJwk = await crypto.subtle.exportKey("jwk", ecdsa.privateKey);
  return {
    deviceId,
    pubKeyB64,
    ecdhPriv: ecdh.privateKey,
    ecdhPub: ecdh.publicKey,
    ecdsaPriv: ecdsa.privateKey,
    ecdsaPub: ecdsa.publicKey,
    bundle: { ecdh: ecdhJwk, ecdsa: ecdsaJwk },
  };
}

export async function importDeviceKeys(bundle: KeyBundle): Promise<DeviceKeys> {
  const ecdhPriv = await crypto.subtle.importKey("jwk", bundle.ecdh, ECDH, true, ["deriveBits"]);
  const ecdsaPriv = await crypto.subtle.importKey("jwk", bundle.ecdsa, ECDSA, true, ["sign"]);
  const ecdhPubJwk = { ...bundle.ecdh };
  delete ecdhPubJwk.d;
  ecdhPubJwk.key_ops = [];
  const ecdsaPubJwk = { ...bundle.ecdsa };
  delete ecdsaPubJwk.d;
  ecdsaPubJwk.key_ops = ["verify"];
  const ecdhPub = await crypto.subtle.importKey("jwk", ecdhPubJwk, ECDH, true, []);
  const ecdsaPub = await crypto.subtle.importKey("jwk", ecdsaPubJwk, ECDSA, true, ["verify"]);
  const pubKeyB64 = await exportPubSpki(ecdsaPub);
  const deviceId = bytesToHex((await sha256(b64ToBytes(pubKeyB64))).slice(0, 16));
  return {
    deviceId,
    pubKeyB64,
    ecdhPriv,
    ecdhPub,
    ecdsaPriv,
    ecdsaPub,
    bundle,
  };
}

function spkiBuf(pubB64: string): ArrayBuffer {
  const bytes = b64ToBytes(pubB64);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function importSpkiEcdh(pubB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", spkiBuf(pubB64), ECDH, true, []);
}

export async function importSpkiEcdsa(pubB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", spkiBuf(pubB64), ECDSA, true, ["verify"]);
}

export async function ecdhShared(priv: CryptoKey, peerPub: CryptoKey): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPub }, priv, 256);
  return new Uint8Array(bits);
}

/** Sign SHA-256 digest of message with ECDSA P-256. */
export async function signBytes(priv: CryptoKey, message: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, asAb(message));
  return bytesToB64(new Uint8Array(sig));
}

export async function verifyBytes(
  pub: CryptoKey,
  message: Uint8Array,
  sigB64: string
): Promise<boolean> {
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pub,
    asAb(b64ToBytes(sigB64)),
    asAb(message)
  );
}

export async function exportEcdhPubB64(pub: CryptoKey): Promise<string> {
  return exportPubSpki(pub);
}
