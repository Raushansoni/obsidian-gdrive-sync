// VaultLog: per-vault append-only op log Durable Object (SQLite-backed class,
// DO id = idFromName(vaultId)).
//
// Signature verification happens in the worker; the DO only stores assigned
// sequence numbers, serves pulls and computes the merkle root over live tips.
//
// RPC surface (worker calls stub.fetch with a JSON body; op comes from the path):
//   POST /push    { ops: SignedOp[] }        -> { seqs: number[], head }
//   POST /pull    { after: number }          -> { ops: SignedOp[], head }   (limit 200)
//   POST /merkle  {}                         -> { root, head }

// @ts-expect-error "cloudflare:workers" is a runtime module provided by workerd; no types package is shipped.
import { DurableObject } from "cloudflare:workers";
import { sha256Hex } from "./d1";
import { readJsonObject, replyJson } from "./http";
import type { DoFailure } from "./http";
import type { SignedOp } from "./protocol";

const PULL_LIMIT = 200;

interface OpRow {
  seq: number;
  device_id: string;
  path_cipher: string;
  blob_hash: string | null;
  prev_hash: string | null;
  hlc: string;
  vv_json: string;
  sig: string;
}

export type VaultPushResult = { ok: true; seqs: number[]; head: number } | DoFailure;
export type VaultPullResult = { ok: true; ops: SignedOp[]; head: number } | DoFailure;
export type VaultMerkleResult = { ok: true; root: string; head: number } | DoFailure;

export class VaultLog extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ops (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT,
        path_cipher TEXT,
        blob_hash TEXT,
        prev_hash TEXT,
        hlc TEXT,
        vv_json TEXT,
        sig TEXT,
        created_at INTEGER
      )`
    );
  }

  async fetch(req: Request): Promise<Response> {
    const op = new URL(req.url).pathname.replace(/^\/+/, "");
    try {
      const body = await readJsonObject(req);
      switch (op) {
        case "push": {
          if (!body) return replyJson({ ok: false, code: "bad_request", error: "invalid JSON body" });
          return replyJson(await this.push(body));
        }
        case "pull": {
          const after = body && typeof body.after === "number" ? body.after : 0;
          return replyJson(await this.pull(after));
        }
        case "merkle":
          return replyJson(await this.merkle());
        default:
          return replyJson({ ok: false, code: "not_found", error: `unknown vault op: ${op}` });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return replyJson({ ok: false, code: "internal", error: message });
    }
  }

  // ------------------------------------------------------------------ ops ---

  private async push(body: Record<string, unknown>): Promise<VaultPushResult> {
    const rawOps: unknown = body.ops;
    if (!Array.isArray(rawOps)) {
      return { ok: false, code: "bad_request", error: "ops must be an array" };
    }

    // Storage SQL calls below are synchronous, so this loop cannot interleave
    // with any other op inside the single-threaded DO event loop.
    const seqs: number[] = [];
    for (const raw of rawOps) {
      if (raw === null || typeof raw !== "object") {
        return { ok: false, code: "bad_request", error: "each op must be an object" };
      }
      const op = raw as SignedOp;
      if (
        typeof op.deviceId !== "string" ||
        typeof op.pathCipherB64 !== "string" ||
        typeof op.hlc !== "string" ||
        typeof op.sigB64 !== "string"
      ) {
        return { ok: false, code: "bad_request", error: "op is missing required string fields" };
      }

      this.sql.exec(
        `INSERT INTO ops (device_id, path_cipher, blob_hash, prev_hash, hlc, vv_json, sig, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        op.deviceId,
        op.pathCipherB64,
        op.blobHash ?? "", // empty string marks a tombstone
        op.prevHash ?? "",
        op.hlc,
        JSON.stringify(op.versionVector ?? {}),
        op.sigB64,
        Date.now()
      );
      seqs.push(this.headValue());
    }

    return { ok: true, seqs, head: this.headValue() };
  }

  private async pull(after: number): Promise<VaultPullResult> {
    const rows = this.sql
      .exec<OpRow>(
        "SELECT seq, device_id, path_cipher, blob_hash, prev_hash, hlc, vv_json, sig FROM ops WHERE seq > ? ORDER BY seq ASC LIMIT ?",
        after,
        PULL_LIMIT
      )
      .toArray();
    return { ok: true, ops: rows.map(toSignedOp), head: this.headValue() };
  }

  private async merkle(): Promise<VaultMerkleResult> {
    // Latest row per path_cipher (max seq wins: tombstone overwrites the tip).
    const rows = this.sql
      .exec<{ path_cipher: string; blob_hash: string | null }>(
        `SELECT o.path_cipher AS path_cipher, o.blob_hash AS blob_hash
         FROM ops o
         JOIN (SELECT path_cipher AS pc, MAX(seq) AS max_seq FROM ops GROUP BY path_cipher) latest
           ON o.path_cipher = latest.pc AND o.seq = latest.max_seq`
      )
      .toArray();

    const tips: Record<string, string | null> = {};
    for (const row of rows) {
      tips[row.path_cipher] = row.blob_hash && row.blob_hash.length > 0 ? row.blob_hash : null;
    }
    const canonical = JSON.stringify(
      Object.fromEntries(Object.keys(tips).sort().map((k) => [k, tips[k]]))
    );
    return { ok: true, root: await sha256Hex(canonical), head: this.headValue() };
  }

  // --------------------------------------------------------------- helpers ---

  private headValue(): number {
    const row = this.sql.exec<{ head: number | null }>("SELECT MAX(seq) AS head FROM ops").one();
    return Number(row.head ?? 0);
  }
}

function toSignedOp(row: OpRow): SignedOp {
  let versionVector: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(row.vv_json);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const vv: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" && Number.isFinite(v)) vv[k] = v;
      }
      versionVector = vv;
    }
  } catch {
    // Malformed vv_json should never happen (we wrote it); default to {}.
  }
  return {
    seq: Number(row.seq),
    deviceId: row.device_id,
    pathCipherB64: row.path_cipher,
    blobHash: row.blob_hash && row.blob_hash.length > 0 ? row.blob_hash : null,
    prevHash: row.prev_hash && row.prev_hash.length > 0 ? row.prev_hash : null,
    hlc: row.hlc,
    versionVector,
    sigB64: row.sig,
  };
}
