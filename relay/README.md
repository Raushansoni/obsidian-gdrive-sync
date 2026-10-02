# Flock relay

Cloudflare Worker: pairing mailbox, per-vault Durable Object log, R2 blobs, D1 device registry.

## Local

```bash
cd relay
npm install
npx wrangler d1 execute flock --local --file=src/schema.sql
npm run dev
```

Or run the whole local workability check (schema + dev server + full protocol flow) with:

```bash
npm run smoke
```

`scripts/smoke.mjs` applies the schema, boots `wrangler dev` on port 8787 (or reuses a worker already listening, or attach with `SMOKE_BASE_URL`), then exercises pair start/claim/msg/inbox/finish/guest-finish, device approve/revoke, vault enroll, ECDSA-signed ops push/pull, merkle root verification and blob put/get. Node 20+ required (WebCrypto).

Plugin default URL: `http://127.0.0.1:8787` (desktop only). Obsidian mobile blocks cleartext HTTP — deploy with `npm run deploy` and set `FLOCK_RELAY_URL` when building the plugin.

## Bindings

Defined in `wrangler.jsonc`: `PAIRING`, `VAULT_LOG`, `BLOBS`, `DB`. Create the remote R2 bucket and D1 database once, then replace `database_id` and ensure `flock-blobs` exists.
