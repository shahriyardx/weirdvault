// Builds the agent for every platform a user might install it on, into the
// directory /install.sh downloads from.
//
//   bun scripts/build-agent.mjs
//
// The output is not committed. These are ~8 MB each and rebuilding them is one
// command, so they live in public/ the same way ssh.wasm does — built on demand,
// gitignored, and published by whatever ships the app.
//
// checksums.txt is written alongside them and is not optional. /install.sh
// refuses to install without it, because a verification that is skipped when
// the file is missing verifies nothing at all. That matters most when
// AGENT_RELEASE_BASE_URL points somewhere other than your own origin: the
// binary then comes from a release host and the checksum is what makes it as
// trustworthy as the script that named it.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_DIR = "apps/agent";
const OUT_DIR = "apps/web/public/agent-bin";

/**
 * What we build for.
 *
 * linux/amd64 and linux/arm64 cover essentially every home server and VPS;
 * linux/arm is the Raspberry Pi 32-bit images that are still in the wild.
 * darwin is here because "the machine at home" is a Mac often enough, and
 * because it is what a developer will try first on their own laptop.
 *
 * No Windows: the agent forwards to sshd on loopback, and a Windows box running
 * OpenSSH server is a different enough install story that shipping an untested
 * binary would be worse than not shipping one.
 */
const TARGETS = [
  ["linux", "amd64"],
  ["linux", "arm64"],
  ["linux", "arm"],
  ["darwin", "arm64"],
  ["darwin", "amd64"],
];

const capture = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

// Stamped into the binary so `weirdvault version` and the agent row in the
// dashboard say something more useful than "dev".
const version = capture("git", ["describe", "--tags", "--always", "--dirty"]) || "dev";

// Removed rather than overwritten: a target dropped from the list above would
// otherwise linger here and keep being served, and it would still be listed in
// checksums.txt, so nothing would flag it.
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

console.log(`building ${SRC_DIR} ${version} → ${OUT_DIR}`);

for (const [goos, goarch] of TARGETS) {
  const name = `weirdvault_${goos}_${goarch}`;
  execFileSync(
    "go",
    ["build", "-trimpath", `-ldflags=-s -w -X main.version=${version}`, "-o", resolve(OUT_DIR, name), "."],
    {
      stdio: "inherit",
      cwd: SRC_DIR,
      env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
    },
  );
  console.log(`  ${name}`);
}

// The same two-column format sha256sum produces, because that is what the
// install script parses and what an operator will regenerate by hand.
const lines = readdirSync(OUT_DIR)
  .filter((f) => f.startsWith("weirdvault_"))
  .sort()
  .map((f) => `${createHash("sha256").update(readFileSync(join(OUT_DIR, f))).digest("hex")}  ${f}`);

writeFileSync(join(OUT_DIR, "checksums.txt"), lines.join("\n") + "\n");

// The same facts again, shaped for a machine rather than a shell script.
//
// checksums.txt is what /install.sh greps because that is what sha256sum
// produces and what an operator regenerates by hand. manifest.json is what a
// running agent reads to decide whether to replace itself, and it carries the
// version — which checksums.txt has no place to put.
const manifest = {
  version,
  binaries: Object.fromEntries(
    lines.map((line) => {
      const [sha256, file] = line.split(/\s+/);
      return [file.replace("weirdvault_", ""), { file, sha256 }];
    }),
  ),
};
writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`\nmanifest.json: version ${version}, ${Object.keys(manifest.binaries).length} targets`);
console.log(lines.join("\n"));
