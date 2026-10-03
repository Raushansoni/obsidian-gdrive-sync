import { WORDS } from "./wordlist";
import { utf8 } from "../crypto/bytes";
import { hkdf, hmacSha256 } from "../crypto/hkdf";

/**
 * Pairing codes: `nameplate-wordA-wordB` (e.g. `123-able-acid`).
 * Two words (8+8 bits) + 3-digit nameplate give the mailbox its guess resistance.
 * Words are also bound into the HKDF info string so a code cannot be transplanted
 * between sessions.
 */

export function formatHostCode(nameplate: string, wordA: string, wordB: string): string {
  return `${nameplate}-${wordA}-${wordB}`.toLowerCase();
}

export interface ParsedCode {
  nameplate: string;
  words: [string, string];
}

/** Accepts spaces or dashes between parts; lower-cases input. */
export function parseCode(input: string): ParsedCode {
  const cleaned = (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const parts = cleaned.split("-").filter(Boolean);
  if (parts.length < 3) {
    throw new Error("Pairing code looks wrong — expected digits-word-word (e.g. 123-able-acid)");
  }
  const nameplate = parts[0];
  if (!/^\d{3}$/.test(nameplate)) {
    throw new Error("The first part of the code must be 3 digits");
  }
  const w1 = parts[1];
  const w2 = parts[2];
  const dict = WORDS as readonly string[];
  if (!dict.includes(w1) || !dict.includes(w2)) {
    throw new Error("Unknown word in pairing code — check spelling");
  }
  return { nameplate, words: [w1, w2] };
}

/** Two uniformly random words from the 256-word list (crypto RNG). */
export function pickWords(): [string, string] {
  const buf = new Uint8Array(2);
  crypto.getRandomValues(buf);
  return [WORDS[buf[0]], WORDS[buf[1]]];
}

/** Deep-link payload encoded into the QR: obsidian://flock-sync?n=NAMEPLATE&c=code */
export function qrPayload(nameplate: string, code: string): string {
  return `obsidian://flock-sync?n=${encodeURIComponent(nameplate)}&c=${encodeURIComponent(code)}`;
}

/**
 * Turn scanned QR text into a pairing code (`737-baby-face`).
 * Accepts the deep link, a query string, or the code typed by hand.
 */
export function codeFromScanText(raw: string): string {
  const text = (raw ?? "").trim();
  if (!text) throw new Error("Empty QR");

  const q = text.indexOf("?");
  const qs = q >= 0 ? text.slice(q + 1) : text.includes("=") ? text : "";
  if (qs) {
    const fromQuery = codeFromQuery(qs);
    if (fromQuery) return fromQuery;
  }

  const direct = tryParseCode(text);
  if (direct) return direct;
  throw new Error("Not a Flock pairing QR");
}

function tryParseCode(value: string): string | null {
  try {
    const p = parseCode(value);
    return formatHostCode(p.nameplate, p.words[0], p.words[1]);
  } catch {
    return null;
  }
}

function codeFromQuery(qs: string): string | null {
  const params = new URLSearchParams(qs);
  const c = params.get("c") || params.get("code");
  if (c) {
    const direct = tryParseCode(c);
    if (direct) return direct;
    const n = params.get("n") || params.get("nameplate");
    if (n) {
      const combined = tryParseCode(`${n}-${c}`);
      if (combined) return combined;
    }
  }
  const n = params.get("n") || params.get("nameplate");
  const w = params.get("w") || params.get("words");
  if (n && w) return tryParseCode(`${n}-${w}`);
  return null;
}

/** HKDF info string binding the session key to the exact code shown to both humans. */
export function sessionKeyInfo(nameplate: string, w1: string, w2: string): string {
  return `flock-pair:${nameplate}:${w1}:${w2}`;
}

/** sessionKey = HKDF-SHA256(ecdhShared, "flock-pair:<nameplate>:<w1>:<w2>", 32) */
export async function deriveSessionKey(
  ecdhShared: Uint8Array,
  nameplate: string,
  w1: string,
  w2: string
): Promise<Uint8Array> {
  return hkdf(ecdhShared, sessionKeyInfo(nameplate, w1, w2), 32);
}

/**
 * Three-word fingerprint of the session key: HMAC-SHA256(sessionKey, "fp"),
 * first three bytes mapped through WORDS, joined with hyphens.
 * Both devices show this; humans compare before confirming.
 */
export async function fingerprintWords(sessionKey: Uint8Array): Promise<string> {
  const mac = await hmacSha256(sessionKey, utf8("fp"));
  return `${WORDS[mac[0]]}-${WORDS[mac[1]]}-${WORDS[mac[2]]}`;
}