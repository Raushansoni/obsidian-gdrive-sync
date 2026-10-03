import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type FlockSyncPlugin from "./main";
import { DEFAULT_RELAY_URL } from "./flock-url";
import { relayUrlProblem } from "./relay-url";
import { renderQrSvg } from "./pair/qr";
import { QrLiveScanner } from "./pair/scan-qr";
import type { HostStartInfo } from "./pair/session";
import type { DeviceRecord } from "./protocol";
import { forkNeedsJoin } from "./sync/pick-vault";
import { showLastError, statusHeadline, visibleStatusLog } from "./status/view";

/** Minimal structural view of StatusMachine so this file compiles independently. */
interface StatusLike {
  state: string;
  detail?: string | null;
  lastSyncAt?: number | null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Pairing phases during which the host/guest panel replaces the main sections. */
const ACTIVE_PAIRING_PHASES = new Set<string>([
  "host-waiting-guest",
  "host-confirm",
  "host-finishing",
  "guest-joining",
  "guest-confirm",
  "guest-finishing",
]);

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Flock Sync settings: relay URL, device pairing (host + guest), vault linking,
 * flock device management, recovery words, and sync behavior.
 * No Google OAuth — Flock Sync uses device pairing only.
 */
export class FlockSettingTab extends PluginSettingTab {
  plugin: FlockSyncPlugin;

  private pairingPoll: ReturnType<typeof setInterval> | null = null;
  private lastPairingSnapshot = "";
  private joinCodeDraft = "";
  private qrScanner = new QrLiveScanner();

  constructor(app: App, plugin: FlockSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    this.stopPairingPoll();
    this.qrScanner.stop();
    if (this.plugin.refreshSettingsTab === this.redisplay) {
      this.plugin.refreshSettingsTab = null;
    }
  }

  private redisplay = (): void => {
    // Only rebuild while this tab's DOM is still mounted.
    if (this.containerEl?.isConnected) this.display();
  };

  display(): void {
    this.stopPairingPoll();
    const { containerEl } = this;
    this.plugin.refreshSettingsTab = this.redisplay;
    containerEl.empty();
    containerEl.addClass("flock-sync-settings");

    containerEl.createEl("h2", { text: "Flock Sync" });
    containerEl.createEl("p", {
      text: "End-to-end encrypted vault sync across your devices. Pair devices once, then link vaults.",
    });

    this.renderRelaySetting(containerEl);

    // While a pairing flow is in flight (first pair OR "add another device"),
    // show the host/guest panel even though this device may already be paired.
    const pairingActive = ACTIVE_PAIRING_PHASES.has(this.plugin.pairing.phase);
    if (this.plugin.identity.hasFlock() && !pairingActive) {
      this.renderPairedSection(containerEl);
    } else {
      this.renderPairingSection(containerEl);
    }

    this.renderSyncBehavior(containerEl);
  }

  // ------------------------------------------------------------------ relay

  private renderRelaySetting(containerEl: HTMLElement): void {
    const desc = "Permanent relay. Phone and PC both use this address — leave it as-is.";
    new Setting(containerEl)
      .setName("Relay URL")
      .setDesc(desc)
      .addText((text) =>
        text
          .setPlaceholder(Platform.isMobile ? "https://flock-relay.your-account.workers.dev" : DEFAULT_RELAY_URL)
          .setValue(this.plugin.data.relayUrl)
          .onChange(async (value) => {
            const url = value.trim() || DEFAULT_RELAY_URL;
            this.plugin.data.relayUrl = url;
            this.plugin.relay.setBase(url);
            await this.plugin.savePluginData();
          })
      );

    const problem = relayUrlProblem(this.plugin.data.relayUrl, Platform.isMobile);
    if (problem) {
      const warn = containerEl.createDiv({ cls: "mod-warning flock-relay-warn" });
      warn.setText(problem);
    }
  }

  // --------------------------------------------------------------- pairing

  private renderPairingSection(containerEl: HTMLElement): void {
    const pairing = this.plugin.pairing;
    const wrap = containerEl.createDiv({ cls: "flock-pairing" });

    if (pairing.phase === "error") {
      const err = wrap.createDiv({ cls: "mod-warning flock-pair-error" });
      err.setText(`Pairing error: ${pairing.error ?? "unknown"}`);
      // Native button: Obsidian Setting buttons can swallow taps on Android.
      const btn = wrap.createEl("button", {
        text: "Dismiss",
        cls: "mod-cta flock-dismiss-btn",
      });
      btn.type = "button";
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        pairing.cancel();
        this.display();
      });
      return;
    }

    switch (pairing.phase) {
      case "host-waiting-guest":
      case "host-confirm":
      case "host-finishing":
        if (pairing.host) {
          this.renderHostPanel(wrap, pairing.host);
          return;
        }
        break;
      case "guest-joining":
      case "guest-confirm":
      case "guest-finishing":
        this.renderGuestPanel(wrap);
        return;
      default:
        break;
    }

    if (pairing.phase === "cancelled") {
      wrap.createEl("p", { text: "Pairing cancelled." });
    }

    const choose = wrap.createDiv({ cls: "flock-pair-choose" });
    choose.createEl("h3", { text: "Pair a device" });

    if (Platform.isMobile) {
      choose.createEl("p", {
        text: "This phone scans the computer. Leave the QR on the PC, then tap Scan QR here — do not start pairing on both devices.",
      });
      const scanBtn = choose.createEl("button", {
        text: "Scan QR",
        cls: "mod-cta flock-scan-btn",
      });
      scanBtn.type = "button";
      scanBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void this.startQrScan();
      });
    } else {
      choose.createEl("p", {
        text: "This computer shows a QR. On the phone, tap Scan QR — do not tap Start pair on both devices.",
      });
      new Setting(choose)
        .setName("Start pairing")
        .setDesc("Show a nameplate, two words and a QR here. Scan them on the phone.")
        .addButton((btn) =>
          btn.setButtonText("Start pair").setCta().onClick(async () => {
            btn.setDisabled(true);
            try {
              await this.plugin.pairing.startHost();
            } catch (e) {
              new Notice(`Pair start failed: ${errMsg(e)}`, 8000);
            }
            this.display();
          })
        );
    }

    new Setting(choose)
      .setName("I have a code")
      .setDesc("Paste the code shown on the other device (e.g. 123-able-acid).")
      .addText((text) =>
        text
          .setPlaceholder("123-able-acid")
          .setValue(this.joinCodeDraft)
          .onChange((value) => (this.joinCodeDraft = value))
      )
      .addButton((btn) =>
        btn.setButtonText("Join").onClick(async () => {
          const code = this.joinCodeDraft.trim();
          if (!code) {
            new Notice("Enter the pairing code first");
            return;
          }
          btn.setDisabled(true);
          await this.joinWithCode(code);
        })
      );

    if (!Platform.isMobile) {
      new Setting(choose)
        .setName("Scan QR with webcam")
        .setDesc("If this computer is joining a phone that is showing the code.")
        .addButton((btn) =>
          btn.setButtonText("Scan QR").onClick(() => {
            void this.startQrScan();
          })
        );
    } else {
      new Setting(choose)
        .setName("This phone shows the code")
        .setDesc("Only if the other device will scan this phone. Normally the computer shows the QR.")
        .addButton((btn) =>
          btn.setButtonText("Show a code").onClick(async () => {
            btn.setDisabled(true);
            try {
              await this.plugin.pairing.startHost();
            } catch (e) {
              new Notice(`Pair start failed: ${errMsg(e)}`, 8000);
            }
            this.display();
          })
        );
    }
  }

  private async joinWithCode(code: string): Promise<void> {
    const fingerprint = await this.plugin.pairing.join(code);
    const pairing = this.plugin.pairing;
    if (!fingerprint || pairing.phase === "error") {
      new Notice(
        `Join failed: ${pairing.error ?? "no fingerprint — check the code and try again"}`,
        8000
      );
    }
    this.display();
  }

  private async startQrScan(): Promise<void> {
    if (this.qrScanner.active) return;
    await this.qrScanner.open({
      onCode: (code) => {
        this.joinCodeDraft = code;
        new Notice("QR scanned — connecting…");
        void this.joinWithCode(code);
      },
      onCancel: () => {
        if (this.containerEl?.isConnected) this.display();
      },
    });
  }

  private renderHostPanel(wrap: HTMLElement, host: HostStartInfo): void {
    const pairing = this.plugin.pairing;

    wrap.createEl("h3", { text: "Pairing — enter this on your other device" });

    if (Platform.isMobile) {
      wrap.createEl("p", {
        cls: "mod-warning",
        text: "This phone is showing a QR. To join the computer, scan the computer's code instead.",
      });
      const scanInstead = wrap.createEl("button", {
        text: "Scan the computer's QR instead",
        cls: "mod-cta flock-scan-btn",
      });
      scanInstead.type = "button";
      scanInstead.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.plugin.pairing.cancel();
        this.stopPairingPoll();
        void this.startQrScan();
      });
    }

    const codeBox = wrap.createDiv({ cls: "flock-pair-code" });
    const nameplateEl = codeBox.createDiv({ cls: "flock-nameplate" });
    nameplateEl.setText(host.nameplate);
    nameplateEl.setAttribute(
      "style",
      "font-size:2.4em;font-weight:700;letter-spacing:0.15em;text-align:center"
    );
    const wordsEl = codeBox.createDiv({ cls: "flock-words" });
    wordsEl.setText(host.words.join("  ·  "));
    wordsEl.setAttribute("style", "font-size:1.4em;text-align:center;margin:4px 0 2px");
    const fullEl = codeBox.createDiv({ cls: "flock-code-full" });
    fullEl.setText(host.code);
    fullEl.setAttribute("style", "text-align:center;font-family:monospace;opacity:0.8");

    const qrWrap = wrap.createDiv({ cls: "flock-qr-wrap" });
    qrWrap.setAttribute("style", "display:flex;justify-content:center;margin:10px 0");
    qrWrap.innerHTML = renderQrSvg(host.link);

    new Setting(wrap).addButton((btn) =>
      btn.setButtonText("Copy code").onClick(async () => {
        const ok = await copyText(host.code);
        new Notice(ok ? "Code copied" : "Could not copy — write it down instead", 3000);
      })
    );

    const fpEl = wrap.createDiv({ cls: "flock-fingerprint" });
    if (pairing.fingerprint) {
      this.renderFingerprint(fpEl, pairing.fingerprint);
      fpEl.createEl("p", {
        text: "These three words also appear on the other device. They must match exactly.",
      });
    }

    const statusText =
      pairing.phase === "host-finishing"
        ? "Finishing…"
        : pairing.fingerprint
          ? "Waiting for you to confirm."
          : "Waiting for the other device to enter the code…";
    wrap.createEl("p", { cls: "flock-pair-status", text: statusText });

    new Setting(wrap)
      .setName("Confirm pairing")
      .setDesc("Only tap Pair after the three words match on both screens.")
      .addButton((btn) => {
        btn
          .setButtonText(pairing.phase === "host-finishing" ? "Finishing…" : "Pair")
          .setCta()
          .setDisabled(!pairing.fingerprint || pairing.phase === "host-finishing");
        btn.onClick(async () => {
          btn.setButtonText("Finishing…").setDisabled(true);
          try {
            await this.plugin.pairing.confirmHost();
            // Identity was persisted by setFlock() in the session; restart the
            // poll timer and repaint so the paired section appears.
            this.plugin.restartAutoSync();
            new Notice(
              this.plugin.data.enrolled
                ? "Paired! The new device has joined your flock."
                : "Paired! Now link this vault.",
              6000
            );
          } catch (e) {
            new Notice(`Pairing failed: ${errMsg(e)}`, 8000);
          }
          this.display();
        });
      });

    new Setting(wrap).addButton((btn) =>
      btn.setButtonText("Cancel").onClick(() => {
        this.plugin.pairing.cancel();
        this.display();
      })
    );

    this.startPairingPoll();
  }

  private renderGuestPanel(wrap: HTMLElement): void {
    const pairing = this.plugin.pairing;

    wrap.createEl("h3", { text: "Joining a flock" });

    if (pairing.phase === "guest-confirm" && pairing.fingerprint) {
      this.renderFingerprint(wrap, pairing.fingerprint);
      wrap.createEl("p", {
        text: "Compare these three words with the host device. They must match exactly.",
      });
      new Setting(wrap)
        .setName("Confirm pairing")
        .setDesc("Tap Pair only if the words match on both screens.")
        .addButton((btn) =>
          btn.setButtonText("Pair").setCta().onClick(async () => {
            btn.setButtonText("Joining…").setDisabled(true);
            try {
              await this.plugin.pairing.confirmGuest();
              // Identity was persisted by setFlock() in the session; restart
              // the poll timer and repaint so the paired section appears.
              this.plugin.restartAutoSync();
              new Notice(
                this.plugin.data.enrolled
                  ? "Paired! The new device has joined your flock."
                  : "Paired! Now link this vault.",
                6000
              );
            } catch (e) {
              new Notice(`Pairing failed: ${errMsg(e)}`, 8000);
            }
            this.display();
          })
        );
    } else {
      const text =
        pairing.phase === "guest-finishing" ? "Joining…" : "Connecting to the host…";
      wrap.createEl("p", { cls: "flock-pair-status", text });
    }

    new Setting(wrap).addButton((btn) =>
      btn.setButtonText("Cancel").onClick(() => {
        this.plugin.pairing.cancel();
        this.display();
      })
    );

    this.startPairingPoll();
  }

  private renderFingerprint(parent: HTMLElement, fingerprint: string): void {
    const box = parent.createDiv({ cls: "flock-fp-box" });
    box.setAttribute(
      "style",
      "display:flex;gap:12px;justify-content:center;margin:10px 0;padding:10px;border:1px solid var(--background-modifier-border);border-radius:8px"
    );
    for (const word of fingerprint.split("-")) {
      const span = box.createSpan({ cls: "flock-fp-word", text: word });
      span.setAttribute("style", "font-size:1.5em;font-weight:600");
    }
  }

  // ----------------------------------------------------------------- paired

  private renderPairedSection(containerEl: HTMLElement): void {
    const plugin = this.plugin;
    const wrap = containerEl.createDiv({ cls: "flock-paired" });

    if (!plugin.data.enrolled) {
      wrap.createEl("h3", { text: "This device is paired." });
      wrap.createEl("p", {
        text: `Flock ID: ${plugin.identity.flockId ?? "—"}`,
      });
      wrap.createEl("p", {
        text: "Link this vault to start syncing it with the flock. You can link several vaults.",
      });
      new Setting(wrap)
        .setName("Vault")
        .setDesc(plugin.app.vault.getName() || "This vault")
        .addButton((btn) =>
          btn.setButtonText("Link this vault").setCta().onClick(async () => {
            await plugin.linkVault();
          })
        );
      this.renderFlockVaults(wrap);
      this.renderAddAnotherDevice(wrap);
      this.renderRecoveryWords(wrap);
      return;
    }

    wrap.createEl("h3", { text: "This vault is linked." });

    const status = (plugin as unknown as { status?: StatusLike }).status;
    wrap.createEl("p", {
      text: statusHeadline(status?.state ?? "waiting", status?.detail),
    });
    wrap.createEl("p", {
      text: plugin.data.lastSyncAt
        ? `Last sync: ${new Date(plugin.data.lastSyncAt).toLocaleString()}`
        : "Last sync: never",
    });
    const liveError = showLastError(status?.state ?? "waiting", plugin.data.lastError);
    if (liveError) {
      wrap.createEl("p", { cls: "mod-warning", text: `Error: ${liveError}` });
    }
    if (plugin.data.vaultId) {
      wrap.createEl("p", { text: `Vault ID: ${plugin.data.vaultId}` });
    }
    const log = visibleStatusLog(plugin.status.snapshotLog(), status?.state ?? "waiting");
    if (log.length) {
      const recent = wrap.createDiv({ cls: "flock-status-log" });
      recent.createEl("h4", { text: "Recent sync" });
      recent.createEl("pre", {
        text: log.map((e) => e.msg).join("\n"),
      });
    }

    this.renderFlockVaults(wrap);
    this.renderAddAnotherDevice(wrap);
    this.renderDevices(wrap);
    this.renderRecoveryWords(wrap);
  }

  /** Flock vaults on the relay — join the shared one so devices exchange notes. */
  private renderFlockVaults(wrap: HTMLElement): void {
    const sec = wrap.createDiv({ cls: "flock-vaults" });
    sec.createEl("h4", { text: "Shared vault" });
    const listEl = sec.createDiv();
    listEl.setText("Loading…");
    void (async () => {
      try {
        const vaults = (await this.plugin.engine?.listNamedVaults()) ?? [];
        if (!this.containerEl?.isConnected) return;
        listEl.empty();
        if (!vaults.length) {
          listEl.setText("No vaults on the relay yet. Tap Link this vault.");
          return;
        }
        if (!forkNeedsJoin(vaults)) {
          const current = vaults.find((v) => v.current);
          const name = current?.name || this.plugin.app.vault.getName() || "this vault";
          listEl.setText(`Sharing “${name}”`);
          return;
        }
        listEl.createEl("p", {
          cls: "mod-warning",
          text: "This device is on a second copy of the same vault, so files are not crossing. Tap Join shared vault to use the copy that already has notes.",
        });
        for (const v of vaults) {
          const row = new Setting(listEl);
          row.setName(v.name || v.vaultId.slice(0, 8));
          row.setDesc(v.current ? `this device · ${v.vaultId}` : v.vaultId);
        }
        new Setting(listEl)
          .setName("Use shared vault")
          .setDesc("Both devices must enroll in the same vault id. This joins the existing one with this name.")
          .addButton((btn) =>
            btn.setButtonText("Join shared vault").setCta().onClick(async () => {
              btn.setDisabled(true);
              try {
                await this.plugin.linkVault();
                await this.plugin.syncNow(true);
              } catch (e) {
                new Notice(`Join failed: ${errMsg(e)}`, 8000);
              }
              if (this.containerEl?.isConnected) this.display();
            })
          );
      } catch (e) {
        if (!this.containerEl?.isConnected) return;
        listEl.empty();
        const warn = listEl.createEl("span", { cls: "mod-warning" });
        warn.setText(`Could not load vaults: ${errMsg(e)}`);
      }
    })();
  }

  /**
   * Add-device flow for an already-paired device: startHost() reuses the
   * existing flock (no re-key) and shows the same host QR/code panel.
   */
  private renderAddAnotherDevice(wrap: HTMLElement): void {
    new Setting(wrap)
      .setName("Add another device")
      .setDesc(
        "Pair one more phone or computer into this flock. It joins with the same flock secret — nothing is re-keyed."
      )
      .addButton((btn) =>
        btn.setButtonText("Add device").onClick(async () => {
          btn.setDisabled(true);
          try {
            await this.plugin.pairing.startHost();
          } catch (e) {
            new Notice(`Pair start failed: ${errMsg(e)}`, 8000);
            btn.setDisabled(false);
            return;
          }
          this.display();
        })
      );
  }

  private renderDevices(wrap: HTMLElement): void {
    const sec = wrap.createDiv({ cls: "flock-devices" });
    sec.createEl("h4", { text: "Devices in this flock" });
    const listEl = sec.createDiv();
    listEl.setText("Loading…");

    void (async () => {
      try {
        const info = await this.plugin.relay.flock();
        if (!this.containerEl?.isConnected) return;
        listEl.empty();
        const me = this.plugin.identity.deviceId;
        const devices: DeviceRecord[] = info.devices ?? [];
        if (!devices.length) {
          listEl.setText("No devices reported by the relay yet.");
        }
        for (const d of devices) {
          const row = new Setting(listEl);
          row.setName(d.displayName || d.deviceId.slice(0, 12));
          row.setDesc(
            d.revoked
              ? `revoked · ${d.deviceId}`
              : d.deviceId === me
                ? "this device"
                : d.deviceId
          );
          if (!d.revoked && d.deviceId !== me) {
            row.addButton((btn) =>
              btn.setButtonText("Revoke").onClick(async () => {
                btn.setDisabled(true);
                try {
                  await this.plugin.relay.revokeDevice(d.deviceId);
                  new Notice("Device revoked");
                } catch (e) {
                  new Notice(`Revoke failed: ${errMsg(e)}`, 8000);
                }
                this.display();
              })
            );
          }
        }
        const vaults = info.vaults ?? [];
        sec.createEl("p", {
          text: `Vaults in flock: ${vaults.length}`,
        });
      } catch (e) {
        if (!this.containerEl?.isConnected) return;
        listEl.empty();
        const warn = listEl.createEl("span", { cls: "mod-warning" });
        warn.setText(`Could not load devices: ${errMsg(e)}`);
      }
    })();
  }

  private renderRecoveryWords(wrap: HTMLElement): void {
    const words = this.plugin.identity.recoveryWords();
    if (!words) return;
    const all = words.split(" ").filter(Boolean);
    const lines: string[] = [];
    for (let i = 0; i < all.length; i += 8) lines.push(all.slice(i, i + 8).join(" "));

    const sec = wrap.createDiv({ cls: "flock-recovery" });
    sec.createEl("h4", { text: "Recovery words" });
    sec.createEl("p", {
      text: "These 32 words can restore your flock secret on a new device. Write them down and keep them somewhere safe — this is the only place they are shown.",
    });
    const box = sec.createDiv({ cls: "flock-recovery-box" });
    box.setAttribute(
      "style",
      "background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:8px;padding:10px;margin:6px 0"
    );
    box.createEl("pre", {
      text: lines.join("\n"),
      attr: { style: "margin:0;font-family:var(--font-monospace);white-space:pre-wrap" },
    });
    new Setting(box).addButton((btn) =>
      btn.setButtonText("Copy words").onClick(async () => {
        const ok = await copyText(words);
        new Notice(ok ? "Recovery words copied" : "Could not copy — select the text manually", 3000);
      })
    );
  }

  // --------------------------------------------------------- sync behavior

  private renderSyncBehavior(containerEl: HTMLElement): void {
    const plugin = this.plugin;
    containerEl.createEl("h3", { text: "Sync" });

    new Setting(containerEl)
      .setName("Auto sync")
      .setDesc("Poll and push changes in the background while Obsidian is open.")
      .addToggle((toggle) =>
        toggle.setValue(plugin.data.autoSync).onChange(async (value) => {
          plugin.data.autoSync = value;
          await plugin.savePluginData();
          plugin.restartAutoSync();
        })
      );

    new Setting(containerEl)
      .setName("Sync interval (seconds)")
      .setDesc("How often auto sync runs. Minimum 15.")
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(plugin.data.syncIntervalSeconds))
          .onChange(async (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 15) return;
            plugin.data.syncIntervalSeconds = Math.floor(n);
            await plugin.savePluginData();
            plugin.restartAutoSync();
          })
      );

    new Setting(containerEl)
      .setName("Ignore patterns")
      .setDesc("One vault path per line. Matched files are never synced.")
      .addTextArea((area) => {
        area.setValue(plugin.data.ignorePatterns).onChange(async (value) => {
          plugin.data.ignorePatterns = value;
          await plugin.savePluginData();
        });
        area.inputEl.rows = 8;
        area.inputEl.cols = 40;
      });

    new Setting(containerEl)
      .setName("Actions")
      .addButton((btn) =>
        btn.setButtonText("Sync now").setCta().onClick(async () => {
          await plugin.syncNow();
          if (this.containerEl?.isConnected) this.display();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Resync from relay").onClick(async () => {
          if (!plugin.identity.hasFlock() || !plugin.data.enrolled) {
            new Notice("Pair and link this vault first");
            return;
          }
          btn.setDisabled(true);
          try {
            new Notice("Resyncing from relay…");
            await plugin.engine?.resyncFromRelay();
            if (plugin.status.state === "synced") new Notice("Resync complete");
            else if (plugin.status.state === "error") {
              new Notice(`Resync error: ${plugin.status.detail}`, 8000);
            }
          } catch (e) {
            new Notice(`Resync failed: ${errMsg(e)}`, 8000);
          }
          if (this.containerEl?.isConnected) this.display();
        })
      );
  }

  // -------------------------------------------------------------- polling

  /** Re-render while a pairing panel is up so fingerprint/phase changes appear. */
  private startPairingPoll(): void {
    this.stopPairingPoll();
    this.lastPairingSnapshot = this.pairingSnapshot();
    this.pairingPoll = setInterval(() => {
      if (!this.containerEl?.isConnected) {
        this.stopPairingPoll();
        return;
      }
      const snap = this.pairingSnapshot();
      if (snap !== this.lastPairingSnapshot) {
        this.lastPairingSnapshot = snap;
        this.display();
      }
    }, 700);
  }

  private stopPairingPoll(): void {
    if (this.pairingPoll) {
      clearInterval(this.pairingPoll);
      this.pairingPoll = null;
    }
  }

  private pairingSnapshot(): string {
    const p = this.plugin.pairing;
    return `${p.phase}|${p.fingerprint ?? ""}|${p.error ?? ""}|${p.host?.code ?? ""}`;
  }
}