// Device authentication.
//
// Header format: `Authorization: Device {deviceId} {token}`.
// Tokens are stored only as SHA-256 hex digests; comparison is constant-time.

import { getDevice, sha256Hex, timingSafeEqualHex } from "./d1";
import type { DeviceRow } from "./d1";

const DEVICE_AUTH_RE = /^Device\s+(\S+)\s+(\S+)\s*$/;

/** Authenticates via the Authorization header. Returns null on any failure (incl. revoked). */
export async function authenticateRequest(req: Request, env: Env): Promise<DeviceRow | null> {
  const header = req.headers.get("Authorization") ?? "";
  const match = DEVICE_AUTH_RE.exec(header.trim());
  if (!match) return null;
  return authenticateDevice(env, match[1], match[2]);
}

/** Authenticates an explicit deviceId/token pair (e.g. body-carried credentials). */
export async function authenticateDevice(
  env: Env,
  deviceId: string,
  token: string
): Promise<DeviceRow | null> {
  const device = await getDevice(env, deviceId);
  if (!device) return null;
  const hash = await sha256Hex(token);
  if (!timingSafeEqualHex(hash, device.token_sha256)) return null;
  if (device.revoked !== 0) return null;
  return device;
}
