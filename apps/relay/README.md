# apps/relay — the WebSocket-to-TCP bridge

A browser cannot open a raw TCP socket, so something has to sit between the tab
and port 22. This is that something, and it is deliberately stupid: it accepts a
WebSocket, dials the requested host, and copies bytes between them.

**It cannot read what it carries.** The SSH handshake happens in the browser
(`apps/ssh`), so every byte through here is already encrypted under keys this
process never sees. It holds no state and no secret beyond the token-signing
key, which makes it cheap to run several of, close to users — relay latency is
felt directly in typing.

The interesting code is the part that says no:

| File | What it guards |
|---|---|
| `src/ssrf.rs` | Port allowlist; rejects loopback, RFC1918, link-local, CGNAT, multicast, and the cloud metadata addresses. Resolves first, vets **every** answer, then dials the vetted IP — which closes the DNS-rebinding window |
| `src/token.rs` | Tokens are bound to one destination, so a token minted for `a.example:22` cannot open `b.example:22` |
| `src/quota.rs` | Per-account connection limits, released by RAII so a panic cannot leak a slot |

An authenticated WebSocket-to-TCP bridge is an SSRF engine if built carelessly.
See `docs/THREAT-MODEL.md` §7.

## Run

```bash
cd apps/relay
RELAY_SECRET=dev-relay-secret-change-me \
RELAY_ALLOW_PRIVATE=1 RELAY_PORTS=22,2222 RELAY_ADDR=127.0.0.1:8080 \
cargo run --release
```

`RELAY_ALLOW_PRIVATE=1` disables the SSRF guard so the local test container on
`127.0.0.1:2222` is reachable. **Never set it in production** — it turns the
relay into an open proxy into whatever network it sits on.

| Variable | Meaning |
|---|---|
| `RELAY_SECRET` | HMAC key for connection tokens. Must match the web app exactly |
| `RELAY_ADDR` | Listen address, e.g. `0.0.0.0:8080` |
| `RELAY_PORTS` | Destination port allowlist. Default `22` |
| `RELAY_ALLOW_PRIVATE` | Development only. Disables the SSRF guard |
| `RUST_LOG` | e.g. `webxterm_relay=info` |

## Test

```bash
cd apps/relay && cargo test    # 13 tests: SSRF vetting, token binding, quotas
```

These are unit tests over the guards, and they are the ones worth reading — each
asserts a refusal rather than a success.

## Build the image

From the repo root, since the Dockerfile expects that context:

```bash
docker build -f apps/relay/Dockerfile -t webxterm-relay .
```

Distroless with no shell: the relay opens sockets and does nothing else, so a
compromised process has no shell to escalate with.
