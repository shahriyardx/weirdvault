// End to end with no account at all: the promise the landing page makes.
//
// signed-in.mjs covers the app once you have signed up. This covers the path
// that is easy to break without noticing — someone who has never created an
// account should still generate a key, connect through the relay, and get a
// real shell. It regressed exactly once already, when the relay started
// requiring a token that only a session could mint.
//
// Also the only place the single-session split is exercised, since it needs
// exactly one session open to trigger the empty pane's host picker.
//
// Needs: `bun run dev`, `bun run sshd`, and the relay running.
//
//   bun tests/signed-out.mjs [--headed]

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

// The connect form ships empty now — placeholders only — so every suite that
// reaches a shell has to type the target itself.
const fillConnectForm = async () => {
  await page.getByLabel("Hostname").fill("127.0.0.1");
  await page.getByLabel("Port").fill("2222");
  await page.getByLabel("Username").fill("webxterm");
};

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
  await page.getByRole("link", { name: "New session", exact: true }).first().click();
  await page.waitForLoadState("networkidle");
  await fillConnectForm();
  await page.getByRole("button", { name: /^connect$/i }).last().click();
  await page.locator('[data-sidebar="menu-button"]', { hasText: "@" })
    .first().waitFor({ timeout: 45000 });
  check("connected without an account", true);
  check("the relay issued an anonymous token", tokenResponse?.anonymous === true,
        `expiresIn ${tokenResponse?.expiresIn}s`);

  console.log(`\n5. A real shell`);
  await page.waitForURL(/\/dashboard\/terminal/, { timeout: 15000 }).catch(() => {});
  // The banner and first prompt are printed during the handshake, before the
  // terminal mounts — they must be buffered, not dropped.
  await terminalHas("$");
  check("shell prompt rendered", true, (await screen()).trim().split("\n").pop());

  await page.locator(".xterm").click();
  await page.keyboard.type("echo ANON-$((6*7))");
  await page.keyboard.press("Enter");
  await terminalHas("ANON-42");
  check("keystrokes reach the remote PTY", true, "echo ANON-42 → ANON-42");

  // xterm paints to a canvas, which cannot resolve CSS custom properties. A
  // `var(--font-mono)` here leaves it measuring cells with one font and drawing
  // with another, which renders as unreadable, wildly spaced text.
  const font = await page.evaluate(() => ({
    family: window.__webxtermTerm?.options.fontFamily ?? "",
    // Actual measured cell width, from the renderer.
    cellWidth: document.querySelector(".xterm-cursor-layer, .xterm-screen")?.clientWidth ?? 0,
  }));
  check("terminal font is a real stack, not a CSS variable",
        !font.family.includes("var("), font.family.split(",")[0]);

  console.log(`\n6. Splitting with only one session`);
  await page.getByRole("button", { name: /^split$/i }).click();
  // With nothing spare to show, the second pane must ask which host to open
  // rather than cloning the session already on screen.
  await page.getByRole("button", { name: /select host/i }).waitFor({ timeout: 5000 });
  check("the new pane offers a host picker instead of a duplicate", true);
  await page.getByRole("button", { name: /select host/i }).click();
  await page.getByRole("menuitem", { name: /webxterm@127\.0\.0\.1/ }).first().waitFor({ timeout: 5000 });
  check("the picker lists the running session", true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /close pane 2/i }).click();

  console.log(`\n7. Files on the same connection`);
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
