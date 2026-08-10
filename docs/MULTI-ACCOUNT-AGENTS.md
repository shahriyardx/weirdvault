# Several accounts, one machine — and controlling it from the dashboard

The plan for four changes that turned out to be one change. Written before any
of it is built, so the decisions are recoverable afterwards.

Read [`../apps/agent/README.md`](../apps/agent/README.md) first if you have not:
what the agent is (a pipe to a port, holding no SSH credentials) is what makes
most of this safe, and what it is not is what makes the rest of it dangerous.

---

## What is being built, and why together

| | |
|---|---|
| **Reachability** | The dashboard says "last connected", which is stamped on reconnect and can be a week old on a machine that is up and fine. It cannot say whether a machine is reachable *now* |
| **Several accounts, one machine** | Two people who both have shells on a box cannot both add it. The second install refuses, and `--force` would overwrite the first person's identity |
| **Remote control** | Restart, upgrade and stop can only be done by someone standing at the machine — which is the one thing the product's users, by definition, may not be able to do |
| **Signed commands** | None of the above can be authorised end to end today, because the agent holds nothing that lets it verify the control plane |

They are one change because the last one is load-bearing for the other three,
and because the multi-account model decides what "stop this machine" even means.

---

## Decisions taken

Recorded because the alternatives were live options, not because they were
obvious.

**One process, many identities.** Not one process per identity, and not systemd
template units. The cost is accepted below in *What the shared process costs*.

**No `start` from the dashboard, ever.** Stopping is one-way: the connection the
command would arrive on is the thing being stopped. A greyed-out button implies
a state where it would work.

**No pause.** Considered as a reversible stop; dropped.

**No opt-out from remote control.** The choice is binary: an agent is running and
controllable, or it is stopped. There is no "running but not reachable by its
owner" state to configure. A self-hoster who does not want a control channel does
not run the agent.

**Restart and upgrade are refused while any session is live**, and the refusal
names which identities are busy.

**Revoke removes that identity from the machine.** It stops the loop and deletes
the config — but only on a *signed* instruction. See *Signing* for why that
sentence has a condition in it.

---

## 1. Signing: the control plane gets a key

Everything else depends on this, so it is built first.

### The problem it solves

The agent proves who it is with an Ed25519 key. Nothing proves anything to the
agent. "You are revoked" arrives as a WebSocket close code from the relay, and
`open` requests arrive as unauthenticated JSON on the same socket. The agent
trusts the relay because it has no way not to.

That is survivable today because the worst a rogue relay can do is deny service:
an agent that is refused exits, systemd holds it down, and a reboot or a
`systemctl start` recovers it. The moment a command can stop a daemon
persistently or delete a private key, the same forgery becomes: *strand every
machine this deployment has, permanently, requiring physical access to recover*.

### The design

An Ed25519 keypair belonging to the control plane.

```
AGENT_COMMAND_SECRET   base64 seed, 32 bytes, on the web app only
                       generated like every other secret: openssl rand -base64 32
```

The public half is returned at enrolment and stored in the identity file as
`commandKeys` — an array, so a rotation does not need every machine
re-enrolled. It travels over the same TLS connection the installer already
trusts to hand out an agent id and a relay URL.

Commands are signed over a domain-separated message, in the shape the existing
agent proof already uses:

```
weirdvault-command-v1\n<agentId>\n<command>\n<nonce>\n<expiresAtUnixSeconds>
```

- **`agentId`** binds it to one identity. A command captured for one machine
  cannot be replayed at another, and on a shared machine it names *which*
  account's identity is being addressed.
- **`nonce`** is 32 random bytes, base64. The agent keeps the nonces it has seen
  until they expire, which bounds replay to the expiry window.
- **`expiresAt`** is 60 seconds out. A command is an instruction about now.

This must stay byte-identical between `apps/web/src/lib/agents/commands.ts` and
`apps/agent/command.go`, and it gets the same treatment as `signingMessage`
already has: a fixture one language produced, asserted by the other. A
round-trip test written in one language passes just as happily with both halves
wrong in the same way.

### What it does and does not buy

The relay can still **drop, delay or reorder** commands — it is the transport.
It cannot **invent** one. That is the whole point: it moves the relay from "must
be trusted with your fleet" to "must be trusted to deliver, and delivery is
observable".

### Agents enrolled before this exists

They have no `commandKeys`, so they refuse every command — including revoke.
The dashboard says so on the card rather than showing controls that will fail,
with the same re-enrol instruction that `Updates: off` already gets. This is the
same shape of gap as agents enrolled before self-update, and it resolves the same
way.

### Rotation

`commandKeys` is a list, and a `rotate-key` command signed by a *current*
key appends a new one. Not built in the first pass; the field is a list from the
start so that adding it later is not a config migration.

---

## 2. Reachability

The relay already holds the answer — `control: DashMap<agentId, Registration>`
is the live set of connected agents, and `account_for()` already exists as the
online check the browser path uses before upgrading a socket.

**Relay:** `POST /agents/presence`, authorised by an HMAC token minted with
`RELAY_SECRET` (the same key and the same shape as the tokens the browser
already carries, so no new secret). Body is a list of agent ids; the response
says which are connected **and registered to the account named in the token**.
Scoped that way so the endpoint cannot be used as an oracle for agent ids that
are not yours.

**Web:** `/api/agents` calls it, with a short cache, and folds the result into
each row. Three states, not two:

| | |
|---|---|
| **Online** | The relay has a live control connection |
| **Offline** | The relay is answering and does not have one |
| **Unknown** | The relay could not be reached — say so rather than reporting every machine offline because one internal call timed out |

**Known limit, documented rather than solved:** agent registration lives in one
relay's memory. A fleet behind a load balancer would answer for the instance
asked. Single-relay deployments — which is what `compose.prod.yaml` builds — are
exact. This is the same caveat `apps/relay/README.md` already carries for agent
connections generally.

---

## 3. Several accounts on one machine

### The model

Each person enrols from their own dashboard and pastes their own command. Each
gets their own agent id, key, row and host record. Nobody shares a secret, and
revocation is already per-person.

This needs **no new server-side concepts** — no sharing, no invitations, no ACL.
That matters beyond implementation cost: "one account is one person, no teams"
is a product position, and this is the only shape of multi-person access that
does not quietly repeal it.

**An agent grants no login.** It is a pipe to a loopback port; the person still
needs an SSH key or password on that machine. A second agent gives someone who
*already has* access their own path in. That is what makes this safe to do
casually, and it should be said out loud in the docs.

### On disk

```
/etc/weirdvault/
  ffa719fa.json          one identity per account (short agent id)
  ffa719fa.stopped       marker: this identity is stopped
  a41c0b93.json
/var/lib/weirdvault/bin/weirdvault    one binary, shared
/run/weirdvault/state.json                  runtime state, see below
```

Named after the agent id because everyone pastes an identical command — only the
token differs — so the installer cannot ask for a name and must derive one. Eight
characters, so `list` output and log lines stay readable.

**Deliberately not named after the person.** Everyone with a shell on that box
can read the directory. How many agents exist is unavoidable; whose they are is
not the installer's fact to publish.

`agent.json` and the existing `weirdvault.service` stay valid exactly as
they are. Nothing already installed moves.

### One process, N control loops

Each identity gets its own WebSocket to `/agent/control`, its own backoff and its
own ping. The relay keys registrations by agent id, so N connections from one
process is what it already expects.

**Hot reload is not optional.** If adding an identity meant `systemctl restart`,
then person B enrolling would kill person A's sessions — which contradicts
refusing a restart while sessions are live. So the daemon polls the config
directory every few seconds: a new file starts a loop, a removed file stops one,
a `.stopped` marker stops one. Polling rather than fsnotify: a handful of small
files, and no new dependency in a binary that currently has exactly one.

**A rejection stops one loop, not the process.** Today rejection means `exit 3`
and systemd holds the unit down. With shared identities that would take everyone
down when one person is revoked. The process exits 3 only when no identity is
left running.

### Runtime state

The CLI is a different process and cannot see inside the daemon. So the daemon
writes `/run/weirdvault/state.json` (`RuntimeDirectory=weirdvault`
in the unit, owned by the service user) on every state change: per identity, its
connection state, session count, last error, and when it last connected.

This is what makes `list` and `status` honest on a multi-identity machine, and it
is what `stop <id>` polls to confirm rather than printing "stopped" a second
before it is true.

### What the shared process costs

Accepted deliberately:

- **`restart` and `upgrade` are machine-wide.** Person A upgrading restarts
  person B's connection. The session check therefore covers *all* identities, and
  a refusal names which are busy — otherwise A is refused with no idea why.
- **A crash takes everyone down.** Per-identity units would isolate that; they
  were not chosen.

Revisit at roughly fifty identities on one machine, which is a different product.

---

## 4. The CLI

| | |
|---|---|
| `stop` | Stops the service — every identity — and stays stopped at boot |
| `stop <id>` | Writes `<id>.stopped`; the daemon drops that loop within seconds |
| `start` / `start <id>` | The inverses |
| `enable` / `disable` | Boot behaviour of the unit. Global |
| `list` / `status` | Per identity, read from the runtime state file |
| `logs`, `upgrade` | Unchanged, service-wide |

`<id>` accepts a unique prefix and refuses an ambiguous one.

A marker file rather than a socket, because it survives a reboot and a daemon
restart with no extra bookkeeping, and it never rewrites a file holding somebody's
private key.

**When the last identity is stopped the daemon keeps running** with zero loops —
otherwise `start <id>` would need systemd — and `status` says "running, 0
identities active" so it does not read as broken.

---

## 5. The command channel

```
relay → agent   {"type":"command","id":…,"command":"restart|upgrade|stop|revoke",
                 "nonce":…,"expiresAt":…,"signature":…}
agent → relay   {"type":"result","id":…,"ok":…,"detail":…}
```

Authority runs browser → web (session, and ownership in the `WHERE` clause) →
relay (HMAC token) → agent's own authenticated socket. **The relay never
originates a command.** The agent verifies the signature before acting, so the
chain is checkable at the end rather than merely at the start.

**No queueing.** A command for an offline machine is refused, not stored. A
`stop` that lands three weeks later is a trap, and a queued `upgrade` is
pointless — an agent self-updates at startup anyway, which is exactly what an
offline machine will do when it comes back.

**Session refusal** is decided at the agent, because only the agent knows. A
check in the browser is a race with a session starting.

Every command writes an `audit_event`, and they are rate limited per agent.

---

## 6. Revoke

1. `revoked_at` is written. Every new connection and token mint is refused from
   that instant — unchanged, and it is what actually protects the account.
2. If the machine is online, a **signed `revoke`** goes down the channel. The
   agent verifies it, stops that loop, and deletes that identity file. Other
   identities are untouched.
3. If it is offline, nothing is sent. The identity is refused on its next connect
   and the loop stops. The dead config stays on disk — a bare close code is not
   authority to delete a private key — and `list` shows it as rejected, with
   `weirdvault forget <id>` to clear it.

For that account the machine is then unusable from the dashboard: no agent, no
sessions. It says nothing about that person's SSH access by other routes, and
nothing about anyone else's identity on the same box.

**macOS is fixed regardless**: launchd has no `RestartPreventExitStatus`, so a
rejected agent currently respawns every ten seconds forever. Without a signed
instruction it backs off hard — retry hourly — rather than disabling itself. Self
-disabling on an unverifiable close code is exactly the fleet-stranding primitive
this document is otherwise built to avoid.

---

## 7. The card

Chosen shape: a status rail carrying reachability, identity on top, facts as a
labelled grid, actions in a footer that wraps.

```
┌─────────────────────────────────────────────┐
│ ● arch                    [Update available]│
│ │ Online · relay connected                  │
│ │ HOST      shahriyar                       │
│ │ SYSTEM    linux/amd64 · v1.1.1            │
│ │ KEY       SHA256:BaegovU…                 │
│ │ SEEN      8/10/2026, 9:07 PM              │
│ ├───────────────────────────────────────────│
│ │ [Connect as root]  Update   ⋯             │
└─────────────────────────────────────────────┘
```

Rail: green online, grey offline, amber unknown. Colour is never the only
carrier — the state is written next to it.

`Connect` and `Update` are the two things anyone does often. `Restart`, `Stop`,
`Rename` and `Revoke` go behind the overflow, which is also what keeps the
footer from becoming six buttons on a phone. `Stop` opens a dialog that says
plainly: **this needs local or SSH access to undo.**

Controls that cannot work are absent, not disabled: no remote control on an
agent with no `commandKeys`, nothing but `Connect` while a machine is
offline.

---

## Threat model delta

For `THREAT-MODEL.md` when this lands.

**What is new.** The agent will act on instructions from outside: restart, stop,
delete an identity. An account takeover therefore reaches the machines, not just
their records — `stop` is the sharp one, because recovering needs access to the
machine.

**What is not new.** Remote `upgrade` adds no code path: the agent already
fetches from the `releaseUrl` fixed at enrolment, and the control plane already
decides what is published there, so it could hand a machine new code at the next
restart regardless. The marginal capability is *now* rather than *at all*.

**What gets better.** The relay stops being trusted with the fleet. Today it can
refuse any agent and, through a close code, stop one — with signing it can only
deliver or fail to deliver instructions it cannot read the authority of.

---

## Build order

Each phase is separately shippable and separately verifiable.

All six have landed. Kept as written so the order — and the reason phases 1 and
2 came first — is recoverable.

| | | |
|---|---|---|
| **1** ✓ | Presence | Relay endpoint, web fold-in, three states. No protocol change, no agent change |
| **2** ✓ | Card | The layout above, against real reachability from phase 1 |
| **3** ✓ | Multi-identity | Config directory, per-identity loops, hot reload, runtime state, CLI selectors, `install.sh` naming and the duplicate-enrolment guard |
| **4** ✓ | Signing | Key, enrolment delivery, `commandKeys`, verification in Go, cross-language fixture |
| **5** ✓ | Commands | Channel, `restart`/`upgrade`/`stop`, session refusal, audit, rate limit, dashboard controls |
| **6** ✓ | Revoke | Signed revoke, identity deletion, the macOS fix |

Two things came out differently from the plan, both for the better:

- **macOS does not back off hourly on a rejection; it stays resident and idle.**
  Backing off still leaves launchd restarting the process forever, just more
  slowly. Staying alive with nothing to run is the only way to stop without a
  supervisor undoing it, short of the self-disable this document argues against.

The duplicate-enrolment question is answered: the enrolment response carries an
opaque `accountRef`, the identity file stores it, and the installer refuses a
second enrolment for an account that already has one here. It identifies nobody
— another account's file says only that it is not yours.

Phases 1 and 2 are independent of the rest and worth landing first — they are
also what makes phases 5 and 6 legible, since a control you cannot see the effect
of is a control nobody trusts.

## What has and has not been on a real machine

The macOS paths were written from documented behaviour with no Mac available,
and have since been installed and run on one — so the plist, the daemon and the
ordinary install are no longer taken on faith. What has not been provoked there
is the behaviour that only happens when something goes wrong: a revoked identity
staying resident rather than letting launchd restart it every ten seconds, and
`launchctl kickstart` as the restart path.

Still unverified anywhere:

- **Multi-relay presence**, which needs a load balancer to be wrong in the way
  described above.
- **The session refusal against a real session.** It is unit-tested with a
  synthetic counter; no actual SSH stream has been open at the moment a restart
  was attempted, because the development host runs no sshd.

## Open questions

- **Duplicate enrolment by the same account.** The file-exists check that
  prevented it is being removed. Proposed replacement: an opaque per-account
  reference in the enrolment response, stored in the identity file, so the
  installer can refuse a second enrolment for an account that already has one —
  opaque so it cannot tell person B who person A is. Not yet decided.
- **Whether the machine's owner should be able to see who has an agent.** `list`
  shows ids and fingerprints: enough to count them and to remove one locally, not
  enough to name a person. Anyone with root can already enrol the box into their
  own account; this is the only place that becomes visible.
