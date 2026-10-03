/**
 * Recovered errors must leave the settings UI. After a successful sync,
 * Error: lines and lastError disappear; duplicate retry noise collapses.
 *
 * Run: node scripts/test-status-view.mjs
 */
import * as esbuild from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stub = path.join(root, "scripts", "obsidian-stub.mjs");

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`ok  ${name}`);
    return;
  }
  failed++;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "flock-status-"));
const viewOut = path.join(tmp, "view.mjs");
const machineOut = path.join(tmp, "machine.mjs");

try {
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "src/status/view.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: viewOut,
    logLevel: "silent",
  });
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "src/status/machine.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: machineOut,
    alias: { obsidian: stub },
    logLevel: "silent",
  });

  const { statusHeadline, showLastError, visibleStatusLog, isErrorLogMsg } = await import(
    pathToFileURL(viewOut).href
  );
  const { StatusMachine } = await import(pathToFileURL(machineOut).href);

  check("error log detector", isErrorLogMsg("Error: device authentication failed"));
  check("sync ok is not an error", !isErrorLogMsg("Sync ok — pushed 5, applied 0"));

  check("healthy headline is not duplicated", statusHeadline("synced", "Synced") === "Status: Synced");
  check(
    "error headline keeps the message",
    statusHeadline("error", "device authentication failed") ===
      "Status: Error — device authentication failed"
  );

  check("lastError hidden after recovery", showLastError("synced", "device authentication failed") === null);
  check("lastError shown while failing", showLastError("error", "device authentication failed") !== null);

  const mixed = [
    { t: 1, msg: "Error: device authentication failed" },
    { t: 2, msg: "Error: device authentication failed" },
    { t: 3, msg: "Vault linked — NEW" },
    { t: 4, msg: "Sync ok — pushed 5, applied 0" },
  ];
  const healthy = visibleStatusLog(mixed, "synced").map((e) => e.msg);
  check(
    "recent sync drops recovered errors",
    healthy.join("|") === "Vault linked — NEW|Sync ok — pushed 5, applied 0",
    healthy.join("|")
  );
  check(
    "recent sync keeps errors while failing",
    visibleStatusLog(mixed, "error").some((e) => isErrorLogMsg(e.msg))
  );

  const data = {
    lastError: "device authentication failed",
    lastSyncAt: null,
    statusLog: [],
  };
  const machine = new StatusMachine();
  machine.hydrate(() => data);
  machine.note("Error: device authentication failed");
  machine.note("Error: device authentication failed");
  machine.note("Error: device authentication failed");
  check("duplicate retry errors collapse to one line", machine.snapshotLog().length === 1);
  machine.set("synced", "Synced");
  check("synced clears lastError", data.lastError === null);
  check(
    "synced drops Error: lines from the log",
    machine.snapshotLog().every((e) => !isErrorLogMsg(e.msg)),
    machine.snapshotLog().map((e) => e.msg).join("|")
  );
  check("synced persists a clean statusLog", (data.statusLog ?? []).every((e) => !String(e.msg).startsWith("Error:")));
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
