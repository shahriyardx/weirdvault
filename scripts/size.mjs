// Reports the WASM bundle size against the Phase 0 gate.
// First load is the one real cost of putting the SSH stack in the browser, so
// this number gets checked on every build rather than discovered later.
import { readFileSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

const GATE_MB = 4;
const path = process.argv[2] ?? "spike/web/ssh.wasm";
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
