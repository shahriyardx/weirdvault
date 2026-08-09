# apps/agent — reaching a machine that cannot be dialled

A server behind a home router has no address the relay can connect to. So it
connects outward instead: this daemon holds one WebSocket open to the relay and
waits. When a browser asks for that machine, the relay says so, the daemon dials
back with a second WebSocket, and pipes it to sshd on loopback.

No port forwarding, no inbound firewall rule, no public IP.

## What it is, and what it is not

It is **a pipe to a port**. It holds no SSH credentials, performs no SSH
handshake, and cannot read a byte of what passes through it — the session is
encrypted end to end between the user's browser tab and sshd on this machine,
and this process sits in the middle of that ciphertext exactly as the relay
does.

Its Ed25519 key authenticates *the machine to the relay*. It says "the agent you
enrolled is here" and nothing else. So a stolen `agent.json` lets the thief
impersonate this machine — offer a connection, see ciphertext they cannot
decrypt — and does not let them log in. Host key pinning in the browser catches
them the moment they substitute their own sshd.

Revoking the agent in the dashboard makes the key useless immediately: the relay
asks the control plane on every reconnect, so there is no cache to expire and
nothing to push.

## Design: one socket per session

The obvious design carries every session over the single control connection with
a stream id on each frame. It is also the wrong one. A multiplexer over one
WebSocket has a single send queue, so an SFTP transfer saturating its half stalls
the interactive terminal beside it — and the fix for that is a per-stream credit
window, which is reimplementing the flow control SSH already has, one layer
down, in the component least able to be debugged from somebody's living room.

Separate sockets get backpressure from TCP for free. The cost is one extra
WebSocket handshake per session, which is invisible next to the SSH handshake
that follows it.

## Protocol

Control connection, `wss://…/agent/control`, JSON text frames:

```
agent → relay   {"type":"hello","agentId":"…"}
relay → agent   {"type":"challenge","nonce":"<32 random bytes, base64>"}
agent → relay   {"type":"proof","signature":"<Ed25519, base64>"}
relay → agent   {"type":"ready"}
relay → agent   {"type":"open","ticket":"…","port":22}     (per session)
```

The signed message is domain-separated and carries the agent id:

```
webxterm-agent-v1\n<agentId>\n<nonce>
```

A signature over a bare nonce is a signature over anything of that length, which
is how a key issued for one purpose validates in another. The agent id is inside
it so a nonce captured from one agent's handshake cannot be replayed into
another's. This must stay byte-identical to `verifyingMessage` in
`apps/web/src/lib/agents/verify.ts` — there is a test there pinned against a
fixture this implementation produced.

On `open`, the agent dials `wss://…/agent/stream?ticket=…` and splices it to
`127.0.0.1:<port>`. The ticket is single-use, expires in seconds, and is claimed
by removal, so a replay finds nothing.

## The port allowlist is load-bearing

The relay names a port in its open request, and the relay took that from a query
parameter the browser set. `allowedPorts` in `agent.json` is the only thing
standing between "somebody can reach your SSH server" and "somebody can reach
anything listening on loopback on this machine" — including the database bound
to `127.0.0.1` precisely because it was assumed unreachable.

Enrollment writes a single entry. Widen it only deliberately.

## Build

```bash
go build -o webxterm-agent ./apps/agent
```

Cross-compiling for a release, with the version stamped in:

```bash
for target in linux/amd64 linux/arm64 linux/arm darwin/arm64; do
  GOOS=${target%/*} GOARCH=${target#*/} go build \
    -ldflags "-X main.version=$(git describe --tags --always)" \
    -o "webxterm-agent_${target%/*}_${target#*/}" ./apps/agent
done
sha256sum webxterm-agent_* > checksums.txt
```

`checksums.txt` is **required**, not optional. `/install.sh` refuses to install
without it — a verification that is skipped when the file is missing verifies
nothing at all.

Publish both alongside each other and point `AGENT_RELEASE_BASE_URL` at the
directory. Unset, it defaults to `<your origin>/agent-bin`.

## Usage

```bash
webxterm-agent enroll --token=ENROLL_… --url=https://app.example.com
webxterm-agent run    --config=/etc/webxterm-agent/agent.json
webxterm-agent status
```

`enroll` generates the keypair locally and sends only the public half. It
refuses to overwrite an existing enrollment without `--force`, because
re-enrolling silently orphans the old agent row: the machine comes back under a
new id, the host record in somebody's vault still points at the old one, and the
only symptom is a host that is permanently offline.

`status` prints the fingerprint. That is what someone compares against the
dashboard when they are not sure the machine in front of them is the one the
browser is showing.

## Relay configuration

Agents are off unless the relay has both:

```
RELAY_AGENT_VERIFY_URL=http://web:3000/api/agents/verify
RELAY_AGENT_SECRET=<shared with the control plane>
```

Setting exactly one is a typo, and the relay says so at startup with a warning
naming the missing half — from the outside, a half-configured relay looks
identical to one where agents were switched off on purpose.

**Agent registration lives in one relay's memory.** A fleet behind a load
balancer needs the browser's `/ws` and the agent's `/agent/control` to land on
the same instance, or agents appear offline at random. A single relay is
unaffected.
