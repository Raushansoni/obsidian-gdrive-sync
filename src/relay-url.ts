/**
 * Relay URL checks shared by settings UI and the HTTP client.
 * Phones cannot reach the desktop wrangler bind (127.0.0.1) and Obsidian
 * mobile rejects cleartext HTTP.
 */

export function isLoopbackRelayUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

export function isCleartextHttp(url: string): boolean {
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return false;
  }
}

/** Human-readable reason this URL cannot be used, or null if it looks reachable. */
export function relayUrlProblem(url: string, isMobile: boolean): string | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return "Relay URL is empty.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `Relay URL is not a valid URL: ${trimmed}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Relay URL must start with https:// (or http:// on desktop only).";
  }
  if (isMobile && isLoopbackRelayUrl(trimmed)) {
    return "This phone cannot reach 127.0.0.1 — that address is the phone itself, not your PC. Set Relay URL to an https:// Cloudflare Worker that both devices share.";
  }
  if (isMobile && isCleartextHttp(trimmed)) {
    return "Obsidian on Android/iOS blocks http://. Set Relay URL to an https:// Cloudflare Worker (the same URL as on your PC).";
  }
  return null;
}

export function explainRelayNetworkError(err: unknown, baseUrl: string, isMobile: boolean): string {
  const blocked = relayUrlProblem(baseUrl, isMobile);
  if (blocked) return blocked;
  const raw = err instanceof Error ? err.message : String(err);
  if (/CLEARTEXT|cleartext/i.test(raw)) {
    return `Android blocked cleartext HTTP to ${baseUrl}. Set Relay URL to https://.`;
  }
  if (/ConnectException|Failed to connect|ECONNREFUSED|ENOTFOUND|NetworkError|net::ERR|Failed to fetch/i.test(raw)) {
    return isMobile
      ? `Cannot reach the relay at ${baseUrl}. On a phone this must be an https:// URL both devices share — not localhost.`
      : `Cannot reach the relay at ${baseUrl}. Is wrangler running?`;
  }
  return raw.replace(/\s+/g, " ").trim() || "Request failed";
}
