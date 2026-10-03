declare const __FLOCK_RELAY_URL__: string;

/** Permanent Cloudflare Worker. Phones and the PC both use this. */
export const PERMANENT_RELAY_URL = "https://flock-relay.raushansoni54321.workers.dev";

export const DEFAULT_RELAY_URL =
  typeof __FLOCK_RELAY_URL__ !== "undefined" && __FLOCK_RELAY_URL__
    ? __FLOCK_RELAY_URL__
    : PERMANENT_RELAY_URL;

/** Local wrangler and Quick Tunnels are temporary. The permanent Worker replaces them. */
export function isEphemeralRelayUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host.endsWith(".trycloudflare.com");
  } catch {
    return false;
  }
}
