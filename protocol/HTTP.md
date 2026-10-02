# Flock relay HTTP v1

Base: `{relayUrl}` (HTTPS in production; `http://127.0.0.1:8787` only for desktop wrangler).

All JSON. CORS `*` GET/POST/PUT + `Authorization`. Errors: `{ "error": string, "code": ErrorBody.code }` with 4xx.

Auth after pair: `Authorization: Device {deviceId} {token}` on every flock/vault route.

## Pairing mailbox (untrusted)

Relay stores opaque base64 frames. Never decrypt. One guest per nameplate. TTL 10 minutes. Alarm deletes the PairingRoom.

| Method | Path | Body | Success |
|--------|------|------|---------|
| POST | `/v1/pair/start` | `PairStartRequest` | `PairStartResponse` nameplate = 3 digits, unique among live rooms |
| POST | `/v1/pair/claim` | `PairClaimRequest` | `{ ok: true }` 409 `taken` if already claimed |
| POST | `/v1/pair/msg` | `PairPostRequest` | `{ id: number }` |
| GET | `/v1/pair/inbox?nameplate=` | | `PairInboxResponse` |
| POST | `/v1/pair/finish` | `PairFinishRequest` | `PairFinishResponse` — host creates flock in D1, registers host device (token hashed) |
| POST | `/v1/pair/guest-finish` | `GuestFinishRequest` | `PairFinishResponse` — guest joins same flock; nameplate must be claimed by this guest |

## Flock

| Method | Path | Notes |
|--------|------|--------|
| GET | `/v1/flock` | devices + vault list (sealed meta only) |
| POST | `/v1/devices/approve` | `ApproveDeviceRequest` |
| POST | `/v1/devices/revoke` | `{ deviceId }` of target; caller cannot be revoked; 401 if caller revoked |
| POST | `/v1/vaults` | `VaultEnrollRequest` upsert sealed meta |
| GET | `/v1/vaults` | `VaultListItem[]` |

## Vault log + blobs

VaultLog DO id = `idFromName(vaultId)`. SQLite table `ops(seq INTEGER PK AUTOINCREMENT, device_id, path_cipher, blob_hash, prev_hash, hlc, vv_json, sig, created_at)`.

| Method | Path | Notes |
|--------|------|--------|
| POST | `/v1/vaults/:vaultId/ops` | `OpsPushRequest` — verify ECDSA P-256 sig over canonical bytes; device must be in flock and not revoked; assign seq |
| GET | `/v1/vaults/:vaultId/ops?after=N` | ops with seq > N, limit 200 |
| GET | `/v1/vaults/:vaultId/merkle` | `MerkleResponse` live tips (latest non-tombstone per path_cipher; tombstone wins if latest) |
| PUT | `/v1/vaults/:vaultId/blobs/:blobHash` | raw body ciphertext, max 25MB, `Content-Type: application/octet-stream`. R2 key `{flockId}/{vaultId}/{blobHash}` |
| GET | `/v1/vaults/:vaultId/blobs/:blobHash` | ciphertext bytes |

## Durable Object routing

- `PAIRING.idFromName(nameplate)` class `PairingRoom`
- `VAULT_LOG.idFromName(vaultId)` class `VaultLog`

Worker authenticates Device token (D1 `devices.token_sha256`) then `stub.fetch` the DO.

## D1

```sql
devices(device_id PK, flock_id, pub_key, display_name, token_sha256, created_at, revoked INTEGER)
flocks(flock_id PK, sealed_meta, created_at)
vaults(vault_id PK, flock_id, sealed_meta, created_at)
```
