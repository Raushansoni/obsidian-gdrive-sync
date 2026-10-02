import { PAIR_TTL_MS, type PairFrame } from "../protocol";
import type { IdentityStore } from "../identity";
import { RelayError, type RelayHttp } from "../relay/client";
import {
  b64ToBytes,
  bytesToB64,
  bytesToHex,
  fromUtf8,
  randomBytes,
  sha256,
  utf8,
} from "../crypto/bytes";
import { exportEcdhPubB64, importSpkiEcdh, ecdhShared } from "../crypto/p256";
import { hmacHex } from "../crypto/hkdf";
import { openJson, sealJson } from "../crypto/box";
import {
  deriveSessionKey,
  fingerprintWords,
  formatHostCode,
  parseCode,
  pickWords,
  qrPayload,
  type ParsedCode,
} from "./code";

/**
 * Mailbox frame payloads are base64(JSON utf8). The relay never parses them.
 *  {t:"ek",      pubB64}      — ephemeral ECDH P-256 public key (SPKI, base64)
 *  {t:"confirm", macHex, fingerprint} — HMAC(sessionKey,"confirm") + 3 words
 *  {t:"seal",    sealedB64}   — AES-GCM(sessionKey) of {flockId, flockSecretB64}
 */

interface EkFrame {
  t: "ek";
  pubB64: string;
}
interface ConfirmFrame {
  t: "confirm";
  macHex: string;
  fingerprint: string;
}
interface SealFrame {
  t: "seal";
  sealedB64: string;
}
type FrameBody = EkFrame | ConfirmFrame | SealFrame;

export type PairingPhase =
  | "idle"
  | "host-waiting-guest" // start+ek posted, waiting for guest ek
  | "host-confirm" // confirm posted, waiting for the human to confirmHost()
  | "host-finishing" // seal + finish in flight
  | "guest-joining" // claim+ek posted, waiting for host ek+confirm
  | "guest-confirm" // verified fingerprint, waiting for the human to confirmGuest()
  | "guest-finishing" // seal open + guest-finish in flight
  | "done"
  | "error"
  | "cancelled";

export interface HostStartInfo {
  nameplate: string;
  words: [string, string];
  code: string;
  /** Deep link for the QR: obsidian://flock-sync?n=NAMEPLATE&c=code */
  link: string;
}

const ECDH_GEN = { name: "ECDH", namedCurve: "P-256" } as const;

class PairingCancelled extends Error {
  constructor() {
    super("Pairing cancelled");
    this.name = "PairingCancelled";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function frameB64(body: FrameBody): string {
  return bytesToB64(utf8(JSON.stringify(body)));
}

function parseFrameBody<T extends FrameBody>(frame: PairFrame): T | null {
  try {
    const body = JSON.parse(fromUtf8(b64ToBytes(frame.payloadB64))) as T;
    if (typeof body === "object" && body !== null && typeof body.t === "string") return body;
    return null;
  } catch {
    return null;
  }
}

/** Newest frame of the given type from the given role (retries overwrite older ones). */
function lastFrame<T extends FrameBody>(
  frames: PairFrame[],
  t: T["t"],
  fromRole: "host" | "guest"
): T | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (f.fromRole !== fromRole) continue;
    const body = parseFrameBody<FrameBody>(f);
    if (body && body.t === t) return body as T;
  }
  return null;
}

export class PairingFlow {
  phase: PairingPhase = "idle";
  fingerprint: string | null = null;
  error: string | null = null;
  host: HostStartInfo | null = null;

  private identity: IdentityStore;
  private relay: RelayHttp;
  private sessionKey: Uint8Array | null = null;
  private guestCode: ParsedCode | null = null;
  private runId = 0;
  private hostDone: Promise<void> | null = null;
  private hostConfirmRequested = false;
  private hostConfirmResolve: (() => void) | null = null;

  constructor(identity: IdentityStore, relay: RelayHttp) {
    this.identity = identity;
    this.relay = relay;
  }

  private reset(): number {
    this.runId++;
    this.phase = "idle";
    this.fingerprint = null;
    this.error = null;
    this.host = null;
    this.guestCode = null;
    this.sessionKey = null;
    this.hostConfirmRequested = false;
    this.hostConfirmResolve = null;
    this.hostDone = null;
    return this.runId;
  }

  private stale(runId: number): boolean {
    return this.runId !== runId;
  }

  /**
   * Aborts any running flow. Dismiss on an error (or a second cancel) returns
   * to idle so the settings UI can show Start pair / Join again.
   */
  cancel(): void {
    this.runId++;
    if (this.phase === "error" || this.phase === "cancelled") {
      this.phase = "idle";
    } else if (this.phase !== "idle" && this.phase !== "done") {
      this.phase = "cancelled";
    }
    this.error = null;
    this.sessionKey = null;
    this.fingerprint = null;
    this.host = null;
    this.guestCode = null;
    this.hostConfirmRequested = false;
    const resolve = this.hostConfirmResolve;
    this.hostConfirmResolve = null;
    resolve?.();
  }

  // -------------------------------------------------------------------- host

  /**
   * Register a pairing room, post our ephemeral ECDH key, and start polling in
   * the background. Resolves immediately with what the UI should show; the
   * fingerprint appears once the guest's key arrives.
   */
  async startHost(): Promise<HostStartInfo> {
    const runId = this.reset();
    try {
      return await this.startHostBody(runId);
    } catch (e) {
      if (this.stale(runId)) throw e instanceof Error ? e : new Error(errMsg(e));
      this.phase = "error";
      this.error = errMsg(e);
      throw e instanceof Error ? e : new Error(this.error);
    }
  }

  private async startHostBody(runId: number): Promise<HostStartInfo> {
    const keys = await this.identity.ensureDevice();
    const start = await this.relay.pairStart({
      hostDeviceId: keys.deviceId,
      hostPubKeyB64: keys.pubKeyB64,
      displayName: this.identity.displayName,
    });
    const words = pickWords();
    const code = formatHostCode(start.nameplate, words[0], words[1]);
    const eph = await crypto.subtle.generateKey(ECDH_GEN, true, ["deriveBits"]);
    const pubB64 = await exportEcdhPubB64(eph.publicKey);
    await this.relay.pairMsg({
      nameplate: start.nameplate,
      fromRole: "host",
      payloadB64: frameB64({ t: "ek", pubB64 }),
    });
    this.host = {
      nameplate: start.nameplate,
      words,
      code,
      link: qrPayload(start.nameplate, code),
    };
    if (this.stale(runId)) {
      // Cancelled while the room/key setup was in flight.
      this.phase = "cancelled";
      return this.host;
    }
    this.phase = "host-waiting-guest";
    this.hostDone = this.runHostLoop(
      runId,
      start.nameplate,
      words,
      eph.privateKey,
      keys.deviceId
    );
    // confirmHost() awaits this; avoid unhandled rejection if nobody does.
    void this.hostDone.catch(() => {});
    return this.host;
  }

  private async runHostLoop(
    runId: number,
    nameplate: string,
    words: [string, string],
    ephPriv: CryptoKey,
    hostDeviceId: string
  ): Promise<void> {
    try {
      // Wait for the guest's ephemeral key.
      const frames = await this.pollInbox(
        runId,
        nameplate,
        (fs) => lastFrame<EkFrame>(fs, "ek", "guest") !== null
      );
      if (this.stale(runId)) throw new PairingCancelled();
      const guestEk = lastFrame<EkFrame>(frames, "ek", "guest");
      if (!guestEk || typeof guestEk.pubB64 !== "string") throw new Error("Bad guest key frame");

      const peerPub = await importSpkiEcdh(guestEk.pubB64);
      const shared = await ecdhShared(ephPriv, peerPub);
      const sKey = await deriveSessionKey(shared, nameplate, words[0], words[1]);
      this.sessionKey = sKey;
      this.fingerprint = await fingerprintWords(sKey);
      await this.relay.pairMsg({
        nameplate,
        fromRole: "host",
        payloadB64: frameB64({
          t: "confirm",
          macHex: await hmacHex(sKey, "confirm"),
          fingerprint: this.fingerprint,
        }),
      });
      if (this.stale(runId)) throw new PairingCancelled();
      this.phase = "host-confirm";

      // Hold here until the human confirms the fingerprint in the UI.
      if (!this.hostConfirmRequested) {
        await new Promise<void>((resolve) => {
          this.hostConfirmResolve = resolve;
          if (this.hostConfirmRequested) resolve();
        });
      }
      if (this.stale(runId)) throw new PairingCancelled();

      // Create (first pair) or reuse (add another device) the flock, seal its
      // secret for the guest, then finish on the relay.
      this.phase = "host-finishing";
      let secret: Uint8Array;
      let flockId: string;
      let hostToken: string;
      if (this.identity.hasFlock() && this.identity.flockSecret && this.identity.flockId) {
        // Adding a later device: never rotate the flock secret. Seal the
        // EXISTING flockId + secret and pair-finish with the existing host
        // token — the relay upserts the flock and re-registers this device.
        secret = this.identity.flockSecret;
        flockId = this.identity.flockId;
        hostToken = this.identity.deviceToken!;
      } else {
        secret = randomBytes(32);
        const secretHash = await sha256(secret);
        flockId = bytesToHex(secretHash.slice(0, 16));
        hostToken = bytesToHex(randomBytes(32));
      }
      const sealed = await sealJson(sKey, {
        flockId,
        flockSecretB64: bytesToB64(secret),
      });
      await this.identity.setFlock(flockId, secret, hostToken);
      const sealedMetaB64 = await sealJson(secret, {
        createdAt: Date.now(),
        name: this.identity.displayName,
      });
      await this.relay.pairFinish({
        nameplate,
        flockId,
        hostDeviceId,
        hostToken,
        sealedMetaB64,
      });
      this.relay.setAuth(this.identity.deviceId!, hostToken);
      // The seal frame goes out only after pair-finish landed, so the guest's
      // guest-finish can never race ahead of the flock existing on the relay
      // (guest-finish 409s while info.flockId is still null).
      await this.relay.pairMsg({
        nameplate,
        fromRole: "host",
        payloadB64: frameB64({ t: "seal", sealedB64: sealed }),
      });
      this.phase = "done";
    } catch (e) {
      if (this.stale(runId)) {
        // A newer run (restart/cancel) owns the phase now — never clobber it.
        return;
      }
      if (e instanceof PairingCancelled) {
        this.phase = "cancelled";
        return;
      }
      this.phase = "error";
      this.error = errMsg(e);
    }
  }

  /** Human tap: lets the host loop send the seal + finish. Resolves when done. */
  async confirmHost(): Promise<void> {
    const waiting =
      this.phase === "host-waiting-guest" ||
      this.phase === "host-confirm" ||
      this.phase === "host-finishing";
    if (!this.hostDone || !waiting) {
      throw new Error("No pairing session to confirm — start pairing first");
    }
    this.hostConfirmRequested = true;
    const resolve = this.hostConfirmResolve;
    this.hostConfirmResolve = null;
    resolve?.();
    await this.hostDone;
    if (this.phase !== "done") {
      // The host loop folds failures into phase="error"/"cancelled" without
      // rejecting — surface them here so the UI never celebrates a failure.
      throw new Error(this.error ?? "Pairing cancelled or failed");
    }
  }

  // ------------------------------------------------------------------- guest

  /**
   * Join via code (spaces or dashes accepted). Verifies the host's MAC and
   * stores + returns the 3-word fingerprint; does NOT join the flock until
   * confirmGuest() is called.
   */
  async join(code: string): Promise<string> {
    const runId = this.reset();
    try {
      const parsed = parseCode(code);
      this.guestCode = parsed;
      this.phase = "guest-joining";
      await this.joinLoop(runId, parsed);
      return this.fingerprint ?? "";
    } catch (e) {
      if (this.stale(runId)) return ""; // a newer run owns the phase
      if (e instanceof PairingCancelled) {
        this.phase = "cancelled";
        return "";
      }
      this.phase = "error";
      this.error = errMsg(e);
      return "";
    }
  }

  private async joinLoop(runId: number, parsed: ParsedCode): Promise<void> {
    const { nameplate, words } = parsed;
    const keys = await this.identity.ensureDevice();
    if (this.stale(runId)) throw new PairingCancelled();
    try {
      await this.relay.pairClaim({
        nameplate,
        guestDeviceId: keys.deviceId,
        guestPubKeyB64: keys.pubKeyB64,
        displayName: this.identity.displayName,
      });
    } catch (e) {
      // 409 "taken": almost always this same guest re-opening the link — continue
      // and let the MAC check prove whether we are really the claimer.
      if (!(e instanceof RelayError && e.code === "taken")) throw e;
    }

    const eph = await crypto.subtle.generateKey(ECDH_GEN, true, ["deriveBits"]);
    const pubB64 = await exportEcdhPubB64(eph.publicKey);
    await this.relay.pairMsg({
      nameplate,
      fromRole: "guest",
      payloadB64: frameB64({ t: "ek", pubB64 }),
    });

    // Host posts ek, then confirm (in that order) — need both.
    const frames = await this.pollInbox(runId, nameplate, (fs) => {
      const ek = lastFrame<EkFrame>(fs, "ek", "host");
      const confirm = lastFrame<ConfirmFrame>(fs, "confirm", "host");
      return ek !== null && confirm !== null;
    });
    if (this.stale(runId)) throw new PairingCancelled();
    const hostEk = lastFrame<EkFrame>(frames, "ek", "host");
    const hostConfirm = lastFrame<ConfirmFrame>(frames, "confirm", "host");
    if (!hostEk || typeof hostEk.pubB64 !== "string") throw new Error("Bad host key frame");
    if (!hostConfirm || typeof hostConfirm.macHex !== "string") {
      throw new Error("Bad host confirm frame");
    }

    const peerPub = await importSpkiEcdh(hostEk.pubB64);
    const shared = await ecdhShared(eph.privateKey, peerPub);
    const sKey = await deriveSessionKey(shared, nameplate, words[0], words[1]);
    this.sessionKey = sKey;
    const expectedMac = await hmacHex(sKey, "confirm");
    if (hostConfirm.macHex.toLowerCase() !== expectedMac) {
      throw new Error("Fingerprint mismatch — the code is wrong or the channel was tampered with. Start over.");
    }
    this.fingerprint =
      typeof hostConfirm.fingerprint === "string" && hostConfirm.fingerprint
        ? hostConfirm.fingerprint
        : await fingerprintWords(sKey);
    this.phase = "guest-confirm";
  }

  /** Human tap on the guest: open the seal, join the flock, register this device. */
  async confirmGuest(): Promise<void> {
    if (!this.guestCode || !this.sessionKey || this.phase !== "guest-confirm") {
      throw new Error("No pairing session to confirm — enter a code first");
    }
    const runId = this.runId;
    const { nameplate } = this.guestCode;
    const sKey = this.sessionKey;
    this.phase = "guest-finishing";
    try {
      const frames = await this.pollInbox(
        runId,
        nameplate,
        (fs) => lastFrame<SealFrame>(fs, "seal", "host") !== null
      );
      if (this.stale(runId)) throw new PairingCancelled();
      const sealFrame = lastFrame<SealFrame>(frames, "seal", "host");
      if (!sealFrame || typeof sealFrame.sealedB64 !== "string") throw new Error("Bad seal frame");
      const payload = await openJson<{ flockId: string; flockSecretB64: string }>(
        sKey,
        sealFrame.sealedB64
      );
      if (typeof payload.flockId !== "string" || typeof payload.flockSecretB64 !== "string") {
        throw new Error("Sealed flock metadata is malformed");
      }
      const secret = b64ToBytes(payload.flockSecretB64);
      const keys = await this.identity.ensureDevice();
      const guestToken = bytesToHex(randomBytes(32));
      await this.identity.setFlock(payload.flockId, secret, guestToken);
      await this.relay.guestFinish({
        nameplate,
        flockId: payload.flockId,
        guestDeviceId: keys.deviceId,
        guestPubKeyB64: keys.pubKeyB64,
        guestToken,
        displayName: this.identity.displayName,
      });
      this.relay.setAuth(keys.deviceId, guestToken);
      this.phase = "done";
    } catch (e) {
      if (this.stale(runId)) {
        // A newer run owns the phase — fail this call without clobbering it.
        throw e instanceof Error ? e : new Error(errMsg(e));
      }
      if (e instanceof PairingCancelled) {
        this.phase = "cancelled";
        throw new Error("Pairing cancelled");
      }
      this.phase = "error";
      this.error = errMsg(e);
      throw e;
    }
  }

  // ------------------------------------------------------------------- poll

  /** Poll the mailbox every 800ms until `ready` matches or TTL/cancel/404. */
  private async pollInbox(
    runId: number,
    nameplate: string,
    ready: (frames: PairFrame[]) => boolean,
    timeoutMs: number = PAIR_TTL_MS
  ): Promise<PairFrame[]> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    let notFoundStreak = 0;
    while (Date.now() < deadline) {
      if (this.stale(runId)) throw new PairingCancelled();
      try {
        const inbox = await this.relay.pairInbox(nameplate);
        lastError = null;
        notFoundStreak = 0;
        const frames = Array.isArray(inbox.frames) ? inbox.frames : [];
        if (ready(frames)) return frames;
      } catch (e) {
        if (e instanceof PairingCancelled) throw e;
        if (e instanceof RelayError && (e.status === 404 || e.code === "not_found")) {
          // Room may lag briefly right after start/claim; fatal once it persists.
          notFoundStreak++;
          if (notFoundStreak > 5) {
            throw new Error("Pairing room expired — start pairing again");
          }
        } else {
          notFoundStreak = 0;
          lastError = e; // transient network error: keep polling
        }
      }
      await sleep(800);
      if (this.stale(runId)) throw new PairingCancelled();
    }
    if (lastError) throw new Error(`Pairing failed: ${errMsg(lastError)}`);
    throw new Error("Pairing timed out — start again");
  }
}