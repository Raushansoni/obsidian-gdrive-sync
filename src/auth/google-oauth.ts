import { Platform, requestUrl } from "obsidian";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEVICE_CODE_ENDPOINT = "https://oauth2.googleapis.com/device/code";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/** drive.file = only files created/opened by this app — works across devices with same OAuth client. */
export const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "openid",
  "email",
].join(" ");

/** Device-code flow (mobile). Must match Google's allowed device scopes list. */
export const DEVICE_SCOPES = "https://www.googleapis.com/auth/drive.file openid email";

export const DESKTOP_REDIRECT_PORT = 42813;
export const DESKTOP_REDIRECT_URI = `http://127.0.0.1:${DESKTOP_REDIRECT_PORT}/`;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  scope?: string;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Exact Authorized redirect URI from Google Cloud credentials. */
  redirectUri?: string;
}

function randomState(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildAuthUrl(config: OAuthConfig, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export function extractCodeFromInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Empty authorization input");

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("obsidian://")) {
    try {
      const url = new URL(trimmed);
      const code = url.searchParams.get("code");
      if (code) return code;
      const err = url.searchParams.get("error");
      if (err) throw new Error(`OAuth error: ${err}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("OAuth error")) throw e;
    }
  }

  // Bare code
  if (/^[\w./\-]+$/.test(trimmed) && trimmed.length > 20) {
    return trimmed;
  }

  const match = trimmed.match(/[?&#]code=([^&\s]+)/);
  if (match?.[1]) return decodeURIComponent(match[1]);

  throw new Error("Could not find authorization code in the pasted text");
}

export async function exchangeCode(
  config: OAuthConfig,
  code: string,
  redirectUri: string
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (config.clientSecret) {
    body.set("client_secret", config.clientSecret);
  }

  const res = await requestUrl({
    url: TOKEN_ENDPOINT,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    throw: false,
  });

  if (res.status >= 400) {
    throw new Error(`Token exchange failed (${res.status}): ${res.text}`);
  }

  const data = res.json as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };

  if (!data.access_token) {
    throw new Error("Token exchange returned no access_token");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? "",
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
    tokenType: data.token_type ?? "Bearer",
    scope: data.scope,
  };
}

export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    grant_type: "refresh_token",
  });
  if (config.clientSecret) {
    body.set("client_secret", config.clientSecret);
  }

  const res = await requestUrl({
    url: TOKEN_ENDPOINT,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    throw: false,
  });

  if (res.status >= 400) {
    throw new Error(`Token refresh failed (${res.status}): ${res.text}`);
  }

  const data = res.json as {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope?: string;
    refresh_token?: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
    tokenType: data.token_type ?? "Bearer",
    scope: data.scope,
  };
}

export async function revokeToken(token: string): Promise<void> {
  try {
    await requestUrl({
      url: `${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`,
      method: "POST",
      throw: false,
    });
  } catch {
    // ignore revoke errors
  }
}

/**
 * Desktop: local loopback server captures the redirect.
 * Mobile: opens browser; caller collects code via paste / protocol handler.
 */
export class GoogleOAuth {
  private pendingState: string | null = null;
  private pendingRedirectUri: string = DESKTOP_REDIRECT_URI;
  private serverCloser: (() => void) | null = null;

  getRedirectUri(): string {
    return this.pendingRedirectUri;
  }

  getPendingState(): string | null {
    return this.pendingState;
  }

  getPendingRedirectUri(): string {
    return this.pendingRedirectUri;
  }

  /** Restore redirect used for an in-flight auth (needed after mobile app switch). */
  setPendingRedirectUri(redirectUri: string): void {
    this.pendingRedirectUri = redirectUri.trim() || DESKTOP_REDIRECT_URI;
  }

  beginAuth(config: OAuthConfig): { authUrl: string; redirectUri: string; state: string } {
    this.cancelPending();
    this.pendingState = randomState();
    this.pendingRedirectUri = (config.redirectUri || DESKTOP_REDIRECT_URI).trim() || DESKTOP_REDIRECT_URI;
    const authUrl = buildAuthUrl(config, this.pendingRedirectUri, this.pendingState);
    return { authUrl, redirectUri: this.pendingRedirectUri, state: this.pendingState };
  }

  usesLoopback(redirectUri: string): boolean {
    return (
      redirectUri.startsWith("http://127.0.0.1:") ||
      redirectUri.startsWith("http://localhost:")
    );
  }

  private loopbackListenTarget(redirectUri: string): { host: string; port: number; base: string } {
    const u = new URL(redirectUri);
    const port = u.port ? Number(u.port) : DESKTOP_REDIRECT_PORT;
    // Prefer 127.0.0.1 for the socket — browsers hitting localhost may use IPv6 (::1)
    // and get CONNECTION_REFUSED if we only bind IPv4 under the name "localhost".
    const host = "127.0.0.1";
    const base = `http://127.0.0.1:${port}`;
    return { host, port, base };
  }

  async connectDesktop(config: OAuthConfig): Promise<OAuthTokens> {
    if (!Platform.isDesktopApp) {
      throw new Error("Loopback OAuth is only available on desktop");
    }

    // Force IPv4 loopback for the desktop capture server (avoids localhost → ::1 refused).
    const desktopConfig: OAuthConfig = {
      ...config,
      redirectUri: DESKTOP_REDIRECT_URI,
    };
    const { authUrl, redirectUri, state } = this.beginAuth(desktopConfig);

    // Web-client https redirects cannot be captured by a local server.
    if (!this.usesLoopback(redirectUri)) {
      window.open(authUrl);
      throw new Error(
        "Browser opened for Google sign-in. When redirected back to your site, Obsidian should open automatically — or paste the URL/code in settings."
      );
    }

    const { host, port, base } = this.loopbackListenTarget(redirectUri);

    const code = await new Promise<string>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const http = require("http") as typeof import("http");
      const server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url ?? "/", `${base}/`);
          const err = url.searchParams.get("error");
          const codeParam = url.searchParams.get("code");
          const st = url.searchParams.get("state");

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          if (err) {
            res.end(`<h1>Auth failed</h1><p>${err}</p><p>You can close this window.</p>`);
            cleanup();
            reject(new Error(`OAuth error: ${err}`));
            return;
          }
          if (!codeParam) {
            res.end("<h1>Missing code</h1>");
            return;
          }
          if (st !== state) {
            res.end("<h1>Invalid state</h1>");
            cleanup();
            reject(new Error("OAuth state mismatch"));
            return;
          }
          res.end(
            "<h1>Connected</h1><p>Google Drive Sync is authorized. Return to Obsidian.</p>"
          );
          cleanup();
          resolve(codeParam);
        } catch (e) {
          cleanup();
          reject(e);
        }
      });

      const cleanup = () => {
        try {
          server.close();
        } catch {
          /* ignore */
        }
        this.serverCloser = null;
      };
      this.serverCloser = cleanup;

      server.listen(port, host, () => {
        window.open(authUrl);
      });
      server.on("error", (e) => {
        cleanup();
        reject(e);
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        cleanup();
        reject(new Error("OAuth timed out — try again or paste the auth code manually"));
      }, 5 * 60 * 1000);
    });

    const tokens = await exchangeCode(config, code, redirectUri);
    if (!tokens.refreshToken) {
      throw new Error(
        "No refresh token received. Remove the app from https://myaccount.google.com/permissions and connect again."
      );
    }
    this.pendingState = null;
    return tokens;
  }

  /** Open browser for mobile / manual flow. */
  openBrowserAuth(config: OAuthConfig): { redirectUri: string } {
    const { authUrl, redirectUri } = this.beginAuth(config);
    window.open(authUrl);
    return { redirectUri };
  }

  /**
   * OAuth 2.0 device authorization (TV / limited-input).
   * No redirect URI — used on mobile (and as desktop fallback).
   * Requires an OAuth client of type “TVs and Limited Input devices”.
   */
  async connectDeviceFlow(
    config: OAuthConfig,
    onUserCode: (info: {
      userCode: string;
      verificationUrl: string;
      expiresIn: number;
    }) => void,
    shouldCancel?: () => boolean
  ): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      client_id: config.clientId,
      scope: DEVICE_SCOPES,
    });
    const start = await requestUrl({
      url: DEVICE_CODE_ENDPOINT,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      throw: false,
    });
    if (start.status >= 400) {
      throw new Error(
        `Device auth start failed (${start.status}): ${start.text}. ` +
          `Create an OAuth client type “TVs and Limited Input devices” (no redirect URIs).`
      );
    }
    const data = start.json as {
      device_code: string;
      user_code: string;
      verification_url: string;
      verification_uri?: string;
      expires_in: number;
      interval?: number;
    };
    const verificationUrl = data.verification_uri || data.verification_url || "https://www.google.com/device";
    onUserCode({
      userCode: data.user_code,
      verificationUrl,
      expiresIn: data.expires_in,
    });

    let intervalMs = Math.max(5, data.interval ?? 5) * 1000;
    const deadline = Date.now() + data.expires_in * 1000;

    while (Date.now() < deadline) {
      if (shouldCancel?.()) throw new Error("Device auth cancelled");
      await sleep(intervalMs);
      if (shouldCancel?.()) throw new Error("Device auth cancelled");

      const pollBody = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        device_code: data.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      const poll = await requestUrl({
        url: TOKEN_ENDPOINT,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: pollBody.toString(),
        throw: false,
      });
      const json = poll.json as {
        error?: string;
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
        scope?: string;
      };

      if (poll.status < 400 && json.access_token) {
        if (!json.refresh_token) {
          throw new Error(
            "No refresh token from device flow. Revoke app access at Google Account permissions and retry."
          );
        }
        return {
          accessToken: json.access_token,
          refreshToken: json.refresh_token,
          expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
          tokenType: json.token_type ?? "Bearer",
          scope: json.scope,
        };
      }

      if (json.error === "authorization_pending") continue;
      if (json.error === "slow_down") {
        intervalMs += 5000;
        continue;
      }
      if (json.error === "access_denied") throw new Error("Google access was denied");
      if (json.error === "expired_token") throw new Error("Device code expired — tap Connect again");
      throw new Error(`Device auth failed: ${json.error || poll.text}`);
    }
    throw new Error("Device auth timed out — tap Connect again");
  }

  async completeWithCode(config: OAuthConfig, rawInput: string): Promise<OAuthTokens> {
    const code = extractCodeFromInput(rawInput);
    const redirectUri =
      (config.redirectUri || "").trim() || this.pendingRedirectUri || DESKTOP_REDIRECT_URI;
    this.pendingRedirectUri = redirectUri;
    const tokens = await exchangeCode(config, code, redirectUri);
    if (!tokens.refreshToken) {
      throw new Error(
        "No refresh token received. Revoke prior access at Google Account permissions and retry with prompt=consent."
      );
    }
    this.pendingState = null;
    return tokens;
  }

  cancelPending(): void {
    if (this.serverCloser) {
      this.serverCloser();
      this.serverCloser = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
