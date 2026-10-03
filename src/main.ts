import { Notice, Plugin, TAbstractFile, addIcon } from "obsidian";
import { DEFAULT_DATA, sanitizePluginData, type PluginData } from "./plugin-data";
import { IdentityStore } from "./identity";
import { RelayHttp } from "./relay/client";
import { PairingFlow } from "./pair/session";
import { FlockSettingTab } from "./settings";
import { FlockSyncEngine } from "./sync/engine";
import { StatusMachine } from "./status/machine";
import { DEEP_LINK_ACTION } from "./protocol";

const RIBBON_ICON_ID = "flock-sync-icon";

export default class FlockSyncPlugin extends Plugin {
  data: PluginData = DEFAULT_DATA;
  identity = new IdentityStore(this.app);
  relay = new RelayHttp(DEFAULT_DATA.relayUrl);
  pairing!: PairingFlow;
  engine: FlockSyncEngine | null = null;
  status = new StatusMachine();
  private statusBarEl: HTMLElement | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  refreshSettingsTab: (() => void) | null = null;
  private lastPaintedState: string | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();
    await this.identity.load();
    // Keys must exist before anything signs or authenticates — even when a
    // persisted flock is present but the key bundle was missing or corrupt.
    await this.identity.ensureDevice();
    this.relay.setBase(this.data.relayUrl);
    if (this.identity.deviceId && this.identity.deviceToken) {
      this.relay.setAuth(this.identity.deviceId, this.identity.deviceToken);
    }
    this.pairing = new PairingFlow(this.identity, this.relay);

    addIcon(
      RIBBON_ICON_ID,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.9 4.9 2.8 2.8"/><path d="m16.3 16.3 2.8 2.8"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.9 19.1 2.8-2.8"/><path d="m16.3 7.7 2.8-2.8"/><circle cx="12" cy="12" r="3"/></svg>`
    );

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("flock-sync-status");
    this.statusBarEl.onclick = () => void this.syncNow();
    this.status.onChange = () => this.paintStatus();
    this.status.hydrate(() => this.data);
    this.paintStatus();

    this.addRibbonIcon(RIBBON_ICON_ID, "Flock Sync now", () => void this.syncNow());
    this.addCommand({ id: "flock-sync-now", name: "Sync now", callback: () => void this.syncNow() });
    this.addCommand({
      id: "flock-open-settings",
      name: "Open Flock Sync settings",
      callback: () => {
        // @ts-expect-error private settings API
        this.app.setting.open();
        // @ts-expect-error private settings API
        this.app.setting.openTabById(this.manifest.id);
      },
    });
    this.addCommand({
      id: "flock-link-vault",
      name: "Link this vault to flock",
      callback: () => void this.linkVault(),
    });

    this.addSettingTab(new FlockSettingTab(this.app, this));

    this.registerObsidianProtocolHandler(DEEP_LINK_ACTION, async (params) => {
      const raw = [params.code, params.c, params.n, params.nameplate].filter(Boolean).join("-");
      const code = String(params.code || params.c || raw || "").trim();
      let fingerprint = "";
      if (!code && params.n) {
        fingerprint = await this.pairing.join(`${params.n}-${params.w || ""}`);
      } else if (code) {
        fingerprint = await this.pairing.join(code.replace(/\s+/g, "-"));
      } else {
        new Notice("Flock Sync: pairing link missing code");
        return;
      }
      if (!fingerprint || this.pairing.phase === "error") {
        new Notice(`Flock Sync: join failed — ${this.pairing.error ?? "check the code"}`, 8000);
        return;
      }
      new Notice("Confirm the matching phrase in settings, then tap Pair");
      this.refreshSettingsTab?.();
    });

    this.engine = new FlockSyncEngine(this.app, this.identity, this.relay, this.status, {
      getData: () => this.data,
      saveData: () => this.savePluginData(),
    });

    this.registerEvent(this.app.vault.on("create", (f) => this.engine?.onLocalCreateOrModify(f)));
    this.registerEvent(this.app.vault.on("modify", (f) => this.engine?.onLocalCreateOrModify(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.engine?.onLocalDelete(f)));
    this.registerEvent(
      this.app.vault.on("rename", (f: TAbstractFile, oldPath: string) =>
        this.engine?.onLocalRename(f, oldPath)
      )
    );

    this.app.workspace.onLayoutReady(() => {
      this.restartAutoSync();
      if (this.identity.hasFlock() && this.data.enrolled && this.data.autoSync) {
        window.setTimeout(() => void this.syncNow(false), 1500);
      }
    });

    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (this.identity.hasFlock() && this.data.enrolled) void this.syncNow(false);
    });
  }

  onunload(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pairing?.cancel();
  }

  async loadPluginData(): Promise<void> {
    const raw = (await this.loadData()) as unknown;
    this.data = sanitizePluginData(raw);
  }

  async savePluginData(): Promise<void> {
    this.data = sanitizePluginData(this.data);
    await this.saveData(this.data);
    this.engine?.updateFromData(this.data);
  }

  async linkVault(): Promise<void> {
    if (!this.identity.hasFlock()) {
      new Notice("Pair a device first");
      return;
    }
    try {
      await this.engine?.linkVault();
      new Notice("This vault is linked");
      this.restartAutoSync(); // the poll timer only runs once a vault is enrolled
      this.refreshSettingsTab?.();
    } catch (e) {
      new Notice(`Link failed: ${String(e)}`, 8000);
    }
  }

  async syncNow(notify = true): Promise<void> {
    if (!this.identity.hasFlock()) {
      if (notify) new Notice("Pair a device first");
      return;
    }
    if (!this.data.enrolled) {
      if (notify) new Notice("Link this vault in settings");
      return;
    }
    if (notify) new Notice("Syncing…");
    try {
      await this.engine?.sync();
      if (notify && this.status.state === "synced") new Notice("Synced");
      if (notify && this.status.state === "error") new Notice(`Sync error: ${this.status.detail}`);
      if (notify && this.status.state === "conflict") new Notice(`Conflicts: ${this.status.detail}`);
    } catch (e) {
      new Notice(`Sync failed: ${String(e)}`, 8000);
    }
  }

  restartAutoSync(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (!this.data.autoSync || !this.identity.hasFlock() || !this.data.enrolled) return;
    const ms = Math.max(15, this.data.syncIntervalSeconds) * 1000;
    this.pollTimer = setInterval(() => void this.engine?.sync(), ms);
  }

  paintStatus(): void {
    if (!this.statusBarEl) return;
    this.statusBarEl.removeClass("is-error", "is-syncing", "is-conflict");
    const s = this.status.state;
    let text = "Flock: Not paired";
    if (!this.identity.hasFlock()) text = "Flock: Pair in settings";
    else if (!this.data.enrolled) text = "Flock: Link this vault";
    else if (s === "syncing") {
      text = `Flock: Syncing ${this.status.queue || ""}`.trim();
      this.statusBarEl.addClass("is-syncing");
    } else if (s === "error") {
      text = "Flock: Error";
      this.statusBarEl.addClass("is-error");
    } else if (s === "conflict") {
      text = `Flock: Conflict ${this.status.queue || ""}`.trim();
      this.statusBarEl.addClass("is-conflict");
    } else if (s === "waiting") text = "Flock: Waiting (open app to sync)";
    else if (s === "retrying") text = "Flock: Retrying…";
    else if (s === "paused") text = "Flock: Paused";
    else if (this.status.lastSyncAt) {
      text = `Flock: ${new Date(this.status.lastSyncAt).toLocaleTimeString()}`;
    } else text = "Flock: Ready";
    this.statusBarEl.setText(text);
    this.statusBarEl.title = this.status.detail || text;
    if (this.lastPaintedState === "error" && s !== "error") {
      this.refreshSettingsTab?.();
    }
    this.lastPaintedState = s;
  }
}

export { DEFAULT_RELAY_URL } from "./flock-url";
