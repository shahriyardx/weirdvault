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

```
apps/web/            Next.js app — marketing, auth, dashboard, control plane
  src/lib/keys.ts    non-extractable key custody
  src/lib/vault/     split KDF, vault crypto, sync
  src/lib/transfers/ streaming upload/download, USTAR writer
core/ssh/            Go → WASM SSH + SFTP core, WebCrypto signer
core/relay/          Rust relay: SSRF guards, tokens, quotas
docs/                threat model, deployment, spike results
```

## Running it

Needs Go 1.26+, Bun, Rust, and Docker.

```bash
bun install
bun run sshd         # stock OpenSSH target on :2222
bun run wasm         # build the SSH core into apps/web/public
bun run db:up        # Postgres
bun run db:push      # apply the schema
bun run relay        # Rust relay on :8080   (leave running)
bun run dev          # app on :3000
```

Open http://localhost:3000/dashboard.

## Verifying

```bash
bun run relay:test   # SSRF guards, token binding, quotas
bun run test         # both browser suites, in order
```

`tests/signed-in.mjs` covers the app with an account — pinning, SFTP, tar
upload, Monaco, vault sync, concurrent sessions, split panes.
`tests/signed-out.mjs` covers the path with no account at all, which is what
the landing page promises and the easiest thing to break without noticing.

Both browser suites drive headless Chromium against the dockerized sshd and
check real behaviour — that the raw password never appears in any request body,
that the stored vault ciphertext contains no plaintext hostnames, that a changed
host key is refused rather than re-pinned, that the relay rejects a token minted
for a different destination.

## Notes

- This machine's npm cache has root-owned files from an old npm bug, which
  breaks `npx`. The project uses Bun, so it rarely matters; fix with
  `sudo chown -R 501:20 ~/.npm`.
- `RELAY_ALLOW_PRIVATE=1` is set by `bun run relay` so the local test container is
  reachable. It must never be set in production.
