# apps/relay — the WebSocket-to-TCP bridge

A browser cannot open a raw TCP socket, so something has to sit between the tab
and port 22. This is that something, and it is deliberately stupid: it accepts a
WebSocket, dials the requested host, and copies bytes between them.

**It cannot read what it carries.** The SSH handshake happens in the browser
(`apps/ssh`), so every byte through here is already encrypted under keys this
process never sees. It holds no database credentials and no secret beyond two
shared strings, which makes it cheap to run several of, close to users — relay
latency is felt directly in typing.

The interesting code is the part that says no:

| File | What it guards |
|---|---|
| `src/ssrf.rs` | Port allowlist; rejects loopback, RFC1918, link-local, CGNAT, multicast, and the cloud metadata addresses. Resolves first, vets **every** answer, then dials the vetted IP — which closes the DNS-rebinding window |
| `src/token.rs` | Tokens are bound to one destination, so a token minted for `a.example:22` cannot open `b.example:22` |
| `src/quota.rs` | Per-account connection limits, released by RAII so a panic cannot leak a slot; and the byte counters behind the transfer allowance |
| `src/reporter.rs` | Posts those byte counts to the control plane on a timer, and drops a batch it cannot deliver rather than retrying it |

An authenticated WebSocket-to-TCP bridge is an SSRF engine if built carelessly.
See `docs/THREAT-MODEL.md` §7.

## Transfer accounting

Every account has a monthly relay transfer allowance, and it is enforced
nowhere in this process.

The relay counts bytes per account in memory as it copies them, and once a
minute POSTs the batch to `RELAY_USAGE_URL` with `RELAY_USAGE_SECRET` as a
bearer token. The control plane accumulates those into a table and refuses to
mint a new connection token for an account that is over. That split is the whole
point: the relay is the internet-facing component, and giving it Postgres
credentials to record a usage row would widen its blast radius to the database
for no gain.

The behaviour that falls out of enforcing at the mint is the behaviour we want.
An account at its limit is refused **new** connections; sessions already open
run to their natural end. Nothing is severed mid-transfer.

Two consequences worth knowing before you deploy this:

- **If the control plane is unreachable, the batch is discarded.** It is not
  retried and not added back, because a POST that timed out may well have
  landed and replaying it would bill someone twice for bytes they moved once.
  Under-counting during an outage is the correct failure direction for an abuse
  control: the cost is some free transfer, and the alternative cost is locking
  a user out of their own servers over a number nobody can reproduce.
- **If you do not set `RELAY_USAGE_URL` and `RELAY_USAGE_SECRET`, nothing is
  counted and no allowance is ever enforced.** The relay says so at startup, in
  a warning, rather than appearing to meter. That is the right configuration
  for a self-hosted relay: the cap exists because relay bandwidth costs the
  hosted deployment money, and bandwidth you are already paying for is not ours
  to ration.

`RELAY_USAGE_SECRET` is deliberately not `RELAY_SECRET`. The latter is an HMAC
signing key that is never transmitted, and a copy of it lets the holder mint a
token for any destination the SSRF rules allow — which is to say, use your relay
as a proxy. The former is a bearer credential that travels in a header on every
flush and will end up in a proxy log somewhere. Two purposes, two secrets.

The POST is plain HTTP: the relay has no TLS stack, and in every deployment we
ship the control plane is a neighbour on a private network. `http://` is the
only scheme accepted, and the process refuses to start on anything else rather
than appearing to encrypt. If your relay is across the public internet from your
control plane, terminate TLS beside the relay and point `RELAY_USAGE_URL` at the
local end of it.

Both halves are set in `compose.prod.yaml` at the repo root, and the secret is
in `.env.example` next to `RELAY_SECRET` so the difference between them is read
at the moment somebody generates one. The control plane's side is documented in
[`apps/web/README.md`](../web/README.md#relay-transfer-accounting).

Nothing compiles both ends of the wire format, so it is pinned from both:
`encodes_the_field_names_the_ingest_endpoint_reads` here asserts what this
process emits, and `apps/web/src/lib/usage.test.ts` feeds that exact object
through the validator that receives it. A rename on either side fails a build
rather than quietly reporting batches that are accepted and count nothing.

## Run

```bash
cd apps/relay
RELAY_SECRET=dev-relay-secret-change-me \
RELAY_PORTS=22 RELAY_ADDR=127.0.0.1:8080 \
cargo run --release
```

Develop against a real server you control. That is not a preference — the relay
dials the destination itself, so a target on `127.0.0.1` is one the SSRF guard
is built to refuse, and reaching it means setting `RELAY_ALLOW_PRIVATE=1` and
running every local test against a relay configured the one way it must never
be configured in production. The guard is the relay's single most important
control; developing with it off is how a difference between development and
production becomes a difference nobody notices.

`RELAY_ALLOW_PRIVATE` still exists, for the deployment that genuinely means to
reach an internal network and is not reachable by untrusted users. It is not
for convenience.

| Variable | Meaning |
|---|---|
| `RELAY_SECRET` | HMAC key for connection tokens. Must match the web app exactly |
| `RELAY_ADDR` | Listen address, e.g. `0.0.0.0:8080` |
| `RELAY_PORTS` | Destination port allowlist. Default `22` |
| `RELAY_ALLOW_PRIVATE` | Disables the SSRF guard, so private and loopback destinations are reachable. For a relay that is meant to reach an internal network *and* is not reachable by untrusted users. Not for development convenience |
| `RELAY_USAGE_URL` | Where to POST transfer counts, e.g. `http://web:3000/api/relay/usage`. `http://` only. Unset means nothing is counted |
| `RELAY_USAGE_SECRET` | Bearer token for that POST. Must match `RELAY_USAGE_SECRET` on the web app. Unset means nothing is counted |
| `RELAY_USAGE_INTERVAL_SECS` | How often to flush. Default `60` |
| `RUST_LOG` | e.g. `weirdvault_relay=info` |

Shutdown is on SIGINT or SIGTERM, and the reporter flushes one last batch on
either. A `docker stop` therefore costs at most the seconds since the last
flush rather than a whole interval.

## Test

```bash
cd apps/relay && cargo test    # 28 tests: SSRF vetting, token binding, quotas, usage reporting
```

These are unit tests over the guards, and they are the ones worth reading — each
asserts a refusal rather than a success.

## Build the image

From the repo root, since the Dockerfile expects that context:

```bash
docker build -f apps/relay/Dockerfile -t weirdvault-relay .
```

Distroless with no shell: the relay opens sockets and does nothing else, so a
compromised process has no shell to escalate with.
