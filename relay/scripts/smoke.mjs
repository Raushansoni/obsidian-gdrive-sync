// Flock relay local smoke test (Node 20+).
//
// Exercises the full protocol/HTTP.md v1 surface against a LOCAL wrangler dev
// worker (http://127.0.0.1:8787 by default). Never run against production.
//
//   node scripts/smoke.mjs
//
// What it does:
//   1. Applies the D1 schema locally (idempotent):
//        npx wrangler d1 execute flock --local --file=src/schema.sql
//   2. Reuses a worker already listening on the port, otherwise boots one via
//      `npx wrangler dev --port 8787` (killed again on exit).
//   3. Drives: pair start -> claim -> msg -> inbox -> finish -> guest-finish,
//      flock admin (approve/revoke), vault enroll, ops push/pull (real ECDSA
//      P-256 WebCrypto signatures), merkle root verification, blob put/get.
//
// Env:
//   SMOKE_BASE_URL  attach to an already-running worker (skip spawning).
//   SMOKE_PORT      port for a spawned dev server (default 8787).
//   SMOKE_SKIP_SCHEMA=1  skip the `wrangler d1 execute` schema step.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = dirname(SCRIPT_DIR);
const PORT = Number(process.env.SMOKE_PORT ?? 8787);
const BASE = process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const IS_WIN = process.platform === "win32";
const SPAWN_DEV = !process.env.SMOKE_BASE_URL;

// ------------------------------------------------------------------ utils ---

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
function utf8(s) {
  return new TextEncoder().encode(s);
}
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const results = [];
function check(name, fn) {
  results.push({ name, fn });
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function request(method, path, { body, token, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Device ${token.deviceId} ${token.token}`;
  let payload;
  if (raw !== undefined) {
    headers["Content-Type"] = "application/octet-stream";
    payload = raw;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text, bytes: new Uint8Array(buf), contentType: res.headers.get("content-type") ?? "" };
}

/** Mirrors protocol/op-canonical.ts canonicalOpMessage (sorted versionVector). */
function canonicalOpMessage(op) {
  const vv = Object.fromEntries(
    Object.keys(op.versionVector)
      .sort()
      .map((k) => [k, op.versionVector[k]])
  );
  return utf8(
    JSON.stringify({
      blobHash: op.blobHash,
      deviceId: op.deviceId,
      hlc: op.hlc,
      pathCipherB64: op.pathCipherB64,
      prevHash: op.prevHash,
      versionVector: vv,
    })
  );
}

/** Mirrors the plugin: deviceId = hex(sha256(SPKI pub)[0:16]). */
async function makeDevice(label) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  const pubKeyB64 = b64(spki);
  const deviceId = sha256Hex(spki).slice(0, 32);
  return {
    label,
    deviceId,
    pubKeyB64,
    token: { deviceId, token: randomHex(32) },
    priv: kp.privateKey,
  };
}

async function signOp(device, op) {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    device.priv,
    canonicalOpMessage(op)
  );
  return { ...op, sigB64: b64(new Uint8Array(sig)) };
}

// ------------------------------------------------------- process plumbing ---

function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(`${cmd} ${args.join(" ")}`, {
    cwd: RELAY_DIR,
    shell: true,
    encoding: "utf8",
    ...opts,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function applySchema() {
  console.log(`[smoke] applying local D1 schema (idempotent)…`);
  const r = runCapture("npx", ["wrangler", "d1", "execute", "flock", "--local", "--file=src/schema.sql"]);
  if (r.code !== 0) {
    console.warn(`[smoke] schema apply exited ${r.code}:\n${r.out}`);
    throw new Error("schema apply failed — run `npx wrangler d1 execute flock --local --file=src/schema.sql` manually");
  }
}

async function serverUp() {
  try {
    // Any HTTP response (even 401) proves a worker is listening.
    await fetch(`${BASE}/v1/flock`, { method: "GET" });
    return true;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await serverUp()) {
    console.log(`[smoke] reusing worker already listening at ${BASE}`);
    return null;
  }
  if (!SPAWN_DEV) throw new Error(`SMOKE_BASE_URL=${BASE} is not answering`);
  console.log(`[smoke] booting wrangler dev on port ${PORT}…`);
  const logFile = mkdtempSync(join(tmpdir(), "flock-smoke-"));
  const logPath = join(logFile, "wrangler-dev.log");
  const child = spawn(`npx wrangler dev --port ${PORT}`, {
    cwd: RELAY_DIR,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (d) => log.push(d));
  child.stderr.on("data", (d) => log.push(d));

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await serverUp()) return { child, logPath, log };
    if (child.exitCode !== null) {
      console.error(`[smoke] wrangler dev exited (code ${child.exitCode}):\n${log.join("")}`);
      throw new Error("wrangler dev failed to start");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`[smoke] wrangler dev not ready in 90s:\n${log.join("")}`);
  throw new Error("wrangler dev did not become ready");
}

function killTree(child) {
  if (!child) return;
  try {
    if (IS_WIN) {
      spawnSync(`taskkill /PID ${String(child.pid)} /T /F`, { shell: true });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* best effort */
  }
}

// ------------------------------------------------------------------ flow ---

async function runPairing(flockId, host, guest, { guestFinishes = true } = {}) {
  const start = await request("POST", "/v1/pair/start", {
    body: { hostDeviceId: host.deviceId, hostPubKeyB64: host.pubKeyB64, displayName: `host-${host.label}` },
  });
  assert(start.status === 200, `pair/start -> ${start.status} ${start.text}`);
  assert(/^\d{3}$/.test(start.json.nameplate), `nameplate not 3 digits: ${start.json.nameplate}`);
  const nameplate = start.json.nameplate;

  const claim = await request("POST", "/v1/pair/claim", {
    body: { nameplate, guestDeviceId: guest.deviceId, guestPubKeyB64: guest.pubKeyB64, displayName: `guest-${guest.label}` },
  });
  assert(claim.status === 200 && claim.json.ok === true, `pair/claim -> ${claim.status} ${claim.text}`);

  const claim2 = await request("POST", "/v1/pair/claim", {
    body: { nameplate, guestDeviceId: "other-guest", guestPubKeyB64: guest.pubKeyB64, displayName: "other" },
  });
  assert(claim2.status === 409 && claim2.json.code === "taken", `second claim should 409 taken -> ${claim2.status} ${claim2.text}`);

  const early = await request("POST", "/v1/pair/guest-finish", {
    body: {
      nameplate, flockId, guestDeviceId: guest.deviceId, guestPubKeyB64: guest.pubKeyB64,
      guestToken: guest.token.token, displayName: `guest-${guest.label}`,
    },
  });
  assert(early.status === 409 && early.json.code === "conflict", `guest-finish before host finish should 409 conflict -> ${early.status} ${early.text}`);

  const m1 = await request("POST", "/v1/pair/msg", {
    body: { nameplate, fromRole: "host", payloadB64: b64(utf8("opaque-pake-frame-1")) },
  });
  assert(m1.status === 200 && typeof m1.json.id === "number", `pair/msg host -> ${m1.status} ${m1.text}`);
  const m2 = await request("POST", "/v1/pair/msg", {
    body: { nameplate, fromRole: "guest", payloadB64: b64(utf8("opaque-pake-frame-2")) },
  });
  assert(m2.status === 200 && m2.json.id === m1.json.id + 1, `pair/msg guest -> ${m2.status} ${m2.text}`);

  const badMsg = await request("POST", "/v1/pair/msg", {
    body: { nameplate, fromRole: "wizard", payloadB64: b64(utf8("x")) },
  });
  assert(badMsg.status === 400, `pair/msg invalid role should 400 -> ${badMsg.status}`);

  const inbox = await request("GET", `/v1/pair/inbox?nameplate=${nameplate}`);
  assert(inbox.status === 200, `pair/inbox -> ${inbox.status} ${inbox.text}`);
  assert(inbox.json.claimed === true, "inbox should report claimed");
  assert(inbox.json.frames.length === 2, `inbox should have 2 frames, got ${inbox.json.frames.length}`);
  assert(inbox.json.frames[0].fromRole === "host" && inbox.json.frames[1].fromRole === "guest", "frames out of order");

  const badInbox = await request("GET", "/v1/pair/inbox?nameplate=12ab");
  assert(badInbox.status === 400, `inbox bad nameplate should 400 -> ${badInbox.status}`);

  const wrongHost = await request("POST", "/v1/pair/finish", {
    body: { nameplate, flockId, hostDeviceId: "not-the-host", hostToken: "x", sealedMetaB64: "x" },
  });
  assert(wrongHost.status === 401, `finish by non-host should 401 -> ${wrongHost.status} ${wrongHost.text}`);

  const finish = await request("POST", "/v1/pair/finish", {
    body: { nameplate, flockId, hostDeviceId: host.deviceId, hostToken: host.token.token, sealedMetaB64: b64(utf8(JSON.stringify({ v: 1 }))) },
  });
  assert(finish.status === 200 && finish.json.flockId === flockId, `pair/finish -> ${finish.status} ${finish.text}`);
  assert(Array.isArray(finish.json.devices) && finish.json.devices.some((d) => d.deviceId === host.deviceId), "host device missing after finish");

  if (guestFinishes) {
    const gf = await request("POST", "/v1/pair/guest-finish", {
      body: {
        nameplate, flockId, guestDeviceId: guest.deviceId, guestPubKeyB64: guest.pubKeyB64,
        guestToken: guest.token.token, displayName: `guest-${guest.label}`,
      },
    });
    assert(gf.status === 200 && gf.json.flockId === flockId, `guest-finish -> ${gf.status} ${gf.text}`);
    const ids = gf.json.devices.map((d) => d.deviceId);
    assert(ids.includes(host.deviceId) && ids.includes(guest.deviceId), `guest-finish devices should include host+guest: ${ids}`);
  }
  return nameplate;
}

async function main() {
  console.log(`[smoke] target: ${BASE}`);
  if (!process.env.SMOKE_SKIP_SCHEMA) await applySchema();

  const server = SPAWN_DEV ? await ensureServer() : null;

  try {
    const flockId = `smoke-flock-${randomHex(8)}`;
    const host = await makeDevice("host");
    const guest = await makeDevice("guest");
    const third = await makeDevice("third");

    // ---- pairing ------------------------------------------------------
    check("pair start → claim → msg → inbox → finish → guest-finish", () =>
      runPairing(flockId, host, guest)
    );

    // ---- flock admin ----------------------------------------------------
    check("GET /v1/flock with device auth lists 2 devices", async () => {
      const r = await request("GET", "/v1/flock", { token: host.token });
      assert(r.status === 200, `-> ${r.status} ${r.text}`);
      assert(r.json.devices.length === 2, `expected 2 devices, got ${r.json.devices.length}`);
      assert(r.json.vaults.length === 0, `expected 0 vaults, got ${r.json.vaults.length}`);
    });

    check("GET /v1/flock with bad token → 401", async () => {
      const r = await request("GET", "/v1/flock", { token: { deviceId: host.deviceId, token: "wrong" } });
      assert(r.status === 401 && r.json.code === "unauthorized", `-> ${r.status} ${r.text}`);
    });

    check("POST /v1/devices/approve upserts a later device", async () => {
      const r = await request("POST", "/v1/devices/approve", {
        token: host.token,
        body: {
          flockId,
          approverDeviceId: host.deviceId,
          approverToken: host.token.token,
          guestDeviceId: third.deviceId,
          guestPubKeyB64: third.pubKeyB64,
          guestToken: third.token.token,
          displayName: "third",
          sealedMetaB64: b64(utf8("{}")),
        },
      });
      assert(r.status === 200, `-> ${r.status} ${r.text}`);
      const flock = await request("GET", "/v1/flock", { token: host.token });
      assert(flock.json.devices.length === 3, `expected 3 devices after approve, got ${flock.json.devices.length}`);
      const approved = await request("GET", "/v1/flock", { token: third.token });
      assert(approved.status === 200, `approved device auth failed -> ${approved.status}`);
    });

    check("POST /v1/devices/revoke: cannot revoke self", async () => {
      const r = await request("POST", "/v1/devices/revoke", {
        token: host.token,
        body: { deviceId: host.deviceId },
      });
      assert(r.status === 400, `self-revoke should 400 -> ${r.status} ${r.text}`);
    });

    check("POST /v1/devices/revoke revokes guest; revoked auth → 401", async () => {
      const r = await request("POST", "/v1/devices/revoke", {
        token: host.token,
        body: { deviceId: guest.deviceId },
      });
      assert(r.status === 200, `-> ${r.status} ${r.text}`);
      const denied = await request("GET", "/v1/flock", { token: guest.token });
      assert(denied.status === 401, `revoked device should get 401 -> ${denied.status}`);
    });

    // ---- vaults ---------------------------------------------------------
    const vaultId = `smoke-vault-${randomHex(6)}`;
    const sealedMeta = b64(utf8(JSON.stringify({ name: "smoke", createdAt: Date.now() })));

    check("POST /v1/vaults enroll + GET /v1/vaults list", async () => {
      const r = await request("POST", "/v1/vaults", { token: host.token, body: { vaultId, sealedMetaB64: sealedMeta } });
      assert(r.status === 200, `enroll -> ${r.status} ${r.text}`);
      const list = await request("GET", "/v1/vaults", { token: host.token });
      assert(list.status === 200 && Array.isArray(list.json), `list -> ${list.status}`);
      const item = list.json.find((v) => v.vaultId === vaultId);
      assert(item && item.sealedMetaB64 === sealedMeta, "enrolled vault meta mismatch");
    });

    check("vault enroll from another flock → 409 conflict", async () => {
      // Mini second flock, then try to steal flock A's vaultId into it.
      const otherFlock = `smoke-flock-${randomHex(8)}`;
      const otherHost = await makeDevice("other-host");
      const otherGuest = await makeDevice("other-guest");
      await runPairing(otherFlock, otherHost, otherGuest, { guestFinishes: false });
      const r = await request("POST", "/v1/vaults", {
        token: otherHost.token,
        body: { vaultId, sealedMetaB64: b64(utf8("evil")) },
      });
      assert(r.status === 409 && r.json.code === "conflict", `cross-flock enroll should 409 -> ${r.status} ${r.text}`);
    });

    check("empty vault merkle root = sha256(JSON {}) with head 0", async () => {
      const r = await request("GET", `/v1/vaults/${vaultId}/merkle`, { token: host.token });
      assert(r.status === 200, `merkle -> ${r.status} ${r.text}`);
      const expected = sha256Hex(utf8(JSON.stringify(Object.fromEntries([]))));
      assert(r.json.root === expected, `empty merkle root ${r.json.root} != ${expected}`);
      assert(r.json.head === 0, `empty head should be 0, got ${r.json.head}`);
    });

    // ---- ops push/pull ----------------------------------------------------
    const pathA = b64(utf8("notes/aaa.txt"));
    const pathB = b64(utf8("notes/zzz.txt"));
    const blobPlain = utf8("smoke blob plaintext " + randomHex(16));

    const mkOp = async (device, pathCipherB64, blobHash, prevHash, n) => ({
      deviceId: device.deviceId,
      pathCipherB64,
      blobHash,
      prevHash,
      hlc: `${Date.now()}:${n}:${device.deviceId}`,
      versionVector: { [device.deviceId]: n },
    });

    let op1, op2, op3;
    check("POST ops: signed op pushes, seq assigned", async () => {
      op1 = await signOp(host, await mkOp(host, pathA, sha256Hex(blobPlain), null, 1));
      const r = await request("POST", `/v1/vaults/${vaultId}/ops`, { token: host.token, body: { ops: [op1] } });
      assert(r.status === 200, `push -> ${r.status} ${r.text}`);
      assert(r.json.ops[0].seq === 1 && r.json.head === 1, `seq/head: ${r.text}`);
    });

    check("POST ops: tampered signature → 401", async () => {
      const bad = { ...op1, sigB64: b64(new Uint8Array(64)) };
      const r = await request("POST", `/v1/vaults/${vaultId}/ops`, { token: host.token, body: { ops: [bad] } });
      assert(r.status === 401, `bad sig should 401 -> ${r.status} ${r.text}`);
    });

    check("POST ops: op deviceId != auth device → 401", async () => {
      const spoofed = { ...op1, deviceId: "someone-else" };
      const r = await request("POST", `/v1/vaults/${vaultId}/ops`, { token: host.token, body: { ops: [spoofed] } });
      assert(r.status === 401, `spoofed deviceId should 401 -> ${r.status} ${r.text}`);
    });

    check("POST ops: revoked device → 401", async () => {
      const op = await signOp(guest, await mkOp(guest, pathB, sha256Hex(blobPlain), null, 1));
      const r = await request("POST", `/v1/vaults/${vaultId}/ops`, { token: guest.token, body: { ops: [op] } });
      assert(r.status === 401, `revoked push should 401 -> ${r.status} ${r.text}`);
    });

    check("tombstone push (blobHash null) gets next seq", async () => {
      op2 = await signOp(host, await mkOp(host, pathA, null, sha256Hex(blobPlain), 2));
      const r = await request("POST", `/v1/vaults/${vaultId}/ops`, { token: host.token, body: { ops: [op2] } });
      assert(r.status === 200 && r.json.ops[0].seq === 2, `tombstone push -> ${r.status} ${r.text}`);
      op3 = await signOp(host, await mkOp(host, pathB, sha256Hex(blobPlain), null, 3));
      const r2 = await request("POST", `/v1/vaults/${vaultId}/ops`, { token: host.token, body: { ops: [op3] } });
      assert(r2.status === 200 && r2.json.ops[0].seq === 3, `live push -> ${r2.status} ${r2.text}`);
    });

    check("GET ops?after=0 returns both ops in seq order", async () => {
      const r = await request("GET", `/v1/vaults/${vaultId}/ops?after=0`, { token: host.token });
      assert(r.status === 200, `pull -> ${r.status} ${r.text}`);
      assert(r.json.ops.length === 3 && r.json.head === 3, `ops/head: ${r.text}`);
      assert(r.json.ops[0].seq === 1 && r.json.ops[2].seq === 3, `seq order: ${r.text}`);
      assert(r.json.ops[1].blobHash === null, `tombstone should round-trip as null: ${r.text}`);
    });

    check("GET ops?after=N resumes correctly", async () => {
      const r = await request("GET", `/v1/vaults/${vaultId}/ops?after=1`, { token: host.token });
      assert(r.status === 200 && r.json.ops.length === 2 && r.json.ops[0].seq === 2, `resume: ${r.text}`);
      const r0 = await request("GET", `/v1/vaults/${vaultId}/ops?after=3`, { token: host.token });
      assert(r0.json.ops.length === 0 && r0.json.head === 3, `after=head should be empty: ${r0.text}`);
    });

    check("merkle root matches locally computed canonical root", async () => {
      const r = await request("GET", `/v1/vaults/${vaultId}/merkle`, { token: host.token });
      assert(r.status === 200 && r.json.head === 3, `merkle -> ${r.status} ${r.text}`);
      // Latest seq per path_cipher wins, tombstone (null) included.
      const tips = { [pathA]: null, [pathB]: op3.blobHash };
      const canonical = JSON.stringify(Object.fromEntries(Object.keys(tips).sort().map((k) => [k, tips[k]])));
      const expected = sha256Hex(utf8(canonical));
      assert(r.json.root === expected, `merkle root ${r.json.root} != expected ${expected} for ${canonical}`);
    });

    // ---- blobs ------------------------------------------------------------
    check("PUT blob → GET blob round-trips bytes", async () => {
      const blobHash = sha256Hex(blobPlain);
      const put = await request("PUT", `/v1/vaults/${vaultId}/blobs/${blobHash}`, { token: host.token, raw: blobPlain });
      assert(put.status === 200, `put -> ${put.status} ${put.text}`);
      const got = await request("GET", `/v1/vaults/${vaultId}/blobs/${blobHash}`, { token: host.token });
      assert(got.status === 200, `get -> ${got.status} ${got.text}`);
      assert(Buffer.compare(Buffer.from(got.bytes), Buffer.from(blobPlain)) === 0, "blob bytes mismatch");
    });

    check("GET missing blob → 404; bad blobHash → 400", async () => {
      const missing = await request("GET", `/v1/vaults/${vaultId}/blobs/${"f".repeat(64)}`, { token: host.token });
      assert(missing.status === 404, `missing blob should 404 -> ${missing.status}`);
      const bad = await request("GET", `/v1/vaults/${vaultId}/blobs/bad%2Fhash`, { token: host.token });
      assert(bad.status === 400, `bad blobHash should 400 -> ${bad.status}`);
    });

    // ---- summary ----------------------------------------------------------
    let failed = 0;
    for (const { name, fn } of results) {
      try {
        await fn();
        console.log(`  ✓ ${name}`);
      } catch (e) {
        failed++;
        console.error(`  ✗ ${name}\n    ${e.message}`);
      }
    }
    console.log(`\n[smoke] ${results.length - failed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : ""}`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    if (server) killTree(server.child);
  }
}

main().catch((e) => {
  console.error(`[smoke] fatal: ${e.message}`);
  process.exitCode = 1;
});
