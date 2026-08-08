// Phase 0 verification: drive a real browser end to end and measure the gates.
//
// The claim under test is narrow and load-bearing: a Go/WASM SSH client can
// authenticate to an unmodified OpenSSH server using a WebCrypto key that it is
// structurally incapable of reading. Everything else in the plan depends on it.
//
//   node scripts/phase0-verify.mjs [--headed]
//
// Requires: `make sshd` running, `make relay` running, `make wasm` built.

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const URL = process.env.HARNESS_URL ?? "http://localhost:8080/";
const CONTAINER = process.env.SSHD_CONTAINER ?? "webxterm-sshd";
const headed = process.argv.includes("--headed");

const GATES = {
  bundleBrotliMB: 4,
  connectMs: 3000,
  keystrokeMs: 50,
  sftpMBps: 20, // stands in for bulk throughput at this stage
};

const results = {};
const fail = [];

function check(name, ok, detail) {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail.push(name);
}

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage();

page.on("console", (m) => {
  if (m.type() === "error") console.log(`  [browser error] ${m.text()}`);
});
page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));

try {
  console.log(`\nwebxterm Phase 0 verification\n${"─".repeat(60)}`);
  console.log(`browser: ${browser.version()}`);

  // 1 ── load the harness and boot WASM
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__wasmBootMs === "number", { timeout: 30000 });
  results.wasmBootMs = await page.evaluate(() => window.__wasmBootMs);
  console.log(`\n1. WASM boot`);
  check("wasm instantiates in the browser", true, `${results.wasmBootMs.toFixed(0)} ms`);

  // 2 ── generate a key and prove it cannot be read back
  console.log(`\n2. Key custody`);
  await page.evaluate(() => window.__api.generate());
  await page.waitForFunction(() => typeof window.__pubkey === "string", { timeout: 10000 });
  const pubkey = await page.evaluate(() => window.__pubkey);
  results.nonExtractable = await page.evaluate(() => window.__nonExtractable);
  check("private key is non-extractable", results.nonExtractable,
        "pkcs8/jwk/raw export all refused");
  check("public key exports in authorized_keys format", /^ssh-ed25519 AAAA/.test(pubkey),
        pubkey.slice(0, 44) + "…");

  // 3 ── authorize it on the stock sshd, exactly as a user would
  console.log(`\n3. Server-side setup`);
  execFileSync("docker", [
    "exec", CONTAINER, "sh", "-c",
    `echo '${pubkey}' >> /home/webxterm/.ssh/authorized_keys`,
  ]);
  check("public key appended to authorized_keys", true, "one line, nothing installed");

  // 4 ── THE GATE: authenticate using only the WebCrypto signer
  console.log(`\n4. Authentication`);
  await page.evaluate(() => window.__api.connect());
  await page.waitForFunction(
    () => window.__connected === true || typeof window.__connectError === "string",
    { timeout: 30000 },
  );
  const connectError = await page.evaluate(() => window.__connectError);
  if (connectError) {
    check("WebCrypto signer accepted by stock OpenSSH", false, connectError);
    throw new Error(`authentication failed: ${connectError}`);
  }
  results.connectMs = await page.evaluate(() => window.__connectMs);
  check("WebCrypto signer accepted by stock OpenSSH", true,
        `authenticated in ${results.connectMs.toFixed(0)} ms`);
  check(`connect under ${GATES.connectMs} ms`, results.connectMs < GATES.connectMs,
        `${results.connectMs.toFixed(0)} ms`);

  // 5 ── the shell actually works
  console.log(`\n5. Interactive shell`);
  await page.evaluate(() => window.__api.send("echo PHASE0-$((6*7))\n"));
  await page.waitForFunction(() => window.__api.screen().includes("PHASE0-42"), { timeout: 15000 });
  check("remote command executes and output renders", true, "echo PHASE0-42 → PHASE0-42");

  // 6 ── keystroke latency
  console.log(`\n6. Latency`);
  const samples = [];
  for (let i = 0; i < 12; i++) samples.push(await page.evaluate(() => window.__api.echoLatency()));
  samples.sort((a, b) => a - b);
  results.keystrokeMedianMs = samples[Math.floor(samples.length / 2)];
  results.keystrokeP95Ms = samples[Math.floor(samples.length * 0.95)];
  check(`median keystroke echo under ${GATES.keystrokeMs} ms`,
        results.keystrokeMedianMs < GATES.keystrokeMs,
        `median ${results.keystrokeMedianMs.toFixed(1)} ms, p95 ${results.keystrokeP95Ms.toFixed(1)} ms`);
  await page.evaluate(() => window.__api.send("")); // Ctrl-C to clear the line

  // 7 ── bulk throughput
  console.log(`\n7. Throughput`);
  const MB = 32;
  const tp = await page.evaluate(
    ([mb]) => window.__api.throughput(`head -c ${mb * 1048576} /dev/zero | tr '\\0' a`, mb * 1048576),
    [MB],
  );
  results.throughputMBps = tp.mbPerSec;
  check(`bulk throughput over ${GATES.sftpMBps} MB/s`, tp.mbPerSec > GATES.sftpMBps,
        `${tp.mbPerSec.toFixed(1)} MB/s over ${(tp.bytes / 1048576).toFixed(0)} MB`);

  console.log(`\n${"─".repeat(60)}`);
  console.log(fail.length === 0 ? "ALL GATES PASSED" : `FAILED: ${fail.join(", ")}`);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}

process.exit(fail.length === 0 ? 0 : 1);
