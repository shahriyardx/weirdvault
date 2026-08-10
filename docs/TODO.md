# TODO

Work that is understood and deliberately not done yet. Each entry says what the
current state is, what should replace it, and what triggers the change — an
entry with no trigger is a wish, not a task.

Kept short on purpose. A list of everything that could ever be improved is a
list nobody reads; what belongs here is work that will bite.

---

## Record that a connection happened

**Now:** `audit_event` has `connection.opened` and `connection.closed` in its
catalogue, with metadata validators, and **nothing emits them**. So the Activity
page shows device registrations, recovery-code use, host keys pinned and keys
installed — everything except the thing anyone would look for first. "Who
connected to which host, when" is recorded nowhere.

**Why this one is not optional.** `README.md` says, in the list of what you get:
"A record of what happened. Every connection, key and device, in one place,
readable only by you." Connections are not in that record. Either the log gains
them or the sentence loses them, and shipping the sentence first is the wrong
order.

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

Agent presence transitions — "it dropped at 3am and came back" — are the same
channel and worth doing in the same pass.

**Trigger:** fired. The README already promises it.

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

## Rotate the command signing key

**Now:** `AGENT_COMMAND_SECRET` signs every instruction the dashboard sends a
machine, and each identity holds its public half in `commandKeys` — a list,
already, so that this is not a config migration when it arrives. There is no way
to change it. Rotating today means re-enrolling every machine.

**What to do instead:** a `rotate-key` command, signed by a *current* key, that
appends a new one to `commandKeys`. Signed by the old key is what makes it safe:
the agent already knows how to check that, and the relay still cannot invent one.

**Trigger:** the first time a key has to change — a leak, or a deployment
splitting in two. "You cannot" is an unpleasant answer to give on that day.
