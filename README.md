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

## Why mobile showed `CONNECTION_REFUSED` (root cause)

Google was told to redirect to `http://127.0.0.1:42813/`. On a phone **nothing listens** on that address, so the browser always reports connection refused. That is not a Drive/API outage — loopback OAuth cannot finish inside a mobile browser.

**Fix (v1.0.3+):** mobile uses an HTTPS callback page, then `obsidian://gdrive-sync?code=…`.

### Google Cloud — use a Web application OAuth client

Your old **Desktop** client only allows localhost. For phones, create (or switch to) **Web application**:

1. Google Cloud → **Credentials → Create OAuth client ID → Web application**
2. Authorized redirect URIs — add **both**:
   - `http://127.0.0.1:42813/`
   - `https://raushansoni.github.io/obsidian-gdrive-sync/oauth-callback.html`
3. Copy Client ID + Secret into GitHub Actions secrets / local `.env`, cut a new release
4. OAuth consent screen: **External** + **In production** (so any Google account can sign in)

### Mobile auth (Android / iOS)

1. Update plugin to **1.0.3+** via BRAT  
2. Tap **Connect Google** → sign in  
3. You should land on the GitHub Pages callback → **Open Obsidian** (or it auto-opens)  
4. Set remote folder name → **Sync now**

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
