import { App, PluginSettingTab, Setting, Notice, Platform } from "obsidian";
import type GDriveSyncPlugin from "./main";

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
  /** Must match an Authorized redirect URI on the Google OAuth client. */
  redirectUri: string;
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
  clientId: "",
  clientSecret: "",
  redirectUri: "http://127.0.0.1:42813/",
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

export class GDriveSyncSettingTab extends PluginSettingTab {
  plugin: GDriveSyncPlugin;
  private pendingAuthCode = "";

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

    new Setting(containerEl)
      .setName("Google OAuth Client ID")
      .setDesc("From Google Cloud Console → APIs & Services → Credentials (Desktop or Web client).")
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
      .setName("OAuth redirect URI")
      .setDesc(
        "Must exactly match a redirect URI on your Google OAuth client (Web clients usually use an https URL)."
      )
      .addText((text) =>
        text
          .setPlaceholder("https://your-app.vercel.app/")
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
            ? "On mobile: Connect opens the browser. Paste the redirect URL or code below."
            : "Connect opens your browser and finishes automatically on desktop."
      )
      .addButton((btn) =>
        btn
          .setButtonText(connected ? "Reconnect" : "Connect Google")
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.connectGoogle();
              this.display();
            } catch (e) {
              new Notice(`Connect failed: ${String(e)}`);
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

    if (!connected || Platform.isMobile) {
      const authBox = containerEl.createDiv({ cls: "gdrive-sync-auth-box" });
      authBox.createEl("div", {
        text: "Mobile / manual auth: after signing in, copy the full redirect URL (or just the code) and paste it here.",
      });
      const area = authBox.createEl("textarea");
      area.placeholder = "http://127.0.0.1:42813/?code=...   or   4/0Afc...";
      area.value = this.pendingAuthCode;
      area.addEventListener("input", () => {
        this.pendingAuthCode = area.value;
      });
      new Setting(authBox)
        .addButton((btn) =>
          btn
            .setButtonText("Submit auth code")
            .setCta()
            .onClick(async () => {
              try {
                await this.plugin.completeManualAuth(this.pendingAuthCode);
                this.pendingAuthCode = "";
                new Notice("Google account connected");
                this.display();
              } catch (e) {
                new Notice(`Auth failed: ${String(e)}`);
              }
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
