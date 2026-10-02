/**
 * Regression: two devices linking the same vault name must share one vaultId,
 * and the device with an empty duplicate must adopt the log that has ops.
 *
 * Run: node scripts/test-vault-join.mjs
 */
import * as esbuild from "esbuild";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(os.tmpdir(), `flock-pick-vault-${Date.now()}.mjs`);

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`ok  ${name}`);
    return;
  }
  failed++;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

await esbuild.build({
  absWorkingDir: root,
  entryPoints: [path.join(root, "src/sync/pick-vault.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "silent",
});

const {
  pickVaultToLink,
  pickRichestVault,
  shouldEnqueueLocalPath,
  namesMatch,
} = await import(pathToFileURL(outfile).href);

check("empty flock → mint new", pickVaultToLink([], "NEW", null) === null);

check(
  "single flock vault is reused even if names differ",
  pickVaultToLink([{ vaultId: "v1", name: "Other" }], "NEW", null) === "v1"
);

check(
  "same name joins the existing vault instead of minting",
  pickVaultToLink(
    [
      { vaultId: "phone", name: "NEW", createdAt: 1 },
      { vaultId: "notes", name: "Work", createdAt: 2 },
    ],
    "NEW",
    null
  ) === "phone"
);

// The user's bug: phone minted 1c1f5d75, desktop minted 1c6e4c02, both named NEW.
const forks = [
  { vaultId: "1c1f5d75-9595-4119-b41a-3be43042481c", name: "NEW", createdAt: 1790919758855 },
  { vaultId: "1c6e4c02-25e2-4cb9-be37-2fa0e331fe99", name: "NEW", createdAt: 1790919762104 },
];
check(
  "same-name forks do not lock onto the later duplicate id",
  pickVaultToLink(forks, "NEW", "1c6e4c02-25e2-4cb9-be37-2fa0e331fe99") ===
    "1c1f5d75-9595-4119-b41a-3be43042481c"
);

check(
  "richest same-name vault wins (desktop's 30 ops, not the phone's empty fork)",
  pickRichestVault([
    { vaultId: "1c1f5d75-9595-4119-b41a-3be43042481c", head: 2 },
    { vaultId: "1c6e4c02-25e2-4cb9-be37-2fa0e331fe99", head: 30 },
  ]) === "1c6e4c02-25e2-4cb9-be37-2fa0e331fe99"
);

check(
  "two different vault names stay separate",
  pickVaultToLink(
    [
      { vaultId: "a", name: "Home", createdAt: 1 },
      { vaultId: "b", name: "Work", createdAt: 2 },
    ],
    "Travel",
    null
  ) === null
);

check("already-enrolled unique vault is kept", pickVaultToLink(forks.slice(0, 1), "NEW", forks[0].vaultId) === forks[0].vaultId);

check("namesMatch ignores case/space", namesMatch("NEW", " new "));
check("namesMatch rejects empty", !namesMatch("", ""));

check("new local file is enqueued", shouldEnqueueLocalPath(undefined) === true);
check("never-synced tombstone is enqueued", shouldEnqueueLocalPath({ hash: null }) === true);
check("already-synced file is not blindly re-enqueued", shouldEnqueueLocalPath({ hash: "abc" }) === false);

await rm(outfile, { force: true });

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
