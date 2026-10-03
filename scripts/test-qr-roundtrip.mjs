/**
 * Pairing QR must round-trip: encoder matrix → raster → jsQR → pairing code.
 * Also covers deep-link / typed-code parsing used by the phone scanner.
 *
 * Run: node scripts/test-qr-roundtrip.mjs
 */
import * as esbuild from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import jsQR from "jsqr";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`ok  ${name}`);
    return;
  }
  failed++;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function rasterize(dark, moduleSize = 4, quiet = 4) {
  const n = dark.length;
  const dim = (n + quiet * 2) * moduleSize;
  const data = new Uint8ClampedArray(dim * dim * 4);
  data.fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!dark[r][c]) continue;
      const y0 = (r + quiet) * moduleSize;
      const x0 = (c + quiet) * moduleSize;
      for (let dy = 0; dy < moduleSize; dy++) {
        for (let dx = 0; dx < moduleSize; dx++) {
          const i = ((y0 + dy) * dim + (x0 + dx)) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
          data[i + 3] = 255;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "flock-qr-"));
const outfile = path.join(tmp, "code-qr.mjs");

try {
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "src/pair/code.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  const qrOut = path.join(tmp, "qr.mjs");
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "src/pair/qr.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: qrOut,
    logLevel: "silent",
  });

  const { qrPayload, codeFromScanText } = await import(pathToFileURL(outfile).href);
  const { qrMatrix } = await import(pathToFileURL(qrOut).href);

  const code = "737-baby-face";
  const link = qrPayload("737", code);
  check(
    "deep link contains nameplate and code",
    link.includes("flock-sync") && link.includes("737") && link.includes("baby-face"),
    link
  );
  check("parse deep link", codeFromScanText(link) === code, codeFromScanText(link));
  check("parse typed code", codeFromScanText("737-baby-face") === code);
  check("parse spaced code", codeFromScanText("737 baby face") === code);
  check("parse query only", codeFromScanText("n=737&c=737-baby-face") === code);

  let threw = false;
  try {
    codeFromScanText("https://example.com/not-a-pair");
  } catch {
    threw = true;
  }
  check("reject unrelated QR text", threw);

  const matrix = qrMatrix(link);
  const img = rasterize(matrix.dark);
  const decoded = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
  check("jsQR reads encoded pairing QR", Boolean(decoded?.data), decoded?.data ?? "null");
  check(
    "decoded QR is a joinable pairing code",
    decoded?.data ? codeFromScanText(decoded.data) === code : false,
    decoded?.data ?? ""
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
