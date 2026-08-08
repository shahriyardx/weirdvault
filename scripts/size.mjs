// Fails the build if ssh.wasm gets too big to download.
//
// Putting the SSH stack in the browser means every first-time visitor fetches
// the whole thing before they can connect to anything. That download is the one
// real cost of the architecture, and it is invisible while developing — the
// file is already cached on this machine. So the build asserts it rather than
// leaving it to be discovered by someone on a slow connection.
//
// The gate is brotli because that is what a CDN actually serves.
import { readFileSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

const GATE_MB = 4;
const path = process.argv[2] ?? "apps/web/public/ssh.wasm";
const buf = readFileSync(path);

const gz = gzipSync(buf, { level: 9 }).length;
const br = brotliCompressSync(buf, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
}).length;

const mb = (n) => (n / 1048576).toFixed(2).padStart(6);
const pass = br < GATE_MB * 1048576;

console.log(
  `wasm  raw ${mb(buf.length)} MB | gzip ${mb(gz)} MB | brotli ${mb(br)} MB` +
    `   [gate: brotli < ${GATE_MB.toFixed(2)} MB — ${pass ? "PASS" : "FAIL"}]`,
);

process.exit(pass ? 0 : 1);
