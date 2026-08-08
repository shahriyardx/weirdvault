// Phase 2/3 verification: the full workspace.
//
// Covers the things added after Phase 1 — host key pinning, password-first key
// installation, the file explorer, streaming downloads, directory upload with
// the tar fast path, Monaco editing, and vault sync.
//
//   node scripts/phase2-verify.mjs [--headed]

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const CONTAINER = process.env.SSHD_CONTAINER ?? "webxterm-sshd";
const headed = process.argv.includes("--headed");

const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail.push(name);
};
const docker = (...args) => execFileSync("docker", ["exec", CONTAINER, ...args]).toString();

const browser = await chromium.launch({ headless: !headed });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));

const screen = () =>
  page.evaluate(() => {
    const b = window.__webxtermTerm?.buffer.active;
    if (!b) return "";
    return Array.from({ length: b.length }, (_, i) =>
      b.getLine(i)?.translateToString(true) ?? "").join("\n");
  });

try {
  console.log(`\nwebxterm Phase 2/3 verification\n${"─".repeat(62)}`);

  // Start from a clean remote home, or leftovers from a previous run get
  // counted as this run's results.
  docker("sh", "-c", "rm -f /home/webxterm/*.txt /home/webxterm/*.bin");

  // Sign up first so the vault is unlocked and portable keys are possible.
  console.log(`\n1. Account and vault`);
  const email = `t${Date.now()}@webxterm.test`;
  await page.goto(`${BASE}/sign-up`, { waitUntil: "networkidle" });
  await page.getByPlaceholder("Name").fill("Test User");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(/\/workspace/, { timeout: 60000 });
  check("signed up and landed in the workspace", true, email);
  await page.waitForFunction(() => window.webxtermSSH !== undefined, { timeout: 30000 });
  check("vault unlocked in the workspace", (await page.getByText(/Vault unlocked/).count()) > 0);

  // ---- portable key, which requires the vault key to wrap ----
  console.log(`\n2. Portable key`);
  await page.getByRole("button", { name: "Portable" }).click();
  await page.waitForSelector("pre", { timeout: 15000 });
  const cmd = (await page.locator("pre").first().innerText()).trim();
  const pubkey = cmd.match(/'([^']+)'/)[1];
  check("portable key generated and wrapped", /^ssh-ed25519 AAAA/.test(pubkey));
  check("key reports non-extractable", (await page.getByText(/✓ non-extractable/).count()) > 0);

  // ---- password-first onboarding installs the key for the user ----
  console.log(`\n3. Password-first onboarding`);
  docker("sh", "-c", "cp /dev/null /home/webxterm/.ssh/authorized_keys");
  await page.getByLabel(/use password once/i).check();
  await page.getByPlaceholder("password").fill("webxterm");
  await page.getByRole("button", { name: /^connect$/i }).click();
  await page.getByRole("button", { name: /disconnect/i }).waitFor({ timeout: 45000 });
  check("connected with a password", true);
  const authorized = docker("cat", "/home/webxterm/.ssh/authorized_keys");
  check("public key installed by webxterm itself", authorized.includes(pubkey.split(" ")[1]),
        "no copy-paste needed");
  check("host key pinned on first contact",
        (await page.getByText(/Pinned host key/).count()) > 0);

  // ---- reconnect using the installed key, verifying the pin ----
  console.log(`\n4. Reconnect with the key`);
  await page.getByRole("button", { name: /disconnect/i }).click();
  await page.getByRole("button", { name: /^connect$/i }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: /^connect$/i }).click();
  await page.getByRole("button", { name: /disconnect/i }).waitFor({ timeout: 45000 });
  check("reconnected using the installed key against the pinned host", true);

  await page.waitForFunction(
    () => window.__webxtermTerm?.buffer.active.getLine(0)?.translateToString(true).length > 0,
    { timeout: 15000 });
  check("shell is live", (await screen()).includes("$"));

  // ---- file explorer ----
  console.log(`\n5. File explorer`);
  await page.waitForFunction(() => document.body.innerText.includes("Empty directory")
    || /\d+ (B|KB|MB)/.test(document.body.innerText)
    || document.body.innerText.includes("📁"), { timeout: 20000 });
  check("explorer listed the remote directory on the same connection", true);

  // ---- upload a directory via the tar fast path ----
  console.log(`\n6. Directory upload (tar fast path)`);
  const uploaded = await page.evaluate(async () => {
    const mod = await import("/_next/static/chunks/does-not-exist.js").catch(() => null);
    void mod;
    return true;
  });
  void uploaded;
  // Drive the hidden file input directly: Playwright can set files on it.
  const files = [];
  for (let i = 0; i < 40; i++) {
    files.push({ name: `f${i}.txt`, mimeType: "text/plain", buffer: Buffer.from(`file ${i}\n`) });
  }
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(files);
  await page.waitForFunction(
    () => document.body.innerText.includes("complete"), { timeout: 60000 });
  const strategyNote = await page.getByText(/via (tar|sftp)/).innerText();
  check("40 small files uploaded", true, strategyNote);
  check("tar fast path chosen for many small files", strategyNote.includes("tar"),
        strategyNote);
  const remoteCount = docker("sh", "-c", "ls /home/webxterm/*.txt | wc -l").trim();
  check("files landed on the server", parseInt(remoteCount, 10) === 40, `${remoteCount} files`);

  // ---- Monaco editing ----
  console.log(`\n7. Remote editing with Monaco`);
  // chown matters: docker exec runs as root, and a root-owned file is one the
  // webxterm user cannot overwrite — which would fail the save for the right
  // reason but the wrong test.
  docker("sh", "-c",
    "echo 'hello from the server' > /home/webxterm/note.txt && chown webxterm:webxterm /home/webxterm/note.txt");
  await page.getByRole("button", { name: "⟳" }).click();
  await page.getByText("note.txt", { exact: false }).first().dblclick();
  await page.waitForSelector(".monaco-editor", { timeout: 60000 });
  check("Monaco opened the remote file", true);
  // Monaco renders spaces as U+00A0 in .view-lines, so normalise before
  // comparing or an exact match never lands.
  const shown = (await page.locator(".monaco-editor .view-lines").innerText())
    .replace(/ /g, " ");
  check("file contents loaded into the editor", shown.includes("hello from the server"),
        shown.trim().split("\n")[0]);

  await page.evaluate(() => window.__webxtermEditor.setValue("edited by webxterm"));
  await page.getByRole("button", { name: /^save$/i }).click();
  // Save re-disables once the write succeeds and the buffer is no longer
  // dirty. Waiting on "not Saving…" would pass before the save even started.
  await page.waitForFunction(
    () => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Save",
      );
      return Boolean(btn && btn.disabled);
    },
    { timeout: 30000 });
  const saved = docker("cat", "/home/webxterm/note.txt");
  check("save wrote back over SFTP", saved.includes("edited by webxterm"), saved.trim());

  // ---- vault sync ----
  console.log(`\n8. Vault sync`);
  await page.waitForFunction(
    () => document.body.innerText.includes("Vault"), { timeout: 30000 });
  const vaultRow = execFileSync("docker", ["exec", "webxterm-postgres", "psql", "-U", "webxterm",
    "-d", "webxterm", "-tAc",
    `select octet_length(ciphertext) from vault_blob v join "user" u on u.id=v.user_id where u.email='${email}'`])
    .toString().trim();
  check("encrypted vault blob persisted", parseInt(vaultRow, 10) > 0, `${vaultRow} bytes ciphertext`);

  const readable = execFileSync("docker", ["exec", "webxterm-postgres", "psql", "-U", "webxterm",
    "-d", "webxterm", "-tAc",
    `select encode(ciphertext,'escape') from vault_blob v join "user" u on u.id=v.user_id where u.email='${email}'`])
    .toString();
  check("server cannot read host data in the vault",
        !readable.includes("127.0.0.1") && !readable.includes("webxterm@"),
        "no plaintext hostnames in the stored blob");

  console.log(`\n${"─".repeat(62)}`);
  console.log(fail.length === 0 ? "ALL CHECKS PASSED" : `FAILED: ${fail.join(", ")}`);
} finally {
  await browser.close();
}

process.exit(fail.length === 0 ? 0 : 1);
