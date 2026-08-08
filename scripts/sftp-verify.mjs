// Phase 2 spike: does SFTP over the browser WASM client actually stream?
//
// Two questions the Phase 0 result did not answer:
//   1. Is SFTP throughput usable, or does the relay round trip kill it?
//   2. Does a large transfer stream, or does it balloon the tab's heap?
//
// The second matters more. A file explorer that buffers a 4 GB upload in
// memory is not a file explorer, it is a crash.
//
//   node scripts/sftp-verify.mjs [--headed] [--size 128]

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const URL = process.env.HARNESS_URL ?? "http://localhost:8080/";
const CONTAINER = process.env.SSHD_CONTAINER ?? "webxterm-sshd";
const headed = process.argv.includes("--headed");
const sizeIdx = process.argv.indexOf("--size");
const SIZE_MB = sizeIdx > -1 ? parseInt(process.argv[sizeIdx + 1], 10) : 128;

const GATES = {
  throughputMBps: 20,
  // Retained heap after a forced GC should be near zero regardless of file
  // size — if we streamed, nothing is left holding the bytes.
  retainedMB: 16,
  // The decisive test: doubling the file must not double memory. A buffering
  // implementation scales ~1.0; a streaming one stays flat.
  scalingRatio: 1.5,
};

const results = {};
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail.push(name);
};

const browser = await chromium.launch({
  headless: !headed,
  // Precise heap numbers, plus window.gc() so we can measure retained memory
  // rather than whatever the collector happened not to have swept yet.
  args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));

try {
  console.log(`\nwebxterm SFTP spike (${SIZE_MB} MB)\n${"─".repeat(60)}`);

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__wasmBootMs === "number", { timeout: 30000 });

  await page.evaluate(() => window.__api.generate());
  await page.waitForFunction(() => typeof window.__pubkey === "string");
  const pubkey = await page.evaluate(() => window.__pubkey);
  execFileSync("docker", ["exec", CONTAINER, "sh", "-c",
    `echo '${pubkey}' >> /home/webxterm/.ssh/authorized_keys`]);

  await page.evaluate(() => window.__api.connect());
  await page.waitForFunction(
    () => window.__connected === true || typeof window.__connectError === "string",
    { timeout: 30000 });
  const err = await page.evaluate(() => window.__connectError);
  if (err) throw new Error(`connect failed: ${err}`);

  console.log(`\n1. Subsystem`);
  const sftpReady = await page.evaluate(() => window.__sftpReady === true);
  check("SFTP opens on the existing SSH connection", sftpReady, "no second login");

  console.log(`\n2. Directory listing`);
  const listing = await page.evaluate(() => window.__api.sftpList("/etc"));
  check("list /etc returns entries", listing.entries.length > 5,
        `${listing.entries.length} entries, dirs first`);
  const home = await page.evaluate(() => window.__api.sftpList("/home/webxterm"));
  check("list home succeeds", Array.isArray(home.entries), home.path);

  const upload = (mb) =>
    page.evaluate(([m]) => window.__api.sftpUpload("/home/webxterm/upload.bin", m), [mb]);
  const download = () =>
    page.evaluate(() => window.__api.sftpDownload("/home/webxterm/upload.bin"));
  const remoteSize = () =>
    parseInt(execFileSync("docker",
      ["exec", CONTAINER, "stat", "-c", "%s", "/home/webxterm/upload.bin"]).toString().trim(), 10);

  console.log(`\n3. Streaming upload`);
  const half = await upload(SIZE_MB / 2);
  const up = await upload(SIZE_MB);
  results.uploadMBps = up.mbPerSec;
  results.uploadRetainedMB = up.retainedMB;
  results.uploadPeakMB = up.peakMB;

  check(`upload over ${GATES.throughputMBps} MB/s`, up.mbPerSec > GATES.throughputMBps,
        `${up.mbPerSec.toFixed(1)} MB/s for ${(up.bytes / 1048576).toFixed(0)} MB`);
  check(`upload retains < ${GATES.retainedMB} MB after GC`,
        up.retainedMB < GATES.retainedMB,
        `retained ${up.retainedMB.toFixed(1)} MB, peak +${up.peakMB.toFixed(1)} MB, moving ${SIZE_MB} MB`);

  // The decisive one: memory must not track file size.
  const upRatio = up.peakMB / Math.max(half.peakMB, 1);
  results.uploadScalingRatio = upRatio;
  check(`upload memory does not scale with file size (< ${GATES.scalingRatio}x)`,
        upRatio < GATES.scalingRatio,
        `${SIZE_MB / 2} MB → +${half.peakMB.toFixed(1)} MB, ${SIZE_MB} MB → +${up.peakMB.toFixed(1)} MB (${upRatio.toFixed(2)}x for 2x the data)`);

  check("uploaded file is intact on the server", remoteSize() === SIZE_MB * 1048576,
        `${remoteSize()} bytes on disk`);

  console.log(`\n4. Streaming download`);
  const down = await download();
  results.downloadMBps = down.mbPerSec;
  results.downloadRetainedMB = down.retainedMB;
  results.downloadPeakMB = down.peakMB;
  check(`download over ${GATES.throughputMBps} MB/s`, down.mbPerSec > GATES.throughputMBps,
        `${down.mbPerSec.toFixed(1)} MB/s for ${(down.bytes / 1048576).toFixed(0)} MB`);
  check(`download retains < ${GATES.retainedMB} MB after GC`,
        down.retainedMB < GATES.retainedMB,
        `retained ${down.retainedMB.toFixed(1)} MB, peak +${down.peakMB.toFixed(1)} MB`);
  check("downloaded byte count matches", down.received === SIZE_MB * 1048576,
        `${down.received} bytes`);

  console.log(`\n5. Mutations`);
  await page.evaluate(() => window.__api.sftpRemove("/home/webxterm/upload.bin"));
  const gone = await page.evaluate(() =>
    window.__api.sftpStat("/home/webxterm/upload.bin").then(() => false).catch(() => true));
  check("remove deletes the file", gone, "stat now fails as expected");

  console.log(`\n${"─".repeat(60)}`);
  console.log(fail.length === 0 ? "ALL GATES PASSED" : `FAILED: ${fail.join(", ")}`);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}

process.exit(fail.length === 0 ? 0 : 1);
