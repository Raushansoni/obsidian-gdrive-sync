/**
 * Regression: Dismiss on a pairing error must leave the error phase.
 * Also covers mobile localhost relay copy so the phone does not show a raw
 * Android ConnectException.
 *
 * Run: node scripts/test-phone-pairing.mjs
 */
import * as esbuild from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

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

const tmp = await mkdtemp(path.join(os.tmpdir(), "flock-pair-"));
const outfile = path.join(tmp, "session.mjs");

try {
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "src/pair/session.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    alias: { obsidian: stub },
    logLevel: "silent",
  });

  const { PairingFlow } = await import(pathToFileURL(outfile).href);
  const flow = new PairingFlow({}, {});

  flow.phase = "error";
  flow.error = "Request Failed.\nConnectException Failed to connect to /127.0.0.1:8787";
  flow.cancel();
  check("dismiss from error → idle", flow.phase === "idle", `phase=${flow.phase}`);
  check("dismiss clears error text", flow.error === null, `error=${flow.error}`);

  flow.phase = "host-waiting-guest";
  flow.error = null;
  flow.cancel();
  check("cancel in-flight → cancelled", flow.phase === "cancelled", `phase=${flow.phase}`);

  flow.phase = "idle";
  flow.cancel();
  check("cancel idle stays idle", flow.phase === "idle", `phase=${flow.phase}`);

  flow.phase = "done";
  flow.cancel();
  check("cancel done stays done", flow.phase === "done", `phase=${flow.phase}`);

  flow.phase = "cancelled";
  flow.cancel();
  check("second cancel from cancelled → idle", flow.phase === "idle", `phase=${flow.phase}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

const urlOut = path.join(os.tmpdir(), `flock-relay-url-${Date.now()}.mjs`);
try {
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "src/relay-url.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: urlOut,
    logLevel: "silent",
  });
  const {
    relayUrlProblem,
    explainRelayNetworkError,
    isLoopbackRelayUrl,
  } = await import(pathToFileURL(urlOut).href);

  check(
    "loopback detection",
    isLoopbackRelayUrl("http://127.0.0.1:8787") &&
      isLoopbackRelayUrl("http://localhost:8787") &&
      !isLoopbackRelayUrl("https://flock-relay.example.workers.dev")
  );

  const mobileLoopback = relayUrlProblem("http://127.0.0.1:8787", true);
  check(
    "mobile localhost is blocked with a human message",
    typeof mobileLoopback === "string" &&
      /phone|https:\/\//i.test(mobileLoopback) &&
      !/ConnectException/i.test(mobileLoopback),
    mobileLoopback ?? "null"
  );

  check("desktop localhost is allowed", relayUrlProblem("http://127.0.0.1:8787", false) === null);

  const mobileHttp = relayUrlProblem("http://192.168.1.10:8787", true);
  check(
    "mobile cleartext HTTP is blocked",
    typeof mobileHttp === "string" && /https:\/\//i.test(mobileHttp),
    mobileHttp ?? "null"
  );

  const translated = explainRelayNetworkError(
    new Error("Request Failed.\nConnectException Failed to connect to /127.0.0.1:8787"),
    "http://127.0.0.1:8787",
    true
  );
  check(
    "ConnectException on phone becomes a relay-url hint",
    /https:\/\//i.test(translated) && !/ConnectException/i.test(translated),
    translated
  );
} catch (e) {
  if (String(e?.message ?? e).includes("Could not resolve") && String(e).includes("relay-url.ts")) {
    check("relay-url.ts exists for mobile copy", false, "file not created yet (expected red)");
  } else {
    failed++;
    console.error("FAIL relay-url bundle", e);
  }
} finally {
  await rm(urlOut, { force: true }).catch(() => {});
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
