# TODO

Work that is understood and deliberately not done yet. Each entry says what the
current state is, what should replace it, and what triggers the change — an
entry with no trigger is a wish, not a task.

---

## Record that a connection happened

**Now:** `audit_event` has `connection.opened` and `connection.closed` in its
catalogue, with metadata validators, and **nothing emits them**. So the Activity
page shows device registrations, recovery-code use, host keys pinned and keys
installed — everything except the thing anyone would look for first. "Who
connected to which host, when" is recorded nowhere.

**Why it was skipped:** both are `source: "relay"`, and the relay has no
database — no sqlx in its Cargo.toml, no audit code. `/api/audit` deliberately
will not take them from a browser, because a client that could fabricate
"connection opened" could fabricate a whole session history.

**What to do instead:** the relay already does exactly this shape of thing for
something else. `apps/relay/src/reporter.rs` batches per-account byte counts and
POSTs them to `/api/relay/usage` with a bearer secret, on a timer, with tests
covering the unreachable-control-plane case; `apps/relay/src/http.rs` is the
shared client. Connection events are the same channel, the same credential and
the same batching. The blinded `targetRef` is the one open question — the relay
knows the host in plaintext and must not store it, so either the browser sends
the ref with the token mint and the relay echoes it back, or the event is
recorded without one.

**Trigger:** the next time somebody asks the Activity page a question it cannot
answer. It is the largest visible gap in the product and the plumbing already
exists.

---

## Make `/pricing` and Stripe agree about the price

**Now:** `PRO_PRICE_USD` in `lib/billing/tiers.ts` is what `/pricing` prints.
The amount actually charged lives in the Stripe Price object named by
`STRIPE_PRICE_PRO`. Nothing checks that the two agree, and `tiers.ts` says so.

**What to do instead:** read the price from Stripe once at startup and log a
warning when it differs from the constant. Not a hard failure — a deployment
with no Stripe configured must still render `/pricing`.

**Trigger:** before the price ever changes. Changing it in one place and not the
other is a page advertising a number nobody is charged.

---

## Give the agent a service file on macOS

**Now:** the installer writes a systemd unit on Linux. On macOS it installs the
binary and that is all, so the agent is a process somebody started in a terminal
— it does not survive a reboot, or the terminal closing.

**What to do instead:** a launchd plist at
`/Library/LaunchDaemons/`, with `KeepAlive` and the same
`RestartPreventExitStatus`-equivalent behaviour: exit code 3 means revoked and
must not be restarted, which launchd expresses as `SuccessfulExit` rather than a
status list.

**Trigger:** the first macOS machine anyone but us enrols.

---

## Let a long-lived agent pick up its own updates

**Now:** `selfUpdate()` runs once, at startup. A machine that stays up for three
months never gets a fix — including a fix to the update path itself.

**What to do instead:** check on the same timer that already exists for the
control connection's ping, and apply on the next clean reconnect rather than
mid-session.

**Trigger:** the first agent fix that matters after there are agents in the
field.

---

## Done, kept here for the reasoning

### The storage ceiling counts both tables again

Shipped. `lib/recording/stored-bytes.ts` sums `recording` and `recording_share`
together, and POST /api/recordings, POST /api/recordings/[id]/shares and the
listing all import it. Before this the two routes carried their own sums and
disagreed: a share was refused for space a recording of the same size would have
been granted, and an account that only ever saved recordings could pass the
ceiling and stay past it. Each route owning its own sum is what let them drift,
so there is one.

### Recording storage moved to object storage

Shipped. `recording.storage_key` and `recording_share.storage_key` name an
object; `ciphertext` is still there and still used when no bucket is configured.
A check constraint forbids both at once. `lib/storage/` holds the SigV4 signer
and the client, `lib/recording/blobs.ts` is the only code that knows there are
two places bytes can be, and `lib/storage/purge.ts` removes an account's objects
after the account is deleted.

Three decisions from the original plan that are worth not re-litigating:

- **Proxy, never presign.** `GET /api/recordings/[id]` fetches the object with
  server credentials and serves it through the same `id = ? AND user_id = ?`
  WHERE clause it always had. A presigned URL would be a second thing that
  grants access — a bearer credential good for its whole lifetime to whoever
  ends up holding it, in browser history, a `Referer` header, a proxy log. There
  is no presign function in `sigv4.ts`, which is how that stays decided.

  For `/api/shares/[token]` it is not a preference at all. That route
  authenticates nobody and enforces `revoked_at` when the request arrives; a
  signed URL minted before a revocation keeps working after it, because a bucket
  has never heard of `revoked_at`.

- **Postgres was not replaced, and there was no backfill.** Both backends are
  read, always, in both directions. A deployment can turn a bucket on after a
  year and every existing recording keeps playing; turning it off gives the old
  ones back. The fallback is not scaffolding to remove later.

- **The ordering is the design.** Object before row on the way in, object before
  row on the way out, so a half-failure always leaves an orphan rather than a
  row pointing at nothing — the first is recoverable and the second is a
  recording that cannot be played. A delete whose object cannot be destroyed
  refuses rather than deleting the row anyway.

What is **not** solved: nothing backfills, so a deployment that switches on a
bucket keeps its old blobs in `pg_dump` until they are deleted.

### The maintenance scripts became a route with a scheduler

Shipped. `prune-audit.mjs` and `sweep-recordings.mjs` are gone. The work is
`src/lib/maintenance/`, triggered by `POST /api/cron`, and `compose.prod.yaml`
ships a `cron` service that calls it — so the default deployment does the work
rather than documenting it. An external scheduler can call the same route, which
is the only option on a serverless deployment.

The part worth keeping: moving the jobs out of node scripts deleted two
duplications that existed **only** because a plain script cannot import from
`src/`. The audit retention windows had a second copy, policed by a test that
read a script as *text* and compared number literals. AWS SigV4 had a second
complete implementation, policed by a test that signed the same five requests
with both signers and compared the Authorization headers. Both copies and both
guard tests are gone; there is one of each again.

That is the argument against reaching for a standalone script next time
something needs scheduling. The runtime image ships no `src/` and no TypeScript,
so a script cannot import anything — and whatever it needs, it ends up carrying.

---

## Rotate the command signing key

**Now:** `AGENT_COMMAND_SECRET` signs every instruction the dashboard sends a
machine, and each identity holds its public half in `commandKeys` — a list,
already, so that this is not a config migration when it arrives. There is no way
to change it. Rotating today means re-enrolling every machine, which is exactly
the cost the list was shaped to avoid.

**What to do instead:** a `rotate-key` command, signed by a *current* key, that
appends a new one to `commandKeys`. Signed by the old key is what makes it safe:
the agent already knows how to check that, and the relay still cannot invent one.
Then the old key is retired on the control plane once the fleet has picked the
new one up, which `list` can report because every identity's keys are on disk.

**Trigger:** the first time a key has to change — a leak, an operator leaving, or
a deployment splitting in two. Also the first time somebody asks how to do it,
because "you cannot" is a worse answer than a small amount of work.

---

## Show which sessions a machine is carrying

**Now:** the agent counts the sessions each identity is carrying, refuses a
remote restart or upgrade while any are open, and names the identity in the
refusal. `weirdvault list` prints the count. The dashboard does not: it offers
Restart, the machine refuses, and the number arrives as a sentence in a toast.

**What to do instead:** the count is already in the runtime state file and could
ride back on the presence answer the same way `online` does. A card that showed
"2 sessions" would make the refusal predictable rather than surprising, and it is
the same fact the terminal page could use to say what is open.

**Trigger:** the first report of somebody pressing Restart twice because the
first refusal read as a failure.

---

## Record when a machine came and went

**Now:** reachability is a live question answered by the relay's registry —
online, offline, or unknown right now. Nothing is written down, so "it dropped
at 3am and came back" is unanswerable, and so is "how often does this machine
fall off".

**What to do instead:** the same channel `connection.opened` and
`connection.closed` are waiting on (see above): the relay already batches usage
counts to the control plane on a timer, and agent presence transitions are the
same shape of event on the same credential.

**Trigger:** the first time somebody asks why a machine was unreachable, which is
a question this product invites by showing the state at all.

---

## Rate limit the relay's own endpoints

**Now:** `/api/agents/[id]/command` is capped at twenty a minute per account, and
`/agents/presence` and `/agents/command` on the relay are not capped at all. They
both require a scoped token minted by the control plane, so this is not an open
door — but a token is good for thirty seconds, and nothing stops it being spent
as fast as a caller can manage.

**What to do instead:** `apps/relay/src/quota.rs` already holds per-account
counters for connections and bytes, which is where a per-account request rate
belongs.

**Trigger:** any evidence of it mattering, or the first deployment that puts the
relay somewhere an untrusted caller can reach the presence endpoint directly.
