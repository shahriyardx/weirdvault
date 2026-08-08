// Phase 1 verification: the real Next.js app, not the spike harness.
//
// Drives the actual workspace UI the way a user would — generate a key, copy
// the authorize command, connect, run something — so we find out whether the
// port from the harness actually works rather than assuming it did.
//
//   node scripts/app-verify.mjs [--headed]

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const APP = process.env.APP_URL ?? "http://localhost:3000/workspace";
const CONTAINER = process.env.SSHD_CONTAINER ?? "webxterm-sshd";
const headed = process.argv.includes("--headed");

const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail.push(name);
};

const browser = await chromium.launch({ headless: !headed });
const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));
page.on("console", (m) => m.type() === "error" && console.log(`  [console] ${m.text()}`));

try {
  console.log(`\nwebxterm Phase 1 — Next.js workspace\n${"─".repeat(60)}`);

  console.log(`\n1. Workspace loads`);
  await page.goto(APP, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.webxtermSSH !== undefined, { timeout: 30000 });
  check("ssh.wasm loads and exports webxtermSSH", true, `version ${await page.evaluate(() => window.webxtermSSH.version)}`);
  check("terminal renders", (await page.locator(".xterm").count()) > 0);

  console.log(`\n2. Key generation in the UI`);
  await page.getByRole("button", { name: "Device-bound" }).click();
  await page.waitForSelector("pre", { timeout: 15000 });
  const cmd = (await page.locator("pre").first().innerText()).trim();
  check("authorize command shown", /^echo 'ssh-ed25519 AAAA.* >> ~\/\.ssh\/authorized_keys$/.test(cmd),
        cmd.slice(0, 52) + "…");
  const proofText = await page.getByText(/non-extractable/i).first().innerText();
  check("UI proves key is non-extractable",
        proofText.includes("Private key is non-extractable"), proofText.slice(0, 60));

  console.log(`\n3. Server-side setup (the one line)`);
  const pubkey = cmd.match(/'([^']+)'/)[1];
  execFileSync("docker", ["exec", CONTAINER, "sh", "-c",
    `echo '${pubkey}' >> /home/webxterm/.ssh/authorized_keys`]);
  check("public key authorized on stock sshd", true);

  console.log(`\n4. Connect`);
  await page.getByRole("button", { name: /^connect$/i }).click();
  await page.getByRole("button", { name: /disconnect/i }).waitFor({ timeout: 30000 });
  check("connected with the WebCrypto signer", true);

  // Read the terminal buffer rather than the DOM: the WebGL renderer paints to
  // canvas, so there is no text in the DOM to assert on.
  const screen = () =>
    page.evaluate(() => {
      const b = window.__webxtermTerm?.buffer.active;
      if (!b) return "";
      return Array.from({ length: b.length }, (_, i) =>
        b.getLine(i)?.translateToString(true) ?? "").join("\n");
    });

  await page.waitForFunction(
    () => {
      const b = window.__webxtermTerm?.buffer.active;
      if (!b) return false;
      return Array.from({ length: b.length }, (_, i) =>
        b.getLine(i)?.translateToString(true) ?? "").join("\n").includes("$");
    },
    { timeout: 15000 });
  check("shell prompt rendered in the terminal", true, (await screen()).trim().split("\n").pop());

  console.log(`\n5. File explorer on the same connection`);
  // The explorer renders as soon as SFTP opens on the existing connection.
  await page.getByRole("button", { name: "Refresh" }).waitFor({ timeout: 20000 });
  const listed = await page.evaluate(
    () => document.body.innerText.includes("Empty directory")
      || /\d+(\.\d+)? (B|KB|MB|GB)/.test(document.body.innerText));
  check("SFTP listing appears without a second login", listed);

  console.log(`\n6. Typing into the remote shell`);
  await page.locator(".xterm").click();
  await page.keyboard.type("echo PHASE1-$((6*7))");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => {
      const b = window.__webxtermTerm?.buffer.active;
      if (!b) return false;
      return Array.from({ length: b.length }, (_, i) =>
        b.getLine(i)?.translateToString(true) ?? "").join("\n").includes("PHASE1-42");
    },
    { timeout: 15000 });
  check("keystrokes reach the remote PTY and echo back", true, "echo PHASE1-42 → PHASE1-42");

  console.log(`\n7. Auth and the split KDF`);
  const email = `t${Date.now()}@webxterm.test`;
  const password = "correct-horse-battery-staple";

  // Watch the wire: the password must never appear in any request body.
  const bodies = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/auth")) bodies.push(r.postData() ?? "");
  });

  await page.goto(APP.replace("/workspace", "/sign-up"), { waitUntil: "networkidle" });
  await page.getByLabel("Name").fill("Test User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(/\/workspace/, { timeout: 60000 });
  check("sign-up creates an account and lands in the workspace", true, email);

  const sent = bodies.join("\n");
  check("raw password never leaves the browser", !sent.includes(password),
        `${bodies.length} auth request(s) inspected`);

  const row = execFileSync("docker", ["exec", "webxterm-postgres", "psql", "-U", "webxterm",
    "-d", "webxterm", "-tAc", `select count(*) from "user" where email='${email}'`])
    .toString().trim();
  check("user row persisted in Postgres", row === "1", `${row} row`);

  const stored = execFileSync("docker", ["exec", "webxterm-postgres", "psql", "-U", "webxterm",
    "-d", "webxterm", "-tAc",
    `select coalesce(a.password,'') from account a join "user" u on u.id=a.user_id where u.email='${email}'`])
    .toString().trim();
  check("stored credential is not the password", stored !== "" && !stored.includes(password),
        "hash of the derived auth token, not the password");

  console.log(`\n${"─".repeat(60)}`);
  console.log(fail.length === 0 ? "ALL CHECKS PASSED" : `FAILED: ${fail.join(", ")}`);
} finally {
  await browser.close();
}

process.exit(fail.length === 0 ? 0 : 1);
