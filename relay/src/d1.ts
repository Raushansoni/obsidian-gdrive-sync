// D1 bootstrap and shared row helpers.
//
// Workers cannot read files at runtime, so the DDL below mirrors relay/src/schema.sql
// exactly (keep them in sync). It is applied lazily on the first request of each
// isolate; DDL is idempotent (CREATE ... IF NOT EXISTS) so concurrent isolates are safe.

import type { DeviceRecord, VaultListItem } from "./protocol";

export interface FlockRow {
  flock_id: string;
  sealed_meta: string;
  created_at: number;
}

export interface DeviceRow {
  device_id: string;
  flock_id: string;
  pub_key: string;
  display_name: string;
  token_sha256: string;
  created_at: number;
  revoked: number;
}

export interface VaultRow {
  vault_id: string;
  flock_id: string;
  sealed_meta: string;
  created_at: number;
}

const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS flocks (
  flock_id TEXT PRIMARY KEY,
  sealed_meta TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  flock_id TEXT NOT NULL,
  pub_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  token_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
)`,
  `CREATE INDEX IF NOT EXISTS devices_flock ON devices(flock_id)`,
  `CREATE TABLE IF NOT EXISTS vaults (
  vault_id TEXT PRIMARY KEY,
  flock_id TEXT NOT NULL,
  sealed_meta TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS vaults_flock ON vaults(flock_id)`,
];

let schemaReady = false;

/** Runs schema.sql statements on first use (probe SELECT fails when tables are missing). */
export async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  try {
    await env.DB.prepare("SELECT flock_id FROM flocks LIMIT 1").first();
    schemaReady = true;
    return;
  } catch {
    // flocks table missing -> create the schema below.
  }
  await env.DB.batch(SCHEMA_STATEMENTS.map((stmt) => env.DB.prepare(stmt)));
  schemaReady = true;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** SHA-256 of a UTF-8 string as lowercase hex (used for device token hashing). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

/** Constant-time comparison of two equal-length hex digests. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function getDevice(env: Env, deviceId: string): Promise<DeviceRow | null> {
  return env.DB.prepare(
    "SELECT device_id, flock_id, pub_key, display_name, token_sha256, created_at, revoked FROM devices WHERE device_id = ?"
  )
    .bind(deviceId)
    .first<DeviceRow>();
}

export async function getVault(env: Env, vaultId: string): Promise<VaultRow | null> {
  return env.DB.prepare(
    "SELECT vault_id, flock_id, sealed_meta, created_at FROM vaults WHERE vault_id = ?"
  )
    .bind(vaultId)
    .first<VaultRow>();
}

export async function flockExists(env: Env, flockId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT flock_id FROM flocks WHERE flock_id = ?")
    .bind(flockId)
    .first();
  return row !== null;
}

export async function upsertFlock(env: Env, flockId: string, sealedMetaB64: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO flocks (flock_id, sealed_meta, created_at) VALUES (?, ?, ?) ON CONFLICT(flock_id) DO NOTHING"
  )
    .bind(flockId, sealedMetaB64, Date.now())
    .run();
}

export interface UpsertDeviceArgs {
  deviceId: string;
  flockId: string;
  pubKeyB64: string;
  displayName: string;
  /** Raw device token; only its SHA-256 hex digest is persisted. */
  token: string;
}

export async function upsertDevice(env: Env, args: UpsertDeviceArgs): Promise<void> {
  const tokenSha256 = await sha256Hex(args.token);
  await env.DB.prepare(
    `INSERT INTO devices (device_id, flock_id, pub_key, display_name, token_sha256, created_at, revoked)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(device_id) DO UPDATE SET
       flock_id = excluded.flock_id,
       pub_key = excluded.pub_key,
       display_name = excluded.display_name,
       token_sha256 = excluded.token_sha256,
       revoked = 0`
  )
    .bind(args.deviceId, args.flockId, args.pubKeyB64, args.displayName, tokenSha256, Date.now())
    .run();
}

export async function listDevices(env: Env, flockId: string): Promise<DeviceRecord[]> {
  const result = await env.DB.prepare(
    "SELECT device_id, flock_id, pub_key, display_name, token_sha256, created_at, revoked FROM devices WHERE flock_id = ? ORDER BY created_at ASC, device_id ASC"
  )
    .bind(flockId)
    .all<DeviceRow>();
  return (result.results ?? []).map((row) => ({
    deviceId: row.device_id,
    pubKeyB64: row.pub_key,
    displayName: row.display_name,
    createdAt: row.created_at,
    revoked: row.revoked !== 0,
  }));
}

export async function listVaults(env: Env, flockId: string): Promise<VaultListItem[]> {
  const result = await env.DB.prepare(
    "SELECT vault_id, flock_id, sealed_meta, created_at FROM vaults WHERE flock_id = ? ORDER BY created_at ASC, vault_id ASC"
  )
    .bind(flockId)
    .all<VaultRow>();
  return (result.results ?? []).map((row) => ({
    vaultId: row.vault_id,
    sealedMetaB64: row.sealed_meta,
    createdAt: row.created_at,
  }));
}
