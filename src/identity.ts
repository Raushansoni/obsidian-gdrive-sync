import { App, Platform } from "obsidian";
import { IDENTITY_LS_KEY, IDENTITY_SECRET_NAME } from "./protocol";
import { b64ToBytes, bytesToB64, bytesToHex, randomBytes } from "./crypto/bytes";
import {
  generateDeviceKeys,
  importDeviceKeys,
  type DeviceKeys,
  type KeyBundle,
} from "./crypto/p256";
import { WORDS } from "./pair/wordlist";

/**
 * Device + flock identity, persisted twice:
 *  1. window.localStorage[IDENTITY_LS_KEY] — always (raw value, not app.saveLocalStorage)
 *  2. app.secretStorage (Obsidian 1.11.4+) — best effort, wrapped in try/catch
 * Load prefers SecretStorage, then localStorage.
 */

interface IdentityJson {
  bundle: KeyBundle | null;
  flockId: string | null;
  flockSecretB64: string | null;
  deviceToken: string | null;
  displayName: string;
}

interface SecretStorageLike {
  getSecret(name: string): string | null | Promise<string | null>;
  setSecret(name: string, value: string): unknown | Promise<unknown>;
}

function parseIdentityJson(raw: string): IdentityJson | null {
  try {
    const j = JSON.parse(raw) as Partial<IdentityJson> | null;
    if (typeof j !== "object" || j === null) return null;
    return {
      bundle: (j.bundle as KeyBundle | undefined) ?? null,
      flockId: typeof j.flockId === "string" ? j.flockId : null,
      flockSecretB64: typeof j.flockSecretB64 === "string" ? j.flockSecretB64 : null,
      deviceToken: typeof j.deviceToken === "string" ? j.deviceToken : null,
      displayName: typeof j.displayName === "string" ? j.displayName : "",
    };
  } catch {
    return null;
  }
}

export class IdentityStore {
  deviceId: string | null = null;
  deviceToken: string | null = null;
  flockId: string | null = null;
  flockSecret: Uint8Array | null = null;
  displayName: string;
  keys: DeviceKeys | null = null;

  private app: App;

  constructor(app: App) {
    this.app = app;
    this.displayName = Platform.isMobile ? "Phone" : "Desktop";
  }

  /** Obsidian 1.11.4 secretStorage, typed loosely so older API stubs still compile. */
  private secretStorage(): SecretStorageLike | null {
    const ss = (
      this.app as unknown as { secretStorage?: Partial<SecretStorageLike> }
    ).secretStorage;
    if (ss && typeof ss.getSecret === "function" && typeof ss.setSecret === "function") {
      return ss as SecretStorageLike;
    }
    return null;
  }

  hasFlock(): boolean {
    return !!(this.flockId && this.flockSecret && this.deviceToken && this.keys);
  }

  async load(): Promise<void> {
    const json = await this.readPersisted();
    if (!json) {
      this.deviceToken = bytesToHex(randomBytes(32));
      return;
    }
    if (json.displayName) this.displayName = json.displayName;
    this.flockId = json.flockId;
    this.flockSecret = json.flockSecretB64 ? b64ToBytes(json.flockSecretB64) : null;
    this.deviceToken = json.deviceToken ?? bytesToHex(randomBytes(32));
    if (json.bundle) {
      try {
        this.keys = await importDeviceKeys(json.bundle);
        this.deviceId = this.keys.deviceId;
      } catch {
        // Corrupt key material: drop the relay token so hasFlock() is false and
        // this device can re-join. Keep flockSecret until setFlock() overwrites it.
        this.keys = null;
        this.deviceId = null;
        this.deviceToken = null;
      }
    }
  }

  async save(): Promise<void> {
    const json: IdentityJson = {
      bundle: this.keys?.bundle ?? null,
      flockId: this.flockId,
      flockSecretB64: this.flockSecret ? bytesToB64(this.flockSecret) : null,
      deviceToken: this.deviceToken,
      displayName: this.displayName,
    };
    const raw = JSON.stringify(json);
    // 1. localStorage — always.
    try {
      window.localStorage.setItem(IDENTITY_LS_KEY, raw);
    } catch {
      // storage may be unavailable (private mode) — secretStorage may still work
    }
    // 2. secretStorage — Obsidian 1.11.4+, best effort.
    const ss = this.secretStorage();
    if (ss) {
      try {
        await ss.setSecret(IDENTITY_SECRET_NAME, raw);
      } catch {
        // fall back to localStorage copy above
      }
    }
  }

  private async readPersisted(): Promise<IdentityJson | null> {
    // Prefer secretStorage (keychain / credential vault) over localStorage.
    const ss = this.secretStorage();
    if (ss) {
      try {
        const v = await ss.getSecret(IDENTITY_SECRET_NAME);
        if (typeof v === "string" && v) {
          const parsed = parseIdentityJson(v);
          if (parsed) return parsed;
        }
      } catch {
        // fall through to localStorage
      }
    }
    try {
      const raw = window.localStorage.getItem(IDENTITY_LS_KEY);
      if (raw) return parseIdentityJson(raw);
    } catch {
      // no localStorage
    }
    return null;
  }

  /** Device key pair: generate once, then persist and reuse forever. */
  async ensureDevice(): Promise<DeviceKeys> {
    if (!this.keys) {
      // Flock secret with no token: keys were unreadable. Mint a new deviceId
      // but do not invent a token, or hasFlock() would lie and sync would 401
      // against a device the relay has never seen.
      const orphanSecret = !!(this.flockId && this.flockSecret && !this.deviceToken);
      this.keys = await generateDeviceKeys();
      this.deviceId = this.keys.deviceId;
      if (!orphanSecret && !this.deviceToken) this.deviceToken = bytesToHex(randomBytes(32));
      await this.save();
    }
    return this.keys;
  }

  /** Called once pairing succeeds; persists flock secret + this device's relay token. */
  async setFlock(flockId: string, secret: Uint8Array, token: string): Promise<void> {
    this.flockId = flockId;
    this.flockSecret = new Uint8Array(secret); // copy — caller's buffer may be reused
    this.deviceToken = token;
    await this.save();
  }

  /**
   * 32 words (one per flock-secret byte, WORDS[byte]) space-joined.
   * UI formats 8 words per line.
   */
  recoveryWords(): string {
    if (!this.flockSecret) return "";
    return Array.from(this.flockSecret)
      .map((b) => WORDS[b])
      .join(" ");
  }
}