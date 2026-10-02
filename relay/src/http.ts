// Shared HTTP plumbing: JSON responses, typed errors, CORS, body parsing.
// Also hosts the small result contract used by the Durable Object RPC surface
// (PairingRoom / VaultLog talk to the worker via stub.fetch + JSON).

import type { ErrorBody, Role } from "./protocol";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** CORS-enabled JSON response. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** Error body per protocol: { error, code } with a 4xx/5xx status. */
export function err(status: number, code: ErrorBody["code"], error: string): Response {
  return json({ error, code } satisfies ErrorBody, status);
}

/** CORS preflight response (204). */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Serialize a Durable Object internal result as JSON. */
export function replyJson(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

/** Parses a JSON object body; returns null for anything malformed. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json();
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Non-empty string extractor for loose JSON bodies. */
export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function isRole(value: unknown): value is Role {
  return value === "host" || value === "guest";
}

/** Failure shape returned by PairingRoom / VaultLog ops. */
export interface DoFailure {
  ok: false;
  code: ErrorBody["code"];
  error: string;
}

const DO_ERROR_STATUS: Record<ErrorBody["code"], number> = {
  bad_request: 400,
  not_found: 404,
  expired: 410,
  taken: 409,
  unauthorized: 401,
  conflict: 409,
  too_large: 413,
  rate_limited: 429,
  internal: 500,
};

/** Maps a DO op failure onto an HTTP error response. */
export function doErrorToResponse(failure: DoFailure): Response {
  return err(DO_ERROR_STATUS[failure.code], failure.code, failure.error);
}
