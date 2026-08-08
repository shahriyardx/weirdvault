// Signed-out verification: the free tier, with no account at all.
//
// phase2-verify covers the signed-in path. This covers the one the landing page
// promises and which is easy to break without noticing — someone who has never
// signed up should still be able to generate a key, connect, and get a shell.
// It regressed exactly once already, when the relay started requiring a token.
//
//   node scripts/signedout-verify.mjs [--headed]

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

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));

const screen = () =>
  page.evaluate(() => {
    const b = window.__webxtermTerm?.buffer.active;
    if (!b) return "";
    return Array.from({ length: b.length }, (_, i) =>
      b.getLine(i)?.translateToString(true) ?? "").join("\n");
  });

const terminalHas = (needle) =>
  page.waitForFunction(
    (s) => {
      const b = window.__webxtermTerm?.buffer.active;
      if (!b) return false;
      return Array.from({ length: b.length }, (_, i) =>
        b.getLine(i)?.translateToString(true) ?? "").join("\n").includes(s);
    },
    needle,
    { timeout: 20000 });

try {
  console.log(`\nwebxterm — signed-out (free tier)\n${"─".repeat(60)}`);

  let tokenResponse = null;
  page.on("response", async (r) => {
    if (r.url().includes("/api/relay-token") && r.status() === 200) {
      tokenResponse = await r.json().catch(() => null);
    }
  });

  console.log(`\n1. The app loads with no account`);
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.webxtermSSH !== undefined, { timeout: 30000 });
  check("ssh.wasm loaded", true, `version ${await page.evaluate(() => window.webxtermSSH.version)}`);
  check("no sign-in wall", !page.url().includes("/sign-in"), page.url().replace(BASE, ""));

  console.log(`\n2. Device-bound key (the only kind available while locked)`);
  await page.getByRole("link", { name: "Keys", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /generate key/i }).first().click();
  check("portable is unavailable without a vault",
        await page.locator("#mode-portable").isDisabled(),
        "portable needs a vault key to wrap with");
  await page.getByRole("button", { name: /^generate key$/i }).last().click();
  await page.waitForSelector("pre", { timeout: 20000 });

  const cmd = (await page.locator("pre").first().innerText()).trim();
  const pubkey = cmd.match(/(ssh-ed25519 [A-Za-z0-9+/=]+)/)[1];
  check("key generated and shown as an authorized_keys line", /^ssh-ed25519 AAAA/.test(pubkey));

  console.log(`\n3. Authorize on stock sshd`);
  execFileSync("docker", ["exec", CONTAINER, "sh", "-c",
    `echo '${pubkey} webxterm' >> /home/webxterm/.ssh/authorized_keys`]);
  check("public key appended", true, "one line, nothing installed");

  console.log(`\n4. Connect through the relay anonymously`);
  await page.getByRole("link", { name: "Connect", exact: true }).first().click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^connect$/i }).last().click();
  await page.getByRole("button", { name: /disconnect/i }).waitFor({ timeout: 45000 });
  check("connected without an account", true);
  check("the relay issued an anonymous token", tokenResponse?.anonymous === true,
        `expiresIn ${tokenResponse?.expiresIn}s`);

  console.log(`\n5. A real shell`);
  await terminalHas("$");
  check("shell prompt rendered", true, (await screen()).trim().split("\n").pop());

  await page.locator(".xterm").click();
  await page.keyboard.type("echo ANON-$((6*7))");
  await page.keyboard.press("Enter");
  await terminalHas("ANON-42");
  check("keystrokes reach the remote PTY", true, "echo ANON-42 → ANON-42");

  console.log(`\n6. Files on the same connection`);
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await page.waitForLoadState("networkidle");
  // The listing is fetched over SFTP after the route renders, so wait for it
  // rather than sampling the DOM once.
  await page.waitForFunction(
    () => document.body.innerText.includes("Empty directory")
      || /\d+(\.\d+)? (B|KB|MB|GB)/.test(document.body.innerText),
    { timeout: 20000 });
  check("SFTP listing without a second login", true);

  console.log(`\n${"─".repeat(60)}`);
  console.log(fail.length === 0 ? "ALL CHECKS PASSED" : `FAILED: ${fail.join(", ")}`);
} finally {
  await browser.close();
}

process.exit(fail.length === 0 ? 0 : 1);
