# apps/web — the app and the control plane

Next.js. Serves the marketing pages, the dashboard, authentication, and the
encrypted vault API. It also serves `ssh.wasm`, which is the part that actually
talks SSH.

What it deliberately cannot do is read your data. Hosts, keys and snippets are
encrypted in the browser with a key derived from your password, and the server
stores the ciphertext as an opaque blob. That is why search runs in the tab —
there is nothing on the server to query.

| Path | What lives there |
|---|---|
| `src/lib/keys.ts` | Non-extractable WebCrypto key custody, generation and import |
| `src/lib/vault/` | Split KDF, vault encryption, sync, restore, re-key, recovery codes |
| `src/lib/ssh/` | Session orchestration, host key pinning policy, connect flows |
| `src/lib/transfers/` | Streaming upload and download, USTAR writer |
| `src/lib/audit/` | Event shapes, hostname blinding, activity queries, retention windows |
| `src/lib/recording/` | Session capture, the cast format, the encrypted store, and the share construction — the re-encryption under a per-link key |
| `src/lib/billing/` | Plan limits, tier resolution, the Stripe client, and the local mirror of subscription state |
| `src/app/(auth)/` | Sign-in, sign-up, recovery-code redemption, and the vault-password bootstrap an OAuth account has to go through |
| `src/app/api/` | Auth, vault, devices, audit, recordings, share links, recovery, relay tokens and usage, billing |
| `drizzle/` | Generated SQL migrations — **commit these** |

## Run

```bash
bun install                    # this app has its own lockfile
bun run wasm                   # from the repo root — writes ssh.wasm into public/
bun run --cwd . db:push        # or from the root: bun run db:up first
bun run dev                    # :3000
```

Needs Postgres and the relay. From the repo root:

```bash
docker compose -f compose.yaml up -d postgres
cd apps/relay && cargo run --release    # see apps/relay/README.md for env
```

Without `ssh.wasm` in `public/` the app loads but cannot connect to anything.

## Test

```bash
bun run typecheck    # tsc
bun run lint         # biome: formatting and lint in one pass
bun run lint:fix     # and apply what it can fix
bun test             # audit event shapes, vault merge, recovery codes, recording
                     # format and capture, the share construction, retention
                     # constants, tier resolution, what a failed query is allowed
                     # to log — pure logic only, no database
```

Biome does both formatting and linting; there is no ESLint and no Prettier.
`biome.jsonc` is JSONC rather than JSON so that each disabled rule says why —
a rule switched off with no reason is indistinguishable from one switched off to
make a build pass. Two exclusions worth knowing: `src/components/ui` is shadcn
output, regenerated rather than edited, so linting it only produces changes the
generator will overwrite; and `public/` holds static assets rather than source.

The browser path — connecting, SFTP, pinning, vault sync — has no automated
coverage. Check it by hand against a server you control, over the network.

GitHub sign-in has none at all. The round trip needs a real OAuth app, a browser
and a database, so the callback, the linking refusal and the vault-password
bootstrap have only been reasoned about — exercise them by hand against a test
OAuth app before trusting them.

Passkeys and TOTP are in the same position, and worse in one way: WebAuthn needs
a real authenticator and an origin that matches the relying party, so nothing
about registration, the locked-vault landing or the RP ID pinning is covered by a
test. Exercise them against a deployment whose `BETTER_AUTH_URL` is the URL you
actually open.

Billing has none either beyond `tiers.test.ts`, which covers the pure resolution
rule. Checkout, the portal, the webhook signature check and every write to the
mirror need a real Stripe and a real database; `stripe listen` plus a test-mode
key is the only way to exercise them.

## Database

```bash
bun run db:push       # local development: diffs the schema straight at Postgres
bun run db:generate   # after editing src/lib/db/schema.ts — writes drizzle/*.sql
bun run db:migrate    # applies pending migrations; what the container runs at start
```

`db:push` is for local iteration only. Production applies the committed SQL in
`drizzle/`, so a schema change is not finished until `db:generate` has run and
the result is committed.

## Signing in with GitHub

Two variables, both optional, read once at server start because the provider
list is built when `src/lib/auth.ts` is first imported:

```bash
GITHUB_CLIENT_ID=      # from an OAuth app at github.com/settings/developers
GITHUB_CLIENT_SECRET=  # callback URL: <BETTER_AUTH_URL>/api/auth/callback/github
```

**Leaving them unset is a supported deployment.** The provider is not
registered, the sign-in page renders no button, and there is nothing to press
that could fail. Adding them needs a restart, not a rebuild. There is no
fallback client id, for the same reason there is no fallback Stripe price.

### The part that is not the button

OAuth returns a session and no secret. The vault key is `Argon2id(password)`
split by HKDF, so an account that signed in with GitHub and never typed a
password **has no vault key** — it is authenticated and cannot encrypt a single
host. Nothing in the UI would explain that, and the first place it would surface
is a Save button that could not work.

So a GitHub callback lands on `/set-vault-password`, not on the dashboard, and
`src/app/dashboard/layout.tsx` refuses the dashboard to any account with no
password credential. The page explains why a second secret is needed when you
have just authenticated: GitHub proves who you are, we hold nothing that could
decrypt your data, and the key therefore has to come from something we never
see.

What it stores is the ordinary thing: the derived auth token, set as the
account's password credential through Better Auth's `setPassword`. That is one
code path rather than two — a wrong password fails at unlock exactly as it
already does for password accounts, the re-key, recovery-code and deletion flows
keep working untouched, and the account gains email-and-password sign-in
alongside GitHub. `setPassword` is a server-only endpoint (absent from the HTTP
router by design), so the token makes one hop through a Server Action in
`src/app/(auth)/actions.ts`. It is the same token sign-up sends and it cannot
derive the vault key.

The layout guard is routing, not authorization. Next's partial rendering does
not re-run a layout on a client-side transition between its own children, so it
runs on entry and on full loads; the API routes authorize themselves, and an
account with no password has no key, which is the enforcement that actually
holds.

### Account linking is off

`account.accountLinking.enabled: false`. If an address already has a
password account and someone presses "Continue with GitHub" on it, the callback
refuses with `account_not_linked` and the sign-in form says, in words, that the
password is the way in.

This is a decision, not the default. Better Auth would link implicitly when the
provider reports the email verified *and* the local user is already verified.
GitHub does verify its side. We verify nothing: this app has no mailer and never
sets `emailVerified`, so an address on a local account is not evidence that its
owner controls it — anyone can register `victim@example.com` here today and wait
for the real owner to arrive through GitHub. And an account here is a vault: two
sign-in routes onto one account is two identities in front of one set of
ciphertext, where whoever set the password can read everything. Turning linking
on needs email verification first, not a config edit.

### The salt hazard

`src/lib/vault/kdf.ts` derives the Argon2id salt from the email address, so the
address on the user row is key material. A password sign-up cannot lose it —
the user typed it and nothing in this app changes it afterwards. GitHub can:
the address comes from GitHub and can be changed there without visiting us.

`overrideUserInfoOnSignIn: false` (written out in `src/lib/auth.ts`, though it
is also the default) pins it: the address is captured at registration and a
later GitHub sign-in never updates it. That is the whole mitigation, and it is
narrower than the problem. The salt still comes from whatever address is on the
row rather than from a column that records which address the key was derived
from, so **any** future feature that changes a user's email strands that
account's vault silently. The durable fix is a `vault_salt_email` column written
once at sign-up and read by the KDF; it is not done here because the derivation
must stay byte-identical for every vault already written.

## Passkeys and two-factor

Three ways to authenticate an account — password, passkey, GitHub — and exactly
one way to derive a vault key, which is typing the password. That sentence is the
whole design, and everything below is a consequence of it.

**A passkey never opens the vault, permanently and by choice.** WebAuthn's PRF
extension can return a stable per-credential secret that would wrap a vault key,
which is how a password manager offers passkey unlock. It is not implemented, it
is not being designed toward, and `src/lib/auth.ts` registers the plugin with no
`extensions` block for that reason. Two derivations would mean two answers to
what a password change does, two paths through re-key, and two places for the
zero-knowledge claim to leak. One derivation, one explanation.

The visible cost lands on the user and the UI is responsible for saying so
first: signing in with a passkey types no password, so it derives no key, so the
dashboard it lands on is authenticated and shut. `components/vault-unlock.tsx`
carries the passkey and GitHub explanations in one place so the two cannot
drift — a reload gets the same dialog with no alert, because nothing surprising
happened — and the sign-in form says it under the button before it is pressed
rather than after.

**The RP ID is derived from `BETTER_AUTH_URL`,** not defaulted to `localhost`. A
credential is bound to the relying party at the moment it is created, so a
passkey registered under the wrong ID is not repairable — it simply never matches
again. `origin` is pinned from the same URL, which is what makes the registration
ceremony refuse a request forwarded from elsewhere.

**TOTP is enrolled only after a code from it has been checked,** and backup codes
are encrypted at rest (`storeBackupCodes: "encrypted"`), which is not the
default — better-auth 1.6 stores them as plain JSON otherwise, and a backup code
is a sign-in in text form. That puts them behind the database *and*
`BETTER_AUTH_SECRET`, the same bar as the TOTP secret. It is not the bar the
vault sits behind and cannot be: verifying a code means reading it back.

**The enrolment control is gated on the schema, and it now passes.** For a
while it did not: `two_factor` was created with `(id, user_id, secret,
backup_codes)`, while the installed plugin also writes `verified`,
`failed_verification_count` and `locked_until`, and the drizzle adapter refuses
an insert naming a column its table does not have — so enabling TOTP answered
500 and the feature was unreachable. Migration `0008` added the three columns.
`totpStorageReady()` still checks at module load and the Settings card still
renders disabled and names what is missing when it fails, because that check is
what turned a silent 500 into a stated reason, and the next plugin upgrade that
adds a column will land the same way. It does not check that the migration has
been *applied* — a schema with the columns and a database without them passes
here and fails at the insert, which `bun run db:migrate` fixes.

**A recovery code does not answer a second factor.** Redemption decrypts locally
and then signs in through `/sign-in/email`, which is challenged like any other
sign-in, and `/recover` has no field for the code — while the sealed copy is
consumed when the server hands it over. So on a TOTP-enrolled account a redeemed
code opens the vault, fails the sign-in, and is spent.
`signInWithRecoveredToken` refuses in those words, and the two-factor card warns
before enrolment rather than after. A second-factor step on `/recover` is the
fix and is not built.

Changes to either factor are audited server-side by a Better Auth `after` hook in
`src/lib/auth.ts`, not by the browser: these rows are the record of who can sign
in as this person, so a client allowed to post them could write a plausible
history around a factor it had just added for itself.

## Billing

Two tiers, one price, no quantity. Free and Pro; Pro is a flat monthly
subscription, one per account. Accounts are personal — there are no
organizations, no members and no seats, so there is nothing to multiply a price
by.

Stripe owns whether an account is paid. The `subscription` table is a mirror of
that answer, not a second source of truth, because the question is asked on
paths that cannot afford an API call: every relay token mint, every audit query,
every attempt to save a recording.

```
src/lib/billing/tiers.ts         Limits per tier, and tierForSubscription() —
                                 the whole resolution rule, pure and tested.
                                 Imports no database, so /pricing and the
                                 landing page can quote a limit without
                                 dragging a connection pool behind them.
src/lib/billing/subscription.ts  The per-user lookups and every write to the
                                 mirror. This is the file that opens Postgres.
src/lib/billing/stripe.ts        The configured SDK client and the three
                                 environment variables, each of which fails
                                 loudly and by name when unset.
src/lib/billing/client.ts        The browser's half: the plan a tab has been
                                 told, and the two buttons that go to Stripe.
```

Three variables, all optional, all read at request time so adding them needs a
restart rather than a rebuild:

```bash
STRIPE_SECRET_KEY=      # server-side API key
STRIPE_PRICE_PRO=       # the recurring Price object Pro is charged against
STRIPE_WEBHOOK_SECRET=  # verifies /api/billing/webhook deliveries
```

**Leaving them unset is a supported deployment.** The plan card in Settings says
nothing can be bought here and offers no upgrade button; nothing 500s, and
nothing is silently granted or denied. There is deliberately no fallback price
id: with `STRIPE_PRICE_PRO` unset, checkout refuses and names the variable
rather than charging against something compiled into the image.

The two variables are checked together for *selling* only. The billing portal
needs neither the price nor the webhook secret, so its button stays on screen
for anyone who has a Stripe customer whatever else is unset — an existing
subscriber must never lose the route to cancelling because an operator cleared
a variable while repricing.

`POST /api/billing/checkout` refuses to sell a second subscription to the same
person twice: once from the mirror, which is free and catches the ordinary case,
and once by asking Stripe for that customer's subscriptions, which catches two
checkouts started before any webhook has landed. A narrow window survives
between that call and two completed card forms; closing it properly means
reconciling in the webhook, which is not built.

The price *amount* lives in Stripe. `PRO_PRICE_USD` in `src/lib/billing/tiers.ts`
is what `/pricing` prints, and nothing checks the two agree — no test can, since
the app never reads the Price object's amount. Change them in the same commit.

### Which way it fails

Toward access, everywhere, and on purpose. A subscription table that cannot be
read grants Pro and logs it: refusing paid features across the site because one
query timed out is worse than a few minutes of unpaid access. `past_due` and
`unpaid` keep granting until `current_period_end`, because those are cards still
being retried and cutting somebody off mid-retry costs them their servers over a
payment that usually succeeds. `current_period_end` bounds those — a stale row
carrying a date cannot grant past it.

`active` and `trialing` have no date to check, so nothing bounds them and the
ordering of writes has to. Each row carries `last_event_at`, Stripe's own
timestamp for the event it was written from, and `mirrorSubscription` refuses a
delivery older than the one already applied. Without that, a redelivered
`active` landing after a `canceled` — which the retry below makes routine —
would grant Pro with nothing left to take it back.

The one place that does *not* fail toward access is account deletion. Deleting a
user cascades the subscription row away, so `user.deleteUser.beforeDelete` in
`src/lib/auth.ts` cancels the subscription at Stripe first, immediately, and
aborts the deletion if Stripe cannot be reached. Making somebody retry is a
smaller harm than destroying the last local record of a live charge.

### The webhook

`POST /api/billing/webhook` is the only unauthenticated write path in the app.
Its signature check is the entire security model, so:

- The **raw** request body is verified. `request.text()`, never `request.json()`
  re-serialised — `JSON.stringify` does not reproduce Stripe's byte-for-byte
  encoding and every delivery would fail with what looks like a wrong secret.
- The event id is inserted into `stripe_event` **before** anything is processed.
  The primary key is the deduplication. On a processing failure the marker is
  deleted again and the response is 500, so Stripe retries.
- Events the app deliberately ignores are answered 200. A non-2xx makes Stripe
  retry for days.

Deduplication is by event id and stops the *same* event twice. It does nothing
about two different events arriving in the wrong order, which the retry above
makes likely — that is what `last_event_at` is for, and a delivery older than
the row is logged and dropped.

One customer with two subscriptions is the other case the mirror has to survive,
since the table holds one row per user. A write naming a different subscription
than the row carries is refused when it would take access away and the mirrored
subscription still grants — checked against Stripe, because the row is the thing
in doubt. Nothing merges the two or cancels the surplus one; the refusal only
stops a cancellation of the abandoned subscription from downgrading an account
that is still paying. That needs a person, and it is logged as an error.

Nothing prunes `stripe_event`. It is one narrow row per delivery and no
retention was invented for it here.

Set the endpoint up in Stripe against these event types:

```
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.payment_failed
```

Locally, `stripe listen --forward-to localhost:3000/api/billing/webhook` prints
its own signing secret, which is not the dashboard endpoint's.

### The recording gate

Saving a **new** recording is the Pro feature. `POST /api/recordings` and
`POST /api/recordings/[id]/shares` refuse with 402 on Free; the browser checks
first (`lib/recording/capture.ts`) so nobody records for ten minutes and finds
out at the end. Listing, playing, downloading and revoking are ungated in the
routes and must stay that way — a recording is the user's own data, encrypted
with a key this server has never held, and holding it behind a payment would
mean ransoming something we cannot read. An unsaved transcript can also be
downloaded straight out of the tab, which is the way out when a save is refused.

## Audit retention

The activity log keeps 30 days on Free and 12 months on Pro, and that is now a
real difference rather than two numbers with one reachable. The windows live in
`src/lib/audit/retention.ts`, next to the query and the pruner that enforce them;
which tier an account is on comes from `src/lib/billing/subscription.ts`, which
is also where the relay transfer allowance is resolved. One resolver for both,
because a tier that means 30 days to the audit log and 5 GB to the relay is
worse than no tier at all.

The browser is told the window rather than working it out. `GET /api/audit`
states `retention.tier`, `retention.days` and `retention.since` on every
response and the Activity page renders those; a tab knows which account it is
signed into and nothing about what that account pays, so a locally resolved
window would show 12 months to a Free account on the first render.

Two places enforce the window, and they need each other:

- `GET /api/audit` never returns a row older than the cutoff. This is what makes
  the retention figure on the Activity page true at any given moment, including
  the moment after a missed cron run.
- `lib/maintenance/audit.ts` deletes them. Real `DELETE`, no soft-delete flag —
  the page tells users the events are gone, so they have to be gone. It runs
  from the scheduled maintenance below, in bounded batches so a large table is
  never locked for long, and is safe to run repeatedly and concurrently with the
  app.

**The pruner deliberately over-keeps.** It chooses a window by whether the
account has a `subscription` row at all — any row, whatever its status, however
long ago it lapsed — rather than re-deriving `tierForSubscription`, which also
weighs status and period end. Transcribing that rule into SQL would be a second
copy of it with row deletion as the failure mode. Somebody who subscribed once
and cancelled a year ago therefore keeps twelve months of rows on disk rather
than thirty days, invisible through the app because `GET /api/audit` still
filters on read. The asymmetry is the point: over-keeping is recoverable,
over-deleting is not. `retention.test.ts` pins it so it is not later tidied into
"correctness".

## Scheduled maintenance

Four jobs, one route, one implementation:

| | |
|---|---|
| `audit-events` | rows past their retention window |
| `agent-enrollments` | tokens minted and never used, an hour past expiry |
| `rate-limit-counters` | buckets whose window closed a day ago |
| `recording-objects` | objects in the bucket that no row claims |

```bash
curl -X POST -H "authorization: Bearer $CRON_SECRET" https://your-app/api/cron
curl -X POST -H "authorization: Bearer $CRON_SECRET" 'https://your-app/api/cron?dryRun=1'
```

`compose.prod.yaml` ships a `cron` service that does exactly this on a schedule
— busybox `crond` and `wget`, both already in the alpine base image — so a
self-hosted deployment schedules itself. Set `CRON_SECRET`; everything else has
a default. A serverless deployment has no such container and needs an external
scheduler pointed at the same route.

Blank `CRON_SECRET` means the route answers 503 to everyone and nothing is ever
pruned. That is deliberate: an endpoint that deletes rows must not become
reachable because a variable was forgotten.

**This used to be two node scripts and never ran anywhere**, because scheduling
them meant an operator writing a crontab line for a machine this repo has never
seen. Moving the work into `src/lib/maintenance/` also deleted two duplications
that existed only because a plain script cannot import from `src/`: a second
copy of the audit retention windows, guarded by a test that read a script as
*text* to compare number literals, and a second complete implementation of AWS
SigV4, guarded by a test that signed the same five requests with both signers
and compared the headers. Both are gone.

Each job is caught separately — an unreachable bucket must not stop audit rows
being pruned — and each is bounded, with truncation reported rather than
swallowed, because a job that quietly stopped early reads as "nothing left to
do". Every job deletes only what is already unreferenced or already outside a
window, so a second run finds less to do and concurrent runs duplicate effort
rather than cause harm. There is no lock, deliberately: a lock is a thing that
can be held by a process that died.

## Rate limits

`src/lib/rate-limit.ts` is the only limiter, and Better Auth is driven through
it via `customStorage` so `/api/auth/*` and this app's own routes cannot drift
into two algorithms. Counters are rows in `rate_limit`, keyed
`<bucket>:<subject>`.

In Postgres rather than in a `Map`, which is what `/api/recovery` used to have.
A process-local limiter has two failures that never show up in testing: a second
container gets a second budget, so scaling out multiplies every limit by the
replica count, and a restart forgets everything, so the limiter is a redeploy
away from being off.

The window is fixed, anchored at the first request in it. Better Auth's own
database backend slides that timestamp forward on every *allowed* request, which
means a caller drip-feeding below the limit still accumulates count until they
are blocked — defensible, and not what a reader of the config would predict, so
it is replaced rather than configured.

The subject, in descending order of trust: a user id when there is a session; a
truncated network when `TRUSTED_PROXY_HOPS` says which `X-Forwarded-For` entry
your own proxy wrote; otherwise **one bucket shared by everybody**. That last
case is trippable by a stranger and is still the right way round — keying on a
header the caller writes hands every caller a private budget, which is the bug
that made the old recovery limiter decorative. Better Auth needs the same fact
as a list of proxy addresses (`TRUSTED_PROXY_IPS`) rather than a hop count, and
neither form derives from the other, so both variables exist.

Everything **fails open**. If the table is unreachable the request proceeds and
the failure is logged: none of these limits are what makes anything secure — a
share token is 256 bits and a recovery code 120 — so trading a bounded abuse
problem for a total outage would be the wrong way round.

```bash
node scripts/check-rate-limit.mjs      # needs the app running and DATABASE_URL
```

`src/lib/rate-limit.test.ts` covers which subject gets counted and what a
refusal looks like. It cannot cover `consume`, whose entire correctness is one
SQL statement — the window arithmetic and its atomicity — and a mock would only
assert that a string matches itself. The script above is the check for that: it
drives the real statement against real Postgres, including ten concurrent
requests against a limit of three, which is exactly the burst a read-then-write
limiter lets through. It then drives the running app to confirm sign-in turns
from `401` into `429` and share fetches turn from `404` into `429`.

Stale counters are one of the scheduled maintenance jobs above, so they are
swept on the same cadence as everything else.

## Orphaned recording objects

Only relevant when `R2_*` is configured and recordings live in a bucket rather
than in a `bytea` column. The sweep is one of the four scheduled maintenance
jobs above; this is why it has to exist.

There is no transaction spanning Postgres and a bucket, so every write to a
recording is two steps and either can fail. The ordering is picked so that a
half-failure always leaves the same shape — an object that no row claims:

- Creating writes the object first and the row second. The reverse would leave a
  row pointing at bytes that were never written, which is a recording in
  somebody's list that cannot be played. An orphan is invisible and merely costs
  storage.
- Deleting destroys the object first and the row second, and refuses outright if
  the object cannot be destroyed. Reporting a successful delete over ciphertext
  still sitting in a bucket is the one outcome that must not happen, because the
  row was the last thing that knew whose it was.

The routes clean up after themselves — a failed insert takes its object back
out. The case they cannot cover is an account deletion whose purge could not
reach the bucket, because by then the rows are already gone.

`lib/maintenance/objects.ts` reads both `recording` and `recording_share` before
it lists the bucket — a share's copy is its own object, and a sweep that read
only the first table would delete every live link's bytes. It reads the database
first and the bucket second on purpose: an object written between the two reads
is missing from the claimed set and looks like an orphan, and the one-hour grace
window is what makes that harmless, so reading in this order keeps the window the
only thing that has to be right.

## Share links

`GET /api/shares/[token]` is the only route in this app that authorizes nobody.
It reads no cookie and never learns who is asking; the token in the path is what
stands in for authorization, and the decryption key is in the link's fragment,
which browsers do not transmit. What it serves is not `recording.ciphertext` but
a second blob the owner's tab produced by re-encrypting one transcript under a
key generated for that link alone — `src/lib/recording/share.ts`.

The owner's side is `/api/recordings/[id]/shares`, which authenticates like every
other owner route and never accepts a token as identity. Expiry, view limit and
revocation are all checked in the single conditional `UPDATE ... RETURNING` that
also increments the view counter, so a limit of one cannot be spent twice by two
viewers arriving together. Every refusal answers 404 with the same body.

Nothing rate-limits that route, which `docs/THREAT-MODEL.md` §7 lists alongside
the other outstanding IP-level limits. Nothing prunes expired shares either: an
expired link stops being served immediately, but its ciphertext stays on disk
until the owner revokes the share or deletes the recording.

## Relay transfer accounting

The relay counts the bytes it forwards per account and POSTs batches to
`POST /api/relay/usage`, which accumulates them into `relay_usage` keyed by
account and by `YYYY-MM` in UTC. `POST /api/relay-token` reads that total and
refuses with `402` once an account is over its monthly allowance
(`RELAY_ALLOWANCE_BYTES` in `src/lib/billing/tiers.ts` — 1 GB on Free). The
refusal is at token mint, never in the forwarding loop, so a session already
running is never cut at a byte boundary; only new connections stop.

This side needs one variable:

```bash
RELAY_USAGE_SECRET=   # bearer token the relay presents. Must match the relay's copy
```

It is deliberately not `RELAY_SECRET`. That one signs connection tokens and is
never transmitted; this one travels in a header on every flush and will end up
in a proxy log. The relay's half — `RELAY_USAGE_URL`, the same secret, and the
flush interval — is in [`apps/relay/README.md`](../relay/README.md).

**Unset means nothing is counted.** The `POST` returns 401 to everyone, no usage
is ever recorded, and no connection is ever refused for transfer. That is the
right default for a relay you run yourself, and the meter on the Settings page
says so on screen rather than showing a zero that reads like reassurance. The
check also fails open if `relay_usage` cannot be read at all: refusing every
connection because one query timed out is worse than some unmetered transfer
during an incident.

Nothing prunes `relay_usage`. It is one small row per account per month, and no
retention was invented for it here.

## Build the image

From the repo root, since the Dockerfile expects that context:

```bash
docker build -f apps/web/Dockerfile -t weirdvault-web .
```

The image builds `ssh.wasm` itself in a Go stage, so it never ships a stale one.
It migrates the database at container start, before the server binds — see
`entrypoint.sh`.

`NEXT_PUBLIC_RELAY_URL` is inlined at build time, so changing the relay URL
means a rebuild, not a restart.
