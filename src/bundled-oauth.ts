/**
 * Optional OAuth client baked in at build time (esbuild define from .env / CI secrets).
 * Source stays empty; release builds can inject values so mobile BRAT installs work
 * without pasting Client ID first.
 */
declare const __GDRIVE_CLIENT_ID__: string;
declare const __GDRIVE_CLIENT_SECRET__: string;
declare const __GDRIVE_REDIRECT_URI__: string;
declare const __GDRIVE_MOBILE_REDIRECT_URI__: string;

export const BUNDLED_CLIENT_ID =
  typeof __GDRIVE_CLIENT_ID__ !== "undefined" ? __GDRIVE_CLIENT_ID__ : "";
export const BUNDLED_CLIENT_SECRET =
  typeof __GDRIVE_CLIENT_SECRET__ !== "undefined" ? __GDRIVE_CLIENT_SECRET__ : "";
export const BUNDLED_REDIRECT_URI =
  typeof __GDRIVE_REDIRECT_URI__ !== "undefined" && __GDRIVE_REDIRECT_URI__
    ? __GDRIVE_REDIRECT_URI__
    : "http://127.0.0.1:42813/";

/** HTTPS callback (GitHub Pages) — mobile cannot use loopback; that causes CONNECTION_REFUSED. */
export const BUNDLED_MOBILE_REDIRECT_URI =
  typeof __GDRIVE_MOBILE_REDIRECT_URI__ !== "undefined" && __GDRIVE_MOBILE_REDIRECT_URI__
    ? __GDRIVE_MOBILE_REDIRECT_URI__
    : "https://raushansoni.github.io/obsidian-gdrive-sync/oauth-callback.html";

/** Prefer IPv4 loopback on desktop. */
export const RECOMMENDED_REDIRECT_URI = "http://127.0.0.1:42813/";
