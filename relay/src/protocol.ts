export const PROTOCOL_VERSION = 1 as const;
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
  hostToken: string;
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

export interface VaultEnrollRequest {
  vaultId: string;
  sealedMetaB64: string;
}

export interface VaultListItem {
  vaultId: string;
  sealedMetaB64: string;
}

export interface SignedOp {
  seq?: number;
  deviceId: string;
  pathCipherB64: string;
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
  root: string;
  head: number;
}
