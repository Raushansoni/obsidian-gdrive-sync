/** Frozen wire types. Plugin and relay MUST stay in lockstep. Protocol v1. */

export const PROTOCOL_VERSION = 1 as const;
export const DEEP_LINK_ACTION = "flock-sync";
export const PAIR_TTL_MS = 10 * 60 * 1000;
export const MAX_BLOB_BYTES = 25 * 1024 * 1024;

export type Role = "host" | "guest";

export interface ErrorBody {
  error: string;
  code:
    | "bad_request"
    | "not_found"
    | "expired"
    | "taken"
    | "unauthorized"
    | "conflict"
    | "too_large"
    | "rate_limited"
    | "internal";
}

/** Opaque PAKE/ECDH frames. Relay MUST NOT parse payloadB64. */
export interface PairFrame {
  id: number;
  fromRole: Role;
  payloadB64: string;
}

export interface PairStartRequest {
  hostDeviceId: string;
  hostPubKeyB64: string;
  displayName: string;
}

export interface PairStartResponse {
  nameplate: string;
  expiresAt: number;
}

export interface PairPostRequest {
  nameplate: string;
  fromRole: Role;
  payloadB64: string;
}

export interface PairInboxResponse {
  expiresAt: number;
  claimed: boolean;
  frames: PairFrame[];
}

export interface PairClaimRequest {
  nameplate: string;
  guestDeviceId: string;
  guestPubKeyB64: string;
  displayName: string;
}

export interface DeviceRecord {
  deviceId: string;
  pubKeyB64: string;
  displayName: string;
  createdAt: number;
  revoked: boolean;
}

export interface PairFinishRequest {
  nameplate: string;
  flockId: string;
  hostDeviceId: string;
  /** Random 32-byte token, sent once. Server stores SHA-256 only. */
  hostToken: string;
  /** AES-GCM(flockSecret, JSON flock meta) — opaque to server. */
  sealedMetaB64: string;
}

export interface PairFinishResponse {
  flockId: string;
  devices: DeviceRecord[];
}

export interface GuestFinishRequest {
  nameplate: string;
  flockId: string;
  guestDeviceId: string;
  guestPubKeyB64: string;
  guestToken: string;
  displayName: string;
}

export interface ApproveDeviceRequest {
  flockId: string;
  approverDeviceId: string;
  approverToken: string;
  guestDeviceId: string;
  guestPubKeyB64: string;
  guestToken: string;
  displayName: string;
  sealedMetaB64: string;
}

export interface AuthHeaders {
  /** Device <deviceId> <token> */
}

export interface VaultEnrollRequest {
  vaultId: string;
  /** AES-GCM(flockSecret, { name, createdAt }) */
  sealedMetaB64: string;
}

export interface VaultListItem {
  vaultId: string;
  sealedMetaB64: string;
  createdAt?: number;
}

export interface SignedOp {
  /** Assigned by VaultLog DO. Omit on upload. */
  seq?: number;
  deviceId: string;
  pathCipherB64: string;
  /** hex sha256 of plaintext. null = tombstone. */
  blobHash: string | null;
  prevHash: string | null;
  hlc: string;
  versionVector: Record<string, number>;
  sigB64: string;
}

export interface OpsPushRequest {
  ops: SignedOp[];
}

export interface OpsPullResponse {
  ops: SignedOp[];
  head: number;
}

export interface MerkleResponse {
  /** hex sha256 of canonical JSON {pathCipherB64: blobHash|null} for live tips */
  root: string;
  head: number;
}
