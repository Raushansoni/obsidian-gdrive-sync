import { App, PluginSettingTab, Setting, Notice, Platform } from "obsidian";
import type GDriveSyncPlugin from "./main";
import {
  BUNDLED_CLIENT_ID,
  BUNDLED_CLIENT_SECRET,
  BUNDLED_REDIRECT_URI,
} from "./bundled-oauth";

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  scope?: string;
}

export interface SyncIndexEntry {
  driveFileId: string;
  hash: string;
  mtime: number;
  size: number;
}

export interface SyncIndex {
  version: 1;
  files: Record<string, SyncIndexEntry>;
  changeToken?: string;
  remoteFolderId?: string;
  remoteRootId?: string;
}

export interface GDriveSyncSettings {
  clientId: string;
  clientSecret: string;
  /** Desktop loopback redirect — must match an Authorized redirect URI. */
  redirectUri: string;
  /** Persisted across app switches so token exchange uses the same redirect_uri. */
  pendingOAuthRedirectUri: string;
  tokens: TokenSet | null;
  remoteFolderName: string;
  remoteFolderId: string;
  syncIntervalSeconds: number;
  autoSync: boolean;
  ignorePatterns: string;
  syncIndex: SyncIndex;
  lastSyncAt: number | null;
  lastError: string | null;
}

export const DEFAULT_IGNORE = [
  ".obsidian/workspace",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/workspaces.json",
  ".obsidian/cache",
  ".obsidian/plugins/obsidian-gdrive-sync/data.json",
  ".trash",
  ".git",
  ".DS_Store",
  "desktop.ini",
  "Thumbs.db",
].join("\n");

export const DEFAULT_SETTINGS: GDriveSyncSettings = {
  clientId: BUNDLED_CLIENT_ID,
  clientSecret: BUNDLED_CLIENT_SECRET,
  redirectUri: BUNDLED_REDIRECT_URI,
  pendingOAuthRedirectUri: "",
  tokens: null,
  remoteFolderName: "",
  remoteFolderId: "",
  syncIntervalSeconds: 30,
  autoSync: true,
  ignorePatterns: DEFAULT_IGNORE,
  syncIndex: { version: 1, files: {} },
  lastSyncAt: null,
  lastError: null,
};

/**
 * Prefer build-time OAuth client. Official releases bake the TVs/Limited-Input client
 * required for mobile device-code auth. Stale Desktop client IDs in data.json cause
 * invalid_client / "Invalid client type" on Connect.
 */
export function applyBundledOAuthDefaults(settings: GDriveSyncSettings): void {
  if (BUNDLED_CLIENT_ID) {
    settings.clientId = BUNDLED_CLIENT_ID;
  }
  if (BUNDLED_CLIENT_SECRET) {
    settings.clientSecret = BUNDLED_CLIENT_SECRET;
  }
  if (!settings.redirectUri?.trim() && BUNDLED_REDIRECT_URI) {
    settings.redirectUri = BUNDLED_REDIRECT_URI;
  }
  // Older builds used http://localhost:42813/ which can CONNECTION_REFUSED via IPv6.
  if (/^http:\/\/localhost:42813\/?$/i.test(settings.redirectUri?.trim() || "")) {
    settings.redirectUri = BUNDLED_REDIRECT_URI || "http://127.0.0.1:42813/";
  }
  // Drop obsolete GitHub Pages mobile HTTPS callback (device-code flow replaced it).
  delete (settings as { mobileRedirectUri?: string }).mobileRedirectUri;
}

export class GDriveSyncSettingTab extends PluginSettingTab {
  plugin: GDriveSyncPlugin;

  constructor(app: App, plugin: GDriveSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("gdrive-sync-settings");

    containerEl.createEl("h2", { text: "Google Drive Sync" });
    containerEl.createEl("p", {
      text: "Sync this vault across Android, Windows, macOS, and Linux with the same Google account and remote folder name.",
    });

    if (BUNDLED_CLIENT_ID && this.plugin.settings.clientId?.trim() === BUNDLED_CLIENT_ID) {
      containerEl.createEl("p", {
        text: "OAuth Client ID is pre-filled from the plugin build. Tap Connect Google below (no need to paste it first).",
      });
    }

    new Setting(containerEl)
      .setName("Google OAuth Client ID")
      .setDesc(
        BUNDLED_CLIENT_ID
          ? "Pre-filled for this build. Leave as-is unless you use your own Google Cloud client."
          : "From Google Cloud Console → APIs & Services → Credentials (Desktop or Web client)."
      )
      .addText((text) =>
        text
          .setPlaceholder("xxxxx.apps.googleusercontent.com")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Google OAuth Client Secret")
      .setDesc("Required for Web clients. Desktop clients often leave this empty.")
      .addText((text) =>
        text
          .setPlaceholder("GOCSPX-...")
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Desktop redirect URI")
      .setDesc("Loopback for PC/Mac. Must be allowed on your Google OAuth client. Mobile uses device-code login (no redirect URI).")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:42813/")
          .setValue(this.plugin.settings.redirectUri)
          .onChange(async (value) => {
            this.plugin.settings.redirectUri = value.trim();
            await this.plugin.saveSettings();
          })
      );

    const connected = !!this.plugin.settings.tokens?.refreshToken;
    new Setting(containerEl)
      .setName("Google account")
      .setDesc(
        connected
          ? "Connected. Use the same account on every device."
          : Platform.isMobile
            ? "Mobile uses Google device login (no localhost). Tap Connect, then enter the code at google.com/device."
            : "Desktop opens the browser automatically; falls back to device code if needed."
      )
      .addButton((btn) =>
        btn
          .setButtonText(connected ? "Reconnect" : "Connect Google")
          .setCta()
          .onClick(async () => {
            try {
              // Refresh UI while device-code polling runs.
              const refresh = window.setInterval(() => {
                if (this.plugin.deviceAuth) this.display();
                else window.clearInterval(refresh);
              }, 800);
              await this.plugin.connectGoogle();
              window.clearInterval(refresh);
              this.display();
            } catch (e) {
              new Notice(`Connect failed: ${String(e)}`, 12000);
              this.display();
            }
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Disconnect")
          .setDisabled(!connected)
          .onClick(async () => {
            await this.plugin.disconnectGoogle();
            new Notice("Disconnected from Google");
            this.display();
          })
      );

    if (this.plugin.deviceAuth) {
      const box = containerEl.createDiv({ cls: "gdrive-sync-auth-box" });
      box.createEl("h3", { text: "Finish Google sign-in" });
      box.createEl("p", {
        text: `1. Open ${this.plugin.deviceAuth.verificationUrl}`,
      });
      box.createEl("p", {
        text: `2. Enter this code: ${this.plugin.deviceAuth.userCode}`,
      });
      box.createEl("p", {
        text: "3. Allow Drive access — Obsidian will connect automatically.",
      });
      new Setting(box).addButton((btn) =>
        btn.setButtonText("Open google.com/device").setCta().onClick(() => {
          window.open(this.plugin.deviceAuth!.verificationUrl);
        })
      );
    }

    new Setting(containerEl)
      .setName("Remote folder name")
      .setDesc(
        "Folder under Drive → ObsidianVaults/. Use the exact same name on every device for this vault."
      )
      .addText((text) =>
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(this.plugin.settings.remoteFolderName)
          .onChange(async (value) => {
            this.plugin.settings.remoteFolderName = value.trim();
            this.plugin.settings.remoteFolderId = "";
            this.plugin.settings.syncIndex.remoteFolderId = undefined;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto sync")
      .setDesc("Watch local changes and poll Google Drive on an interval.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
          this.plugin.restartAutoSync();
        })
      );

    new Setting(containerEl)
      .setName("Sync interval (seconds)")
      .setDesc("How often to pull remote changes. Minimum 15.")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.syncIntervalSeconds))
          .onChange(async (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 15) return;
            this.plugin.settings.syncIntervalSeconds = Math.floor(n);
            await this.plugin.saveSettings();
            this.plugin.restartAutoSync();
          })
      );

    new Setting(containerEl)
      .setName("Ignore patterns")
      .setDesc("One path prefix or exact relative path per line. Matched files are never synced.")
      .addTextArea((area) => {
        area.setValue(this.plugin.settings.ignorePatterns).onChange(async (value) => {
          this.plugin.settings.ignorePatterns = value;
          await this.plugin.saveSettings();
        });
        area.inputEl.rows = 8;
        area.inputEl.cols = 40;
      });

    new Setting(containerEl)
      .setName("Actions")
      .addButton((btn) =>
        btn.setButtonText("Sync now").setCta().onClick(async () => {
          await this.plugin.syncNow();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Reset sync index").onClick(async () => {
          this.plugin.settings.syncIndex = { version: 1, files: {} };
          this.plugin.settings.remoteFolderId = "";
          await this.plugin.saveSettings();
          new Notice("Sync index reset. Next sync will rebuild mapping.");
        })
      );

    if (this.plugin.settings.lastSyncAt) {
      containerEl.createEl("p", {
        text: `Last sync: ${new Date(this.plugin.settings.lastSyncAt).toLocaleString()}`,
      });
    }
    if (this.plugin.settings.lastError) {
      containerEl.createEl("p", {
        cls: "mod-warning",
        text: `Last error: ${this.plugin.settings.lastError}`,
      });
    }
  }
}
