# Phase 0 Results — GO

**Date:** 2026-08-08
**Verdict:** the end-to-end-encrypted architecture is viable. Proceed to Phase 1.

## The question

> Can a Go/WASM SSH client running in a browser tab authenticate to an
> **unmodified** OpenSSH server using a **non-extractable WebCrypto key** that
> the client itself is structurally incapable of reading?

If no, webxterm collapses to a conventional server-side gateway that holds
users' private keys — the thing every existing web SSH tool already is, and the
thing the whole product thesis exists to avoid.

**Answer: yes.**

## Results

| Gate | Target | Measured | |
|---|---|---|---|
| WebCrypto signer accepted by stock OpenSSH | must work | **works** | PASS |
| Private key non-extractable | must be | `pkcs8`/`jwk`/`raw` export all refused | PASS |
| Bundle size (Brotli) | < 4 MB | **1.25 MB** (6.11 MB raw, 1.69 MB gzip) | PASS |
| Connect time | < 3000 ms | **63 ms** | PASS |
| Keystroke echo | < 50 ms | **1.5 ms** median, 2.3 ms p95 | PASS |
| Bulk throughput | > 20 MB/s | **33.6 MB/s** | PASS |
| WASM cold boot | — | 46 ms | — |

Browser: Chromium 151 headless. Target: `alpine:3` + stock `openssh-server`, no
patches, no agent, no webxterm-specific configuration.

Measured on the standalone Phase 0 harness, since deleted — `git log -- spike/`
if the measurement ever needs repeating. The *properties* it established are now
checked against the shipped app by `tests/signed-in.mjs` and
`tests/signed-out.mjs`. The timings are not: they were taken on a bare page with
no framework in the way, which is what made them meaningful.

## What was actually proven

1. **`webCryptoSigner` works.** `x/crypto/ssh` accepts an `ssh.AlgorithmSigner`
   that owns no key material — it holds a JS callback, hands the auth challenge
   out, and gets a signature back. OpenSSH verifies it like any other client.
2. **WebCrypto Ed25519 output is SSH's wire format verbatim.** The 64-byte
   signature drops straight into `ssh.Signature.Blob` with no repacking.
3. **A `CryptoKey` survives in IndexedDB** without the key bytes ever existing.
   Reloading the page reuses the key without re-authorizing on the server.
4. **The relay never sees plaintext.** It does `io.Copy` in both directions over
   bytes that are already SSH-encrypted by the tab.
5. **Server setup really is one line.** `echo '<pubkey>' >> ~/.ssh/authorized_keys`.

## What these numbers do NOT prove

Stated plainly so nobody quotes them as production figures:

- **Everything is on localhost.** Browser, relay, and sshd share a machine, so
  the latency and connect numbers exclude all network RTT — the dominant real
  term. Expect keystroke latency ≈ RTT to the nearest relay PoP; the 1.5 ms
  says the *client* adds no meaningful overhead, not that users will see 1.5 ms.
- **Ed25519 only.** The RSA and ECDSA P-256 paths are implemented in
  `signer.go` but untested. ECDSA in particular needs the r‖s → mpint repack
  verified against a real server.
- **No SFTP yet.** Throughput was measured over a shell channel, not the SFTP
  subsystem. `pkg/sftp` is not yet in the build, and it will add to the bundle.
- **Bundle size will grow.** 1.25 MB is the SSH core alone — no SFTP, no
  Monaco, no app. The 4 MB gate has headroom but is not banked.
- **The relay is the Go spike, not the Rust production relay.** SSRF guards are
  implemented and the dev override (`-allow-private`) is what let this test hit
  loopback at all.
- **Host keys are trust-on-first-use and not persisted.** Production must pin
  them and refuse loudly on change.

## Consequences for the plan

- The E2E architecture stands. Model B in PLAN.md §2 is confirmed; the Model A
  gateway fallback is not needed.
- Go/WASM over `russh` was the right call — the whole SSH core came in at
  1.25 MB compressed and 46 ms cold boot.
- Bundle budget is the thing to watch, not CPU. Lazy-load SFTP and Monaco.
- **Next unproven thing:** SFTP throughput and streaming upload/download through
  browser memory limits. That is the Phase 2 risk and deserves its own spike
  before the file explorer UI gets built.

## Files

As they stood when this was measured. The `wasm/ssh/` files are still there and
still carry the argument; the rest lived in the Phase 0 harness and were deleted
once the app superseded them — `git log -- spike/` if you need them back.

```
wasm/ssh/signer.go     webCryptoSigner — the load-bearing 100 lines
wasm/ssh/wsconn.go     net.Conn over a browser WebSocket
wasm/ssh/main.go       connect(), PTY session, JS handle
spike/relay/main.go    WebSocket ↔ TCP with SSRF guards        (deleted)
spike/web/keys.js      non-extractable key custody             (deleted)
scripts/phase0-verify.mjs  this test                           (deleted)
```
