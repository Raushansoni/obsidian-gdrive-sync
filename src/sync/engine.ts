import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import type { PathTip, PluginData } from "../plugin-data";
import type { OpsPullResponse, SignedOp } from "../protocol";
import { MAX_BLOB_BYTES } from "../protocol";
import { seal, sealDeterministic, sealJson, open, openJson } from "../crypto/box";
import { b64ToBytes, bytesToB64, fromUtf8, utf8 } from "../crypto/bytes";
import { hkdf } from "../crypto/hkdf";
import {
  bumpVv,
  dominates,
  packHlc,
  parseHlc,
  recvHlc,
  tickHlc,
} from "../crypto/hlc";
import { canonicalOpMessage } from "../crypto/op-canonical";
import { signBytes } from "../crypto/p256";
import { sha256Hex } from "../util/hash";
import { basename, dirname, normalizeVaultPath } from "../util/paths";
import { isIgnored, parseIgnorePatterns } from "./ignore";
import { isConfigPathAllowed } from "./config-dir";
import { mergeContent } from "./content-merge";
import { covers, isHash, isSyncPath, pathTipsHash, relayRoot, validateHead, validatePull } from "./relay-state";
import {
  namesMatch,
  pickRichestVault,
  pickVaultToLink,
} from "./pick-vault";
import type { IdentityStore } from "../identity";
import { RelayError, type RelayHttp } from "../relay/client";
import type { StatusMachine } from "../status/machine";
import type { VaultListItem } from "../protocol";

const WATCH_DEBOUNCE_MS = 1200;
const QUEUED_RERUN_MS = 250;
const MAX_CATCH_UP_PASSES = 3;
const FULL_SCAN_INTERVAL_MS = 5 * 60 * 1000;

interface OpCtx {
  vaultId: string;
  secret: Uint8Array;
  deviceId: string;
  ecdsaPriv: CryptoKey;
  relay: RelayHttp;
  scope: string;
  assertCurrent(): void;
}

interface SyncProgress {
  applied: number;
  pushed: number;
  conflicts: number;
  rebuilt: boolean;
}

interface PreparedOp {
  path: string;
  op: SignedOp;
  revision: number;
}

class CatchUpNeeded extends Error {}
class RebuildNeeded extends Error {}
class ContextChanged extends Error {}
class MissingBlob extends Error {}

/**
 * FlockSyncEngine — end-to-end encrypted vault sync over the Flock relay.
 *
 * Model: every local/remote change is an immutable signed op in a per-vault
 * log. Op paths are AES-GCM sealed with the flock secret (aad = vaultId).
 * File contents are sealed with a per-blob key derived via HKDF from the
 * plaintext's sha256 (`blob:<hash>`), so identical content dedupes on the
 * relay and integrity is verifiable after decryption.
 *
 * Merge supported content from a known common base. Preserve both versions
 * when their edits cannot be merged, then publish joined causal knowledge.
 *
 * Note on `document.hidden`: sync() never early-returns for hidden windows —
 * mobile/background sync relies on the plugin calling sync() on
 * visibilitychange and from the interval timer, so an explicit call must
 * always go through.
 */
export class FlockSyncEngine {
  private app: App;
  private identity: IdentityStore;
  private relay: RelayHttp;
  private status: StatusMachine;
  private io: { getData(): PluginData; saveData(): Promise<void> };

  /** One in-flight sync; extra triggers queue exactly one rerun (old engine pattern). */
  private running = false;
  private queued = false;
  private queuedFullScan = false;
  private lastFullScanAt: number | null = null;
  private lastConfigScanAt: number | null = null;
  private verifiedHead: { scope: string; cursor: number; state: string } | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  private deletingRemotePaths = new Set<string>();
  private pendingCanvasReloads = new Set<string>();

  private pendingLocal = new Set<string>();
  private pendingDeletes = new Set<string>();
  private explicitDeletes = new Set<string>();
  private pathRevisions = new Map<string, number>();
  private recoveryRequested = false;
  private activeContext: OpCtx | null = null;
  private pendingRenames: Array<{ oldPath: string; newPath: string }> = [];

  private ignoreRaw = "";
  private ignorePatterns: string[] = [];

  constructor(
    app: App,
    identity: IdentityStore,
    relay: RelayHttp,
    status: StatusMachine,
    io: { getData(): PluginData; saveData(): Promise<void> }
  ) {
    this.app = app;
    this.identity = identity;
    this.relay = relay;
    this.status = status;
    this.io = io;
    this.refreshIgnore(this.io.getData());
  }

  /** Called whenever the plugin persists data — refresh cached settings. */
  updateFromData(data: PluginData): void {
    this.refreshIgnore(data);
  }

  // ------------------------------------------------------------------ watch

  onLocalCreateOrModify(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    const path = normalizeVaultPath(file.path);
    if (this.isConfigPath(path)) return; // config files are scanned, not evented
    if (this.shouldIgnore(path)) return;
    this.markLocalChange(path);
    this.pendingLocal.add(path);
    this.pendingDeletes.delete(path);
    this.explicitDeletes.delete(path);
    this.scheduleSync();
  }

  onLocalDelete(file: TAbstractFile): void {
    const path = normalizeVaultPath(file.path);
    if (this.deletingRemotePaths.has(path)) return;
    if (this.isConfigPath(path)) return;
    if (this.shouldIgnore(path)) return;
    if (file instanceof TFolder) {
      // Preserve explicit intent even if a metadata rebuild is queued next.
      for (const child of Object.keys(this.io.getData().pathTips)) {
        if (!child.startsWith(path + "/")) continue;
        this.markLocalChange(child);
        this.explicitDeletes.add(child);
        this.pendingDeletes.add(child);
      }
      this.scheduleSync();
      return;
    }
    this.markLocalChange(path);
    this.explicitDeletes.add(path);
    this.pendingLocal.delete(path);
    this.pendingDeletes.add(path);
    this.scheduleSync();
  }

  onLocalRename(file: TAbstractFile, oldPath: string): void {
    const from = normalizeVaultPath(oldPath);
    const to = normalizeVaultPath(file.path);
    if (this.isConfigPath(from) || this.isConfigPath(to)) return;
    if (this.shouldIgnore(from) && this.shouldIgnore(to)) return;
    if (file instanceof TFolder) {
      // Folder rename cascades to contained files.
      for (const f of this.app.vault.getFiles()) {
        const p = normalizeVaultPath(f.path);
        if (!p.startsWith(to + "/")) continue;
        const oldChild = from + p.slice(to.length);
        if (this.shouldIgnore(oldChild) && this.shouldIgnore(p)) continue;
        this.pendingRenames.push({ oldPath: oldChild, newPath: p });
        this.markLocalChange(oldChild);
        this.markLocalChange(p);
        this.explicitDeletes.add(oldChild);
        this.pendingLocal.add(p);
        this.pendingDeletes.delete(p);
      }
      this.scheduleSync();
      return;
    }
    if (!(file instanceof TFile)) return;
    this.pendingRenames.push({ oldPath: from, newPath: to });
    this.markLocalChange(from);
    this.markLocalChange(to);
    this.explicitDeletes.add(from);
    this.pendingLocal.add(to);
    this.pendingDeletes.delete(to);
    this.scheduleSync();
  }

  private scheduleSync(delayMs = WATCH_DEBOUNCE_MS): void {
    if (!this.io.getData().autoSync) {
      if (!this.running && this.status.state !== "error" && this.status.state !== "paused") {
        this.status.set("paused", "Auto-sync is off");
      }
      return;
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.sync({ full: false });
    }, delayMs);
  }

  // ------------------------------------------------------------------ link

  private markLocalChange(path: string): void {
    this.pathRevisions.set(path, (this.pathRevisions.get(path) ?? 0) + 1);
  }

  /** Enroll this vault with the relay under the paired flock. */
  async linkVault(): Promise<void> {
    const data = this.io.getData();
    const secret = this.identity.flockSecret;
    if (!this.identity.hasFlock() || !secret) {
      throw new Error("Pair a device first");
    }
    const vaultId = await this.resolveSharedVaultId();
    const switched = data.enrolled && !!data.vaultId && data.vaultId !== vaultId;
    if (switched) {
      await this.adoptVault(
        vaultId,
        `Joined the shared "${this.app.vault.getName()}" vault so notes can move between devices`
      );
      this.scheduleSync(300);
      return;
    }
    data.vaultId = vaultId;
    const sealedMetaB64 = await sealJson(secret, {
      name: this.app.vault.getName(),
      createdAt: Date.now(),
    });
    await this.relay.vaultEnroll({ vaultId, sealedMetaB64 });
    data.enrolled = true;
    this.status.note(`Vault linked — ${this.app.vault.getName()}`);
    this.status.set("waiting", "Vault linked — syncing…");
    await this.io.saveData();
    this.scheduleSync(300);
  }

  /**
   * If this flock already has a vault with our name (or only one vault),
   * join that log instead of minting a second UUID.
   */
  private async resolveSharedVaultId(ctx?: OpCtx): Promise<string> {
    const data = this.io.getData();
    const secret = ctx?.secret ?? this.identity.flockSecret;
    const relay = ctx?.relay ?? this.relay;
    const localName = this.app.vault.getName();
    if (!secret) return data.vaultId || crypto.randomUUID();

    let list: VaultListItem[] = [];
    try {
      list = await relay.vaultList();
    } catch {
      ctx?.assertCurrent();
      list = [];
    }
    const named = [];
    for (const item of list) {
      named.push({
        vaultId: item.vaultId,
        name: await decodeVaultName(secret, item.sealedMetaB64),
        createdAt: item.createdAt,
      });
    }
    const sameName = named.filter((v) => namesMatch(v.name, localName));
    if (sameName.length > 1) {
      const heads: Array<{ vaultId: string; head: number }> = [];
      for (const v of sameName) {
        try {
          const m = await relay.merkle(v.vaultId);
          heads.push({ vaultId: v.vaultId, head: typeof m.head === "number" ? m.head : 0 });
        } catch {
          ctx?.assertCurrent();
          heads.push({ vaultId: v.vaultId, head: 0 });
        }
      }
      if (heads.some((h) => h.head > 0)) {
        return pickRichestVault(heads) ?? sameName[0].vaultId;
      }
      if (data.vaultId && sameName.some((v) => v.vaultId === data.vaultId)) return data.vaultId;
    }
    return pickVaultToLink(named, localName, data.vaultId) ?? data.vaultId ?? crypto.randomUUID();
  }

  /** Move this device onto an existing flock vault and replay its log from seq 0. */
  async adoptVault(vaultId: string, reason: string): Promise<void> {
    if (this.running) throw new Error("Sync is running — join the vault after it finishes");
    await this.switchVault(vaultId, reason);
  }

  private async switchVault(vaultId: string, reason: string, ctx?: OpCtx): Promise<void> {
    const secret = ctx?.secret ?? this.identity.flockSecret;
    if (!secret) throw new Error("Pair a device first");
    const sealedMetaB64 = await sealJson(secret, {
      name: this.app.vault.getName(),
      createdAt: Date.now(),
    });
    ctx?.assertCurrent();
    await (ctx?.relay ?? this.relay).vaultEnroll({ vaultId, sealedMetaB64 });
    ctx?.assertCurrent();
    const data = this.io.getData();
    data.vaultId = vaultId;
    data.enrolled = true;
    data.relayState = null;
    if (ctx) this.activeContext = await this.opCtx();
    this.status.note(reason);
    await this.checkpoint();
  }

  /** Queue a read-only metadata rebuild; never clear state under an active sync. */
  async resyncFromRelay(): Promise<void> {
    const data = this.io.getData();
    if (!this.identity.hasFlock() || !data.enrolled || !data.vaultId) {
      throw new Error("Pair and link this vault first");
    }
    this.recoveryRequested = true;
    this.status.note("Resync from relay — rebuilding metadata, preserving local notes");
    if (!this.running) this.status.set("waiting", "Resyncing…");
    await this.sync();
  }

  async listNamedVaults(): Promise<
    Array<{ vaultId: string; name: string | null; current: boolean; canonical: boolean }>
  > {
    const secret = this.identity.flockSecret;
    const current = this.io.getData().vaultId;
    if (!secret) return [];
    let list: VaultListItem[] = [];
    try {
      list = await this.relay.vaultList();
    } catch {
      return [];
    }
    const out: Array<{ vaultId: string; name: string | null; current: boolean; canonical: boolean }> =
      [];
    for (const item of list) {
      out.push({
        vaultId: item.vaultId,
        name: await decodeVaultName(secret, item.sealedMetaB64),
        current: item.vaultId === current,
        canonical: false,
      });
    }
    const groups = new Map<string, typeof out>();
    for (const v of out) {
      const key = (v.name ?? "").trim().toLowerCase() || v.vaultId;
      const g = groups.get(key) ?? [];
      g.push(v);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      if (g.length === 1) {
        g[0].canonical = true;
        continue;
      }
      const heads: Array<{ vaultId: string; head: number }> = [];
      for (const v of g) {
        try {
          const m = await this.relay.merkle(v.vaultId);
          heads.push({ vaultId: v.vaultId, head: typeof m.head === "number" ? m.head : 0 });
        } catch {
          heads.push({ vaultId: v.vaultId, head: 0 });
        }
      }
      if (heads.some((h) => h.head > 0)) {
        const id = pickRichestVault(heads);
        const row = out.find((v) => v.vaultId === id);
        if (row) row.canonical = true;
      } else {
        const enrolled = g.find((v) => v.current) ?? g[0];
        enrolled.canonical = true;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ sync

  async sync({ full = true }: { full?: boolean } = {}): Promise<void> {
    if (this.running) {
      this.queued = true;
      this.queuedFullScan ||= full;
      return;
    }
    const data = this.io.getData();
    this.refreshIgnore(data);

    if (!this.identity.hasFlock() || !this.identity.flockSecret) {
      this.status.set("waiting", "Pair a device first");
      return;
    }
    if (!data.enrolled || !data.vaultId) {
      this.status.set("waiting", "Link this vault in settings");
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.status.set("waiting", "Offline — will sync when back online");
      return;
    }
    this.running = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    const forceRecovery = this.recoveryRequested;
    this.recoveryRequested = false;
    const fullScan = full || forceRecovery || this.lastFullScanAt === null ||
      Date.now() - this.lastFullScanAt >= FULL_SCAN_INTERVAL_MS;
    const configScan = fullScan || this.lastConfigScanAt === null ||
      Date.now() - this.lastConfigScanAt >= data.syncIntervalSeconds * 1000;
    const queuedCount =
      this.pendingLocal.size + this.pendingDeletes.size + this.pendingRenames.length;
    this.status.set("syncing", "Syncing…", queuedCount);

    const progress: SyncProgress = { applied: 0, pushed: 0, conflicts: 0, rebuilt: false };
    let completed = false;
    const previousSyncAt = this.status.lastSyncAt;

    try {
      let ctx = await this.opCtx();
      if (!ctx) throw new Error("Missing device identity");
      this.activeContext = ctx;
      ctx.assertCurrent();
      const sharedId = fullScan ? await this.resolveSharedVaultId(ctx) : ctx.vaultId;
      ctx.assertCurrent();
      if (this.io.getData().vaultId && sharedId !== this.io.getData().vaultId) {
        await this.switchVault(
          sharedId,
          `Joined the shared "${this.app.vault.getName()}" vault so notes can move between devices`, ctx
        );
        ctx = this.activeContext!;
      }
      // Verify metadata BEFORE deriving any local deletion from it.
      await this.ensureVerified(ctx, progress, forceRecovery, fullScan);
      await this.scanLocalChanges(fullScan || progress.rebuilt, configScan);
      for (let pass = 0; pass < MAX_CATCH_UP_PASSES; pass++) {
        const pushed = progress.pushed;
        const rebuilt = progress.rebuilt;
        await this.pushLocalChanges(ctx, progress);
        if (progress.pushed !== pushed) await this.ensureVerified(ctx, progress);
        await this.scanLocalChanges(!rebuilt && progress.rebuilt);
        if (!this.pendingLocal.size && !this.pendingDeletes.size && !this.pendingRenames.length) {
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
          completed = true;
          break;
        }
      }
      if (!completed) throw new CatchUpNeeded("Local changes arrived during sync — catch-up is pending");
      if (this.io.getData().relayState?.policy !== this.applicationPolicy) {
        throw new CatchUpNeeded("Sync settings changed — reconciliation is pending");
      }

      this.io.getData().lastError = null;
      ctx.assertCurrent();
      if (progress.conflicts > 0) {
        this.status.set(
          "conflict",
          `${progress.conflicts} conflict file${progress.conflicts === 1 ? "" : "s"}`,
          progress.conflicts
        );
      } else {
        this.status.set("synced", "Synced", 0);
      }
      this.status.note(
        `Sync ok — pushed ${progress.pushed}, applied ${progress.applied}` +
          (progress.conflicts > 0 ? `, ${progress.conflicts} conflict(s)` : "")
      );
      await this.checkpoint();
      if (fullScan || progress.rebuilt) this.lastFullScanAt = Date.now();
      if (configScan || progress.rebuilt) this.lastConfigScanAt = Date.now();
    } catch (e) {
      this.lastFullScanAt = null;
      try { this.activeContext?.assertCurrent(); } catch (changed) { e = changed; }
      if (e instanceof ContextChanged) {
        // Do not save A's projection as verified metadata for B. Keep local
        // bytes/tips for conservative reconstruction under the next context.
        this.io.getData().relayState = null;
        this.io.getData().lastSyncAt = previousSyncAt;
        this.status.lastSyncAt = previousSyncAt;
        this.activeContext = null;
      }
      const msg = e instanceof Error ? e.message : String(e);
      completed = false;
      if (e instanceof CatchUpNeeded) {
        this.status.note(msg);
        this.status.set("waiting", msg);
      } else {
        this.io.getData().lastError = msg;
        this.status.note(`Error: ${msg}`);
        this.status.set("error", msg);
      }
      try {
        await this.checkpoint();
      } catch {
        /* keep the failure visible via status */
      }
    } finally {
      this.activeContext = null;
      this.running = false;
      const rerun = this.queued && (completed || this.recoveryRequested);
      const rerunFull = this.queuedFullScan;
      this.queued = false;
      this.queuedFullScan = false;
      if (rerun) {
        setTimeout(() => {
          void this.sync({ full: rerunFull });
        }, QUEUED_RERUN_MS);
      }
    }
  }

  // ------------------------------------------------------------- internals

  /** saveData may replace PluginData. Never retain its object across a checkpoint. */
  private async checkpoint(): Promise<void> {
    this.assertRunContext();
    const state = this.io.getData().relayState;
    if (state) {
      const hash = await pathTipsHash(this.io.getData().pathTips);
      this.assertRunContext();
      const live = this.io.getData().relayState;
      if (live) live.pathTipsHash = hash;
    }
    await this.io.saveData();
    this.assertRunContext();
  }

  private assertRunContext(): void {
    this.activeContext?.assertCurrent();
  }

  private async ensureVerified(ctx: OpCtx, progress: SyncProgress, force = false, refresh = false): Promise<void> {
    ctx.assertCurrent();
    const data = this.io.getData();
    if (force || !data.relayState || data.relayState.cursor !== data.localCursor ||
      data.relayState.context !== ctx.scope ||
      data.relayState.policy !== this.applicationPolicy ||
      data.relayState.pathTipsHash !== await pathTipsHash(data.pathTips)) {
      await this.rebuildRelayState(ctx, progress);
    }
    for (let pass = 0; pass < MAX_CATCH_UP_PASSES; pass++) {
      let head: number;
      try {
        head = await this.drainPull(ctx, progress);
      } catch (error) {
        if (!(error instanceof RebuildNeeded) || progress.rebuilt) throw error;
        await this.rebuildRelayState(ctx, progress);
        continue;
      }
      const cursor = this.io.getData().localCursor;
      const state = this.io.getData().relayState!;
      if (state.policy !== this.applicationPolicy) {
        throw new CatchUpNeeded("Sync settings changed - reconciliation is pending");
      }
      if (!refresh && head === cursor && this.verifiedHead?.scope === ctx.scope &&
        this.verifiedHead.cursor === cursor && this.verifiedHead.state === state.pathTipsHash) return;
      const root = await relayRoot(state.tips);
      // The relay reads rows, awaits hashing, then reads head. Confirm a mismatch
      // before treating it as corruption; a moving head is only catch-up work.
      let merkle = await ctx.relay.merkle(ctx.vaultId);
      validateHead(merkle.head);
      if (!isHash(merkle.root)) throw new Error("Malformed relay Merkle root");
      if (merkle.head > cursor) continue;
      if (merkle.head === cursor && merkle.root === root) {
        this.verifiedHead = { scope: ctx.scope, cursor, state: state.pathTipsHash };
        if (this.io.getData().relayState?.policy !== this.applicationPolicy) {
          throw new CatchUpNeeded("Sync settings changed — reconciliation is pending");
        }
        return;
      }
      merkle = await ctx.relay.merkle(ctx.vaultId);
      validateHead(merkle.head);
      if (!isHash(merkle.root)) throw new Error("Malformed relay Merkle root");
      if (merkle.head > cursor) continue;
      if (merkle.head === cursor && merkle.root === root) {
        this.verifiedHead = { scope: ctx.scope, cursor, state: state.pathTipsHash };
        if (this.io.getData().relayState?.policy !== this.applicationPolicy) {
          throw new CatchUpNeeded("Sync settings changed — reconciliation is pending");
        }
        return;
      }
      if (!progress.rebuilt) {
        this.status.note("Rebuilding relay metadata after verification failed");
        await this.rebuildRelayState(ctx, progress);
        continue;
      }
      throw new Error(`Drift: merkle mismatch (relay head ${merkle.head}, cursor ${cursor})`);
    }
    throw new CatchUpNeeded("Relay head is moving — catch-up is pending");
  }

  /** Consume a finite observed prefix, never the unconsumed head of a push response. */
  private async drainPull(ctx: OpCtx, progress: SyncProgress, target?: number): Promise<number> {
    ctx.assertCurrent();
    let pull = await this.pullOps(ctx, this.io.getData().localCursor);
    validatePull(pull, this.io.getData().localCursor);
    if (pull.head < this.io.getData().localCursor) throw new RebuildNeeded("Relay log became shorter");
    const head = target ?? pull.head;
    validateHead(head);
    while (this.io.getData().localCursor < head) {
      if (pull.head < head) throw new RebuildNeeded("Relay log changed during pull");
      const before = this.io.getData().localCursor;
      for (const op of pull.ops) {
        if (op.seq! > head) break;
        const path = await this.decodePath(ctx, op);
        await this.applyRemote(ctx, op, path, progress, false);
        this.observeHlc(op.hlc, ctx.deviceId);
        const live = this.io.getData();
        // Only successful application (or a deliberate exclusion) consumes bytes.
        live.relayState!.tips[op.pathCipherB64] = op.blobHash;
        live.localCursor = op.seq!;
        live.relayState!.cursor = op.seq!;
      }
      await this.checkpoint();
      if (this.io.getData().localCursor === before) throw new Error("Relay pull did not reach its advertised head");
      if (this.io.getData().localCursor < head) {
        pull = await this.pullOps(ctx, this.io.getData().localCursor);
        validatePull(pull, this.io.getData().localCursor);
      }
    }
    return pull.head;
  }

  /** Reconstruct the wire projection, then reconcile causal-maximal state, not superseded history. */
  private async rebuildRelayState(ctx: OpCtx, progress: SyncProgress): Promise<void> {
    ctx.assertCurrent();
    progress.rebuilt = true;
    this.verifiedHead = null;
    this.io.getData().relayState = null;
    const policy = this.applicationPolicy;
    const tips: Record<string, string | null> = Object.create(null);
    const variants = new Map<string, SignedOp[]>();
    const knowledge = new Map<string, Record<string, number>>();
    let cursor = 0;
    let target: number | undefined;
    let verified = false;
    let clock = this.io.getData().lastHlc;
    for (let pass = 0; pass < MAX_CATCH_UP_PASSES; pass++) {
      let pull = await this.pullOps(ctx, cursor);
      validatePull(pull, cursor);
      target ??= pull.head;
      while (cursor < target) {
        if (pull.head < target) throw new CatchUpNeeded("Relay log changed during metadata recovery");
        const before = cursor;
        for (const op of pull.ops) {
          if (op.seq! > target) break;
          tips[op.pathCipherB64] = op.blobHash;
          variants.set(op.pathCipherB64, retainMaximal(variants.get(op.pathCipherB64) ?? [], op));
          knowledge.set(op.pathCipherB64, mergeVv(knowledge.get(op.pathCipherB64), op.versionVector));
          clock = packHlc(recvHlc(clock ? parseHlc(clock) : null, parseHlc(op.hlc), ctx.deviceId));
          cursor = op.seq!;
        }
        if (cursor === before) throw new Error("Relay recovery did not reach its advertised head");
        if (cursor < target) {
          pull = await this.pullOps(ctx, cursor);
          validatePull(pull, cursor);
        }
      }
      const merkle = await ctx.relay.merkle(ctx.vaultId);
      validateHead(merkle.head);
      if (!isHash(merkle.root)) throw new Error("Malformed relay Merkle root");
      if (merkle.head === cursor && merkle.root === await relayRoot(tips)) {
        verified = true;
        break;
      }
      if (merkle.head < cursor) throw new CatchUpNeeded("Relay log changed during metadata recovery");
      target = merkle.head;
      if (pass === MAX_CATCH_UP_PASSES - 1 && merkle.head === cursor) {
        throw new Error(`Drift: merkle mismatch after metadata recovery (relay head ${merkle.head})`);
      }
    }
    if (!verified) throw new CatchUpNeeded("Relay head is moving — metadata recovery is pending");
    if (policy !== this.applicationPolicy) throw new CatchUpNeeded("Sync settings changed during metadata recovery");

    const paths = new Map<string, { ops: SignedOp[]; vv: Record<string, number> }>();
    let pathError: unknown = null;
    for (const [cipher, ops] of variants) {
      try {
        const path = await this.decodePath(ctx, ops[0]);
        const previous = paths.get(path);
        let maximal = previous?.ops ?? [];
        for (const op of ops) maximal = retainMaximal(maximal, op);
        maximal.sort((a, b) => a.seq! - b.seq!);
        paths.set(path, { ops: maximal, vv: mergeVv(previous?.vv, knowledge.get(cipher)) });
      } catch (error) {
        if (error instanceof ContextChanged) throw error;
        // Valid paths can still be restored, but the invalid op is NOT acknowledged.
        pathError ??= error;
      }
    }
    const reconciled: Record<string, PathTip> = Object.create(null);
    for (const [path, { ops, vv }] of [...paths].sort((a, b) =>
      a[1].ops[a[1].ops.length - 1].seq! - b[1].ops[b[1].ops.length - 1].seq!)) {
      const op = ops[ops.length - 1];
      if (this.canSync(path) && await this.mergeRecoveryVariants(ctx, path, ops)) {
        reconciled[path] = { hash: op.blobHash, vv, pending: true, pendingMerge: true };
        this.pendingLocal.add(path);
        progress.applied++;
        continue;
      }
      // Sequence order picks the original, not which concurrent bytes survive.
      // Preserve every distinct maximal live variant before acknowledging joined
      // knowledge. A concurrent tombstone cannot discard another maximal blob.
      const hashes = new Set([op.blobHash]);
      if (this.canSync(path)) {
        for (const other of ops) {
          const hash = other.blobHash;
          if (hash === null || hashes.has(hash)) continue;
          hashes.add(hash);
          if (await this.hashLocalPath(path) !== hash) {
            await this.preserveConflict(path, hash, () => this.remoteBytes(ctx, path, hash), progress);
          }
        }
      }
      const tip = await this.applyRemote(ctx, op, path, progress, true, vv);
      if (tip) {
        // Publish a causal join only after its concurrent contents are real files.
        if (ops.length > 1) tip.pending = true;
        reconciled[path] = tip;
      }
    }
    if (pathError) throw pathError;
    if (policy !== this.applicationPolicy) throw new CatchUpNeeded("Sync settings changed during metadata recovery");
    const hash = await pathTipsHash(reconciled);
    ctx.assertCurrent();
    const live = this.io.getData();
    live.pathTips = reconciled;
    live.localCursor = cursor;
    live.lastHlc = clock;
    live.relayState = { cursor, context: ctx.scope, policy, tips, pathTipsHash: hash };
    await this.checkpoint();
    this.status.note(`Relay metadata verified — ${cursor} operations accounted for`);
  }

  private async mergeRecoveryVariants(ctx: OpCtx, path: string, ops: SignedOp[]): Promise<boolean> {
    if (ops.length < 2 || !this.isMergeable(path) || this.explicitDeletes.has(path)) return false;
    const baseHash = ops[0].prevHash;
    if (!isHash(baseHash) || ops.some((op) => op.prevHash !== baseHash || op.blobHash === null)) return false;
    const hashes = [...new Set(ops.map((op) => op.blobHash!))];
    if (hashes.length < 2) return false;
    const localHash = await this.hashLocalPath(path);
    const base = await this.tryMergeBaseBytes(ctx, path, baseHash);
    if (!base) return false;
    let merged = await this.remoteBytes(ctx, path, hashes[0]);
    for (const hash of hashes.slice(1)) {
      const remote = await this.remoteBytes(ctx, path, hash);
      const result = mergeContent(path, base, merged, remote);
      if (!result) return false;
      merged = result;
    }
    if (await sha256Hex(merged) === localHash) return true;
    if (localHash !== null && localHash !== baseHash && !hashes.includes(localHash)) return false;
    await this.writeLocalBytes(path, merged, localHash);
    return true;
  }

  private async decodePath(ctx: OpCtx, op: SignedOp): Promise<string> {
    ctx.assertCurrent();
    let path: string;
    try {
      path = fromUtf8(await open(ctx.secret, op.pathCipherB64, ctx.vaultId));
    } catch {
      throw new Error(`Could not decrypt relay path at operation ${op.seq}`);
    }
    ctx.assertCurrent();
    if (!isSyncPath(path)) throw new Error(`Unsafe relay path at operation ${op.seq}`);
    return path;
  }

  private observeHlc(remote: string, deviceId: string): void {
    const data = this.io.getData();
    data.lastHlc = packHlc(recvHlc(data.lastHlc ? parseHlc(data.lastHlc) : null, parseHlc(remote), deviceId));
  }

  private pathTip(path: string): PathTip | null {
    const tips = this.io.getData().pathTips;
    return Object.prototype.hasOwnProperty.call(tips, path) ? tips[path] : null;
  }

  private setPathTip(path: string, tip: PathTip): void {
    this.assertRunContext();
    Object.defineProperty(this.io.getData().pathTips, path, {
      value: tip, enumerable: true, writable: true, configurable: true,
    });
  }

  private get applicationPolicy(): string {
    return JSON.stringify([this.configDir, this.io.getData().ignorePatterns]);
  }

  private canSync(path: string): boolean {
    return !this.shouldIgnore(path) && (!this.isConfigPath(path) || isConfigPathAllowed(path, this.configDir));
  }

  private async applyRemote(
    ctx: OpCtx, op: SignedOp, path: string, progress: SyncProgress,
    recovery: boolean, knowledge = op.versionVector
  ): Promise<PathTip | null> {
    if (!this.canSync(path)) return null;
    const tip = this.pathTip(path);
    // Rebuild causal knowledge from this verified log, not possibly corrupt
    // tips (or tips belonging to a different relay/vault/identity context).
    const vv = mergeVv(recovery ? undefined : tip?.vv, knowledge);
    if (!recovery && tip && ((tip.hash === op.blobHash && covers(tip.vv, op.versionVector)) ||
      dominates(tip.vv, op.versionVector))) {
      // Equal vectors are not concurrent. In particular, self echoes must not
      // replace newer local bytes or manufacture another conflict on each retry.
      const known = { ...tip, ...(tip.hash !== op.blobHash ? { pending: true } : {}) };
      if (known.pending) this.pendingLocal.add(path);
      this.setPathTip(path, known);
      progress.applied++;
      return known;
    }
    let localHash = await this.hashLocalPath(path);
    let pending = false;
    let pendingMerge = false;
    if (localHash !== op.blobHash) {
      const unchanged = !recovery && !!tip && !tip.pending && tip.hash === localHash &&
        dominates(op.versionVector, tip.vv);
      if (op.blobHash === null) {
        if (unchanged) {
          await this.deleteLocalPath(path, localHash);
        } else {
          // No tombstone is permission to erase divergent or untracked bytes.
          pending = true;
          this.pendingLocal.add(path);
        }
      } else {
        const bytes = await this.remoteBytes(ctx, path, op.blobHash);
        // Network/crypto awaits may have allowed a local edit. Decide using the
        // current bytes, not the snapshot from before fetching the blob.
        if (!this.isConfigPath(path)) await this.flushOpenEditors(path);
        const localBytes = await this.readLocalBytes(path);
        localHash = localBytes === null ? null : await sha256Hex(localBytes);
        const stillUnchanged = !recovery && !!tip && !tip.pending && tip.hash === localHash &&
          dominates(op.versionVector, tip.vv);
        const newPath = localHash === null && !this.explicitDeletes.has(path) &&
          (recovery || !tip || (tip.hash === null && !tip.pending));
        if (localHash === op.blobHash) {
          // Already materialized by a prior, interrupted application.
        } else if (stillUnchanged || newPath) {
          await this.writeLocalBytes(path, bytes, localHash);
        } else if (op.deviceId === ctx.deviceId && !recovery) {
          // A lost push receipt is our own history, not a second user's conflict.
          pending = true;
        } else {
          const baseHash = !recovery && tip ? this.commonBase(tip, op) : null;
          const merged = localBytes && baseHash ? await this.mergeFromBase(ctx, path, baseHash, localBytes, bytes) : null;
          if (merged) {
            const mergedHash = await sha256Hex(merged);
            if (mergedHash !== localHash) await this.writeLocalBytes(path, merged, localHash);
            pending = mergedHash !== op.blobHash || !!tip && !covers(op.versionVector, tip.vv);
            pendingMerge = pending;
          } else {
            await this.preserveConflict(path, op.blobHash, bytes, progress);
            pending = true;
          }
        }
      }
    }
    if (pending) this.pendingLocal.add(path);
    const result: PathTip = {
      hash: op.blobHash, vv,
      ...(pending ? { pending: true } : isHash(op.prevHash) ? { prevHash: op.prevHash } : {}),
      ...(pendingMerge ? { pendingMerge: true } : {}),
    };
    this.setPathTip(path, result);
    progress.applied++;
    return result;
  }

  private commonBase(tip: PathTip, op: SignedOp): string | null {
    if (!isHash(op.prevHash)) return null;
    if (tip.pending) return tip.pendingMerge && tip.hash === op.prevHash ? op.prevHash : null;
    if (tip.hash === op.prevHash && covers(op.versionVector, tip.vv)) return op.prevHash;
    if (tip.prevHash === op.prevHash && !covers(op.versionVector, tip.vv) &&
      !covers(tip.vv, op.versionVector)) return op.prevHash;
    return null;
  }

  private async mergeFromBase(
    ctx: OpCtx, path: string, baseHash: string, local: Uint8Array, remote: Uint8Array
  ): Promise<Uint8Array | null> {
    if (!this.isMergeable(path)) return null;
    const base = await this.tryMergeBaseBytes(ctx, path, baseHash);
    return base ? mergeContent(path, base, local, remote) : null;
  }

  private isMergeable(path: string): boolean {
    return !this.isConfigPath(path) && /\.(?:md|canvas)$/i.test(path);
  }

  private async tryMergeBaseBytes(ctx: OpCtx, path: string, baseHash: string): Promise<Uint8Array | null> {
    try {
      return await this.remoteBytes(ctx, path, baseHash);
    } catch (error) {
      ctx.assertCurrent();
      if (error instanceof MissingBlob) return null;
      throw error;
    }
  }

  private async remoteBytes(ctx: OpCtx, path: string, hash: string): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      const packed = await ctx.relay.getBlob(ctx.vaultId, hash);
      const key = await hkdf(ctx.secret, `blob:${hash}`, 32);
      bytes = await open(key, bytesToB64(new Uint8Array(packed)));
    } catch (error) {
      ctx.assertCurrent();
      const message = `Could not fetch/decrypt blob for ${path}: ${error instanceof Error ? error.message : error}`;
      if (error instanceof RelayError && error.status === 404 && /blob not found/i.test(error.message)) {
        throw new MissingBlob(message);
      }
      throw new Error(message);
    }
    if (await sha256Hex(bytes) !== hash) throw new Error(`Checksum mismatch for ${path}`);
    ctx.assertCurrent();
    return bytes;
  }

  /** Content-addressed names make interrupted recovery/restarts idempotent. Never overwrite a copy. */
  private async preserveConflict(
    path: string, hash: string, bytes: Uint8Array | (() => Promise<Uint8Array>), progress: SyncProgress
  ): Promise<void> {
    const original = this.isConfigPath(path) ? `Flock conflicts/${path.slice(this.configDir.length + 1)}` : path;
    const name = basename(original);
    const dir = dirname(original);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 0; i < 100; i++) {
      const target = `${dir ? dir + "/" : ""}${stem} (conflict ${hash.slice(0, 12)}${i ? ` ${i}` : ""})${ext}`;
      if (!this.canSync(target)) throw new Error(`Conflict destination is excluded: ${target}`);
      const kind = await this.localKind(target);
      if (kind === "folder") continue;
      const existingHash = await this.hashLocalPath(target);
      if (existingHash !== null && existingHash !== hash) continue;
      if (existingHash === null) {
        const content = typeof bytes === "function" ? await bytes() : bytes;
        await this.writeLocalBytes(target, content, null);
        progress.conflicts++;
        this.status.note(`Conflict: ${path} — kept local, saved remote as ${target}`);
      }
      this.pendingLocal.add(target);
      return;
    }
    throw new Error(`Could not reserve a conflict file for ${path}`);
  }

  private get configDir(): string {
    return normalizeVaultPath(this.app.vault.configDir || ".obsidian");
  }

  private isConfigPath(path: string): boolean {
    const cd = this.configDir;
    return cd.length > 0 && (path === cd || path.startsWith(cd + "/"));
  }

  private refreshIgnore(data: PluginData): void {
    if (data.ignorePatterns !== this.ignoreRaw) {
      this.ignoreRaw = data.ignorePatterns;
      this.ignorePatterns = parseIgnorePatterns(data.ignorePatterns);
    }
  }

  private shouldIgnore(path: string): boolean {
    return isIgnored(path, this.ignorePatterns);
  }

  /**
   * The permanent Worker starts empty. A vault id from the old tunnel 404s.
   * Enroll that same id, then upload local notes from scratch.
   */
  private async pullOps(ctx: OpCtx, after: number): Promise<OpsPullResponse> {
    try {
      return await ctx.relay.opsPull(ctx.vaultId, after);
    } catch (e) {
      if (!this.isMissingVault(e)) throw e;
      await this.enrollCurrentVault(ctx);
      this.status.note("Linked this vault on the relay — rebuilding metadata");
      return await ctx.relay.opsPull(ctx.vaultId, after);
    }
  }

  private isMissingVault(e: unknown): boolean {
    return e instanceof RelayError && e.status === 404 && /vault not found/i.test(e.message);
  }

  private async enrollCurrentVault(ctx: OpCtx): Promise<void> {
    const sealedMetaB64 = await sealJson(ctx.secret, {
      name: this.app.vault.getName(),
      createdAt: Date.now(),
    });
    try {
      await ctx.relay.vaultEnroll({ vaultId: ctx.vaultId, sealedMetaB64 });
    } catch (e) {
      if (e instanceof RelayError && (e.status === 401 || e.code === "unauthorized")) {
        throw new Error(
          "This relay is new. On the PC tap Add device, then Scan QR on the phone."
        );
      }
      throw e;
    }
  }

  private async opCtx(): Promise<OpCtx | null> {
    const data = this.io.getData();
    const secret = this.identity.flockSecret;
    const deviceId = this.identity.deviceId;
    const keys = this.identity.keys;
    if (!secret || !deviceId || !keys || !data.vaultId) return null;
    const vaultId = data.vaultId;
    const flockId = this.identity.flockId;
    const token = this.identity.deviceToken;
    const relayUrl = data.relayUrl.trim().replace(/\/+$/, "");
    const relayVersion = this.relay.contextVersion;
    const capturedSecret = new Uint8Array(secret);
    const assertCurrent = () => {
      const live = this.io.getData();
      const currentSecret = this.identity.flockSecret;
      if (live.relayUrl.trim().replace(/\/+$/, "") !== relayUrl ||
        this.relay.baseUrl !== relayUrl || this.relay.contextVersion !== relayVersion ||
        !live.enrolled || live.vaultId !== vaultId || this.identity.deviceId !== deviceId ||
        this.identity.flockId !== flockId || this.identity.deviceToken !== token ||
        this.identity.keys?.ecdsaPriv !== keys.ecdsaPriv || !currentSecret ||
        currentSecret.length !== capturedSecret.length ||
        !capturedSecret.every((byte, i) => byte === currentSecret[i])) {
        throw new ContextChanged("Sync context changed — relay metadata must be verified again");
      }
    };
    assertCurrent();
    // Persist only a nonsecret scope/fingerprint, never the key or auth token.
    const scope = JSON.stringify([relayUrl, vaultId, deviceId, flockId, await sha256Hex(capturedSecret)]);
    assertCurrent();
    return {
      vaultId, secret: capturedSecret, deviceId, ecdsaPriv: keys.ecdsaPriv,
      relay: this.relay.snapshot(assertCurrent), scope, assertCurrent,
    };
  }

  /**
   * Build and sign one op. `prevHash` chains to the content hash this op
   * replaces (the previous tip hash; null for new paths) — the only
   * "previous" pointer derivable from the frozen PluginData shape.
   */
  private async makeOp(
    ctx: OpCtx,
    path: string,
    blobHash: string | null,
    prevTip: PathTip | null
  ): Promise<SignedOp> {
    ctx.assertCurrent();
    const data = this.io.getData();
    const prevHlc = data.lastHlc ? parseHlc(data.lastHlc) : null;
    const hlc = packHlc(tickHlc(prevHlc, ctx.deviceId));
    data.lastHlc = hlc;
    const unsigned = {
      deviceId: ctx.deviceId,
      pathCipherB64: await sealDeterministic(ctx.secret, utf8(path), ctx.vaultId),
      blobHash,
      prevHash: prevTip ? prevTip.hash : null,
      hlc,
      versionVector: bumpVv(prevTip ? prevTip.vv : {}, ctx.deviceId),
    };
    const sigB64 = await signBytes(ctx.ecdsaPriv, canonicalOpMessage(unsigned));
    ctx.assertCurrent();
    return { ...unsigned, sigB64 };
  }

  private async localKind(path: string): Promise<"file" | "folder" | null> {
    this.assertRunContext();
    if (this.isConfigPath(path)) {
      const stat = await this.app.vault.adapter.stat(path);
      this.assertRunContext();
      return stat?.type ?? null;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? "file" : file instanceof TFolder ? "folder" : null;
  }

  private async readLocalBytes(path: string): Promise<Uint8Array | null> {
    this.assertRunContext();
    if (this.isConfigPath(path)) {
      const kind = await this.localKind(path);
      if (kind === null) return null;
      if (kind !== "file") throw new Error(`Expected a file, found a folder: ${path}`);
      const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(path));
      this.assertRunContext();
      return bytes;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFolder) throw new Error(`Expected a file, found a folder: ${path}`);
    if (!(file instanceof TFile)) return null;
    const bytes = new Uint8Array(await this.app.vault.readBinary(file));
    this.assertRunContext();
    return bytes;
  }

  private async hashLocalPath(path: string, flush = true): Promise<string | null> {
    if (flush && !this.isConfigPath(path)) await this.flushOpenEditors(path);
    const bytes = await this.readLocalBytes(path);
    const hash = bytes ? await sha256Hex(bytes) : null;
    this.assertRunContext();
    return hash;
  }

  private async writeLocalBytes(path: string, bytes: Uint8Array, expectedHash: string | null): Promise<void> {
    this.assertRunContext();
    if (!isSyncPath(path)) throw new Error("Unsafe file write path");
    const ab = toArrayBuffer(bytes);
    if (this.isConfigPath(path)) {
      const dir = dirname(path);
      if (dir) await this.ensureAdapterFolder(dir);
      if (await this.hashLocalPath(path) !== expectedHash) throw new CatchUpNeeded(`Local file changed during sync: ${path}`);
      this.assertRunContext();
      await this.app.vault.adapter.writeBinary(path, ab);
      this.assertRunContext();
      return;
    }
    const folder = dirname(path);
    if (folder) await this.ensureLocalFolder(folder);
    if (await this.hashLocalPath(path) !== expectedHash) throw new CatchUpNeeded(`Local file changed during sync: ${path}`);
    this.assertRunContext();
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, ab);
    else await this.app.vault.createBinary(normalizePath(path), ab);
    this.assertRunContext();
    if (/\.canvas$/i.test(path)) {
      this.pendingCanvasReloads.add(path);
      await this.reloadOpenViews(path);
      if (await this.hashLocalPath(path, false) !== await sha256Hex(bytes)) {
        this.markLocalChange(path);
        this.pendingLocal.add(path);
        this.scheduleSync();
        throw new CatchUpNeeded(`Canvas changed during reload: ${path}`);
      }
    }
  }

  private async deleteLocalPath(path: string, expectedHash: string | null): Promise<void> {
    this.assertRunContext();
    if (!isSyncPath(path)) throw new Error("Unsafe file delete path");
    if (await this.hashLocalPath(path) !== expectedHash) throw new CatchUpNeeded(`Local file changed during sync: ${path}`);
    if (this.isConfigPath(path)) {
      if (await this.localKind(path) === "file") await this.app.vault.adapter.remove(path);
      this.assertRunContext();
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFolder) throw new Error(`Refusing to delete a folder: ${path}`);
    if (file instanceof TFile) {
      this.deletingRemotePaths.add(path);
      try {
        await this.app.vault.delete(file);
      } finally {
        this.deletingRemotePaths.delete(path);
      }
    }
    this.assertRunContext();
  }

  private async ensureLocalFolder(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    const parts = normalized.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      this.assertRunContext();
      cur = cur ? `${cur}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(cur);
      if (existing instanceof TFile) throw new Error(`Expected a folder, found a file: ${cur}`);
      if (!existing) {
        await this.app.vault.createFolder(cur);
        this.assertRunContext();
      }
    }
  }

  private async ensureAdapterFolder(dir: string): Promise<void> {
    const parts = normalizeVaultPath(dir).split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      this.assertRunContext();
      cur = cur ? `${cur}/${part}` : part;
      const stat = await this.app.vault.adapter.stat(cur);
      this.assertRunContext();
      if (stat?.type === "file") throw new Error(`Expected a folder, found a file: ${cur}`);
      if (!stat) await this.app.vault.adapter.mkdir(cur);
      this.assertRunContext();
    }
  }

  // ------------------------------------------------------------ scan passes

  /** Unlike a best-effort settings listing, an unreadable directory is not proof of deletion. */
  private async listConfigFiles(): Promise<string[]> {
    this.assertRunContext();
    const adapter = this.app.vault.adapter;
    const root = await adapter.stat(this.configDir);
    this.assertRunContext();
    if (!root) return [];
    if (root.type !== "folder") throw new Error("Obsidian config directory is not a folder");
    const files: string[] = [];
    const queue = [this.configDir];
    const seen = new Set(queue);
    while (queue.length) {
      const listing = await adapter.list(queue.shift()!);
      this.assertRunContext();
      for (const path of listing.files) {
        if (isConfigPathAllowed(path, this.configDir) && !this.shouldIgnore(path)) files.push(path);
      }
      for (const path of listing.folders) {
        if (!seen.has(path) && isConfigPathAllowed(`${path}/_`, this.configDir) && !this.shouldIgnore(path)) {
          seen.add(path);
          queue.push(path);
        }
      }
    }
    return files;
  }

  /** Reconciliation catches edits made while watch events were unavailable. */
  private async scanLocalChanges(full: boolean, config = full): Promise<void> {
    this.assertRunContext();
    for (const { oldPath, newPath } of this.pendingRenames.splice(0)) {
      if (this.canSync(oldPath)) this.pendingDeletes.add(oldPath);
      if (this.canSync(newPath)) this.pendingLocal.add(newPath);
    }
    const paths = new Set([...this.pendingLocal, ...this.pendingDeletes]);
    if (full || config) {
      for (const path of Object.keys(this.io.getData().pathTips)) {
        if (full || this.isConfigPath(path)) paths.add(path);
      }
      for (const path of await this.listConfigFiles()) paths.add(path);
    }
    if (full) {
      for (const file of this.app.vault.getFiles()) paths.add(file.path);
    }
    for (const path of paths) {
      if (!this.canSync(path)) {
        this.pendingLocal.delete(path);
        this.pendingDeletes.delete(path);
        continue;
      }
      if (!isSyncPath(path)) throw new Error(`Unsafe local sync path: ${path}`);
      if (!this.isConfigPath(path)) await this.flushOpenEditors(path);
      const revision = this.pathRevisions.get(path) ?? 0;
      const tip = this.pathTip(path);
      // Config has no watch events and adapters can preserve mtime/size. Only a
      // fresh content hash can certify that it still matches acknowledged bytes.
      const hash = await this.hashLocalPath(path, false);
      if ((this.pathRevisions.get(path) ?? 0) !== revision) {
        this.pendingLocal.add(path);
        continue;
      }
      if (hash === null) {
        this.pendingLocal.delete(path);
        if (tip && (tip.hash !== null || tip.pending)) this.pendingDeletes.add(path);
        else this.pendingDeletes.delete(path);
      } else {
        this.pendingDeletes.delete(path);
        if (!tip || tip.hash !== hash || tip.pending) this.pendingLocal.add(path);
        else this.pendingLocal.delete(path);
      }
    }
  }

  private async pushLocalChanges(ctx: OpCtx, progress: SyncProgress): Promise<void> {
    ctx.assertCurrent();
    const prepared: PreparedOp[] = [];
    for (const path of [...this.pendingDeletes]) {
      const revision = this.pathRevisions.get(path) ?? 0;
      const tip = this.pathTip(path);
      if (!this.canSync(path) || !tip || (tip.hash === null && !tip.pending)) {
        this.pendingDeletes.delete(path);
        continue;
      }
      if (await this.localKind(path) !== null) {
        this.pendingLocal.add(path);
        this.pendingDeletes.delete(path);
        continue;
      }
      prepared.push({ path, op: await this.makeOp(ctx, path, null, tip), revision });
    }
    for (const path of [...this.pendingLocal]) {
      if (!this.canSync(path)) { this.pendingLocal.delete(path); continue; }
      if (!this.isConfigPath(path)) await this.flushOpenEditors(path);
      const revision = this.pathRevisions.get(path) ?? 0;
      const tip = this.pathTip(path);
      const bytes = await this.readLocalBytes(path);
      if (bytes === null) {
        if (tip && tip.hash !== null) this.pendingDeletes.add(path);
        if ((this.pathRevisions.get(path) ?? 0) === revision) this.pendingLocal.delete(path);
        continue;
      }
      const hash = await sha256Hex(bytes);
      if (tip?.hash === hash && !tip.pending) {
        if ((this.pathRevisions.get(path) ?? 0) === revision) this.pendingLocal.delete(path);
        continue;
      }
      if (bytes.byteLength > MAX_BLOB_BYTES) {
        throw new Error(`${path} is over the ${Math.round(MAX_BLOB_BYTES / (1024 * 1024))} MB sync limit`);
      }
      const key = await hkdf(ctx.secret, `blob:${hash}`, 32);
      const sealed = await seal(key, bytes);
      await ctx.relay.putBlob(ctx.vaultId, hash, toArrayBuffer(b64ToBytes(sealed)));
      prepared.push({ path, op: await this.makeOp(ctx, path, hash, tip), revision });
    }
    if (!prepared.length) return;
    // No path tip or pending work is advanced for a blob upload alone. Persist
    // the clock/merged knowledge so failures and a restart can safely retry.
    await this.checkpoint();
    const before = this.io.getData().localCursor;
    const receipt = await ctx.relay.opsPush(ctx.vaultId, { ops: prepared.map(({ op }) => op) });
    validateHead(receipt.head);
    if (!Array.isArray(receipt.ops) || receipt.ops.length !== prepared.length) throw new Error("Incomplete push acknowledgment");
    let seq = before;
    for (let i = 0; i < prepared.length; i++) {
      const accepted = receipt.ops[i];
      const sent = prepared[i].op;
      if (!Number.isSafeInteger(accepted.seq) || accepted.seq! <= seq || accepted.seq! > receipt.head ||
        accepted.sigB64 !== sent.sigB64 ||
        bytesToB64(canonicalOpMessage(accepted)) !== bytesToB64(canonicalOpMessage(sent))) {
        throw new Error("Invalid push acknowledgment");
      }
      seq = accepted.seq!;
    }
    for (const { path, op, revision } of prepared) {
      const tip = this.pathTip(path);
      this.setPathTip(path, {
        hash: op.blobHash, vv: mergeVv(tip?.vv, op.versionVector),
        ...(!covers(op.versionVector, tip?.vv ?? {}) ? { pending: true } : {}),
        ...(isHash(op.prevHash) ? { prevHash: op.prevHash } : {}),
      });
      if ((this.pathRevisions.get(path) ?? 0) === revision) {
        this.pendingLocal.delete(path);
        this.pendingDeletes.delete(path);
        this.explicitDeletes.delete(path);
      }
    }
    progress.pushed += prepared.length;
    await this.checkpoint();
    // The receipt may include unread peer ops between our last pull and push.
    await this.drainPull(ctx, progress, receipt.head);
  }

  // ------------------------------------------------- editor flush / reload

  /** TextFileView.save is the persistence barrier; requestSave is only a debounce. */
  private async flushOpenEditors(path: string): Promise<void> {
    const ctx = this.activeContext;
    ctx?.assertCurrent();
    const target = normalizeVaultPath(path);
    if (this.pendingCanvasReloads.has(target)) await this.reloadOpenViews(target);
    const views: Array<{ save?: () => Promise<void> }> = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as {
        file?: TFile;
        requestSave?: () => void;
        save?: () => Promise<void>;
      };
      const file = view.file;
      if (!file || normalizeVaultPath(file.path) !== target) return;
      if (typeof view.save === "function" || typeof view.requestSave === "function") views.push(view);
    });
    const results = await Promise.allSettled(views.map(async (view) => {
      ctx?.assertCurrent();
      if (!view.save) throw new Error(`Cannot safely save the open editor for ${path}`);
      const saved = view.save();
      if (!saved || typeof saved.then !== "function") throw new Error(`Editor save is not awaitable for ${path}`);
      await saved;
      ctx?.assertCurrent();
    }));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    ctx?.assertCurrent();
  }

  /** Rebuild open canvas leaves for a path so pulled content shows up. */
  private async reloadOpenViews(target: string): Promise<void> {
    const rebuilds: Array<() => void | Promise<void>> = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as { file?: TFile; getViewType?: () => string };
      const file = view.file;
      if (!file || normalizeVaultPath(file.path) !== target) return;
      if ((view.getViewType?.() ?? "") !== "canvas") return;
      const rebuild = (leaf as { rebuildView?: () => void | Promise<void> }).rebuildView;
      if (typeof rebuild === "function") rebuilds.push(() => rebuild.call(leaf));
      else rebuilds.push(() => { throw new Error(`Cannot safely reload the open canvas for ${target}`); });
    });
    for (const rebuild of rebuilds) {
      this.assertRunContext();
      await rebuild();
    }
    this.assertRunContext();
    this.pendingCanvasReloads.delete(target);
  }
}

// ------------------------------------------------------------------ helpers

/** Keep the version-vector antichain; equal-vector retries of equal bytes dedupe. */
function retainMaximal(versions: SignedOp[], incoming: SignedOp): SignedOp[] {
  if (versions.some((op) => dominates(op.versionVector, incoming.versionVector))) return versions;
  return [...versions.filter((op) =>
    !dominates(incoming.versionVector, op.versionVector) &&
    !(op.blobHash === incoming.blobHash && covers(op.versionVector, incoming.versionVector) &&
      covers(incoming.versionVector, op.versionVector))), incoming];
}

/** Element-wise max of two version vectors. */
function mergeVv(
  a?: Record<string, number>,
  b?: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const av = a && Object.prototype.hasOwnProperty.call(a, k) ? a[k] : 0;
    const bv = b && Object.prototype.hasOwnProperty.call(b, k) ? b[k] : 0;
    out[k] = Math.max(av, bv);
  }
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

async function decodeVaultName(secret: Uint8Array, sealedMetaB64: string): Promise<string | null> {
  try {
    const meta = await openJson<{ name?: unknown }>(secret, sealedMetaB64);
    return typeof meta.name === "string" && meta.name.trim() ? meta.name : null;
  } catch {
    return null;
  }
}
