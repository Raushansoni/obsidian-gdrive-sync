import {
  Notice,
  Platform,
  Plugin,
  TAbstractFile,
  addIcon,
} from "obsidian";
import {
  DEFAULT_SETTINGS,
  GDriveSyncSettingTab,
  applyBundledOAuthDefaults,
  type GDriveSyncSettings,
  type TokenSet,
} from "./settings";
import { GoogleOAuth, revokeToken, DESKTOP_REDIRECT_URI } from "./auth/google-oauth";
import { DriveClient } from "./drive/drive-client";
import { SyncEngine, type SyncStatus } from "./sync/sync-engine";

const RIBBON_ICON_ID = "gdrive-sync-icon";

export default class GDriveSyncPlugin extends Plugin {
  settings: GDriveSyncSettings = DEFAULT_SETTINGS;
  oauth = new GoogleOAuth();
  private drive: DriveClient | null = null;
  private engine: SyncEngine | null = null;
  private statusBarEl: HTMLElement | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private status: SyncStatus = "idle";
  private statusDetail = "";
  /** Live device-code auth UI (mobile). */
  deviceAuth: {
    userCode: string;
    verificationUrl: string;
    phase: "waiting" | "checking";
  } | null = null;
  private deviceAuthCancel = false;
  /** Refresh open settings tab (set by GDriveSyncSettingTab). */
  refreshSettingsTab: (() => void) | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    addIcon(
      RIBBON_ICON_ID,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><path d="M12 12v5"/><path d="m9 14 3-3 3 3"/></svg>`
    );

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("gdrive-sync-status");
    this.statusBarEl.setText("GDrive: Idle");
    this.statusBarEl.onclick = () => void this.syncNow();

    this.addRibbonIcon(RIBBON_ICON_ID, "Google Drive Sync Now", () => {
      void this.syncNow();
    });

    this.addCommand({
      id: "gdrive-sync-now",
      name: "Sync now",
      callback: () => void this.syncNow(),
    });

    this.addCommand({
      id: "gdrive-connect",
      name: "Connect Google account",
      callback: () => void this.connectGoogle(),
    });

    this.addCommand({
      id: "gdrive-disconnect",
      name: "Disconnect Google account",
      callback: () => void this.disconnectGoogle(),
    });

    this.addCommand({
      id: "gdrive-open-settings",
      name: "Open Google Drive Sync settings",
      callback: () => {
        // @ts-ignore — setting tab id is plugin id
        this.app.setting.open();
        // @ts-ignore
        this.app.setting.openTabById(this.manifest.id);
      },
    });

    this.addSettingTab(new GDriveSyncSettingTab(this.app, this));

    // Deep link for mobile: obsidian://gdrive-sync?code=...
    this.registerObsidianProtocolHandler("gdrive-sync", async (params) => {
      try {
        const raw =
          params.code
            ? `http://127.0.0.1/?code=${encodeURIComponent(params.code)}`
            : params.url || "";
        if (!raw && !params.code) {
          new Notice("GDrive Sync: no auth code in URL");
          return;
        }
        await this.completeManualAuth(params.code || raw);
        new Notice("Google Drive Sync connected");
      } catch (e) {
        new Notice(`GDrive auth failed: ${String(e)}`);
      }
    });

    this.engine = new SyncEngine(this.app, this.settings, {
      onStatus: (status, detail) => this.setStatus(status, detail),
      saveSettings: () => this.saveSettings(),
    });

    if (this.settings.tokens?.refreshToken) {
      this.initDrive();
    }

    this.registerEvent(
      this.app.vault.on("create", (f) => this.engine?.onLocalCreateOrModify(f))
    );
    this.registerEvent(
      this.app.vault.on("modify", (f) => this.engine?.onLocalCreateOrModify(f))
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => this.engine?.onLocalDelete(f))
    );
    this.registerEvent(
      this.app.vault.on("rename", (f: TAbstractFile, oldPath: string) =>
        this.engine?.onLocalRename(f, oldPath)
      )
    );

    this.app.workspace.onLayoutReady(() => {
      this.restartAutoSync();
      if (this.settings.tokens?.refreshToken && this.settings.autoSync) {
        window.setTimeout(() => void this.syncNow(false), 2500);
      }
    });

    // Mobile: browser auth freezes timers; poll as soon as Obsidian is visible again.
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (!this.deviceAuth) return;
      this.deviceAuth = { ...this.deviceAuth, phase: "checking" };
      this.refreshSettingsTab?.();
      this.oauth.wakeDevicePoll();
    });

    const platformHint = Platform.isMobile
      ? "mobile"
      : Platform.isDesktopApp
        ? "desktop"
        : "app";
    console.log(`[GDrive Sync] loaded (${platformHint})`);
  }

  onunload(): void {
    this.oauth.cancelPending();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<GDriveSyncSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    const beforeId = this.settings.clientId;
    applyBundledOAuthDefaults(this.settings);
    if (!this.settings.syncIndex || this.settings.syncIndex.version !== 1) {
      this.settings.syncIndex = { version: 1, files: {} };
    }
    if (!this.settings.remoteFolderName) {
      this.settings.remoteFolderName = this.app.vault.getName();
    }
    // Persist when bundled OAuth replaces a stale Desktop client saved on the device.
    if (this.settings.clientId && this.settings.clientId !== beforeId) {
      await this.saveData(this.settings);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.engine?.updateSettings(this.settings);
  }

  private oauthConfig() {
    return {
      clientId: this.settings.clientId,
      clientSecret: this.settings.clientSecret,
      // Desktop loopback only; mobile uses device-code flow (no redirect URI).
      redirectUri: this.settings.redirectUri || DESKTOP_REDIRECT_URI,
    };
  }

  private async rememberOAuthRedirect(redirectUri: string): Promise<void> {
    this.settings.pendingOAuthRedirectUri = redirectUri;
    await this.saveSettings();
  }

  private initDrive(): void {
    if (!this.settings.tokens?.refreshToken || !this.settings.clientId) {
      this.drive = null;
      this.engine?.setDrive(null);
      return;
    }
    this.drive = new DriveClient(
      this.oauthConfig(),
      this.settings.tokens,
      async (tokens) => {
        this.settings.tokens = tokens as TokenSet;
        await this.saveSettings();
      }
    );
    this.engine?.setDrive(this.drive);
  }

  async connectGoogle(): Promise<void> {
    applyBundledOAuthDefaults(this.settings);
    if (!this.settings.clientId?.trim()) {
      new Notice("Add your Google OAuth Client ID in settings first");
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const setting = (this.app as any).setting;
        setting?.open?.();
        setting?.openTabById?.(this.manifest.id);
      } catch {
        /* ignore */
      }
      return;
    }

    const config = this.oauthConfig();

    // Mobile: device-code flow (no localhost redirect → no CONNECTION_REFUSED).
    // Requires OAuth client type “TVs and Limited Input devices”.
    if (Platform.isMobile) {
      await this.connectWithDeviceFlow(config);
      return;
    }

    const isLoopback = this.oauth.usesLoopback(config.redirectUri);
    if (Platform.isDesktopApp && isLoopback) {
      new Notice("Complete Google sign-in in your browser…");
      try {
        await this.rememberOAuthRedirect(DESKTOP_REDIRECT_URI);
        const tokens = await this.oauth.connectDesktop(config);
        this.settings.pendingOAuthRedirectUri = "";
        await this.applyTokens(tokens);
        new Notice("Connected to Google Drive");
        await this.ensureRemoteFolder();
        await this.syncNow(false);
        return;
      } catch (e) {
        console.warn("[GDrive Sync] Desktop OAuth failed, trying device flow", e);
        new Notice("Browser connect failed — switching to device code…", 5000);
        await this.connectWithDeviceFlow(config);
        return;
      }
    }

    await this.connectWithDeviceFlow(config);
  }

  private async connectWithDeviceFlow(config: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<void> {
    this.deviceAuthCancel = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const setting = (this.app as any).setting;
      setting?.open?.();
      setting?.openTabById?.(this.manifest.id);

      const tokens = await this.oauth.connectDeviceFlow(
        config,
        (info) => {
          this.deviceAuth = {
            userCode: info.userCode,
            verificationUrl: info.verificationUrl,
            phase: "waiting",
          };
          new Notice(
            `Code ${info.userCode} — open google.com/device, Allow, then return here (no redirect).`,
            20000
          );
          this.refreshSettingsTab?.();
          try {
            setting?.openTabById?.(this.manifest.id);
          } catch {
            /* ignore */
          }
        },
        () => this.deviceAuthCancel
      );

      // Mark connected in UI immediately — do not wait for first sync.
      this.deviceAuth = null;
      await this.applyTokens(tokens);
      this.refreshSettingsTab?.();
      new Notice("Connected to Google Drive ✓", 8000);

      try {
        await this.ensureRemoteFolder();
        await this.syncNow(false);
        new Notice("Vault sync finished", 5000);
      } catch (syncErr) {
        console.warn("[GDrive Sync] Connected but first sync failed", syncErr);
        new Notice(`Connected, but sync failed: ${String(syncErr)}`, 12000);
      }
      this.refreshSettingsTab?.();
    } catch (e) {
      this.deviceAuth = null;
      this.refreshSettingsTab?.();
      throw e;
    }
  }

  async completeManualAuth(raw: string): Promise<void> {
    if (!this.settings.clientId) {
      throw new Error("Missing Client ID");
    }
    applyBundledOAuthDefaults(this.settings);
    const redirectUri =
      this.settings.pendingOAuthRedirectUri?.trim() || this.oauthConfig().redirectUri;
    const config = { ...this.oauthConfig(), redirectUri };
    this.oauth.setPendingRedirectUri(redirectUri);
    const tokens = await this.oauth.completeWithCode(config, raw);
    this.settings.pendingOAuthRedirectUri = "";
    await this.applyTokens(tokens);
    await this.ensureRemoteFolder();
    new Notice("Connected to Google Drive");
    await this.syncNow(false);
  }

  private async applyTokens(tokens: TokenSet): Promise<void> {
    this.settings.tokens = tokens;
    await this.saveSettings();
    this.initDrive();
    this.restartAutoSync();
  }

  async disconnectGoogle(): Promise<void> {
    const token = this.settings.tokens?.refreshToken || this.settings.tokens?.accessToken;
    if (token) await revokeToken(token);
    this.settings.tokens = null;
    this.drive = null;
    this.engine?.setDrive(null);
    await this.saveSettings();
    this.restartAutoSync();
    this.setStatus("idle", "Disconnected");
  }

  private async ensureRemoteFolder(): Promise<void> {
    if (!this.drive) return;
    const name = this.settings.remoteFolderName.trim() || this.app.vault.getName();
    const { rootId, folderId } = await this.drive.ensureVaultFolder(name);
    this.settings.remoteFolderName = name;
    this.settings.remoteFolderId = folderId;
    this.settings.syncIndex.remoteFolderId = folderId;
    this.settings.syncIndex.remoteRootId = rootId;
    if (!this.settings.syncIndex.changeToken) {
      this.settings.syncIndex.changeToken = await this.drive.getStartPageToken();
    }
    await this.saveSettings();
  }

  async syncNow(notify = true): Promise<void> {
    if (!this.settings.tokens?.refreshToken) {
      if (notify) new Notice("Connect your Google account first");
      return;
    }
    this.initDrive();
    if (!this.engine) return;
    if (notify) new Notice("Syncing with Google Drive…");
    await this.engine.sync();
    if (this.status === "idle" && notify) {
      new Notice("Google Drive sync complete");
    } else if (this.status === "error" && notify) {
      new Notice(`Sync error: ${this.statusDetail}`);
    }
  }

  restartAutoSync(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (!this.settings.autoSync || !this.settings.tokens?.refreshToken) return;
    const ms = Math.max(15, this.settings.syncIntervalSeconds) * 1000;
    this.pollTimer = setInterval(() => {
      void this.engine?.sync();
    }, ms);
  }

  private setStatus(status: SyncStatus, detail?: string): void {
    this.status = status;
    this.statusDetail = detail ?? "";
    if (!this.statusBarEl) return;
    this.statusBarEl.removeClass("is-error", "is-syncing");
    let text = "GDrive: Idle";
    if (status === "syncing") {
      text = "GDrive: Syncing…";
      this.statusBarEl.addClass("is-syncing");
    } else if (status === "error") {
      text = `GDrive: Error`;
      this.statusBarEl.addClass("is-error");
      this.statusBarEl.setAttribute("aria-label", detail ?? "Error");
    } else if (status === "offline") {
      text = "GDrive: Offline";
    } else if (this.settings.lastSyncAt) {
      const t = new Date(this.settings.lastSyncAt).toLocaleTimeString();
      text = `GDrive: ${t}`;
    }
    this.statusBarEl.setText(text);
    if (detail) this.statusBarEl.title = detail;
  }
}

// Re-export redirect constant for tests/docs
export { DESKTOP_REDIRECT_URI };
