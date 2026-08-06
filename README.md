# Google Drive Sync for Obsidian

Bidirectional vault sync across **Android, Windows, macOS, and Linux** using your Google Drive storage.

Same Google account + same remote folder name on every device = one shared vault.

## Features

- Works in Obsidian Desktop and Obsidian Mobile (`isDesktopOnly: false`)
- OAuth connect (auto loopback on desktop; paste-code flow on mobile)
- Automatic sync (local watchers + interval pull)
- Manual **Sync now** command / ribbon / status bar
- Last-write-wins with conflict copies: `Note (conflict YYYY-MM-DD).md`
- Ignores noisy paths (workspace cache, trash, plugin data) by default
- Syncs notes, attachments, and selected `.obsidian` config files

## Cross-device setup (Android ↔ Windows ↔ Mac)

1. Install this plugin on **every** device (same build).
2. Use the **same Google account** on every device.
3. Use the **exact same Remote folder name** (e.g. `Personal`).
4. Connect Google → Sync now.

Files live under Google Drive:

`My Drive / ObsidianVaults / <Remote folder name> / …`

## 1. Google Cloud (once)

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or pick one).
3. Enable **Google Drive API**.
4. **OAuth consent screen**
   - User type: **External**
   - Publishing status: **Testing**
   - Add your Google account(s) under **Test users** (every account that will sync).
5. **Credentials → Create credentials → OAuth client ID**
   - Application type: **Desktop app** (recommended for this plugin)
   - Copy the **Client ID** (and **Client Secret** if shown)
6. Plugin redirect URI (loopback — does **not** use any website / Vercel / Navigator app):

   `http://127.0.0.1:42813/`

   - **Desktop** clients: loopback is handled automatically.
   - **Web** clients: add that exact URI under Authorized redirect URIs, and paste the Client Secret in plugin settings.
   - Do not point this plugin at an unrelated web app’s redirect URL.

## 2. Install

### Phone / any device — BRAT (recommended)

1. In Obsidian: **Settings → Community plugins → Browse** → install **BRAT** (by TfTHacker) → Enable it  
2. Turn **Restricted mode OFF** if prompted  
3. Command palette → **BRAT: Add beta plugin**  
4. Paste this repo URL:

   `https://github.com/Raushansoni/obsidian-gdrive-sync`

5. Enable **Google Drive Sync** in Community plugins  
6. Plugin settings → **Connect Google** (Client ID is pre-filled in official releases) → same **Remote folder name** as your PC → **Sync now**

BRAT installs from GitHub **Releases** (`main.js`, `manifest.json`, `styles.css`). After updates: **BRAT: Check for plugin updates**.

Official release builds bake in the OAuth client at compile time (via CI secrets / local `.env`). The GitHub **source** does not contain those values.

### Desktop — local setup script

```bash
npm install
npm run setup
```

Options:

```bash
npm run setup -- --vault="C:\Users\YOU\Documents\MyVault"
npm run setup -- --credentials="C:\path\to\client_secret.json"
npm run setup -- --rebuild
```

Then: Connect Google → Remote folder name → Sync now.

## Mobile auth (device code)

Phones cannot use the desktop loopback redirect (`http://127.0.0.1:42813/`). Mobile uses Google’s **device-code** login instead — no redirect URI and no hosted callback page.

### Google Cloud — “TVs and Limited Input devices” client

1. [Credentials](https://console.cloud.google.com/apis/credentials) → **Create OAuth client ID**  
2. Application type: **TVs and Limited Input devices**  
3. Name it (e.g. `Obsidian GDrive Sync`) → **Create**  
4. Copy **Client ID** + **Client Secret** (no redirect URIs)  
5. Put them in GitHub secrets / `.env` and cut a release (or paste into plugin settings)  
6. OAuth consent screen: **External** + **In production** so any Google account can approve

Keep a **Desktop** client for PC browser loopback if you want; mobile (and desktop fallback) uses the TV/device client.

### Connect on Android / iOS

1. Update plugin to **1.0.4+** via BRAT  
2. Tap **Connect Google**  
3. Open **google.com/device** (button in settings)  
4. Enter the on-screen code → Allow  
5. Obsidian connects automatically → set remote folder → **Sync now**

## Commands

| Command | Action |
|--------|--------|
| Sync now | Run a full bidirectional sync |
| Connect Google account | Start OAuth |
| Disconnect Google account | Revoke local tokens |
| Open Google Drive Sync settings | Jump to settings |

## Conflict handling

If the same note changed on two devices since the last sync:

- Local version is kept as the main file
- Remote version is saved as `Note (conflict YYYY-MM-DD).md`
- Local version is pushed to Drive

## Security notes

- Vault files are stored in **your** Google Drive (not end-to-end encrypted by this plugin).
- OAuth tokens are stored in the plugin `data.json` inside the vault’s `.obsidian` folder (that file is ignored from sync by default).
- Scope used: `drive.file` (only files created/opened by this app).

## Development

```bash
npm run dev          # watch build
npm run build        # production build
npm run setup        # build (if needed) + install + enable in vault
```

### Publish a BRAT release

```bash
npm run build
git add -A && git commit -m "release: v1.0.1"
git tag v1.0.1
git push origin main --tags
```

Or run the **Build and release** GitHub Action (workflow_dispatch). Bump `version` in `manifest.json` / `package.json` to match the tag.

## Limitations (v1)

- First sync of a large vault can take a while (full listing + uploads).
- Not a real-time collaborative editor (device sync, not CRDT).
- Requires Google Cloud OAuth client in Testing mode for personal use (no Play Store / Community listing verification needed).
