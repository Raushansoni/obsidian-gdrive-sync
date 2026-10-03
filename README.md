# Flock Sync for Obsidian

End-to-end encrypted vault sync for Obsidian across **Windows, macOS, Linux, Android, and iOS** — no Google account, no cloud drive, no third-party file storage reading your notes.

Pair your devices once, link a vault, and Flock Sync keeps it in sync through a small relay while Obsidian is open. The relay only ever sees **ciphertext**.

- Works in Obsidian Desktop **and** Obsidian Mobile (`isDesktopOnly: false`, minAppVersion 1.11.4)
- Pairing with a 3-digit nameplate + two words — or scan a QR code
- End-to-end encryption (AES-GCM); the relay stores only encrypted blobs
- Conflicts become **sibling files**, never a silent last-write-wins overwrite
- Recovery via **32 wordlist words** from your flock secret

## How it works

1. **Pair** — two devices exchange a short pairing code (`123-able-acid`) over the relay and verify a three-word fingerprint on both screens. Pairing happens **once per device**; the flock identity is stored in Obsidian's SecretStorage (and localStorage as fallback), not in the vault.
2. **Link this vault** — each device chooses which of its vaults joins the flock. You can link several vaults.
3. **Sync** — while Obsidian is open, changes are pushed and pulled through the relay, end-to-end encrypted.

## 1. Run the relay (desktop, local)

The plugin ships with the default relay URL `http://127.0.0.1:8787`, which is what `wrangler dev` serves. From the repo root:

```bash
cd relay
npm install
npx wrangler d1 execute flock --local --file=src/schema.sql
npm run dev
```

Keep that terminal running while you sync. This local relay is all you need for **desktop-to-desktop** sync.

> **Phone / `127.0.0.1` error:** On Android or iOS, `http://127.0.0.1:8787` is the **phone itself**, not your PC. Pairing then fails with `ConnectException Failed to connect to /127.0.0.1:8787`. Put an `https://` Worker URL in **Relay URL** on the phone (and the same URL on the PC if you are not using a tunnel in front of local wrangler). Restart Obsidian on the phone if **Dismiss** is stuck on an older build.

To bake a different relay URL into `main.js` at build time:

```bash
# bash / macOS / Linux
FLOCK_RELAY_URL=https://your-relay.example npm run build

# PowerShell
$env:FLOCK_RELAY_URL="https://your-relay.example"; npm run build
```

(You can also change **Relay URL** in the plugin settings at runtime.)

## 2. Install the plugin

### Option A — BRAT (phone + desktop)

1. In Obsidian: **Settings → Community plugins** — turn Restricted mode off, then install **BRAT** (by TfTHacker) and enable it.
2. Command palette → **BRAT: Add a beta plugin for testing**.
3. Paste:

   `https://github.com/Raushansoni/obsidian-gdrive-sync`

4. Enable **Flock Sync** in Community plugins.
5. After updates: **BRAT: Check for plugin updates**.

BRAT installs from GitHub **Releases** (`main.js`, `manifest.json`, `styles.css`). Use the latest **v2** release (Flock Sync). Older **v1.x** releases are the previous Google Drive plugin.

Set **Relay URL** in plugin settings. Both devices must share a relay the phone can reach:

- Desktop-only: `http://127.0.0.1:8787` (local `wrangler dev`)
- Phone: an `https://` URL (deployed Worker, or `wrangler dev --tunnel` while the PC stays on)

### Option B — setup script (this machine)

From the repo root:

```bash
npm install
npm run build
npm run setup
```

The script builds the plugin, finds your Obsidian vaults automatically (or you pass one), copies the plugin files in, and enables the plugin:

```bash
npm run setup -- --vault="C:\Users\YOU\Documents\MyVault"
npm run setup -- --rebuild   # force a rebuild first
```

### Option C — manual copy

```bash
npm install && npm run build
```

Then copy these three files:

```
main.js
manifest.json
styles.css
```

into your vault at:

```
<vault>/.obsidian/plugins/obsidian-gdrive-sync/
```

The folder name must be exactly `obsidian-gdrive-sync` (the plugin id). Restart Obsidian, go to **Settings → Community plugins**, turn Restricted mode off if prompted, and enable **Flock Sync**.

## 3. Pair your devices

Do this once per device. You need two devices with the plugin installed and the relay reachable.

**On the computer (the host):**

1. Open **Settings → Flock Sync**.
2. Tap **Start pair**. Leave that screen up — it shows a **nameplate**, two words, the full code (e.g. `123-able-acid`), and a **QR code**.

**On the phone (the guest):**

1. Open **Settings → Flock Sync**. Do **not** tap Start pair / Show a code — that would draw a second QR with nothing to scan.
2. Tap **Scan QR** and point the camera at the computer's QR. You can also type the code under **I have a code** and tap **Join**.
3. Both screens now show **three check words** (the fingerprint). Compare them.
4. If they match on both devices, tap **Pair** on both.

**Then, on every device that should sync a given vault:**

- Tap **Link this vault** in Settings → Flock Sync. If the flock already has a vault with this name, the device **joins that vault** instead of creating a second copy. Two devices that each minted their own vault id will look "synced" but never exchange notes — tap **Join shared vault** or **Sync now** after updating to collapse them.

Pairing is stored once per device (flock identity in SecretStorage + localStorage) — you never pair the same device twice, even across multiple vaults.

To add a third device later, open Settings → Flock Sync on an already-paired device and tap **Add another device**. That shows the same nameplate / QR flow and reuses the existing flock secret (nothing is re-keyed). The new device joins as a guest with the code.

## 4. Sync

- **Sync now** — ribbon icon, command palette, the status bar (click it), or the **Actions → Sync now** button in settings.
- **Auto sync** — on by default; pushes/pulls every *Sync interval* seconds (default 20, minimum 15) while Obsidian is open, and again when the app window regains focus or a file changes.
- Mobile syncs while the Obsidian app is open; it is not a background push service.

### Status bar meanings

The status bar item starts with `Flock:` and clicking it runs a sync.

| Status | Meaning |
|--------|---------|
| `Flock: Pair in settings` | This device has no flock yet — start pairing in settings |
| `Flock: Link this vault` | Device is paired, but this vault is not linked yet |
| `Flock: Syncing` | A sync round is running (may show a queue count) |
| `Flock: Waiting (open app to sync)` | Paired and linked; syncs resume when Obsidian is open |
| `Flock: Retrying…` | The last round hit a transient problem and will retry |
| `Flock: Paused` | Auto sync is paused/off |
| `Flock: Ready` | Linked, idle, nothing pending yet |
| `Flock: 10:24:31` | Time of the last completed sync |
| `Flock: Conflict …` | Conflicting edits were kept as sibling files (see below) |
| `Flock: Error` | Sync failed — hover for the detail, check settings for the last error |

### Conflicts

If the same file changed on two devices between syncs, Flock Sync does **not** silently pick a winner. Both versions survive as siblings:

```
Note.md
Note (conflict 2026-10-02).md
```

Merge by hand, then delete the copy you don't want. Conflict files are synced too, so every device sees both versions.

### Ignore patterns

Settings → Flock Sync → **Ignore patterns** (one vault path per line, `#` starts a comment). Matching is exact path, folder prefix, or a simple `*.ext` glob. Defaults:

```
.obsidian/workspace
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/workspaces.json
.obsidian/cache
.obsidian/plugins/obsidian-gdrive-sync/data.json
.trash
.git
.DS_Store
desktop.ini
Thumbs.db
```

Matched files are never synced. The plugin's own `data.json` is always ignored (it holds relay URLs and cursors, not secrets).

## Recovery words

After pairing, Settings → Flock Sync shows **Recovery words**: 32 words derived from your flock secret. This is the only place they are ever shown.

Write them down and keep them somewhere safe. They restore your flock secret on a new device — without them, a lost device is just a device you revoke from the flock, but a lost *flock secret* means the encrypted data on the relay is unreadable.

## Commands

| Command | Action |
|---------|--------|
| **Sync now** | Run a full bidirectional sync |
| **Link this vault to flock** | Enroll the current vault (pair first) |
| **Open Flock Sync settings** | Jump to the settings tab |

## Security notes

- Notes and attachments are encrypted client-side (AES-GCM) before they touch the relay; the relay stores only ciphertext and metadata (paths are encrypted too).
- Pairing is interactive and verified by comparing the three-word fingerprint on both screens.
- Flock identity (device keys + flock secret) lives in Obsidian's SecretStorage (keychain / credential vault) with a localStorage fallback. It is never written into the vault or synced.
- Back up your **32 recovery words**; they are the only way to restore the flock secret.
- Revoking a device in Settings → Flock Sync immediately cuts it off from the relay.

## Not in v1

- **No Google Drive importer** — this plugin no longer talks to Google Drive at all. Bring your notes into the vault with any file copy; there is no migration from a previous Google-Drive-based build.
- **No background mobile push** — on Android/iOS, sync runs while the Obsidian app is open, not in the background.
- **No public hosted relay** — the default relay URL is the local dev relay (`http://127.0.0.1:8787`). Deploying your own Cloudflare Worker is optional and not required for desktop-local sync.
- Not a real-time collaborative editor (device sync, not CRDT).

## Development

```bash
npm run dev        # watch build
npm run build      # typecheck + production build
npm run setup      # build (if needed) + install + enable in a vault
```

The relay lives in `relay/` (Cloudflare Worker: pairing mailbox, per-vault Durable Object log, R2 blobs, D1 device registry). See `relay/README.md` and `protocol/HTTP.md`.
