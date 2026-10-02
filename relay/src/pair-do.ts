// PairingRoom: untrusted mailbox Durable Object, one per 3-digit nameplate
// (DO id = idFromName(nameplate), SQLite-backed class).
//
// Stores pairing identities + opaque base64 frames (relay never decrypts them).
// A single guest may claim a room; an alarm at `expiresAt` deletes the room.
//
// RPC surface (worker calls stub.fetch with a JSON body; op comes from the path):
//   POST /start        { hostDeviceId, hostPubKeyB64, displayName, expiresAt }
//   POST /claim        { guestDeviceId, guestPubKeyB64, displayName }
//   POST /msg          { fromRole, payloadB64 }        -> { id }
//   POST /inbox        {}                              -> { expiresAt, claimed, frames, expired }
//   POST /markFinished { flockId }
//   POST /info         {}   (host/guest identities, used by pair finish flows)

// @ts-expect-error "cloudflare:workers" is a runtime module provided by workerd; no types package is shipped.
import { DurableObject } from "cloudflare:workers";
import { asString, isRole, readJsonObject, replyJson } from "./http";
import type { DoFailure } from "./http";
import type { PairFrame, Role } from "./protocol";

interface PairState {
  hostDeviceId: string;
  hostPubKey: string;
  hostName: string;
  guestDeviceId: string | null;
  guestPubKey: string | null;
  guestName: string | null;
  claimed: boolean;
  expiresAt: number;
  /** Set once the host (or guest) finishes pairing. */
  flockId: string | null;
}

const STATE_KEY = "state";

export type StartResult = { ok: true; expiresAt: number } | DoFailure;
export type ClaimResult = { ok: true } | DoFailure;
export type MsgResult = { ok: true; id: number } | DoFailure;
export type InboxResult = {
  ok: true;
  expiresAt: number;
  claimed: boolean;
  expired: boolean;
  frames: PairFrame[];
} | DoFailure;
export type MarkFinishedResult = { ok: true } | DoFailure;
export type InfoResult = {
  ok: true;
  expired: boolean;
  claimed: boolean;
  expiresAt: number;
  hostDeviceId: string;
  hostPubKey: string;
  hostName: string;
  guestDeviceId: string | null;
  guestPubKey: string | null;
  guestName: string | null;
  flockId: string | null;
} | DoFailure;

export class PairingRoom extends DurableObject {
  private readonly sql: SqlStorage;
  private readonly storage: DurableObjectStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS frames (id INTEGER PRIMARY KEY AUTOINCREMENT, from_role TEXT, payload TEXT)"
    );
  }

  async fetch(req: Request): Promise<Response> {
    const op = new URL(req.url).pathname.replace(/^\/+/, "");
    try {
      if (op === "inbox") return replyJson(await this.inbox());
      if (op === "info") return replyJson(await this.info());

      const body = await readJsonObject(req);
      if (!body) return replyJson({ ok: false, code: "bad_request", error: "invalid JSON body" });

      switch (op) {
        case "start":
          return replyJson(await this.start(body));
        case "claim":
          return replyJson(await this.claim(body));
        case "msg":
          return replyJson(await this.msg(body));
        case "markFinished":
          return replyJson(await this.markFinished(body));
        default:
          return replyJson({ ok: false, code: "not_found", error: `unknown pairing op: ${op}` });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return replyJson({ ok: false, code: "internal", error: message });
    }
  }

  /** Alarm at expiresAt deletes the whole room. */
  async alarm(): Promise<void> {
    const state = await this.loadState();
    if (state && state.expiresAt > Date.now()) {
      // Stray early alarm: reschedule instead of deleting a live room.
      await this.storage.setAlarm(state.expiresAt);
      return;
    }
    this.sql.exec("DELETE FROM frames");
    await this.storage.deleteAll();
  }

  // ------------------------------------------------------------------ ops ---

  private async start(body: Record<string, unknown>): Promise<StartResult> {
    const hostDeviceId = asString(body.hostDeviceId);
    const hostPubKey = asString(body.hostPubKeyB64);
    const hostName = asString(body.displayName);
    const expiresAt =
      typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
        ? Math.floor(body.expiresAt)
        : null;
    if (!hostDeviceId || !hostPubKey || !hostName || expiresAt === null) {
      return {
        ok: false,
        code: "bad_request",
        error: "hostDeviceId, hostPubKeyB64, displayName and expiresAt are required",
      };
    }

    const existing = await this.loadState();
    if (existing && !PairingRoom.isExpired(existing)) {
      // Live room: only the original host may (idempotently) re-start it,
      // and never once a guest has claimed it.
      if (existing.claimed || existing.hostDeviceId !== hostDeviceId) {
        return { ok: false, code: "taken", error: "nameplate in use" };
      }
      return { ok: true, expiresAt: existing.expiresAt };
    }

    const state: PairState = {
      hostDeviceId,
      hostPubKey,
      hostName,
      guestDeviceId: null,
      guestPubKey: null,
      guestName: null,
      claimed: false,
      expiresAt,
      flockId: null,
    };
    await this.storage.put(STATE_KEY, state);
    this.sql.exec("DELETE FROM frames");
    await this.storage.setAlarm(expiresAt);
    return { ok: true, expiresAt };
  }

  private async claim(body: Record<string, unknown>): Promise<ClaimResult> {
    const guestDeviceId = asString(body.guestDeviceId);
    const guestPubKey = asString(body.guestPubKeyB64);
    const guestName = asString(body.displayName);
    if (!guestDeviceId || !guestPubKey || !guestName) {
      return {
        ok: false,
        code: "bad_request",
        error: "guestDeviceId, guestPubKeyB64 and displayName are required",
      };
    }

    const state = await this.loadState();
    if (!state) return { ok: false, code: "not_found", error: "no pairing room for this nameplate" };
    if (PairingRoom.isExpired(state)) return { ok: false, code: "expired", error: "pairing room expired" };
    if (state.claimed) return { ok: false, code: "taken", error: "nameplate already claimed" };

    await this.storage.put(STATE_KEY, {
      ...state,
      claimed: true,
      guestDeviceId,
      guestPubKey,
      guestName,
    });
    return { ok: true };
  }

  private async msg(body: Record<string, unknown>): Promise<MsgResult> {
    const fromRole: unknown = body.fromRole;
    const payloadB64 = asString(body.payloadB64);
    if (!isRole(fromRole) || !payloadB64) {
      return { ok: false, code: "bad_request", error: "fromRole (host|guest) and payloadB64 are required" };
    }

    const state = await this.loadState();
    if (!state) return { ok: false, code: "not_found", error: "no pairing room for this nameplate" };
    if (PairingRoom.isExpired(state)) return { ok: false, code: "expired", error: "pairing room expired" };

    this.sql.exec("INSERT INTO frames (from_role, payload) VALUES (?, ?)", fromRole, payloadB64);
    const row = this.sql.exec<{ id: number | null }>("SELECT MAX(id) AS id FROM frames").one();
    return { ok: true, id: Number(row.id ?? 0) };
  }

  private async inbox(): Promise<InboxResult> {
    const state = await this.loadState();
    if (!state) return { ok: false, code: "not_found", error: "no pairing room for this nameplate" };

    const rows = this.sql
      .exec<{ id: number; from_role: string; payload: string }>(
        "SELECT id, from_role, payload FROM frames ORDER BY id ASC"
      )
      .toArray();
    const frames: PairFrame[] = rows.map((row) => ({
      id: Number(row.id),
      fromRole: row.from_role as Role,
      payloadB64: row.payload,
    }));
    return {
      ok: true,
      expiresAt: state.expiresAt,
      claimed: state.claimed,
      expired: PairingRoom.isExpired(state),
      frames,
    };
  }

  private async markFinished(body: Record<string, unknown>): Promise<MarkFinishedResult> {
    const flockId = asString(body.flockId);
    if (!flockId) return { ok: false, code: "bad_request", error: "flockId is required" };

    const state = await this.loadState();
    if (!state) return { ok: false, code: "not_found", error: "no pairing room for this nameplate" };

    await this.storage.put(STATE_KEY, { ...state, flockId });
    return { ok: true };
  }

  private async info(): Promise<InfoResult> {
    const state = await this.loadState();
    if (!state) return { ok: false, code: "not_found", error: "no pairing room for this nameplate" };
    return {
      ok: true,
      expired: PairingRoom.isExpired(state),
      claimed: state.claimed,
      expiresAt: state.expiresAt,
      hostDeviceId: state.hostDeviceId,
      hostPubKey: state.hostPubKey,
      hostName: state.hostName,
      guestDeviceId: state.guestDeviceId,
      guestPubKey: state.guestPubKey,
      guestName: state.guestName,
      flockId: state.flockId,
    };
  }

  // --------------------------------------------------------------- helpers ---

  private async loadState(): Promise<PairState | undefined> {
    return this.storage.get<PairState>(STATE_KEY);
  }

  private static isExpired(state: PairState): boolean {
    return Date.now() >= state.expiresAt;
  }
}
