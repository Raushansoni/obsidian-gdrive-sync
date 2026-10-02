CREATE TABLE IF NOT EXISTS flocks (
  flock_id TEXT PRIMARY KEY,
  sealed_meta TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  flock_id TEXT NOT NULL,
  pub_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  token_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS devices_flock ON devices(flock_id);

CREATE TABLE IF NOT EXISTS vaults (
  vault_id TEXT PRIMARY KEY,
  flock_id TEXT NOT NULL,
  sealed_meta TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS vaults_flock ON vaults(flock_id);
