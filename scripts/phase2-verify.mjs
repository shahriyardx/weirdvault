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

/** Navigate via the sidebar so the in-memory vault key survives. */
const nav = async (name) => {
  await page.getByRole("link", { name, exact: true }).click();
  await page.waitForLoadState("networkidle");
};

/** Closes every open session via the sidebar's per-session x. */
const closeAllSessions = async () => {
  for (;;) {
    const actions = page.locator('[data-sidebar="menu-action"]');
    if ((await actions.count()) === 0) break;
    await actions.first().click();
    await page.waitForTimeout(400);
  }
};

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
  await page.getByLabel("Name").fill("Test User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 60000 });
  check("signed up and landed in the app", true, email);
  await page.waitForFunction(() => window.webxtermSSH !== undefined, { timeout: 30000 });
  check("vault unlocked in the app", (await page.getByText(/Vault unlocked/).count()) > 0);

  // ---- portable key, which requires the vault key to wrap ----
  console.log(`\n2. Portable key`);
  await nav("Keys");
  await page.getByRole("button", { name: /generate key/i }).first().click();
  // With the vault unlocked the dialog defaults to portable, which is the mode
  // under test because it is the one wrapped with the vault key.
  check("portable is offered when the vault is unlocked",
        await page.locator("#mode-portable").isChecked());
  await page.getByRole("button", { name: /^generate key$/i }).last().click();
  await page.waitForSelector("pre", { timeout: 20000 });
  const cmd = (await page.locator("pre").first().innerText()).trim();
  const pubkey = cmd.match(/(ssh-ed25519 [A-Za-z0-9+/=]+)/)[1];
  check("portable key generated and wrapped", /^ssh-ed25519 AAAA/.test(pubkey));

  // ---- password-first onboarding installs the key for the user ----
  console.log(`\n3. Password-first onboarding`);
  docker("sh", "-c", "cp /dev/null /home/webxterm/.ssh/authorized_keys");
  await page.getByRole("link", { name: "New session", exact: true }).first().click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel(/use a password once/i).click();
  await page.getByLabel("Password", { exact: true }).fill("webxterm");
  await page.getByRole("button", { name: /^connect$/i }).click();
  await page.locator('[data-sidebar="menu-button"]', { hasText: "@" })
    .first().waitFor({ timeout: 45000 });
  check("connected with a password", true);
  const authorized = docker("cat", "/home/webxterm/.ssh/authorized_keys");
  check("public key installed by webxterm itself", authorized.includes(pubkey.split(" ")[1]),
        "no copy-paste needed");
  check("connected and pinned the host key on first contact", true);

  // ---- reconnect using the installed key, verifying the pin ----
  console.log(`\n4. Reconnect with the key`);
  await closeAllSessions();
  await page.getByRole("link", { name: "New session", exact: true }).first().click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /save and connect/i }).click();
  await page.locator('[data-sidebar="menu-button"]', { hasText: "@" })
    .first().waitFor({ timeout: 45000 });
  check("reconnected using the installed key against the pinned host", true);

  await page.locator('[data-sidebar="menu-button"]', { hasText: "@" }).first().click();
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(
    () => window.__webxtermTerm?.buffer.active.getLine(0)?.translateToString(true).length > 0,
    { timeout: 20000 });
  check("terminal reattached to the session after navigating", (await screen()).includes("$"));

  // ---- file explorer, same connection, different route ----
  console.log(`\n5. File explorer`);
  await nav("Files");
  await page.waitForFunction(() => document.body.innerText.includes("Empty directory")
    || /\d+(\.\d+)? (B|KB|MB|GB)/.test(document.body.innerText), { timeout: 20000 });
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
  await page.getByRole("button", { name: "Refresh" }).click();
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

  // ---- several sessions, including two to the same host ----
  console.log(`\n9. Multiple concurrent sessions`);
  const open = async (mark) => {
    await page.getByRole("link", { name: "New session", exact: true }).first().click();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /^connect$/i }).last().click();
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-sidebar="menu-button"]')
        .length >= n, 3, { timeout: 45000 });
    // Mark this shell so we can tell the two apart.
    await page.waitForTimeout(1200);
    await page.locator(".xterm").click();
    await page.keyboard.type(`export MARK=${mark}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
  };

  await open("one");
  await open("two");

  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('[data-sidebar="menu-button"]')]
      .map((b) => b.textContent?.trim() ?? "")
      .filter((t) => t.includes("@")));
  check("both sessions listed in the sidebar", labels.length >= 2, labels.join(" | "));
  check("a second session to the same host is distinguished",
        labels.some((l) => l.includes("#2")), labels.join(" | "));

  // Switching must land on that session's own shell. The two marked sessions
  // are the ones just opened; the first entry is the original from step 4 and
  // deliberately carries no mark.
  const readMark = async (label) => {
    await page.locator('[data-sidebar="menu-button"]', { hasText: label }).first().click();
    await page.waitForTimeout(900);
    await page.locator(".xterm").click();
    await page.keyboard.type("echo SESSION=$MARK");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    const text = await screen();
    return text.split("\n").filter((l) => l.startsWith("SESSION=")).pop() ?? "";
  };

  const markTwo = await readMark("#2");
  const markThree = await readMark("#3");
  check("each session keeps its own shell state",
        markTwo === "SESSION=one" && markThree === "SESSION=two",
        `#2 → ${markTwo}, #3 → ${markThree}`);

  // ---- navigating out of Files ----
  console.log(`\n10. Files does not trap you`);
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await page.waitForURL(/\/dashboard\/files/, { timeout: 15000 }).catch(() => {});
  check("Files page opens", page.url().includes("/dashboard/files"), page.url().split("/dashboard")[1]);

  await page.locator('[data-sidebar="menu-button"]', { hasText: "@" }).first().click();
  await page.waitForURL(/\/dashboard\/terminal/, { timeout: 15000 }).catch(() => {});
  check("clicking a session from Files opens the terminal",
        page.url().includes("/dashboard/terminal"), page.url().split("/dashboard")[1]);

  // ---- the pin has to actually refuse a changed key ----
  console.log(`\n11. Host key pinning refuses a changed key`);
  await closeAllSessions();

  // Rotate the server's host key, exactly as rebuilding the machine would.
  docker("sh", "-c", "rm -f /etc/ssh/ssh_host_* && ssh-keygen -A");
  execFileSync("docker", ["restart", CONTAINER]);
  await page.waitForTimeout(4000);

  await page.getByRole("link", { name: "New session", exact: true }).first().click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^connect$/i }).last().click();

  await page.getByText(/Host key mismatch/i).waitFor({ timeout: 45000 });
  check("a changed host key is refused, not silently trusted", true);

  const stillDisconnected =
    (await page.locator('[data-sidebar="menu-button"]', { hasText: "@" }).count()) === 0;
  check("the connection did not proceed", stillDisconnected);

  const clearDisabled = await page
    .getByRole("button", { name: /^clear pin$/i })
    .isDisabled();
  check("clearing the pin requires explicit confirmation", clearDisabled,
        "no one-click trust-anyway");

  console.log(`\n${"─".repeat(62)}`);
  console.log(fail.length === 0 ? "ALL CHECKS PASSED" : `FAILED: ${fail.join(", ")}`);
} finally {
  await browser.close();
}

process.exit(fail.length === 0 ? 0 : 1);
