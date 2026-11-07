/**
 * Behavioral regressions for equal-head Merkle drift, skipped work, and false Synced.
 * Run: node scripts/test-sync-recovery.mjs [case-name-substring]
 * Safety batch only: node scripts/test-sync-recovery.mjs safety-
 * Only the Obsidian host and relay transport are faked. No real vault/network is used.
 */
import * as esbuild from "esbuild";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode")
  : path.join(os.tmpdir(), "opencode");
const VAULT_ID = "regression-test-vault";
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const BASE_URL = "https://sync-recovery.invalid";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const buffer = (bytes) => Uint8Array.from(bytes).buffer;
globalThis.crypto ??= webcrypto;

await mkdir(tempRoot, { recursive: true });
const tmp = await mkdtemp(path.join(tempRoot, "flock-sync-recovery-"));
let production;
let failed = 0;
let passed = 0;
let problems = [];
let timedOut = false;
const cases = [];
const test = (name, run) => cases.push({ name, run });
class SyncTimeout extends Error {}

// Accumulate assertions so a false status cannot hide a second failure in local bytes.
function equal(actual, expected, message) {
  try { assert.deepEqual(actual, expected, message); } catch (error) { problems.push(error.message); }
}
function ok(condition, message) { equal(Boolean(condition), true, message); }

/** Raw wire log, not a decrypted-path approximation of the relay. */
class TestRelay {
  ops = [];
  blobs = new Map();
  devices = new Map();
  blobFaults = new Map();
  rejectPushes = 0;
  rejectBlobPuts = 0;
  losePushResponses = 0;
  merkleFault = null;
  beforePush = null;
  afterMerkle = null;
  lastActivity = performance.now();

  async init() {
    this.peer = await production.generateDeviceKeys();
    this.devices.set(this.peer.deviceId, this.peer);
    this.meta = await production.sealJson(SECRET, { name: "Sync recovery test", createdAt: 1 });
    production.setRelayTransport((request) => this.request(request));
    return this;
  }

  append(op) {
    const stored = structuredClone({ ...op, seq: this.ops.length + 1 });
    this.ops.push(stored);
    return stored;
  }

  async remote(path, text, options = {}) {
    const peer = options.device ?? this.peer;
    const pathCipherB64 = options.pathCipherB64 ?? await production.sealDeterministic(SECRET, Buffer.from(path), VAULT_ID);
    const previous = [...this.ops].reverse().find((op) => op.pathCipherB64 === pathCipherB64);
    const blobHash = text === null ? null : digest(Buffer.from(text));
    if (text !== null) {
      const key = await production.hkdf(SECRET, `blob:${blobHash}`, 32);
      this.blobs.set(blobHash, Buffer.from(await production.seal(key, Buffer.from(text)), "base64"));
    }
    const unsigned = {
      deviceId: peer.deviceId,
      pathCipherB64,
      blobHash,
      prevHash: previous?.blobHash ?? null,
      hlc: `1700000000000:${this.ops.length + 1}:${peer.deviceId}`,
      versionVector: options.versionVector ?? { [peer.deviceId]: this.ops.length + 1 },
    };
    const sigB64 = await production.signBytes(peer.ecdsaPriv, production.canonicalOpMessage(unsigned));
    return this.append({ ...unsigned, sigB64 });
  }

  root() {
    const tips = new Map();
    for (const op of this.ops) tips.set(op.pathCipherB64, op.blobHash); // null tombstones remain.
    const canonical = JSON.stringify(Object.fromEntries([...tips].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
    return digest(Buffer.from(canonical)); // Independent Node SHA-256, not localMerkleRoot.
  }

  async failBlobOnce(hash, mode) {
    if (mode === "fetch") this.blobFaults.set(hash, { status: 503 });
    if (mode === "decrypt") {
      const corrupted = Buffer.from(this.blobs.get(hash));
      corrupted[corrupted.length - 1] ^= 1; // Real AES-GCM authentication must reject this.
      this.blobFaults.set(hash, { bytes: corrupted });
    }
    if (mode === "checksum") {
      const key = await production.hkdf(SECRET, `blob:${hash}`, 32);
      const wrong = await production.seal(key, Buffer.from("valid encryption, wrong plaintext\n"));
      this.blobFaults.set(hash, { bytes: Buffer.from(wrong, "base64") });
    }
  }

  response(status, json, bytes) {
    const text = json === undefined ? "" : JSON.stringify(json);
    return {
      status,
      headers: { "content-type": bytes ? "application/octet-stream" : "application/json" },
      text,
      json: json === undefined ? null : structuredClone(json),
      arrayBuffer: buffer(bytes ?? Buffer.from(text)),
    };
  }

  async request(request) {
    this.lastActivity = performance.now();
    const url = new URL(request.url);
    assert.equal(url.origin, BASE_URL, "The harness must not contact a real relay");
    const auth = /^Device (\S+) (\S+)$/.exec(request.headers.Authorization ?? "");
    assert.ok(auth && this.devices.has(auth[1]), "Use an actual registered device identity");
    const json = (status, body) => this.response(status, body);
    if (url.pathname === "/v1/vaults" && request.method === "GET") {
      return json(200, [{ vaultId: VAULT_ID, sealedMetaB64: this.meta, createdAt: 1 }]);
    }
    if (url.pathname === "/v1/vaults" && request.method === "POST") {
      assert.equal(JSON.parse(request.body).vaultId, VAULT_ID);
      return json(200, { ok: true });
    }
    const prefix = `/v1/vaults/${VAULT_ID}/`;
    assert.ok(url.pathname.startsWith(prefix), `Unexpected relay route: ${url.pathname}`);
    const route = url.pathname.slice(prefix.length);
    if (route === "ops" && request.method === "GET") {
      const after = Number(url.searchParams.get("after"));
      assert.ok(Number.isInteger(after) && after >= 0, "Pull cursor must be a nonnegative integer");
      return json(200, { ops: this.ops.filter((op) => op.seq > after).slice(0, 200), head: this.ops.length });
    }
    if (route === "ops" && request.method === "POST") {
      if (this.rejectPushes > 0) {
        this.rejectPushes--;
        return json(503, { error: "Temporary opsPush failure", code: "internal" });
      }
      const { ops } = JSON.parse(request.body);
      assert.ok(Array.isArray(ops));
      for (const op of ops) {
        assert.equal(op.deviceId, auth[1], "Signed op must match the authenticated device");
        const valid = await production.verifyBytes(
          this.devices.get(auth[1]).ecdsaPub, production.canonicalOpMessage(op), op.sigB64
        );
        assert.ok(valid, "The engine must produce a real valid ECDSA signature");
      }
      const interleave = this.beforePush;
      this.beforePush = null;
      if (interleave) await interleave(); // Peer work is not included in the push response ops.
      const accepted = ops.map((op) => this.append(op));
      if (this.losePushResponses > 0) {
        this.losePushResponses--;
        throw new Error("Relay committed ops, but the response was lost");
      }
      return json(200, { ops: accepted, head: this.ops.length }); // Complete OpsPullResponse.
    }
    if (route === "merkle" && request.method === "GET") {
      if (this.merkleFault === "unavailable") return json(503, { error: "Merkle verification unavailable", code: "internal" });
      const response = json(200, { root: this.merkleFault === "bad-root" ? "f".repeat(64) : this.root(), head: this.ops.length });
      if (this.afterMerkle) await this.afterMerkle();
      return response;
    }
    if (route.startsWith("blobs/")) {
      const hash = decodeURIComponent(route.slice("blobs/".length));
      if (request.method === "PUT") {
        assert.ok(request.body instanceof ArrayBuffer);
        if (this.rejectBlobPuts > 0) {
          this.rejectBlobPuts--;
          return json(503, { error: "Temporary blob upload failure", code: "internal" });
        }
        this.blobs.set(hash, Buffer.from(request.body));
        return json(200, { ok: true });
      }
      if (request.method === "GET") {
        const fault = this.blobFaults.get(hash);
        this.blobFaults.delete(hash);
        if (fault?.status) return json(fault.status, { error: "Temporary blob fetch failure", code: "internal" });
        const bytes = fault?.bytes ?? this.blobs.get(hash);
        return bytes ? this.response(200, undefined, bytes) : json(404, { error: "Blob not found", code: "not_found" });
      }
    }
    throw new Error(`Unsupported test relay request: ${request.method} ${url.pathname}`);
  }
}

async function device(relay, initial = {}, stored = {}) {
  const app = new production.App(initial);
  const identity = new production.IdentityStore(app);
  await identity.ensureDevice();
  await identity.setFlock("regression-test-flock", SECRET, `test-token-${identity.deviceId}`);
  relay.devices.set(identity.deviceId, identity.keys);
  const client = new production.RelayHttp(BASE_URL);
  client.setAuth(identity.deviceId, identity.deviceToken);
  let liveData = production.sanitizePluginData({
    ...structuredClone(production.DEFAULT_DATA), ...structuredClone(stored), relayUrl: BASE_URL,
    vaultId: VAULT_ID, enrolled: true, autoSync: false,
  });
  let persisted = structuredClone(liveData);
  let engine;
  let status;
  let lastStatusChange = performance.now();
  const snapshots = [];

  async function saveData() {
    // Match src/main.ts savePluginData: REPLACE the live object before persistence.
    liveData = production.sanitizePluginData(liveData);
    persisted = structuredClone(liveData);
    await Promise.resolve();
    engine.updateFromData(liveData);
  }

  const start = () => {
    status = new production.StatusMachine();
    status.hydrate(() => liveData);
    status.onChange = () => {
      lastStatusChange = performance.now();
      snapshots.push({
        state: status.state,
        lastSyncAt: status.lastSyncAt,
        relayUrl: liveData.relayUrl,
        files: new Map([...app.vault.files].map(([path]) => [path, app.vault.text(path)])),
      });
    };
    engine = new production.FlockSyncEngine(app, identity, client, status, {
      getData: () => liveData,
      saveData,
    });
  };
  start();
  app.vault.on("create", (file) => engine.onLocalCreateOrModify(file));
  app.vault.on("modify", (file) => engine.onLocalCreateOrModify(file));
  app.vault.on("delete", (file) => engine.onLocalDelete(file));

  async function runAndSettle(action) {
    let timer;
    try {
      await Promise.race([
        (async () => {
          await action();
          // Use real timers. Let the engine's queued 250 ms pagination rerun finish.
          while (status.state === "syncing" || performance.now() - Math.max(relay.lastActivity, lastStatusChange) < 350) {
            await delay(20);
          }
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new SyncTimeout("Engine did not settle within 6 seconds")), 6000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  return {
    vault: app.vault,
    workspace: app.workspace,
    snapshots,
    get status() { return status; },
    get relayUrl() { return liveData.relayUrl; },
    async setRelayUrl(value) {
      const url = value.trim() || production.DEFAULT_DATA.relayUrl;
      liveData.relayUrl = url;
      client.setBase(url);
      await saveData();
    },
    sync: () => runAndSettle(() => engine.sync()),
    resync: () => runAndSettle(() => engine.resyncFromRelay()),
    restart() {
      liveData = production.sanitizePluginData(structuredClone(persisted));
      start();
    },
  };
}

test("control: real encrypted note, allowed config, and tombstone sync", async () => {
  const relay = await new TestRelay().init();
  await relay.remote("Note.md", "hello from peer\n");
  await relay.remote(".obsidian/app.json", '{"vimMode":true}\n');
  const removed = await relay.remote("Removed.md", "obsolete\n");
  await relay.remote("Removed.md", null, { pathCipherB64: removed.pathCipherB64 });
  const local = await device(relay);
  await local.sync();
  equal(local.vault.text("Note.md"), "hello from peer\n", "Allowed note reaches the vault");
  equal(local.vault.text(".obsidian/app.json"), '{"vimMode":true}\n', "Allowed config reaches the adapter");
  equal(local.vault.text("Removed.md"), null, "Latest tombstone deletes the file");
  equal(local.status.state, "synced", "Successful real apply reports Synced");
  const logLength = local.status.snapshotLog().length;
  await local.sync();
  ok(!local.status.snapshotLog().slice(logLength).some(({ msg }) => /merkle mismatch/i.test(msg)), "Control has no repeated drift");
});

// Break caught: dropping excluded remote tips from Merkle accounting creates endless false drift.
test("ignored: excluded relay entries do not cause recurring equal-head drift", async () => {
  const relay = await new TestRelay().init();
  await relay.remote("Notes/allowed.md", "allowed note from phone\n");
  await relay.remote(".obsidian/app.json", '{"vimMode":true}\n');
  await relay.remote(".obsidian/workspace.json", "remote layout must stay remote\n");
  await relay.remote(".obsidian/hotkeys.json", "disallowed remote config\n");
  await relay.remote("private/secret.md", "ignored remote note\n");
  const old = await relay.remote("Retired.md", "retired\n");
  await relay.remote("Retired.md", null, { pathCipherB64: old.pathCipherB64 });
  const local = await device(relay, {
    ".obsidian/workspace.json": "local layout\n",
    ".obsidian/hotkeys.json": "local hotkeys\n",
    "private/secret.md": "local ignored content\n",
  }, { ignorePatterns: `${production.DEFAULT_DATA.ignorePatterns}\nprivate` });
  await local.sync();
  const logLength = local.status.snapshotLog().length;
  await local.sync();
  await local.sync();
  equal(local.vault.text("Notes/allowed.md"), "allowed note from phone\n", "Ignored entries do not block the allowed note");
  equal(local.vault.text(".obsidian/app.json"), '{"vimMode":true}\n', "Allowed config still syncs");
  equal(local.vault.text(".obsidian/workspace.json"), "local layout\n", "Ignored workspace bytes stay local");
  equal(local.vault.text(".obsidian/hotkeys.json"), "local hotkeys\n", "Disallowed config bytes stay local");
  equal(local.vault.text("private/secret.md"), "local ignored content\n", "Custom ignored bytes stay local");
  equal(local.vault.text("Retired.md"), null, "Tombstone remains applied");
  equal(local.status.state, "synced", "Fully accounted-for exclusions can reach Synced");
  const recurring = local.status.snapshotLog().slice(logLength).filter(({ msg }) => /merkle mismatch/i.test(msg));
  equal(recurring.map(({ msg }) => msg), [], "Idle retries must not keep displaying equal-head Merkle mismatch");
});

for (const mode of ["fetch", "decrypt", "checksum"]) {
  // Break caught: acknowledging a failed apply skips these bytes forever, yet shows Synced.
  test(`blob-${mode}: failed apply stays unsynced and retries on the next sync`, async () => {
    const relay = await new TestRelay().init();
    const first = await relay.remote("Notes/retry.md", "eventually available\n");
    await relay.remote("Notes/later.md", "operation after the failed blob\n");
    await relay.failBlobOnce(first.blobHash, mode);
    const local = await device(relay);
    await local.sync();
    ok(!local.snapshots.some(({ state, files }) => state === "synced" && files.get("Notes/retry.md") !== "eventually available\n"),
      "Visible Synced must not precede successful application of the failed blob");
    if (local.vault.text("Notes/retry.md") !== "eventually available\n") {
      ok(local.status.state !== "synced", "An unresolved blob failure must remain visible, not Synced");
      equal(local.status.lastSyncAt, null, "An unresolved apply must not record a successful sync time");
    }
    await local.sync();
    equal(local.vault.text("Notes/retry.md"), "eventually available\n", "Next sync must retry the failed operation rather than skip its bytes");
    equal(local.vault.text("Notes/later.md"), "operation after the failed blob\n", "Retry also retains the later operation");
    equal(local.status.state, "synced", "Synced becomes valid once both real files are present");
  });
}

// Break caught: advancing a local tip before opsPush acknowledges it makes the edit unretryable.
test("push-retry: a rejected push retries the actual edit without another modify event", async () => {
  const relay = await new TestRelay().init();
  const writer = await device(relay, { "Note.md": "acknowledged baseline\n" });
  await writer.sync();
  const reader = await device(relay);
  await reader.sync();
  equal(reader.vault.text("Note.md"), "acknowledged baseline\n", "A second engine observes the acknowledged starting version");
  writer.vault.edit("Note.md", "edit survives failed push\n");
  relay.rejectPushes = 1;
  await writer.sync();
  ok(writer.status.state !== "synced", "Rejected push is not Synced");
  equal(writer.vault.text("Note.md"), "edit survives failed push\n", "Rejected push retains local edit bytes");
  await reader.sync();
  equal(reader.vault.text("Note.md"), "acknowledged baseline\n", "Rejected operation has not reached a peer");
  await writer.sync(); // No further edit/event: the unacknowledged work must survive.
  await reader.sync();
  equal(writer.vault.text("Note.md"), "edit survives failed push\n", "Retry must not overwrite the local edit");
  equal(reader.vault.text("Note.md"), "edit survives failed push\n", "A real peer must receive the retried edit, not merely its uploaded blob");
  equal(writer.status.state, "synced", "Writer may report Synced only after the edit can reach its peer");
});

// Break caught: assigning the push head to the pull cursor skips unseen pages and peer ops.
test("pagination-race: 201 remote ops and a peer op during push all reach local files", async () => {
  const relay = await new TestRelay().init();
  for (let i = 0; i < 201; i++) {
    await relay.remote(`Remote/${String(i).padStart(3, "0")}.md`, `remote-${i}\n`);
  }
  const local = await device(relay, { "Local.md": "desktop edit\n" });
  relay.beforePush = () => relay.remote("Peer arrived.md", "peer op between pull and push\n");
  await local.sync();
  await local.sync();
  const missingOrWrong = [];
  for (let i = 0; i < 201; i++) {
    const path = `Remote/${String(i).padStart(3, "0")}.md`;
    if (local.vault.text(path) !== `remote-${i}\n`) missingOrWrong.push(path);
  }
  equal(missingOrWrong, [], "All pages, including operation 201, must be materialized");
  equal(local.vault.text("Peer arrived.md"), "peer op between pull and push\n", "Push head must not acknowledge an unseen peer operation");
  equal(local.vault.text("Local.md"), "desktop edit\n", "Pagination retains the outgoing local edit");
  ok(!local.snapshots.some(({ state, files }) => state === "synced" &&
    (files.get("Remote/200.md") !== "remote-200\n" || files.get("Peer arrived.md") !== "peer op between pull and push\n")),
  "No visible Synced while a page or interleaved peer op is missing");
  const reader = await device(relay);
  await reader.sync();
  equal(reader.vault.text("Local.md"), "desktop edit\n", "An independent engine receives the outgoing edit");
  equal(local.status.state, "synced", "Complete pagination eventually reaches Synced");
});

for (const metadata of ["missing", "corrupted"]) {
  // Break caught: trusting equal cursors hides missing metadata; blind replay destroys divergent bytes.
  test(`equal-cursor-${metadata}: recover remote files without overwriting divergent local bytes`, async () => {
    const relay = await new TestRelay().init();
    await relay.remote("Diverged.md", "relay version worth preserving\n");
    await relay.remote("Restored.md", "remote-only note must return\n");
    const old = await relay.remote("Gone.md", "obsolete\n");
    await relay.remote("Gone.md", null, { pathCipherB64: old.pathCipherB64 });
    const pathTips = metadata === "missing" ? {} : {
      "Diverged.md": { hash: "0".repeat(64), vv: { [relay.peer.deviceId]: 1 } },
      "Restored.md": { hash: "1".repeat(64), vv: { [relay.peer.deviceId]: 2 } },
      "Gone.md": { hash: null, vv: { [relay.peer.deviceId]: 4 } },
    };
    const local = await device(relay, {
      "Diverged.md": "unsent desktop changes\n",
      "Local only.md": "never uploaded local note\n",
    }, { localCursor: 4, pathTips, lastSyncAt: 1700000000000 });
    await local.sync();
    await local.sync();
    await local.sync();
    equal(local.vault.text("Restored.md"), "remote-only note must return\n", "Equal head/cursor is not proof that the remote note was applied");
    equal(local.vault.text("Diverged.md"), "unsent desktop changes\n", "Recovery must preserve divergent bytes at the original local path");
    equal(local.vault.text("Local only.md"), "never uploaded local note\n", "Recovery retains local-only changes");
    equal(local.vault.text("Gone.md"), null, "Recovery honors the latest tombstone");
    ok(local.vault.getFiles().some((file) => local.vault.text(file.path) === "relay version worth preserving\n"),
      "A divergent remote version must survive as a real file, not be silently replaced");
    ok(!local.snapshots.some(({ state, files }) => state === "synced" &&
      (files.get("Restored.md") !== "remote-only note must return\n" || files.get("Diverged.md") !== "unsent desktop changes\n")),
    "Recovery must not display Synced while missing remote data or losing local changes");
    ok(["synced", "conflict"].includes(local.status.state), "Bounded recovery ends healthy or with a real visible conflict");
    const logLength = local.status.snapshotLog().length;
    local.restart();
    await local.sync();
    equal(local.vault.text("Restored.md"), "remote-only note must return\n", "Recovered remote bytes survive persisted restart");
    equal(local.vault.text("Diverged.md"), "unsent desktop changes\n", "Divergent local bytes survive persisted restart");
    ok(!local.status.snapshotLog().slice(logLength).some(({ msg }) => /merkle mismatch/i.test(msg)),
      "Equal-head mismatch must not recur after persisted recovery");
  });
}

// Break caught: relying only on modify events silently loses edits made while the plugin was closed.
test("safety-offline-edit: an eventless edit of a tracked file reaches a peer after restart", async () => {
  const relay = await new TestRelay().init();
  const writer = await device(relay, { "Tracked.md": "previously acknowledged\n" });
  await writer.sync();
  const reader = await device(relay);
  await reader.sync();
  equal(reader.vault.text("Tracked.md"), "previously acknowledged\n", "Peer starts from a real acknowledged version");
  writer.vault.store("Tracked.md", "edited while plugin was closed\n"); // Deliberately no Obsidian event.
  writer.restart();
  await writer.sync();
  await reader.sync();
  equal(writer.vault.text("Tracked.md"), "edited while plugin was closed\n", "Restart keeps the eventless local edit");
  equal(reader.vault.text("Tracked.md"), "edited while plugin was closed\n", "Persisted tracking must not hide the offline edit from a peer");
  equal(writer.status.state, "synced", "Offline edit can finish a verified sync");
});

// Break caught: treating a lost acknowledgment as a new concurrent edit creates duplicate conflicts or loses bytes.
test("safety-lost-push-response: accepted work converges after retry and persisted restart", async () => {
  const relay = await new TestRelay().init();
  const writer = await device(relay, { "Note.md": "before uncertain acknowledgment\n" });
  await writer.sync();
  const reader = await device(relay);
  await reader.sync();
  writer.vault.edit("Note.md", "committed despite lost response\n");
  relay.losePushResponses = 1;
  await writer.sync();
  equal(writer.vault.text("Note.md"), "committed despite lost response\n", "Lost response must not roll back the local edit");
  await reader.sync();
  equal(reader.vault.text("Note.md"), "committed despite lost response\n", "The relay really committed before dropping its response");
  writer.restart(); // Reload while the acknowledgment is still uncertain, not after a successful retry.
  await writer.sync();
  await writer.sync();
  await reader.sync();
  await writer.sync();
  for (const [name, local] of [["writer", writer], ["reader", reader]]) {
    const tree = local.vault.getFiles().map((file) => [file.path, local.vault.text(file.path)]).sort();
    equal(tree, [["Note.md", "committed despite lost response\n"]], `${name} converges without losing the edit or manufacturing conflict copies`);
    equal(local.status.state, "synced", `${name} eventually verifies the committed edit`);
  }
});

for (const tracking of ["tracked", "untracked"]) {
  // Break caught: a tombstone deletes unsent local bytes merely because its vector dominates old or absent metadata.
  test(`safety-tombstone-${tracking}: remote deletion preserves divergent local content`, async () => {
    const relay = await new TestRelay().init();
    const old = await relay.remote("Draft.md", "old peer draft\n");
    const local = await device(relay, tracking === "untracked" ? { "Draft.md": "unsent local draft\n" } : {});
    if (tracking === "tracked") {
      await local.sync();
      equal(local.vault.text("Draft.md"), "old peer draft\n", "Tracked fixture first applies the old version");
      local.vault.edit("Draft.md", "unsent local draft\n");
    }
    await relay.remote("Draft.md", null, { pathCipherB64: old.pathCipherB64 });
    await local.sync();
    await local.sync();
    ok(local.vault.getFiles().some((file) => local.vault.text(file.path) === "unsent local draft\n"),
      "Remote deletion must keep unsent bytes in the original file or a real recoverable conflict file");
    local.restart();
    await local.sync();
    ok(local.vault.getFiles().some((file) => local.vault.text(file.path) === "unsent local draft\n"),
      "Preserved draft remains recoverable after restart and replay");
  });
}

// Break caught: interpreting a file tombstone as permission to recursively delete a local folder loses unrelated children.
test("safety-tombstone-folder: a remote file tombstone cannot delete a local directory tree", async () => {
  const relay = await new TestRelay().init();
  await relay.remote("Folder", null);
  const local = await device(relay, {
    "Folder/child.md": "child must survive\n",
    "Folder/nested/grandchild.md": "nested child must survive\n",
  });
  await local.sync();
  await local.sync();
  equal(local.vault.text("Folder/child.md"), "child must survive\n", "File tombstone must not erase folder children");
  equal(local.vault.text("Folder/nested/grandchild.md"), "nested child must survive\n", "File tombstone must not erase nested children");
  ok(local.vault.getAbstractFileByPath("Folder"), "The original local folder remains accessible");
});

for (const history of ["missing-history", "available-history"]) {
  // Break caught: replaying superseded file operations can overwrite divergence or fail forever on a dead historical blob.
  test(`safety-latest-resync-${history}: obsolete log entries cannot destroy local divergence or block latest state`, async () => {
    const relay = await new TestRelay().init();
    const obsolete = await relay.remote("Changed.md", "obsolete remote bytes\n");
    await relay.remote("Changed.md", "current remote version\n", { pathCipherB64: obsolete.pathCipherB64 });
    const deleted = await relay.remote("Deleted.md", "obsolete deleted bytes\n");
    await relay.remote("Deleted.md", null, { pathCipherB64: deleted.pathCipherB64 });
    if (history === "missing-history") {
      relay.blobs.delete(obsolete.blobHash);
      relay.blobs.delete(deleted.blobHash);
    }
    const local = await device(relay, { "Changed.md": "local divergence before resync\n" }, {
      localCursor: 4,
      pathTips: { "Changed.md": { hash: obsolete.blobHash, vv: { [relay.peer.deviceId]: 1 } } },
    });
    await local.resync(); // Public recovery entry point; saves replace live PluginData.
    await local.sync();
    equal(local.vault.text("Changed.md"), "local divergence before resync\n", "Resync must retain divergent bytes at the original path");
    ok(local.vault.getFiles().some((file) => local.vault.text(file.path) === "current remote version\n"),
      "Latest remote version is materialized without sacrificing the local version");
    equal(local.vault.text("Deleted.md"), null, "Latest tombstone wins over the obsolete historical version");
    equal(local.vault.writes.filter(({ text }) => ["obsolete remote bytes\n", "obsolete deleted bytes\n"].includes(text)), [],
      "Recovery must not transiently write superseded content into the vault");
    ok(["synced", "conflict"].includes(local.status.state), "Unavailable obsolete blobs must not prevent latest-state recovery from settling");
  });
}

for (const fault of ["bad-root", "unavailable"]) {
  // Break caught: swallowing an unverifiable or persistently wrong Merkle result falsely certifies success.
  test(`safety-verification-${fault}: unverifiable equal-head state never reports a successful sync`, async () => {
    const relay = await new TestRelay().init();
    await relay.remote("Stable.md", "known good local bytes\n");
    const local = await device(relay);
    await local.sync();
    equal(local.status.state, "synced", "Verification fixture starts healthy");
    const successAt = local.status.lastSyncAt;
    const snapshotStart = local.snapshots.length;
    relay.merkleFault = fault;
    await local.sync();
    await local.sync();
    ok(local.status.state !== "synced", "Persistent verification failure must not display Synced");
    equal(local.status.lastSyncAt, successAt, "Unverified retries must not advance the last successful sync time");
    ok(local.snapshots.slice(snapshotStart).every(({ state, lastSyncAt }) => state !== "synced" && lastSyncAt === successAt),
      "No transient healthy status or success timestamp may certify a failed verification");
    equal(local.vault.text("Stable.md"), "known good local bytes\n", "Bounded verification retries preserve the real local file");
  });
}

// Break caught: acknowledging a failed Obsidian write skips the operation without ever materializing its bytes.
test("safety-vault-write: transient host write failure remains unsynced and retries", async () => {
  const relay = await new TestRelay().init();
  await relay.remote("Write.md", "must reach the actual vault\n");
  const local = await device(relay);
  local.vault.failNext("write", "Write.md");
  await local.sync();
  ok(!local.snapshots.some(({ state, files }) => state === "synced" && files.get("Write.md") !== "must reach the actual vault\n"),
    "Failed vault write must not display Synced before bytes exist");
  if (local.vault.text("Write.md") !== "must reach the actual vault\n") {
    ok(local.status.state !== "synced", "Unresolved host write failure stays visible");
    equal(local.status.lastSyncAt, null, "Unresolved host write failure cannot record a successful sync");
  }
  await local.sync();
  equal(local.vault.text("Write.md"), "must reach the actual vault\n", "Next sync retries the real failed write");
  equal(local.status.state, "synced", "Successful retry can verify the actual file");
});

// Break caught: swallowing a failed Obsidian delete acknowledges a tombstone or resurrects the stale file.
test("safety-vault-delete: transient host delete failure is retried instead of acknowledged or resurrected", async () => {
  const relay = await new TestRelay().init();
  const old = await relay.remote("Delete.md", "unchanged file to delete\n");
  const local = await device(relay);
  await local.sync();
  equal(local.vault.text("Delete.md"), "unchanged file to delete\n", "Delete fixture first applies a real tracked file");
  const successAt = local.status.lastSyncAt;
  const snapshotStart = local.snapshots.length;
  await relay.remote("Delete.md", null, { pathCipherB64: old.pathCipherB64 });
  local.vault.failNext("delete", "Delete.md");
  await local.sync();
  ok(!local.snapshots.slice(snapshotStart).some(({ state, files }) => state === "synced" && files.has("Delete.md")),
    "A file that survived its failed delete cannot be reported as Synced");
  if (local.vault.text("Delete.md") !== null) {
    ok(local.status.state !== "synced", "Unresolved delete stays unsynced");
    equal(local.status.lastSyncAt, successAt, "Unresolved delete cannot advance the success timestamp");
  }
  await local.sync();
  equal(local.vault.text("Delete.md"), null, "Next sync must actually apply the tombstone, not upload the stale bytes again");
  equal(local.status.state, "synced", "A completed real delete can reach Synced");
});

for (const phase of ["upload", "push"]) {
  // Break caught: caching config mtime/size or advancing its tip before acknowledgment silently loses a settings edit.
  test(`safety-config-${phase}: failed config changes retry with a warm stat cache and after restart`, async () => {
    const relay = await new TestRelay().init();
    const configPath = ".obsidian/app.json";
    const writer = await device(relay, { [configPath]: '{"setting":"baseline"}\n' });
    await writer.sync();
    const reader = await device(relay);
    await reader.sync();
    equal(reader.vault.text(configPath), '{"setting":"baseline"}\n', "Peer starts from acknowledged config bytes");
    const rejectNext = () => { if (phase === "upload") relay.rejectBlobPuts = 1; else relay.rejectPushes = 1; };
    writer.vault.store(configPath, '{"setting":"warm-cache edit"}\n'); // Config has no vault modify event.
    rejectNext();
    await writer.sync();
    ok(writer.status.state !== "synced", "Failed config transfer must stay unsynced");
    equal(writer.vault.text(configPath), '{"setting":"warm-cache edit"}\n', "Failed transfer retains local settings");
    await writer.sync();
    await reader.sync();
    equal(reader.vault.text(configPath), '{"setting":"warm-cache edit"}\n', "Warm configStatCache must not suppress the required retry");
    writer.vault.store(configPath, '{"setting":"restart edit"}\n');
    rejectNext();
    await writer.sync();
    ok(writer.status.state !== "synced", "Failed pre-restart config transfer stays unsynced");
    writer.restart();
    await writer.sync();
    await reader.sync();
    equal(writer.vault.text(configPath), '{"setting":"restart edit"}\n', "Persisted restart keeps the local settings edit");
    equal(reader.vault.text(configPath), '{"setting":"restart edit"}\n', "Unacknowledged config edit reaches a real peer after restart");
    equal(writer.status.state, "synced", "Config retry eventually verifies the settings bytes");
  });
}

// Break caught: merging unseen concurrent knowledge without retaining its bytes silently loses a version.
test("safety-concurrent-recovery: latest-state recovery retains causally concurrent remote versions", async () => {
  const relay = await new TestRelay().init();
  const other = await production.generateDeviceKeys();
  await relay.remote("Concurrent.md", "independent phone edit\n", {
    versionVector: { [relay.peer.deviceId]: 1 },
  });
  await relay.remote("Concurrent.md", "independent desktop edit\n", {
    device: other, versionVector: { [other.deviceId]: 1 },
  });
  const local = await device(relay);
  await local.sync();
  const contents = local.vault.getFiles().map((file) => local.vault.text(file.path));
  ok(contents.includes("independent phone edit\n"), "Recovery must not forget an earlier non-dominated remote version");
  ok(contents.includes("independent desktop edit\n"), "Recovery retains the latest concurrent remote version too");
  local.restart();
  await local.sync();
  const restored = local.vault.getFiles().map((file) => local.vault.text(file.path));
  ok(restored.includes("independent phone edit\n") && restored.includes("independent desktop edit\n"),
    "Both concurrent versions survive persisted restart");
});

// Break caught: accepting our push must not hide a same-path peer operation inserted before it.
test("safety-concurrent-push: a same-path peer edit between pull and push stays recoverable", async () => {
  const relay = await new TestRelay().init();
  const first = await relay.remote("Concurrent.md", "shared baseline\n");
  const local = await device(relay);
  await local.sync();
  local.vault.edit("Concurrent.md", "unsent desktop edit\n");
  relay.beforePush = () => relay.remote("Concurrent.md", "concurrent phone edit\n", { pathCipherB64: first.pathCipherB64 });
  await local.sync();
  await local.sync();
  equal(local.vault.text("Concurrent.md"), "unsent desktop edit\n", "Concurrent peer push cannot replace unsent local bytes");
  ok(local.vault.getFiles().some((file) => local.vault.text(file.path) === "concurrent phone edit\n"),
    "The interleaved same-path peer version remains a real recoverable file");
});

// Break caught: re-encrypting an old randomized path invents a different Merkle key and causes permanent false drift.
test("safety-opaque-path: exact randomized encrypted path key verifies without recurring drift", async () => {
  const relay = await new TestRelay().init();
  const rawCipher = await production.seal(SECRET, Buffer.from("Opaque.md"), VAULT_ID);
  await relay.remote("Opaque.md", "legacy opaque path content\n", { pathCipherB64: rawCipher });
  const local = await device(relay);
  await local.sync();
  const logLength = local.status.snapshotLog().length;
  await local.sync();
  await local.sync();
  local.restart();
  await local.sync();
  equal(local.vault.text("Opaque.md"), "legacy opaque path content\n", "Opaque wire key still decrypts into the correct real file");
  equal(local.status.state, "synced", "The original opaque key can be fully accounted for");
  equal(local.status.snapshotLog().slice(logLength).filter(({ msg }) => /merkle mismatch/i.test(msg)).map(({ msg }) => msg), [],
    "Idle sync and persisted restart must not recreate false drift by changing the encrypted key");
});

// Break caught: normalizing attacker-controlled absolute or traversal paths before validation writes outside the vault or aliases local files.
test("safety-unsafe-paths: reject traversal and absolute writes without any external mutation", async () => {
  const relay = await new TestRelay().init();
  await relay.remote("Safe.md", "safe remote note\n");
  for (const path of ["../outside.md", "Folder/../../outside.md", "/Keep.md", "C:\\outside.md", "\\\\server\\share\\outside.md"]) {
    await relay.remote(path, `UNSAFE PAYLOAD ${path}\n`);
  }
  const local = await device(relay, { "Keep.md": "local sentinel must not be aliased\n" });
  await local.sync();
  equal(local.vault.text("Safe.md"), "safe remote note\n", "A valid op still reaches its intended vault file");
  equal(local.vault.text("Keep.md"), "local sentinel must not be aliased\n", "An absolute path must not be converted into an overwrite of a local relative path");
  equal(local.vault.externalMutations, [], "No traversal, drive-absolute, or UNC mutation may reach even the virtual external filesystem");
  equal(local.vault.writes.filter(({ text }) => text.startsWith("UNSAFE PAYLOAD")), [],
    "Rejected paths must not transiently materialize attacker bytes under any normalized alias");
  equal(local.vault.getFiles().map((file) => [file.path, local.vault.text(file.path)]).sort(), [
    ["Keep.md", "local sentinel must not be aliased\n"],
    ["Safe.md", "safe remote note\n"],
  ], "Only the original local file and the valid remote file remain in the vault");
});

// Break caught: treating a debounced requestSave as an awaited disk flush lets a dominating op erase dirty editor bytes.
test("review-editor-delayed-save: await the immediate editor save before applying a dominating remote edit", async () => {
  const relay = await new TestRelay().init();
  const old = await relay.remote("Editor.md", "tracked disk O\n");
  const local = await device(relay);
  await local.sync();
  const view = {
    file: local.vault.getAbstractFileByPath("Editor.md"),
    text: "dirty editor L\n",
    dirty: true,
    deferredSave: null,
    requestSave() { this.deferredSave = () => this.save(); }, // Queued 2-second debounce, NOT a flush.
    async save() {
      if (!this.dirty) return;
      await delay(20);
      local.vault.edit(this.file.path, this.text);
      this.dirty = false;
      this.deferredSave = null;
    },
  };
  local.workspace.leaves.push({ view });
  await relay.remote("Editor.md", "dominating relay R\n", { pathCipherB64: old.pathCipherB64 });
  const snapshotStart = local.snapshots.length;
  await local.sync();
  const contents = local.vault.getFiles().map((file) => local.vault.text(file.path));
  ok(contents.includes("dirty editor L\n"), "Dirty editor L must survive in an actual vault file, not only in view memory");
  ok(contents.includes("dominating relay R\n"), "Dominating relay R must also survive in an actual vault file");
  ok(!local.snapshots.slice(snapshotStart).some(({ state, files }) => state === "synced" && ![...files.values()].includes("dirty editor L\n")),
    "No premature Synced before the delayed immediate save materializes L");
});

// Break caught: swallowing or ignoring a rejected editor save certifies remote replacement of still-unsaved local work.
test("review-editor-rejected-save: failed editor flush cannot overwrite disk or advance sync success", async () => {
  const relay = await new TestRelay().init();
  const old = await relay.remote("Editor.md", "tracked disk O\n");
  const local = await device(relay);
  await local.sync();
  const successAt = local.status.lastSyncAt;
  const view = {
    file: local.vault.getAbstractFileByPath("Editor.md"),
    text: "dirty editor L\n",
    dirty: true,
    deferredSave: null,
    requestSave() { this.deferredSave = () => this.save(); },
    save() {
      const rejected = Promise.reject(new Error("Editor disk save rejected"));
      rejected.catch(() => {}); // An ignored promise must fail assertions, not crash the Node runner.
      return rejected;
    },
  };
  local.workspace.leaves.push({ view });
  await relay.remote("Editor.md", "dominating relay R\n", { pathCipherB64: old.pathCipherB64 });
  const snapshotStart = local.snapshots.length;
  await local.sync();
  equal(local.vault.text("Editor.md"), "tracked disk O\n", "A failed editor flush must preserve the previously stored disk version");
  equal(view.text, "dirty editor L\n", "A failed flush preserves the dirty editor version");
  ok(view.dirty, "Failed editor save cannot mark unsaved work clean");
  ok(local.status.state !== "synced", "Rejected editor save must remain visibly unsynced");
  equal(local.status.lastSyncAt, successAt, "Rejected editor save cannot advance the success timestamp");
  ok(local.snapshots.slice(snapshotStart).every(({ state, lastSyncAt }) => state !== "synced" && lastSyncAt === successAt),
    "No transient successful certification over a rejected editor save");
});

// Break caught: certifying relay A after settings switch the live URL/base to B presents stale verification as current success.
test("review-relay-url-switch: changing relay after final verification cannot certify stale relay state", async () => {
  const relay = await new TestRelay().init();
  await relay.remote("Stable.md", "stable local bytes\n");
  const local = await device(relay);
  await local.sync();
  const successAt = local.status.lastSyncAt;
  const snapshotStart = local.snapshots.length;
  const changedUrl = "https://switched-sync-recovery.invalid";
  let verifications = 0;
  relay.afterMerkle = () => {
    // A healthy no-change pass verifies before its first scan and again before its final scan.
    if (++verifications === 2) local.vault.beforeNextRead = () => local.setRelayUrl(changedUrl);
  };
  await local.sync();
  equal(local.relayUrl, changedUrl, "The final-read barrier must apply the real settings URL/base mutation and save replacement");
  equal(local.vault.text("Stable.md"), "stable local bytes\n", "A relay settings race retains local bytes");
  ok(local.status.state !== "synced", "Verification of A must not display Synced after switching to B");
  equal(local.status.lastSyncAt, successAt, "Relay switch after verification cannot advance the success timestamp");
  ok(!local.snapshots.slice(snapshotStart).some(({ state, relayUrl, lastSyncAt }) => relayUrl === changedUrl &&
    (state === "synced" || lastSyncAt !== successAt)), "No stale Synced or success timestamp may be emitted under the new live relay URL");
});

// Break caught: trusting only config mtime/size drops equal-length edits made by tools that preserve timestamps.
test("review-config-same-stat: same-session config edit with unchanged mtime and size reaches its peer", async () => {
  const relay = await new TestRelay().init();
  const configPath = ".obsidian/app.json";
  const writer = await device(relay, { [configPath]: '{"mode":"old"}\n' });
  await writer.sync();
  const reader = await device(relay);
  await reader.sync();
  equal(reader.vault.text(configPath), '{"mode":"old"}\n', "Peer starts from the acknowledged config version O");
  const oldStat = await writer.vault.adapter.stat(configPath);
  const file = writer.vault.store(configPath, '{"mode":"new"}\n'); // Config has no watcher event.
  file.stat.mtime = oldStat.mtime;
  file.stat.size = oldStat.size; // Equal-length content, with actual host stat preserved.
  await writer.sync();
  await reader.sync();
  equal(writer.vault.text(configPath), '{"mode":"new"}\n', "Same-stat edit L remains on local disk");
  equal(reader.vault.text(configPath), '{"mode":"new"}\n', "A warm stat cache cannot suppress the real same-stat config change L");
});

try {
  const outfile = path.join(tmp, "production.mjs");
  await esbuild.build({
    absWorkingDir: root,
    stdin: {
      contents: `
        export { FlockSyncEngine } from "./src/sync/engine.ts";
        export { StatusMachine } from "./src/status/machine.ts";
        export { sanitizePluginData, DEFAULT_DATA } from "./src/plugin-data.ts";
        export { IdentityStore } from "./src/identity.ts";
        export { RelayHttp } from "./src/relay/client.ts";
        export { seal, sealDeterministic, sealJson } from "./src/crypto/box.ts";
        export { hkdf } from "./src/crypto/hkdf.ts";
        export { generateDeviceKeys, signBytes, verifyBytes } from "./src/crypto/p256.ts";
        export { canonicalOpMessage } from "./src/crypto/op-canonical.ts";
        export { App, setRelayTransport } from "./scripts/test-sync-recovery-host.mjs";
      `,
      resolveDir: root,
      sourcefile: "sync-recovery-entry.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    alias: { obsidian: path.join(root, "scripts/test-sync-recovery-host.mjs") },
    logLevel: "silent",
  });
  production = await import(pathToFileURL(outfile).href);
  const selected = cases.filter(({ name }) => !process.argv[2] || name.includes(process.argv[2]));
  assert.ok(selected.length, `No cases match ${JSON.stringify(process.argv[2])}`);
  for (const { name, run } of selected) {
    problems = [];
    let setupError = null;
    try { await run(); } catch (error) { setupError = error; }
    if (setupError || problems.length) {
      failed++;
      console.error(`${setupError ? "ERROR" : "FAIL"} ${name}`);
      if (setupError) console.error(setupError.stack);
      for (const problem of problems) console.error(`  ${problem.replace(/\n/g, "\n  ")}`);
    } else {
      passed++;
      console.log(`ok  ${name}`);
    }
    production.setRelayTransport(null);
    if (setupError instanceof SyncTimeout) {
      timedOut = true;
      break; // Do not let an unbounded old engine run against another case's transport.
    }
  }
} finally {
  await rm(tmp, { recursive: true, force: true }); // Only the directory created by this run.
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
if (timedOut) process.exit(1); // Stop runaway production retries after owned temp cleanup.
