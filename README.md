# webxterm

Zero-install web SSH workspace. Open a browser, generate or import a key, connect
to any server — terminal, file explorer, uploads, remote editing, nothing to install
on either end.

See [`PLAN.md`](PLAN.md) for the full product and architecture plan.

## Status

**Phase 0 — de-risking spike.** Proving the load-bearing assumption before any UI work:

> Can a Go/WASM SSH client in a browser authenticate to stock OpenSSH using a
> **non-extractable WebCrypto key** it is incapable of reading?

If yes, webxterm can be end-to-end encrypted — the relay never sees a private key or
a plaintext byte. If no, the thesis collapses to a conventional server-side gateway.

Results land in [`docs/PHASE0-RESULTS.md`](docs/PHASE0-RESULTS.md).

## Layout

```
wasm/ssh/      Go → WASM SSH + SFTP core, WebCrypto signer callback
spike/relay/   Phase 0 relay: WebSocket ↔ TCP (production relay will be Rust)
spike/web/     Minimal xterm.js harness
docs/          THREAT-MODEL, PHASE0-RESULTS
```

## Running the spike

```bash
make sshd      # dockerized OpenSSH target on :2222
make wasm      # build wasm/ssh → spike/web/ssh.wasm
make relay     # serve harness + relay on :8080
open http://localhost:8080
```
