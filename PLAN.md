# webxterm — Zero-Install Web SSH Workspace

> Open a browser. Generate or import a key. Connect to any server, anywhere.
> Terminal, file explorer, uploads, remote editing — no client software, ever.

---

## Part 0 — Scope

**What the user does:**
1. Opens `webxterm.app` on any device — laptop, tablet, someone else's machine
2. Generates an SSH key in the browser (or imports an existing one)
3. Copies a one-liner to authorize it on their server
4. Instantly gets a terminal, a file explorer, drag-drop upload, and a remote code editor

**What the user never does:** install anything.

**Non-goals (for now):** desktop app, mobile app store presence, RDP/VNC, Kubernetes.
The entire product is one URL.

---

## Part 1 — Landscape, Condensed

The full competitive breakdown is in [`docs/COMPETITORS.md`](docs/COMPETITORS.md). The short version of what to take:

| Source | Steal this |
|---|---|
| **Termius** | Vault UX, host organization, snippets, cross-device sync — but give sync away free (their paywall is their #1 grievance: $10/$20/$30 per user) |
| **MobaXterm** | SFTP browser **auto-attached to every session**, always visible. The single best detail in any SSH client |
| **Royal TSX** | Folder-level credential inheritance — best fleet-management idea nobody copies |
| **sshx** | Live session sharing by link, multi-cursor |
| **Teleport** | Session recording, audit log, short-lived certs |
| **ssheasy / sshterm** | Proof that WASM SSH+SFTP in the browser works today |
| **Warp / CtrlOps** | AI assist — but approval-gated, never auto-executing |
| **Blink Shell** | Mobile keyboard handling. The hardest unsolved problem on touch devices |

**The unclaimed position:** every existing web SSH tool (Guacamole, Shellngn, Wetty, WebSSH) proxies SSH *server-side* — the gateway holds your private key and sees your plaintext. Nobody has shipped a polished, end-to-end-encrypted browser SSH client where the server is mathematically incapable of reading your session.

That is webxterm.

---

## Part 2 — The Architecture

A browser cannot open a TCP socket, so a relay is unavoidable. The question is whether the relay sees plaintext. It will not.

```
┌────────────────────────────────────────────────────────────┐
│ BROWSER — the entire client                                │
│                                                            │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────┐  │
│  │  xterm.js    │   │ File Explorer│   │ Monaco Editor  │  │
│  └──────┬───────┘   └──────┬───────┘   └───────┬────────┘  │
│         │                  │                   │           │
│  ┌──────▼──────────────────▼───────────────────▼────────┐  │
│  │  ssh-wasm   (Go/Rust → WASM)                         │  │
│  │  · SSH transport, channels, PTY                      │  │
│  │  · SFTP subsystem                                    │  │
│  │  · signs auth challenges via callback ───────┐       │  │
│  └──────────────────────┬───────────────────────┼───────┘  │
│                         │                       │          │
│  ┌──────────────────────┼───────────────────────▼───────┐  │
│  │  WebCrypto — NON-EXTRACTABLE private key             │  │
│  │  key material is unreachable to JS, XSS, extensions  │  │
│  └──────────────────────┼──────────────────────────────┘   │
└─────────────────────────┼──────────────────────────────────┘
                          │ WebSocket — opaque SSH ciphertext
                 ┌────────▼─────────┐
                 │  RELAY (Rust)    │  stateless byte pipe
                 │  authz·quota·    │  CANNOT decrypt
                 │  SSRF guard      │  self-hostable
                 └────────┬─────────┘
                          │ TCP :22
                    ┌─────▼──────┐
                    │ YOUR SERVER│  unmodified sshd
                    └────────────┘

CONTROL PLANE (separate service): accounts · encrypted vault blobs ·
sync · billing.  Stores ciphertext only.  Never sees a key or a keystroke.
```

### 2.1 The key-custody design — the core innovation

Ed25519 landed in WebCrypto across every major engine (Firefox 129, Safari 17, Chrome 137), and WebCrypto supports **non-extractable** keys — the browser holds the private key in a form JavaScript literally cannot read.

So: **the WASM SSH stack never possesses the private key.** When sshd sends an auth challenge, the WASM client calls back into JS, which asks WebCrypto to sign, and gets back only a signature.

All three common SSH key types map cleanly onto WebCrypto primitives:

| SSH algorithm | WebCrypto algorithm |
|---|---|
| `ssh-ed25519` | `Ed25519` |
| `rsa-sha2-256` / `-512` | `RSASSA-PKCS1-v1_5` + SHA-256/512 |
| `ecdsa-sha2-nistp256` | `ECDSA` P-256 |

**Generated keys** are created non-extractable and never exist as bytes anywhere.
**Imported keys** exist as bytes for milliseconds during `importKey`, then the buffer is zeroed and only the non-extractable handle persists in IndexedDB.

Consequence worth stating plainly to users: *an exportable backup is a separate, deliberate choice.* Non-extractable means non-extractable — if they clear browser storage without a backup, the key is gone. The onboarding must make this impossible to miss.

### 2.2 Stack decision — Go, not Rust

My first instinct was `russh` → WASM. Research says no: `russh` has an **open, unresolved issue** for WASM targets, and its dependency tree doesn't cleanly build for `wasm32-unknown-unknown`.

Meanwhile Go's `golang.org/x/crypto/ssh` + `pkg/sftp` → WASM is **already proven in shipped projects** — `ssheasy` and `sshterm` both do exactly SSH + SFTP in a browser tab today.

**Decision: Go/WASM for the SSH core.** The relay and control plane stay Rust — they're conventional network services where Rust is a clear win.

The one real cost is bundle size: Go WASM binaries run ~8–10 MB raw (~2–3 MB Brotli). Mitigations: Brotli + aggressive caching + a Service Worker so it downloads exactly once, and lazy-load the SFTP module so first paint only pays for the terminal path. TinyGo is *not* a safe assumption here — `x/crypto/ssh` leans on reflection and full crypto. Budget the real number in Phase 0.

### 2.3 The honest limitations

These are structural, not bugs. Design around them and say so out loud.

| Limitation | Why | Mitigation |
|---|---|---|
| **Closing the tab kills the session** | The SSH client *is* the tab. Gateway products keep sessions server-side; we can't and stay E2E | Aggressive auto-reconnect; one-click "auto-attach tmux/screen"; keep-alive via SharedWorker across navigations. **Say this in the docs, don't hide it** |
| **Relay must reach the host** | Servers behind NAT/firewall are unreachable | Publish static relay IPs for allowlisting; Tailscale/WireGuard support later; optional tiny agent as an explicit, opt-in exception to zero-install |
| **Relay sees metadata** | It routes packets: target IP/port, timing, byte volume | State it in the threat model. Self-hosting removes it entirely |
| **No mosh** | Mosh needs UDP; browsers don't do raw UDP | Fast reconnect + tmux. Revisit if WebTransport matures |
| **Mobile keyboards are hostile** | No Ctrl/Esc/arrows on touch keyboards | Custom accessory key bar — treat as a first-class feature, not a patch |
| **First load is multi-MB** | Go WASM | Service Worker precache; subsequent loads are instant and offline-capable |

### 2.4 Relay security — do not build an open proxy

A WebSocket→TCP relay is an SSRF cannon if built naively. Hard requirements:

- Authenticated sessions only; no anonymous relaying
- Destination allowlist: port 22 + user-declared ports only
- **Block RFC1918, loopback, link-local, and `169.254.169.254`** (cloud metadata endpoints) unless the user self-hosts
- Per-account connection and bandwidth quotas; global rate limits
- Structured connection logs (who → where → when → bytes), never content
- Relay runs in its own network namespace with no cloud IAM role attached

---

### 2.5 What the user installs on their server: nothing

The entire server-side setup is one line, once:

```bash
echo 'ssh-ed25519 AAAAC3Nza… you@webxterm' >> ~/.ssh/authorized_keys
```

Stock `sshd`. No agent, no daemon, no extra port, no root. Uninstalling is deleting that line.

**Prerequisites — all true by default on any VPS:**

| Requirement | Reality |
|---|---|
| `sshd` running on a reachable port | Already true |
| `PubkeyAuthentication yes` | OpenSSH default |
| Login user permitted by `AllowUsers`/`AllowGroups` if set | Only matters if they've hardened it |
| Relay IPs can reach the port | The only real friction — publish static relay IPs for allowlisting |

**The NAT exception.** A box with no inbound path can't work zero-install. Options are a VPN (Tailscale/WireGuard) or a small opt-in agent. Label this clearly as the one case where the promise doesn't hold — do not quietly ship an agent.

**Onboarding trick — build this in Phase 1.** For a fresh server the user has never keyed: let them connect with their password once, and webxterm appends the public key itself. "Copy this command and run it somewhere else" is where non-expert users bail; removing that step is worth more than any feature on the Phase 1 list.

**Optional, user's choice:**
- `tmux`/`screen` — enables one-click reattach after a tab close. Usually already installed
- `tar` — enables the fast path for uploading folders of many small files. Universally present
- **SSH CA** (Phase 5) — one `TrustedUserCAKeys` line in `sshd_config` + reload. After that, new devices never touch `authorized_keys` again and revocation actually works. Push teams toward this

---

## Part 3 — The Product Surface

### 3.1 Onboarding — must be under 60 seconds

```
1. Land on webxterm.app                     → terminal preview, no signup wall
2. "Add a server"  → host, port, username
3. "Generate key"  → Ed25519, non-extractable, created in ~5ms
4. Show a copy-paste one-liner:
     echo 'ssh-ed25519 AAAA…' >> ~/.ssh/authorized_keys
   with a "how do I run this?" escape hatch for first-timers
5. Connect.
```
Also support: paste an existing private key, drag a `.pem`/`id_ed25519` file, or import a whole `~/.ssh/config` to bulk-create hosts. Encrypted OpenSSH keys need `bcrypt_pbkdf` decryption in WASM before re-import as non-extractable.

Password auth must work too — many users' first server has no key yet. Offer it, then actively nudge them to upgrade to a key.

### 3.2 Terminal

- xterm.js + WebGL renderer; true color, ligatures, sixel/Kitty graphics
- Tabs, split panes (h/v), drag-to-rearrange, per-host color coding
- Search, infinite scrollback, copy-on-select, bracketed paste
- Theme gallery + import from iTerm2/Windows Terminal formats
- **Mobile accessory bar**: Ctrl, Alt, Esc, Tab, arrows, Ctrl-C, `|`, `~`, `/` — plus swipe-to-scroll and pinch-to-zoom font size
- Broadcast input to N panes with a loud visual warning
- Reconnect banner with one-tap "reattach tmux"

### 3.3 File explorer — the feature that wins the demo

Auto-attached to every session, one keystroke away, sharing the same SSH connection.

- Dual-pane (local ↔ remote) and single-pane modes; tree + list views
- **Drag-and-drop upload**, including whole folders (`DataTransferItem` recursion)
- **Streaming uploads**: `File.stream()` → chunked SFTP writes. Never buffer a whole file in memory — this is what lets a 4 GB upload work in a browser tab
- **Streaming downloads**: File System Access API (`showSaveFilePicker` + `WritableStream`) where available; Service-Worker streaming response as fallback. Same reason
- Resumable transfers, parallel queue, per-file progress, retry on drop
- **Tar-pipe fast path**: for folders with many small files, `tar -czf - dir | ...` over an exec channel is dramatically faster than per-file SFTP. Auto-select the strategy by file count
- Rename, chmod, chown, mkdir, symlink, delete-with-confirm, hidden-file toggle
- Right-click → "Open terminal here"
- Preview: images, PDFs, video (range-request streaming), archive listing, `tail -f` for logs
- **Remote editing via Monaco** — open a remote file, edit with full syntax highlighting/LSP-lite, Ctrl-S writes back over SFTP. This is "VS Code Remote without installing VS Code," and it is the single most compelling thing on this list

### 3.4 Host & credential management

- Folders, tags, search, favorites, recent
- **Credential inheritance**: set a key on a folder, every host below inherits it
- Jump hosts / ProxyJump chains, per-host port forwards
- `~/.ssh/config` import **and export** — never trap users
- Snippets with `{{variables}}`, run-on-many-hosts
- Port forwarding manager: local/remote/dynamic SOCKS, visual on/off toggles

### 3.5 Sync — free, zero-knowledge

- Master passphrase → Argon2id → data key → per-record AES-256-GCM
- Server stores `{id, ciphertext, updated_at}` and nothing else
- Automerge CRDT for conflict-free multi-device edits, offline-capable
- Printable recovery code at setup; optional escrow only as a conscious opt-in that plainly states it forfeits zero-knowledge
### 3.6 Key portability — how "log in anywhere and connect" actually works

A non-extractable WebCrypto key **cannot leave the browser that made it.** That's the security property, and it directly conflicts with the product promise of connecting from any device. So key portability is an explicit per-key choice, not an accident:

| Mode | How it works | Cost |
|---|---|---|
| **Portable** *(default)* | Key generated extractable → immediately wrapped with `vault_key` → ciphertext syncs → decrypted and re-imported as **non-extractable** on each new device | Key existed as bytes for ~1ms at creation. Server still can't read it |
| **Device-bound** | Non-extractable from birth, never syncs. Each device makes its own key; all pubkeys go in `authorized_keys` | Max security. New device = touch the server once |
| **SSH CA** *(Phase 5)* | Servers trust a CA once. Each device gets a short-lived cert | Best of both. Instant new devices, real revocation, no `authorized_keys` edits ever again |

**Portable is the default** because "open a browser anywhere and connect" is the entire product. Device-bound is one toggle away for people who want it. SSH CA is the endgame for teams — it's the only mode where revoking a lost laptop doesn't mean SSHing into every server.

Whichever mode, the server holds ciphertext only.

---

## Part 4 — Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| App framework | **Next.js (App Router)** + TypeScript | marketing, docs, auth, billing, control-plane API |
| UI | **Tailwind + shadcn/ui** (Radix under it) | |
| Terminal | **xterm.js** + `addon-webgl`, `addon-search`, `addon-fit` | VS Code's engine |
| Editor | **Monaco** | lazy-loaded chunk |
| SSH/SFTP core | **Go** `x/crypto/ssh` + `pkg/sftp` → **WASM** | proven path; Rust deferred |
| Key custody | **WebCrypto non-extractable** + IndexedDB handles | the core differentiator |
| Vault crypto | WebCrypto AES-GCM + `argon2` WASM | |
| Sync | **Automerge** over ciphertext | |
| Auth & orgs | **Better Auth** — organization, SSO, passkeys, 2FA plugins | teams/RBAC/invites out of the box |
| ORM | **Drizzle** + `drizzle-kit` migrations | Better Auth ships a Drizzle adapter |
| Database | **Postgres** (Neon / Supabase / RDS) | ciphertext blobs, orgs, audit, billing |
| Relay | **Rust** + tokio + axum | stateless; **cannot run on Vercel** — see below |
| Offline/caching | **Service Worker** via **Serwist** | precaches WASM; powers streaming downloads |
| Deploy | Next.js on Vercel; relay on Fly.io / Railway / bare metal | relay needs long-lived raw TCP |

### 4.1 Three notes that matter

**The control plane is now Next.js, not Rust.** Better Auth + Drizzle covers accounts, sessions, organizations, roles, invitations, and SSO — which was most of Phase 5. Route handlers serve the vault-blob sync API. One less service to run.

**The relay stays Rust and deploys separately.** It holds long-lived WebSocket connections bridged to raw TCP :22 — serverless functions cannot do this at all. Fly.io or Railway, multi-region for keystroke latency. This split is not negotiable; don't try to fold it into Next.js.

**The workspace is a client island.** `/app/(workspace)` is `"use client"` end to end — xterm.js, WASM, WebCrypto, and IndexedDB are all browser-only, and RSC buys nothing there. Next.js earns its place on the *other* routes: landing, docs, pricing, auth, billing, team admin. Load the WASM blob from `/public` with an explicit `fetch` + `WebAssembly.instantiateStreaming` rather than fighting the bundler.

### 4.2 The trap: Better Auth's password is NOT the vault passphrase

If the login password is also the vault passphrase, the server sees it at sign-in and **zero-knowledge is dead.** Split it client-side before anything leaves the browser:

```
master     = Argon2id(password, salt)          // never transmitted
auth_token = HKDF(master, "webxterm/auth/v1")  // sent to Better Auth as the "password"
vault_key  = HKDF(master, "webxterm/vault/v1") // NEVER leaves the device
```

One password for the user, and the server only ever receives a value that is useless for decryption. Better Auth allows a custom password hasher, so this is a supported integration rather than a fight. Write it into `docs/THREAT-MODEL.md` before any auth code exists — retrofitting it later means a migration of every user's vault.

```
webxterm/
├─ apps/web/                    # Next.js — marketing, auth, billing, API, workspace
│  ├─ app/(marketing)/          # landing, pricing, docs         [RSC]
│  ├─ app/(auth)/               # Better Auth flows              [RSC]
│  ├─ app/(dashboard)/          # team admin, billing, audit     [RSC]
│  ├─ app/(workspace)/          # the terminal app           ["use client"]
│  ├─ app/api/auth/[...all]/    # Better Auth handler
│  ├─ app/api/vault/            # encrypted blob sync
│  ├─ lib/auth.ts               # Better Auth + organization/SSO plugins
│  ├─ lib/db/                   # Drizzle schema + migrations
│  ├─ lib/vault/                # WebCrypto custody, KDF split, Automerge
│  ├─ components/terminal/      # xterm, panes, mobile keybar
│  ├─ components/files/         # explorer, transfer queue, streaming IO
│  ├─ components/editor/        # Monaco remote editing
│  └─ public/ssh.wasm           # Go SSH core, Brotli-served
├─ core/ssh/                    # Go → WASM SSH + SFTP, JS signer callback
├─ core/relay/                # WebSocket ↔ TCP, SSRF guard, quotas
├─ docs/                        # THREAT-MODEL.md, COMPETITORS.md, PHASE0-RESULTS.md
└─ deploy/
```

---

## Part 5 — Roadmap

### Phase 0 — De-risk (1–2 weeks) · **gate before any UI work**
Prove the chain end to end and measure it:
- Go `x/crypto/ssh` → WASM → WebSocket → real `sshd`, rendered in xterm.js
- **Custom `ssh.Signer` that calls out to WebCrypto** — this is the unproven piece and the whole thesis rests on it
- Measure: WASM bundle size (raw + Brotli), cold start, throughput on `yes` and `find /`, keystroke latency, SFTP throughput
- Write `docs/PHASE0-RESULTS.md`

**Gates:** Brotli bundle < 4 MB · keystroke latency < 50 ms over relay · SFTP > 20 MB/s · WebCrypto signer authenticates against stock OpenSSH.
Miss the signer gate → the E2E thesis is dead, and it's a normal (good) web SSH client instead. Better to learn that in week 2 than month 6.

### Phase 1 — Connect (4–6 weeks)
Key gen/import, host form, single terminal, relay with SSRF guards, password + key auth, mobile keybar, PWA install. Local storage only, no accounts. **Ship publicly and free.**

### Phase 2 — Files (4–6 weeks)
SFTP explorer, streaming up/download, drag-drop folders, transfer queue, tar-pipe fast path, previews, Monaco remote editing. *This is the demo that gets shared.*

### Phase 3 — Workspace (4–6 weeks)
Accounts, zero-knowledge vault, Automerge sync, tabs/splits, folders + credential inheritance, `ssh_config` import/export, snippets, port forwarding, themes.

### Phase 4 — Collaborate (6 weeks)
Share-a-session links (read-only / read-write), session recording + replay, approval-gated AI (explain output, draft command, triage errors) with destructive-command guard.

### Phase 5 — Teams (8 weeks)
Team vaults via X25519 key wrapping, RBAC, audit log + export, SSO/SCIM, self-host Docker + Helm, static relay IPs for allowlisting.

---

## Part 6 — Monetization

| Tier | Price | Contents |
|---|---|---|
| **Free** | $0 | Unlimited hosts & devices, **sync included**, terminal, SFTP, editor, port forwarding |
| **Pro** | **$5/user/mo** | AI assist, session recording/replay, share links, larger transfer quotas, priority relays |
| **Team** | **$12/user/mo** | Team vault, RBAC, audit log, SSO, credential inheritance policy |
| **Self-host** | Custom | Own relay + control plane; no metadata leaves your network |

Undercuts Termius ($10/$20/$30) while giving away the thing they charge for. Open-core: client + relay Apache-2.0; team/audit/SSO commercial. The open, self-hostable relay isn't a giveaway — it's what makes a security team approve the tool.

---

## Part 7 — Risks

| Risk | Mitigation |
|---|---|
| **WebCrypto signer doesn't work with stock sshd** | Phase 0 gate #1. Fallback: key bytes in WASM memory — weaker, still better than server-side custody |
| **Bundle too large for mobile networks** | Brotli + SW precache + lazy SFTP module; measure in Phase 0 |
| **"SSH keys in a browser" scares people** | Non-extractable keys are a *stronger* story than a desktop app's on-disk `id_ed25519`. Lead with that, publish the threat model, get a third-party audit before charging for Team |
| **Tab-close kills sessions** | Documented, plus tmux auto-attach. Don't oversell "persistent" |
| **Relay abused as open proxy** | SSRF guards + auth + quotas from day one, not retrofitted |
| **Users lose non-extractable keys** | Loud onboarding, mandatory backup prompt, recovery codes |
| **Termius ships free sync** | Costs them revenue; and E2E custody + open self-host are architectural, not feature-flag, changes |

---

## Part 8 — Next Steps

1. `git init`; scaffold pnpm + Go + cargo workspace
2. `docs/THREAT-MODEL.md` — write it *before* vault code
3. Phase 0 spike: `core/ssh` + `core/relay` + 100-line xterm harness
4. **Hardest thing first: the WebCrypto `ssh.Signer` callback**, against a throwaway VPS
5. `docs/PHASE0-RESULTS.md` → go/no-go

---

### Sources
- [Ed25519 support lands in Chrome — Igalia](https://blogs.igalia.com/jfernandez/2025/08/25/ed25519-support-lands-in-chrome-what-it-means-for-developers-and-the-web/)
- [Secure Curves in the Web Cryptography API — Igalia](https://blogs.igalia.com/jfernandez/2023/06/20/secure-curves-in-the-web-cryptography-api/)
- [ssheasy — ssh/sftp in browser via Go + WASM](https://github.com/hullarb/ssheasy)
- [sshterm — Go SSH client compiled to WASM](https://github.com/c2FmZQ/sshterm)
- [russh WASM target issue #224](https://github.com/Eugeny/russh/issues/224)
- [xterm.js](https://xtermjs.org/)
- [Termius pricing 2026](https://www.softwaresuggest.com/termius/pricing)
- [11 Free and Open-source Web-based SSH Clients](https://medevel.com/ssh-web-based/)
