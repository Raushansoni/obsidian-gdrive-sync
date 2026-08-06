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

function parseCredentialsFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const block = raw.installed || raw.web || raw;
  const clientId = block.client_id || block.clientId;
  const clientSecret = block.client_secret || block.clientSecret || "";
  if (!clientId) {
    throw new Error(`No client_id found in ${filePath}`);
  }
  const redirects = block.redirect_uris || block.redirectUris || [];
  return { clientId, clientSecret, redirects };
}

function writePluginSettings(vaultPath, creds) {
  const dataPath = path.join(vaultPath, ".obsidian", "plugins", PLUGIN_ID, "data.json");
  let data = {};
  if (fs.existsSync(dataPath)) {
    try {
      data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    } catch {
      data = {};
    }
  }
  data.clientId = creds.clientId;
  data.clientSecret = creds.clientSecret || data.clientSecret || "";
  const listed = (creds.redirects || []).map(String);
  if (listed.some((u) => u.includes("127.0.0.1"))) {
    data.redirectUri = "http://127.0.0.1:42813/";
  } else if (listed.some((u) => /localhost/i.test(u))) {
    // Desktop client JSON often lists http://localhost — match host to avoid redirect_uri_mismatch
    data.redirectUri = "http://localhost:42813/";
  } else if (!data.redirectUri) {
    data.redirectUri = "http://127.0.0.1:42813/";
  }
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`Wrote OAuth Client ID into plugin data.json`);
  console.log(`Redirect URI set to: ${data.redirectUri}`);
}

function installToVault(vaultPath, creds) {
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
  if (creds) writePluginSettings(vaultPath, creds);
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

  const credArg = process.argv.find((a) => a.startsWith("--credentials="))?.slice("--credentials=".length);
  const credPath = credArg || process.env.GOOGLE_OAUTH_CREDENTIALS;
  let creds = null;
  if (credPath) {
    const resolved = path.resolve(credPath);
    if (!fs.existsSync(resolved)) {
      console.error(`Credentials file not found: ${resolved}`);
      process.exit(1);
    }
    creds = parseCredentialsFile(resolved);
    console.log(`Loaded Google OAuth client from: ${resolved}`);
  }

  const vaultPath = await resolveVaultPath();
  if (!fs.existsSync(vaultPath)) {
    console.error(`Vault path does not exist: ${vaultPath}`);
    process.exit(1);
  }

  console.log(`\nInstalling into: ${vaultPath}\n`);
  installToVault(vaultPath, creds);

  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) {
    let envBody = `OBSIDIAN_VAULT_PATH=${vaultPath}\n`;
    if (credPath) envBody += `GOOGLE_OAUTH_CREDENTIALS=${path.resolve(credPath)}\n`;
    fs.writeFileSync(envPath, envBody, "utf8");
    console.log(`Saved paths to .env for next time`);
  }

  console.log(`
Done. Restart Obsidian (or reload the vault).

Still needed once inside Obsidian:
  1. If Restricted mode is on → turn it off
  2. Settings → Google Drive Sync → Connect Google
  3. Set Remote folder name → Sync now
${creds ? "  (Client ID / Secret were pre-filled from your credentials file)\n" : "  (Paste Client ID if not using --credentials=...)\n"}
Important: In Google Cloud, for this Desktop client, loopback auth uses:
  http://127.0.0.1:42813/
If Connect fails with redirect_uri_mismatch, add that URI (or use http://localhost:42813/ in plugin settings to match your client JSON).

Re-run:
  npm run setup -- --credentials="C:\\\\path\\\\to\\\\client_secret.json"
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
