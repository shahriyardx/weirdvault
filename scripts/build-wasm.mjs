// Builds the Go SSH core into the app's public directory.
//
// This is a script rather than a one-line npm script because of wasm_exec.js:
// it ships inside the Go toolchain and has to match the compiler that produced
// the module, so it is copied out of GOROOT on every build rather than
// vendored. A stale copy fails at runtime with an unhelpful error.
//
//   bun scripts/build-wasm.mjs

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_DIR = "apps/ssh";
const OUT_DIR = "apps/web/public";
// go build runs with its own module as the working directory, so the output
// path has to be absolute or it lands next to the source.
const WASM = resolve(OUT_DIR, "ssh.wasm");

/** Runs a command, inheriting stdio. Throws on a non-zero exit. */
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    stdio: "inherit",
    ...opts,
    env: { ...process.env, ...opts.env },
  });

/** Runs a command and returns its stdout. */
const capture = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8" }).trim();

mkdirSync(OUT_DIR, { recursive: true });

console.log(`building ${SRC_DIR} → ${WASM}`);
run("go", ["build", "-ldflags=-s -w", "-o", WASM, "."], {
  cwd: SRC_DIR,
  env: { GOOS: "js", GOARCH: "wasm" },
});

const goroot = capture("go", ["env", "GOROOT"]);
copyFileSync(join(goroot, "lib/wasm/wasm_exec.js"), join(OUT_DIR, "wasm_exec.js"));
console.log(`copied wasm_exec.js from ${goroot}`);

// Bundle size is the one real cost of putting the SSH stack in the browser, so
// it gets checked on every build rather than discovered by a user on 4G.
run("bun", ["scripts/size.mjs", WASM]);
