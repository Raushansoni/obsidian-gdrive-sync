import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import process from "process";
import { fileURLToPath } from "url";
import readline from "readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const PLUGIN_ID = "obsidian-gdrive-sync";
const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];

function loadEnv() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function obsidianConfigPath() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || "", "obsidian", "obsidian.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
  }
  return path.join(os.homedir(), ".config", "obsidian", "obsidian.json");
}

function discoverVaults() {
  const configFile = obsidianConfigPath();
  if (!fs.existsSync(configFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(configFile, "utf8"));
    const vaults = data.vaults || {};
    return Object.values(vaults)
      .map((v) => v?.path)
      .filter((p) => typeof p === "string" && fs.existsSync(p))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function ensureBuilt() {
  const missing = PLUGIN_FILES.filter((f) => !fs.existsSync(path.join(root, f)));
  if (missing.length === 0 && !process.argv.includes("--rebuild")) return;

  console.log("Building plugin…");
  if (!fs.existsSync(path.join(root, "node_modules"))) {
    const install = spawnSync("npm", ["install"], { cwd: root, stdio: "inherit", shell: true });
    if (install.status !== 0) process.exit(install.status ?? 1);
  }
  const build = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

function enablePlugin(vaultPath) {
  const obsidianDir = path.join(vaultPath, ".obsidian");
  fs.mkdirSync(obsidianDir, { recursive: true });

  const listPath = path.join(obsidianDir, "community-plugins.json");
  let enabled = [];
  if (fs.existsSync(listPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(listPath, "utf8"));
      if (Array.isArray(parsed)) enabled = parsed;
    } catch {
      enabled = [];
    }
  }
  if (!enabled.includes(PLUGIN_ID)) {
    enabled.push(PLUGIN_ID);
    fs.writeFileSync(listPath, JSON.stringify(enabled, null, 2) + "\n", "utf8");
    console.log(`Enabled plugin in community-plugins.json`);
  } else {
    console.log(`Plugin already listed in community-plugins.json`);
  }
}

const FLOCK_KEYS = [
  "relayUrl",
  "vaultId",
  "enrolled",
  "autoSync",
  "syncIntervalSeconds",
  "ignorePatterns",
  "lastSyncAt",
  "lastError",
  "statusLog",
  "localCursor",
  "pathTips",
  "lastHlc",
];

function looksLikeLegacyDrive(data) {
  return (
    data &&
    typeof data === "object" &&
    ("tokens" in data ||
      "syncIndex" in data ||
      "clientId" in data ||
      "clientSecret" in data ||
      "remoteFolderId" in data ||
      "pendingOAuthRedirectUri" in data)
  );
}

/** Keep only Flock fields. Drive OAuth tokens / syncIndex never survive install. */
function toFlockData(parsed, relayUrl) {
  const src = parsed && typeof parsed === "object" ? parsed : {};
  const legacy = looksLikeLegacyDrive(src);
  const interval = Number(src.syncIntervalSeconds);
  const out = {
    relayUrl: relayUrl || (typeof src.relayUrl === "string" && src.relayUrl.trim()) || undefined,
    vaultId: legacy ? null : typeof src.vaultId === "string" ? src.vaultId : null,
    enrolled: legacy ? false : src.enrolled === true,
    autoSync: src.autoSync !== false,
    syncIntervalSeconds: Number.isFinite(interval) && interval >= 15 ? Math.floor(interval) : 20,
    ignorePatterns: typeof src.ignorePatterns === "string" ? src.ignorePatterns : undefined,
    lastSyncAt: legacy ? null : typeof src.lastSyncAt === "number" ? src.lastSyncAt : null,
    lastError: legacy ? null : typeof src.lastError === "string" ? src.lastError : null,
    statusLog: legacy ? [] : Array.isArray(src.statusLog) ? src.statusLog : [],
    localCursor: legacy ? 0 : typeof src.localCursor === "number" ? src.localCursor : 0,
    pathTips: legacy ? {} : src.pathTips && typeof src.pathTips === "object" ? src.pathTips : {},
    lastHlc: legacy ? null : typeof src.lastHlc === "string" ? src.lastHlc : null,
  };
  if (!out.relayUrl) delete out.relayUrl;
  if (!out.ignorePatterns) delete out.ignorePatterns;
  return { out, legacy, extra: Object.keys(src).some((k) => !FLOCK_KEYS.includes(k)) };
}

function patchPluginData(vaultPath, relayUrl) {
  const dataPath = path.join(vaultPath, ".obsidian", "plugins", PLUGIN_ID, "data.json");
  let parsed = {};
  if (fs.existsSync(dataPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(dataPath, "utf8"));
      if (raw && typeof raw === "object") parsed = raw;
    } catch {
      parsed = {};
    }
  }
  const { out, legacy, extra } = toFlockData(parsed, relayUrl);
  if (!relayUrl && !legacy && !extra && fs.existsSync(dataPath)) return;
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(out, null, 2) + "\n", "utf8");
  if (relayUrl) console.log(`Wrote relay URL into plugin data.json: ${relayUrl}`);
  if (legacy || extra) console.log("Removed leftover Google Drive credentials from data.json");
}

function installToVault(vaultPath, relayUrl) {
  const target = path.join(vaultPath, ".obsidian", "plugins", PLUGIN_ID);
  fs.mkdirSync(target, { recursive: true });

  for (const file of PLUGIN_FILES) {
    const src = path.join(root, file);
    if (!fs.existsSync(src)) {
      console.error(`Missing ${file}. Build failed?`);
      process.exit(1);
    }
    fs.copyFileSync(src, path.join(target, file));
    console.log(`Copied ${file}`);
  }
  console.log(`Installed → ${target}`);
  enablePlugin(vaultPath);
  patchPluginData(vaultPath, relayUrl);
}

async function resolveVaultPath() {
  const cliPath = process.argv.find((a) => a.startsWith("--vault="))?.slice("--vault=".length);
  if (cliPath) return path.resolve(cliPath);
  if (process.env.OBSIDIAN_VAULT_PATH) return path.resolve(process.env.OBSIDIAN_VAULT_PATH);

  const vaults = discoverVaults();
  if (vaults.length === 1) {
    console.log(`Found vault: ${vaults[0]}`);
    return vaults[0];
  }
  if (vaults.length > 1) {
    console.log("Found Obsidian vaults:\n");
    vaults.forEach((v, i) => console.log(`  [${i + 1}] ${v}`));
    console.log("");
    const answer = await ask(`Pick a number (1-${vaults.length}), or paste a vault path: `);
    const asNum = Number(answer);
    if (Number.isInteger(asNum) && asNum >= 1 && asNum <= vaults.length) {
      return vaults[asNum - 1];
    }
    if (answer) return path.resolve(answer);
  }

  const typed = await ask("Enter your Obsidian vault path: ");
  if (!typed) {
    console.error("No vault path provided.");
    process.exit(1);
  }
  return path.resolve(typed);
}

async function main() {
  loadEnv();
  ensureBuilt();

  const vaultPath = await resolveVaultPath();
  if (!fs.existsSync(vaultPath)) {
    console.error(`Vault path does not exist: ${vaultPath}`);
    process.exit(1);
  }

  // Optional: point the plugin at a specific relay (e.g. a deployed worker).
  // Unset = plugin default (the permanent workers.dev relay).
  const relayUrl = process.env.FLOCK_RELAY_URL?.trim() || null;
  if (relayUrl) console.log(`Using relay URL from FLOCK_RELAY_URL: ${relayUrl}\n`);

  console.log(`\nInstalling into: ${vaultPath}\n`);
  installToVault(vaultPath, relayUrl);

  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `OBSIDIAN_VAULT_PATH=${vaultPath}\n`, "utf8");
    console.log(`Saved vault path to .env for next time`);
  }

  console.log(`
Done. Restart Obsidian (or reload the vault).

Pair your devices (Flock Sync — no Google account):
  1. If Restricted mode is on → turn it off
  2. Make sure the relay is running (desktop): cd relay && npm run dev
     (first time: npm install, then
      npx wrangler d1 execute flock --local --file=src/schema.sql)
  3. Settings → Flock Sync → "Pair a device" → Start pairing
     → shows a nameplate, two words, and a QR code
  4. On the other device: enter the code (e.g. 123-able-acid) or scan the QR
  5. Compare the three check words on both screens → tap Pair on both
  6. "Link this vault" on every device that should sync this vault
  7. Sync now (ribbon, status bar, or command palette)

Notes:
  - Pairing is once per device; linking is per vault.
  - Phones cannot reach http://127.0.0.1:8787 (cleartext HTTP is blocked on
    mobile). Deploy the relay later and build with FLOCK_RELAY_URL=<https-url>
    to add mobile devices — not needed for desktop-to-desktop sync.
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
