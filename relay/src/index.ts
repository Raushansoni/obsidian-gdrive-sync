// Flock relay worker — HTTP router implementing protocol/HTTP.md in full.
//
//   Pairing mailbox:   /v1/pair/start | claim | msg | inbox | finish | guest-finish
//   Flock admin:       /v1/flock, /v1/devices/approve, /v1/devices/revoke
//   Vault enrollment:  /v1/vaults (POST upsert sealed meta, GET list)
//   Vault log/blobs:   /v1/vaults/:vaultId/ops | merkle | blobs/:blobHash
//
// Pairing routes are untrusted (nameplate-keyed Durable Objects). Every flock/vault
// route requires `Authorization: Device {deviceId} {token}` (hashed, D1 lookup).

import {
  CORS_HEADERS,
  asString,
  doErrorToResponse,
  err,
  json,
  preflight,
  readJsonObject,
} from "./http";
import {
  ensureSchema,
  flockExists,
  getDevice,
  getVault,
  listDevices,
  listVaults,
  upsertDevice,
  upsertFlock,
} from "./d1";
import type { DeviceRow, VaultRow } from "./d1";
import { authenticateDevice, authenticateRequest } from "./auth";
import { verifyOpSignature } from "./verify-op";
import type { InboxResult, InfoResult, MarkFinishedResult, MsgResult, ClaimResult, StartResult } from "./pair-do";
import type { VaultMerkleResult, VaultPullResult, VaultPushResult } from "./vault-do";
import { MAX_BLOB_BYTES, PAIR_TTL_MS } from "./protocol";
import type {
  MerkleResponse,
  OpsPullResponse,
  PairFinishResponse,
  PairInboxResponse,
  PairStartResponse,
  SignedOp,
  VaultListItem,
} from "./protocol";

export { PairingRoom } from "./pair-do";
export { VaultLog } from "./vault-do";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return preflight();
    try {
      await ensureSchema(env);

      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // --- pairing mailbox (untrusted) ---------------------------------
      if (method === "POST" && path === "/v1/pair/start") return await pairStart(req, env);
      if (method === "POST" && path === "/v1/pair/claim") return await pairClaim(req, env);
      if (method === "POST" && path === "/v1/pair/msg") return await pairMsg(req, env);
      if (method === "GET" && path === "/v1/pair/inbox") return await pairInbox(req, env);
      if (method === "POST" && path === "/v1/pair/finish") return await pairFinish(req, env);
      if (method === "POST" && path === "/v1/pair/guest-finish") return await pairGuestFinish(req, env);

      // --- flock admin (device auth) ------------------------------------
      if (method === "GET" && path === "/v1/flock") return await flockGet(req, env);
      if (method === "POST" && path === "/v1/devices/approve") return await deviceApprove(req, env);
      if (method === "POST" && path === "/v1/devices/revoke") return await deviceRevoke(req, env);

      // --- vault enrollment ---------------------------------------------
      if (method === "POST" && path === "/v1/vaults") return await vaultEnroll(req, env);
      if (method === "GET" && path === "/v1/vaults") return await vaultList(req, env);

      // --- vault log + blobs ----------------------------------------------
      const vaultRoute = /^\/v1\/vaults\/([^/]+)\/(ops|merkle|blobs)(?:\/([^/]+))?$/.exec(path);
      if (vaultRoute) {
        const vaultId = decodeURIComponent(vaultRoute[1]);
        const sub = vaultRoute[2];
        const tail = vaultRoute[3] !== undefined ? decodeURIComponent(vaultRoute[3]) : null;
        if (sub === "ops" && method === "POST") return await vaultOpsPush(req, env, vaultId);
        if (sub === "ops" && method === "GET") return await vaultOpsPull(req, env, vaultId, url);
        if (sub === "merkle" && method === "GET") return await vaultMerkle(req, env, vaultId);
        if (sub === "blobs" && tail !== null) {
          if (method === "PUT") return await blobPut(req, env, vaultId, tail);
          if (method === "GET") return await blobGet(req, env, vaultId, tail);
        }
        return err(404, "not_found", "unsupported method for this route");
      }

      return err(404, "not_found", "unknown route");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(500, "internal", `internal error: ${message}`);
    }
  },
};

// ===========================================================================
// Ambient runtime types
// ===========================================================================
// The relay intentionally avoids depending on @cloudflare/workers-types (it is
// not installed; tsconfig uses `types: []`). The bindings and runtime globals
// used by this worker are therefore declared here. wrangler/esbuild bundles the
// code directly; these declarations exist only for `tsc --noEmit`.
// ===========================================================================

declare global {
  interface Env {
    PAIRING: DurableObjectNamespace;
    VAULT_LOG: DurableObjectNamespace;
    BLOBS: R2Bucket;
    DB: D1Database;
  }

  interface DurableObjectId {
    readonly name?: string;
    toString(): string;
  }

  interface DurableObjectStub {
    fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>;
  }

  interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    idFromString(id: string): DurableObjectId;
    newUniqueId(): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }

  interface DurableObjectState {
    readonly storage: DurableObjectStorage;
    waitUntil(promise: Promise<unknown>): void;
  }

  interface DurableObjectStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    deleteAll(): Promise<void>;
    getAlarm(): Promise<number | null>;
    setAlarm(time: number | Date): Promise<void>;
    deleteAlarm(): Promise<void>;
    readonly sql: SqlStorage;
  }

  type SqlStorageValue = ArrayBuffer | string | number | null;

  interface SqlStorage {
    exec<T = Record<string, SqlStorageValue>>(
      query: string,
      ...params: SqlStorageValue[]
    ): SqlStorageCursor<T>;
  }

  interface SqlStorageCursor<T = Record<string, SqlStorageValue>> {
    one(): T;
    toArray(): T[];
  }

  interface D1Result<T = unknown> {
    results?: T[];
    success: boolean;
    meta?: unknown;
  }

  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    run(): Promise<D1Result>;
  }

  interface D1Database {
    prepare(query: string): D1PreparedStatement;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  }

  interface R2Object {
    readonly key: string;
    readonly size: number;
  }

  interface R2ObjectBody extends R2Object {
    readonly body: ReadableStream<Uint8Array>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }

  interface R2Bucket {
    get(key: string): Promise<R2ObjectBody | null>;
    head(key: string): Promise<R2Object | null>;
    put(
      key: string,
      value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string | null,
      options?: { httpMetadata?: { contentType?: string } }
    ): Promise<R2Object>;
  }
}

// ===========================================================================
// Handlers
// ===========================================================================

const NAMEPLATE_RE = /^\d{3}$/;
const BLOB_HASH_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Random 3-digit nameplate via crypto RNG (never Math.random). */
function randomNameplate(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100 + (buf[0] % 900));
}

async function pairStub(env: Env, nameplate: string): Promise<DurableObjectStub> {
  return env.PAIRING.get(env.PAIRING.idFromName(nameplate));
}

async function vaultStub(env: Env, vaultId: string): Promise<DurableObjectStub> {
  return env.VAULT_LOG.get(env.VAULT_LOG.idFromName(vaultId));
}

async function doJson<T>(stub: DurableObjectStub, op: string, payload: unknown = {}): Promise<T> {
  const res = await stub.fetch(`https://do.internal/${op}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const parsed = (await res.json().catch(() => null)) as T | null;
  if (!res.ok || parsed === null) {
    throw new Error(`durable object "${op}" call failed (status ${res.status})`);
  }
  return parsed;
}

// ------------------------------------------------------- pairing mailbox ---

async function pairStart(req: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(req);
  const hostDeviceId = body ? asString(body.hostDeviceId) : null;
  const hostPubKeyB64 = body ? asString(body.hostPubKeyB64) : null;
  const displayName = body ? asString(body.displayName) : null;
  if (!body || !hostDeviceId || !hostPubKeyB64 || !displayName) {
    return err(400, "bad_request", "hostDeviceId, hostPubKeyB64 and displayName are required");
  }

  const expiresAt = Date.now() + PAIR_TTL_MS;
  const startArgs = { hostDeviceId, hostPubKeyB64, displayName, expiresAt };

  // Retry ~8 times to find a nameplate without a live room.
  for (let attempt = 0; attempt < 8; attempt++) {
    const nameplate = randomNameplate();
    const result = await doJson<StartResult>(await pairStub(env, nameplate), "start", startArgs);
    if (result.ok) {
      const response: PairStartResponse = { nameplate, expiresAt: result.expiresAt };
      return json(response);
    }
    if (result.code !== "taken") return doErrorToResponse(result);
  }
  return err(503, "rate_limited", "unable to allocate a free nameplate, retry shortly");
}

async function pairClaim(req: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(req);
  const nameplate = body ? asString(body.nameplate) : null;
  const guestDeviceId = body ? asString(body.guestDeviceId) : null;
  const guestPubKeyB64 = body ? asString(body.guestPubKeyB64) : null;
  const displayName = body ? asString(body.displayName) : null;
  if (!body || !nameplate || !guestDeviceId || !guestPubKeyB64 || !displayName) {
    return err(
      400,
      "bad_request",
      "nameplate, guestDeviceId, guestPubKeyB64 and displayName are required"
    );
  }
  if (!NAMEPLATE_RE.test(nameplate)) return err(400, "bad_request", "nameplate must be 3 digits");

  const result = await doJson<ClaimResult>(await pairStub(env, nameplate), "claim", {
    guestDeviceId,
    guestPubKeyB64,
    displayName,
  });
  if (!result.ok) return doErrorToResponse(result);
  return json({ ok: true });
}

async function pairMsg(req: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(req);
  const nameplate = body ? asString(body.nameplate) : null;
  const payloadB64 = body ? asString(body.payloadB64) : null;
  const fromRole: unknown = body ? body.fromRole : null;
  if (!body || !nameplate || !payloadB64 || (fromRole !== "host" && fromRole !== "guest")) {
    return err(400, "bad_request", "nameplate, fromRole (host|guest) and payloadB64 are required");
  }
  if (!NAMEPLATE_RE.test(nameplate)) return err(400, "bad_request", "nameplate must be 3 digits");

  const result = await doJson<MsgResult>(await pairStub(env, nameplate), "msg", {
    fromRole,
    payloadB64,
  });
  if (!result.ok) return doErrorToResponse(result);
  return json({ id: result.id });
}

async function pairInbox(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const nameplate = url.searchParams.get("nameplate");
  if (!nameplate || !NAMEPLATE_RE.test(nameplate)) {
    return err(400, "bad_request", "nameplate query parameter must be 3 digits");
  }

  const result = await doJson<InboxResult>(await pairStub(env, nameplate), "inbox");
  if (!result.ok) return doErrorToResponse(result);
  if (result.expired) return err(410, "expired", "pairing room expired");

  const response: PairInboxResponse = {
    expiresAt: result.expiresAt,
    claimed: result.claimed,
    frames: result.frames,
  };
  return json(response);
}

async function pairFinish(req: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(req);
  const nameplate = body ? asString(body.nameplate) : null;
  const flockId = body ? asString(body.flockId) : null;
  const hostDeviceId = body ? asString(body.hostDeviceId) : null;
  const hostToken = body ? asString(body.hostToken) : null;
  const sealedMetaB64 = body ? asString(body.sealedMetaB64) : null;
  if (!body || !nameplate || !flockId || !hostDeviceId || !hostToken || !sealedMetaB64) {
    return err(
      400,
      "bad_request",
      "nameplate, flockId, hostDeviceId, hostToken and sealedMetaB64 are required"
    );
  }
  if (!NAMEPLATE_RE.test(nameplate)) return err(400, "bad_request", "nameplate must be 3 digits");

  const stub = await pairStub(env, nameplate);
  const info = await doJson<InfoResult>(stub, "info");
  if (!info.ok) return doErrorToResponse(info);
  if (info.expired) return err(410, "expired", "pairing room expired");
  if (info.hostDeviceId !== hostDeviceId) {
    return err(401, "unauthorized", "hostDeviceId does not match the pairing room");
  }

  const marked = await doJson<MarkFinishedResult>(stub, "markFinished", { flockId });
  if (!marked.ok) return doErrorToResponse(marked);

  // Host creates the flock and registers its own device (token stored hashed).
  await upsertFlock(env, flockId, sealedMetaB64);
  await upsertDevice(env, {
    deviceId: hostDeviceId,
    flockId,
    pubKeyB64: info.hostPubKey,
    displayName: info.hostName,
    token: hostToken,
  });

  const response: PairFinishResponse = { flockId, devices: await listDevices(env, flockId) };
  return json(response);
}

async function pairGuestFinish(req: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(req);
  const nameplate = body ? asString(body.nameplate) : null;
  const flockId = body ? asString(body.flockId) : null;
  const guestDeviceId = body ? asString(body.guestDeviceId) : null;
  const guestPubKeyB64 = body ? asString(body.guestPubKeyB64) : null;
  const guestToken = body ? asString(body.guestToken) : null;
  const displayName = body ? asString(body.displayName) : null;
  if (
    !body ||
    !nameplate ||
    !flockId ||
    !guestDeviceId ||
    !guestPubKeyB64 ||
    !guestToken ||
    !displayName
  ) {
    return err(
      400,
      "bad_request",
      "nameplate, flockId, guestDeviceId, guestPubKeyB64, guestToken and displayName are required"
    );
  }
  if (!NAMEPLATE_RE.test(nameplate)) return err(400, "bad_request", "nameplate must be 3 digits");

  const info = await doJson<InfoResult>(await pairStub(env, nameplate), "info");
  if (!info.ok) return doErrorToResponse(info);
  if (info.expired) return err(410, "expired", "pairing room expired");
  if (!info.claimed || info.guestDeviceId !== guestDeviceId) {
    return err(401, "unauthorized", "nameplate not claimed by this guest");
  }
  if (info.flockId === null) return err(409, "conflict", "host has not finished pairing yet");
  if (info.flockId !== flockId) return err(409, "conflict", "flockId does not match the pairing room");
  if (!(await flockExists(env, flockId))) return err(404, "not_found", "flock not found");

  // Guest joins the same flock (token stored hashed). Prefer the identity the
  // guest presented at claim time.
  await upsertDevice(env, {
    deviceId: guestDeviceId,
    flockId,
    pubKeyB64: info.guestPubKey ?? guestPubKeyB64,
    displayName: info.guestName ?? displayName,
    token: guestToken,
  });

  const response: PairFinishResponse = { flockId, devices: await listDevices(env, flockId) };
  return json(response);
}

// ------------------------------------------------------------ flock admin ---

async function flockGet(req: Request, env: Env): Promise<Response> {
  const device = await authenticateRequest(req, env);
  if (!device) return err(401, "unauthorized", "device authentication failed");
  return json({
    devices: await listDevices(env, device.flock_id),
    vaults: await listVaults(env, device.flock_id),
  });
}

async function deviceApprove(req: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(req);
  const flockId = body ? asString(body.flockId) : null;
  const guestDeviceId = body ? asString(body.guestDeviceId) : null;
  const guestPubKeyB64 = body ? asString(body.guestPubKeyB64) : null;
  const guestToken = body ? asString(body.guestToken) : null;
  const displayName = body ? asString(body.displayName) : null;
  if (!body || !flockId || !guestDeviceId || !guestPubKeyB64 || !guestToken || !displayName) {
    return err(
      400,
      "bad_request",
      "flockId, guestDeviceId, guestPubKeyB64, guestToken and displayName are required"
    );
  }

  // Header credentials first; ApproveDeviceRequest body fields as fallback.
  const fallbackId = asString(body.approverDeviceId);
  const fallbackToken = asString(body.approverToken);
  const caller =
    (await authenticateRequest(req, env)) ??
    (fallbackId && fallbackToken ? await authenticateDevice(env, fallbackId, fallbackToken) : null);
  if (!caller) return err(401, "unauthorized", "device authentication failed");
  if (flockId !== caller.flock_id) return err(401, "unauthorized", "approver is not in this flock");

  const existingGuest = await getDevice(env, guestDeviceId);
  if (existingGuest && existingGuest.flock_id !== flockId) {
    return err(409, "conflict", "device is registered in another flock");
  }

  await upsertDevice(env, {
    deviceId: guestDeviceId,
    flockId,
    pubKeyB64: guestPubKeyB64,
    displayName,
    token: guestToken,
  });
  return json({ ok: true });
}

async function deviceRevoke(req: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(req);
  const targetId = body ? asString(body.deviceId) : null;
  if (!body || !targetId) return err(400, "bad_request", "deviceId is required");

  const caller = await authenticateRequest(req, env);
  if (!caller) return err(401, "unauthorized", "device authentication failed"); // includes revoked callers
  if (targetId === caller.device_id) return err(400, "bad_request", "cannot revoke yourself");

  const target = await getDevice(env, targetId);
  if (!target || target.flock_id !== caller.flock_id) {
    return err(404, "not_found", "device not found in this flock");
  }
  await env.DB.prepare("UPDATE devices SET revoked = 1 WHERE device_id = ?").bind(targetId).run();
  return json({ ok: true });
}

// --------------------------------------------------------- vault routes ----

async function vaultEnroll(req: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(req);
  const vaultId = body ? asString(body.vaultId) : null;
  const sealedMetaB64 = body ? asString(body.sealedMetaB64) : null;
  if (!body || !vaultId || !sealedMetaB64) {
    return err(400, "bad_request", "vaultId and sealedMetaB64 are required");
  }
  const device = await authenticateRequest(req, env);
  if (!device) return err(401, "unauthorized", "device authentication failed");

  // A vaultId is bound to the flock that first enrolled it. Re-enrolling from
  // another flock must not steal the vault (it would also fork the shared
  // VaultLog DO op log across flocks).
  const existing = await getVault(env, vaultId);
  if (existing && existing.flock_id !== device.flock_id) {
    return err(409, "conflict", "vault is enrolled in another flock");
  }

  await env.DB.prepare(
    `INSERT INTO vaults (vault_id, flock_id, sealed_meta, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(vault_id) DO UPDATE SET
       sealed_meta = excluded.sealed_meta
     WHERE vaults.flock_id = excluded.flock_id`
  )
    .bind(vaultId, device.flock_id, sealedMetaB64, Date.now())
    .run();

  const bound = await getVault(env, vaultId);
  if (!bound || bound.flock_id !== device.flock_id) {
    return err(409, "conflict", "vault is enrolled in another flock");
  }
  return json({ ok: true });
}

async function vaultList(req: Request, env: Env): Promise<Response> {
  const device = await authenticateRequest(req, env);
  if (!device) return err(401, "unauthorized", "device authentication failed");
  const vaults: VaultListItem[] = await listVaults(env, device.flock_id);
  return json(vaults);
}

/**
 * Resolves the vault and authenticates the caller: device must exist, be
 * unrevoked, and belong to the vault's flock.
 */
async function vaultContext(
  req: Request,
  env: Env,
  vaultId: string
): Promise<{ device: DeviceRow; vault: VaultRow } | Response> {
  const vault = await getVault(env, vaultId);
  if (!vault) return err(404, "not_found", "vault not found");
  const device = await authenticateRequest(req, env);
  if (!device) return err(401, "unauthorized", "device authentication failed");
  if (device.revoked !== 0) return err(401, "unauthorized", "device is revoked");
  if (device.flock_id !== vault.flock_id) {
    return err(401, "unauthorized", "device does not belong to this vault's flock");
  }
  return { device, vault };
}

async function vaultOpsPush(req: Request, env: Env, vaultId: string): Promise<Response> {
  const context = await vaultContext(req, env, vaultId);
  if (context instanceof Response) return context;
  const { device } = context;

  const body = await readJsonObject(req);
  const rawOps: unknown = body ? body.ops : null;
  if (!body || !Array.isArray(rawOps)) return err(400, "bad_request", "ops must be an array");

  const ops: SignedOp[] = [];
  for (const raw of rawOps) {
    if (raw === null || typeof raw !== "object") {
      return err(400, "bad_request", "each op must be an object");
    }
    const op = raw as SignedOp;
    if (
      typeof op.deviceId !== "string" ||
      typeof op.pathCipherB64 !== "string" ||
      typeof op.hlc !== "string" ||
      typeof op.sigB64 !== "string"
    ) {
      return err(400, "bad_request", "op is missing required string fields");
    }
    if (op.deviceId !== device.device_id) {
      return err(401, "unauthorized", "op deviceId does not match authenticated device");
    }
    // ECDSA P-256 / SHA-256 over canonicalOpMessage, key from D1 (SPKI).
    if (!(await verifyOpSignature(device.pub_key, op))) {
      return err(401, "unauthorized", "op signature verification failed");
    }
    ops.push(op);
  }

  const result = await doJson<VaultPushResult>(await vaultStub(env, vaultId), "push", { ops });
  if (!result.ok) return doErrorToResponse(result);

  const pushed: OpsPullResponse = {
    ops: ops.map((op, i) => ({ ...op, seq: result.seqs[i] })),
    head: result.head,
  };
  return json(pushed);
}

async function vaultOpsPull(
  req: Request,
  env: Env,
  vaultId: string,
  url: URL
): Promise<Response> {
  const context = await vaultContext(req, env, vaultId);
  if (context instanceof Response) return context;

  const afterParam = url.searchParams.get("after");
  let after = 0;
  if (afterParam !== null) {
    after = Number.parseInt(afterParam, 10);
    if (!Number.isFinite(after) || after < 0) {
      return err(400, "bad_request", "after must be a non-negative integer");
    }
  }

  const result = await doJson<VaultPullResult>(await vaultStub(env, vaultId), "pull", { after });
  if (!result.ok) return doErrorToResponse(result);

  const response: OpsPullResponse = { ops: result.ops, head: result.head };
  return json(response);
}

async function vaultMerkle(req: Request, env: Env, vaultId: string): Promise<Response> {
  const context = await vaultContext(req, env, vaultId);
  if (context instanceof Response) return context;

  const result = await doJson<VaultMerkleResult>(await vaultStub(env, vaultId), "merkle");
  if (!result.ok) return doErrorToResponse(result);

  const response: MerkleResponse = { root: result.root, head: result.head };
  return json(response);
}

// ---------------------------------------------------------------- blobs ----

async function blobPut(req: Request, env: Env, vaultId: string, blobHash: string): Promise<Response> {
  if (!BLOB_HASH_RE.test(blobHash)) return err(400, "bad_request", "invalid blobHash");
  const context = await vaultContext(req, env, vaultId);
  if (context instanceof Response) return context;
  const { vault } = context;

  const contentLength = Number.parseInt(req.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BLOB_BYTES) {
    return err(413, "too_large", "blob exceeds the 25MB limit");
  }
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_BLOB_BYTES) {
    return err(413, "too_large", "blob exceeds the 25MB limit");
  }

  await env.BLOBS.put(`${vault.flock_id}/${vaultId}/${blobHash}`, body, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return json({ ok: true });
}

async function blobGet(req: Request, env: Env, vaultId: string, blobHash: string): Promise<Response> {
  if (!BLOB_HASH_RE.test(blobHash)) return err(400, "bad_request", "invalid blobHash");
  const context = await vaultContext(req, env, vaultId);
  if (context instanceof Response) return context;
  const { vault } = context;

  const obj = await env.BLOBS.get(`${vault.flock_id}/${vaultId}/${blobHash}`);
  if (!obj) return err(404, "not_found", "blob not found");
  return new Response(obj.body, {
    headers: { ...CORS_HEADERS, "Content-Type": "application/octet-stream" },
  });
}
