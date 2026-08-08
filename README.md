# webxterm

Zero-install web SSH workspace. Open a browser, generate or import a key, connect
to any server — terminal, file explorer, uploads, remote editing, nothing to install
on either end.

See [`PLAN.md`](PLAN.md) for the product and architecture plan.

## Status

**Phase 1 — the app runs end to end.** Both de-risking spikes passed:

- [`docs/PHASE0-RESULTS.md`](docs/PHASE0-RESULTS.md) — a Go/WASM SSH client
  authenticates to stock OpenSSH using a **non-extractable WebCrypto key** it
  cannot read. 1.25 MB Brotli, 63 ms connect, 1.5 ms keystroke echo.
- [`docs/PHASE2-SPIKE.md`](docs/PHASE2-SPIKE.md) — SFTP transfers **stream**:
  doubling the file moved peak memory 0.92×, retained heap after GC is negative.
  21 MB/s up, 38 MB/s down.

Working today: key generation and custody, host management, terminal, SFTP file
explorer, accounts with organizations, and the split KDF that keeps the server
from ever seeing anything that can decrypt a vault.

## Architecture in one paragraph

The SSH client runs **inside the browser tab** as WASM. A stateless relay bridges
WebSocket to TCP but only ever forwards ciphertext — the SSH handshake and all
encryption terminate in the tab. Private keys are generated non-extractable in
WebCrypto, so the WASM core, our JavaScript, an injected script, and a browser
extension are all equally incapable of reading them; authentication works by
handing the challenge to WebCrypto and getting a signature back.

## Layout

```
apps/web/              Next.js app — marketing, auth, workspace, control plane
  src/app/(workspace)/ the terminal app (client island)
  src/lib/keys.ts      non-extractable key custody
  src/lib/vault/kdf.ts the split KDF: auth branch vs vault branch
  src/lib/db/          Drizzle schema
wasm/ssh/              Go → WASM SSH + SFTP core, WebCrypto signer
spike/relay/           WebSocket ↔ TCP relay (production relay will be Rust)
spike/web/             standalone harness used for the spikes
docs/                  spike results, threat model
```

## Running it

Needs Go 1.26+, Bun, and Docker.

```bash
bun install
make sshd              # stock OpenSSH test target on :2222
make wasm              # build the SSH core into apps/web/public
bun run db:up          # Postgres
bun run db:push        # apply the schema
make relay             # relay on :8080  (leave running)
bun run dev            # app on :3000
```

Then open http://localhost:3000/workspace, generate a key, and run the printed
one-liner on your server. For the local test container:

```bash
make authorize KEY='ssh-ed25519 AAAA…'
```

## Verifying

```bash
bun run verify:phase0    # WASM SSH + WebCrypto signer gates
bun run verify:sftp      # streaming transfer gates
node scripts/app-verify.mjs   # the real Next.js workspace, end to end
```

Each drives headless Chromium against the dockerized sshd and checks real gates,
including that the raw password never appears in any request body.

## Note on npm

This machine's npm cache contains root-owned files from an old npm bug, which
breaks `npx`. The project uses Bun, so this only matters if you reach for npm;
fix it with `sudo chown -R 501:20 ~/.npm`.
