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
agent → relay   {"type":"hello","agentId":"…","version":"…"}
relay → agent   {"type":"challenge","nonce":"<32 random bytes, base64>"}
agent → relay   {"type":"proof","signature":"<Ed25519, base64>"}
relay → agent   {"type":"ready"}
relay → agent   {"type":"open","ticket":"…","port":22}     (per session)
```

`version` is a label, not a claim. It rides on hello because that is the only
frame that already exists per reconnect, it is sent before anything is verified,
and nothing is decided from it — the relay forwards it and the control plane
records it only after the signature checks out. It is what stops the dashboard
showing the build a machine was installed with months after it replaced itself.
Optional in both directions: an agent older than the relay sends none, and a
relay older than the agent ignores it.

The signed message is domain-separated and carries the agent id:

```
weirdvault-agent-v1\n<agentId>\n<nonce>
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

## Self-update

The agent checks for a newer build when it starts, replaces its own binary, and
re-execs. An agent lives on a machine in somebody's house; without this, every
fix reaches it only when a person walks over and copies a file, which is not a
workaround but a missing feature.

It reads `manifest.json` from the release URL it was given at enrolment — the
same place `/install.sh` downloads from, so a machine's behaviour does not
depend on how it was set up. Different version means update; the versions are
`git describe` strings and inventing an ordering for them would be inventing a
wrong one.

**Where the binary lives, and why it is not `/usr/local/bin`.** Replacing itself
means writing a temp file beside the binary and renaming it, so the *directory*
has to be writable by the account the service runs as — an unprivileged one. On
Linux the binary therefore lives in `/var/lib/weirdvault-agent/bin`, owned by
that account, with `/usr/local/bin/weirdvault-agent` a symlink so the command
people type is unchanged; `replaceSelf` resolves the link before replacing the
target. `StateDirectory=weirdvault-agent` in the unit is what exempts that
directory from the read-only remount `ProtectSystem=strict` imposes.

Both halves are load-bearing, and an earlier version of this had only one. The
unit pointed `ReadWritePaths` at `/usr/local/bin` and read as correct — but that
directive lifts the sandbox, not the file permissions, and `/usr/local/bin` is
`root:root 0755`. Every update on every install with a service user downloaded
its binary, verified the checksum, and failed on the write. The failure is a log
line rather than a crash, so the machines stayed up, stayed working, and stayed
on the version they were installed with. Fix an install from before this with
`install.sh --repair`, which keeps the machine's identity and replaces only the
binary and the unit.

**What this trusts.** It downloads a binary and runs it as root. The manifest
and the binary come from the same origin, so the SHA-256 proves the download was
not corrupted — it does not prove the origin is honest. TLS to the deployment's
own domain is the real trust anchor, the same one the install command already
relies on. What that does not extend to is plaintext: `install.sh` is fetched
once by a person who can read the URL they typed, while this runs unattended
forever, so **http:// is refused unless it is loopback**.

Bounded to one attempt per start: the re-exec'd process finds an environment
marker and skips the check, so a manifest whose version never matches cannot
produce a restart loop.

`--no-update` disables it, and the agent then never touches its own binary.

Agents enrolled before this existed have no release URL and never check;
`weirdvault-agent status` says so rather than implying they are up to date.

## Build

```bash
go build -o weirdvault-agent ./apps/agent
```

Cross-compiling for a release, with the version stamped in:

```bash
for target in linux/amd64 linux/arm64 linux/arm darwin/arm64; do
  GOOS=${target%/*} GOARCH=${target#*/} go build \
    -ldflags "-X main.version=$(git describe --tags --always)" \
    -o "weirdvault-agent_${target%/*}_${target#*/}" ./apps/agent
done
sha256sum weirdvault-agent_* > checksums.txt
```

Or just `bun run agent`, which does all of that and writes `manifest.json`
beside it.

`checksums.txt` is **required**, not optional. `/install.sh` refuses to install
without it — a verification that is skipped when the file is missing verifies
nothing at all.

Publish both alongside each other and point `AGENT_RELEASE_BASE_URL` at the
directory. Unset, it defaults to `<your origin>/agent-bin`.

## Usage

```bash
weirdvault-agent enroll --token=ENROLL_… --url=https://app.example.com
weirdvault-agent run    --config=/etc/weirdvault-agent/agent.json
weirdvault-agent status
```

`enroll` generates the keypair locally and sends only the public half. It
refuses to overwrite an existing enrollment without `--force`, because
re-enrolling silently orphans the old agent row: the machine comes back under a
new id, the host record in somebody's vault still points at the old one, and the
only symptom is a host that is permanently offline.

`status` prints the fingerprint — what someone compares against the dashboard
when they are not sure the machine in front of them is the one the browser is
showing — and whether the agent is running, and whether it will be after a
reboot.

## Running it, and stopping it

| | |
|---|---|
| `start [--boot-only]` | Start now, and at every boot |
| `stop [--keep-enabled]` | Stop now, and stay stopped across reboots |
| `restart` | Restart, leaving boot behaviour alone |
| `enable` / `disable` | Change only whether it starts at boot |
| `list` | Every agent on this machine, and what each is doing |
| `logs [-f] [-n N]` | What the service has been saying |
| `upgrade [--check]` | Install the build this deployment publishes, now |

These wrap systemd on Linux and launchd on macOS. They exist because the
alternative was knowing that a unit exists, knowing its name, and knowing that
`systemctl stop` is undone by the next reboot.

**`stop` also stops it at boot**, and says so. "Stop the agent" is said by
somebody who wants the machine off the network until they say otherwise, and a
reboot two days later silently undoing that leaves a machine reachable while its
owner believes it is not. `--keep-enabled` is there for the person who meant
only this run; `start` turns it back on.

`list` finds agents by looking at the process table rather than at a pidfile, so
it sees the copy somebody started in a terminal to debug something and forgot —
which is what produces two agents claiming one machine and a dashboard that
flickers between online and offline.

`upgrade` is the same self-update that happens at startup, asked for on purpose,
and it restarts the service afterwards so the running process is the build that
was just installed. `--check` prints what is published against what is running
and touches nothing.

### macOS

`install-service` writes `/Library/LaunchDaemons/com.weirdvault.agent.plist` for
the enrolment already on the machine, and `uninstall-service` removes it. The
installer runs the first of those, so a Mac survives a reboot the same way a
Linux box does — before this, macOS was enrolled and then left with "start it
yourself".

launchd has no equivalent of systemd's `RestartPreventExitStatus`, so a revoked
agent — which exits 3 on purpose and would be right to stay down — is started
again every ten seconds. The agent says so in the log line it prints before
exiting, and `weirdvault-agent stop` is what ends it.

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
