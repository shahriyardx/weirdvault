# webxterm

Zero-install web SSH client. Open a browser, generate or import a key, connect
to any server — terminal, file explorer, uploads, remote editing, nothing to install
on either end.

- [`PLAN.md`](PLAN.md) — product and architecture plan
- [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) — what each party can and cannot see
- [`docs/PHASE0-RESULTS.md`](docs/PHASE0-RESULTS.md) · [`docs/PHASE2-SPIKE.md`](docs/PHASE2-SPIKE.md) — de-risking results

## How it works

The SSH client runs **inside the browser tab** as WebAssembly. A stateless Rust
relay bridges WebSocket to TCP but only ever forwards ciphertext — the handshake
and all encryption terminate in the tab. Private keys are generated
non-extractable in WebCrypto, so the WASM core, our own JavaScript, an injected
script, and a browser extension are all equally unable to read them;
authentication works by handing the challenge to WebCrypto and getting back a
signature.

Host keys are pinned on first use and verified on every reconnect. That check is
what keeps the relay honest — without it, a hostile relay could present its own
key and the encryption would be end-to-relay rather than end-to-end.

**On the server: nothing to install.** One line, once:

```bash
echo 'ssh-ed25519 AAAA… you@webxterm' >> ~/.ssh/authorized_keys
```

Or tick "use password once" and webxterm installs the key itself.

## Working today

| | |
|---|---|
| Terminal | xterm.js + WebGL, resize, full VT |
| Keys | Ed25519, non-extractable; portable (vault-wrapped, syncs) or device-bound |
| Host keys | pinned on first use, hard refusal on mismatch |
| Files | SFTP explorer on the same connection, context menu, transfer queue |
| Uploads | streaming, drag-and-drop folders, tar fast path for many small files |
| Downloads | streaming to disk via File System Access API, service worker fallback |
| Editing | Monaco, lazy-loaded, saves back over SFTP |
| Accounts | Better Auth with organizations; split KDF keeps the vault key local |
| Sync | zero-knowledge vault blob with optimistic concurrency |
| Relay | Rust, SSRF-guarded, destination-bound tokens, per-account quotas |

## Layout

Three programs, each with its own README covering how to run and test it.

| | | |
|---|---|---|
| [`apps/web/`](apps/web/README.md) | TypeScript | The app and control plane. Serves the pages, holds the encrypted vault it cannot read |
| [`apps/ssh/`](apps/ssh/README.md) | Go → WASM | The SSH and SFTP client that runs in the tab. Where the encryption actually happens |
| [`apps/relay/`](apps/relay/README.md) | Rust | The WebSocket-to-TCP bridge. Forwards ciphertext, guards against SSRF |
| [`tests/`](tests/README.md) | | Browser suites against a real dockerized sshd |
| `docs/` | | Threat model, deployment, and the spike results behind the architecture |

Each app owns its own manifest — `apps/web/package.json`, `apps/ssh/go.mod`,
`apps/relay/Cargo.toml` — so nothing at the root has to know how any of them
build.

## Running it

Needs Go 1.26+, Bun, Rust, and Docker. Start here, then read the app you are
working on:

```bash
bun install                        # root: test tooling only
bun install --cwd apps/web         # the app's own dependencies
bun run wasm                       # apps/ssh → apps/web/public/ssh.wasm

docker compose up -d postgres      # database
bun run --cwd apps/web db:push     # schema
bun run --cwd apps/web dev         # app on :3000
```

The relay runs from its own directory, because it takes several environment
variables that matter — [`apps/relay/README.md`](apps/relay/README.md) lists
them.

Open http://localhost:3000/dashboard.

## Verifying

```bash
bun run sshd     # the test target on :2222
bun run test     # both browser suites
```

They drive headless Chromium against a stock `sshd` and check real behaviour,
including the negatives: that the raw password never reaches the wire, that the
stored vault ciphertext holds no plaintext hostname, that a changed host key is
refused rather than re-pinned. See [`tests/README.md`](tests/README.md).

## Deploying

```bash
cp .env.example .env      # fill in the secrets
docker compose -f compose.prod.yaml up -d --build
```

The web container applies database migrations at start, before it serves.
Full guide, including TLS: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Notes

- `RELAY_ALLOW_PRIVATE=1` makes the local test container reachable by disabling
  the SSRF guard. It must never be set in production.
- This machine's npm cache has root-owned files from an old npm bug, which
  breaks `npx`. The project uses Bun, so it rarely matters; fix with
  `sudo chown -R 501:20 ~/.npm`.
