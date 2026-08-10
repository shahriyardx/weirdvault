# Deploying weirdvault

Three pieces, and one of them constrains everything else.

```
  browser ──wss──▶  relay  ──tcp:22──▶  your servers
     │                (Rust, stateless)
     └──https──▶  web  ──▶  Postgres
                  (Next.js control plane)
```

**The relay cannot be serverless.** It holds long-lived WebSockets bridged to
raw TCP. Vercel, Cloudflare Workers, Lambda, and every other function runtime
can do neither. It needs a real process on a real host: Fly.io, Railway, Render,
a VM, or Kubernetes.

The web app is an ordinary Next.js deployment and can go on Vercel if you like,
provided it shares `RELAY_SECRET` with the relay.

---

## Option A — self-host everything

The whole product on one machine. This is what removes relay metadata exposure:
run it on your own network and no third party learns which hosts you connect to.

```bash
cp .env.example .env
# fill in the secrets, then:
openssl rand -base64 48        # BETTER_AUTH_SECRET
openssl rand -base64 48        # RELAY_SECRET
openssl rand -base64 32        # POSTGRES_PASSWORD

docker compose -f compose.prod.yaml up -d --build
```

The schema is applied by the web container as it starts, so there is no
migration step to remember and no window where the code is newer than the
database.

Then put TLS in front. Both services speak plain HTTP, and **browsers refuse a
plaintext WebSocket from an https page** — so if the app is on https, the relay
must be on wss. Caddy makes this two lines:

```
weirdvault.example.com     { reverse_proxy localhost:3000 }
relay.weirdvault.example.com { reverse_proxy localhost:8080 }
```

nginx needs the upgrade headers spelled out:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;   # SSH sessions idle for long stretches
    proxy_send_timeout 3600s;
}
```

That `proxy_read_timeout` matters. The default 60s will silently drop idle SSH
sessions, and it will look like a weirdvault bug.

`deploy/nginx/` has a working config for a single hostname serving both the app
and the relay. The Cloudflare real-IP handling is a **separate** file on
purpose: `real_ip_header` may be declared only once per nginx, and on a server
that already has it — from another site, or a global include — a second
declaration is not a warning but "directive is duplicate", and nginx refuses to
start. Install `cloudflare-realip.conf` only if nothing else sets it.

Once a proxy is in front, set `TRUSTED_PROXY_HOPS` to the number of proxies
between the internet and the web container — `1` for the Caddy or nginx block
above, `2` if a CDN sits in front of that — and `TRUSTED_PROXY_IPS` to the
addresses those proxies connect from (`172.16.0.0/12` for a container network,
`127.0.0.1` for a proxy on the host). Until both are set, the app records no
client address on any audit row and every unauthenticated rate limit shares one
bucket for everybody, which a single caller can trip for everyone.

Two variables for one fact because the two consumers want it in different
shapes: the app's own limits and the audit log count hops from the right-hand
end, Better Auth matches proxy addresses. Neither is derivable from the other.

That is deliberate. `X-Forwarded-For` is written by whoever sends the request,
and every proxy in normal use *appends* to it, so the left-most entry is a value
the caller chose. Reading it would put an attacker-supplied network into the
audit log — including on `recovery.redeemed`, the one row that says somebody got
in without the password — and would hand every caller a private rate-limit
budget. The hop count is what says which entry your own proxy wrote. Set it too
high and you are back to reading a forgeable entry, so if you are unsure, leave
it unset: an empty address field is honest, a wrong one is not.

---

## Option B — web on Vercel, relay on Fly.io

```bash
# relay
fly launch --dockerfile apps/relay/Dockerfile --no-deploy
fly secrets set RELAY_SECRET=...
fly deploy

# web
vercel --prod
```

Set on Vercel:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon, Supabase, or RDS |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 48` |
| `BETTER_AUTH_URL` | `https://your-app` |
| `RELAY_SECRET` | **must match the relay exactly** |
| `RELAY_AGENT_SECRET` | **must match the relay exactly.** Blank means machines with no public address cannot be enrolled at all — the relay refuses agent connections and the dashboard says so rather than minting a token for an agent that could never connect |
| `NEXT_PUBLIC_RELAY_URL` | `wss://your-relay/ws` |
| `AGENT_RELEASE_BASE_URL` | Where agent binaries are published. Defaults to `<your origin>/agent-bin`, which is what `bun run agent` writes — set it if you serve them from a release host instead |
| `TRUSTED_PROXY_HOPS` | `1` on Vercel — its edge appends the client address |
| `TRUSTED_PROXY_IPS` | The addresses those proxies connect from |

Everything else, and what each one means when left blank, is in
[Configuration](#configuration).

`NEXT_PUBLIC_*` is inlined at build time, so changing the relay URL means a
rebuild, not a restart.

Migrations ship inside the web image and run at container start, before it
serves a request. To apply them from elsewhere — CI, or a machine with a tunnel
open — point `DATABASE_URL` at the database and run
`bun run --cwd apps/web db:migrate`. It is idempotent: already-applied
migrations are recorded in a `__migrations` table and skipped.

Schema changes are made by editing `src/lib/db/schema.ts` and running
`bun run --cwd apps/web db:generate`, which writes a new SQL file under
`apps/web/drizzle/`. **Commit it.** The generated files are the migration
history; without them, an upgrade has no way to tell a fresh database from one
that is three versions behind. `db:push` diffs the schema straight against a
live database and is for local development only.

---

## Configuration

`.env.example` is the template; this is what each variable means. Everything is
read at runtime except `NEXT_PUBLIC_RELAY_URL`, which is inlined into the
browser bundle at build time — changing that one needs `docker compose build
web`, not a restart.

### Where each value comes from

Five are random secrets. Generate each one **separately** — reusing one value
across two of them collapses their blast radii into one:

```bash
openssl rand -base64 48    # BETTER_AUTH_SECRET
openssl rand -base64 48    # RELAY_SECRET          — same value on web and relay
openssl rand -base64 48    # CRON_SECRET
openssl rand -base64 48    # RELAY_USAGE_SECRET    — optional
openssl rand -base64 48    # RELAY_AGENT_SECRET    — optional
openssl rand -base64 32    # POSTGRES_PASSWORD
```

The rest you look up or decide:

| | |
|---|---|
| `DATABASE_URL` | Write it out with the password above: `postgres://weirdvault:<POSTGRES_PASSWORD>@postgres:5432/weirdvault` |
| `BETTER_AUTH_URL` | Your app's URL, e.g. `https://weirdvault.example.com` |
| `NEXT_PUBLIC_RELAY_URL` | `wss://<relay host>/ws`, or `wss://<your app>/ws` if you route `/ws` to the relay on one origin |
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys (`sk_live_…`) |
| `STRIPE_PRICE_PRO` | Stripe → Products → your recurring price (`price_…`). It must be recurring; checkout runs in subscription mode |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Developers → Webhooks → your endpoint (`whsec_…`). Each endpoint has its own, and `stripe listen` prints a different one again |
| `GITHUB_CLIENT_ID` / `_SECRET` | github.com/settings/developers, callback `<BETTER_AUTH_URL>/api/auth/callback/github` |
| `R2_ENDPOINT` | Cloudflare → R2 → your bucket → Settings → S3 API (`https://<account-id>.r2.cloudflarestorage.com`) |
| `R2_BUCKET` | The bucket name |
| `R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | Cloudflare → R2 → Manage API tokens → **Object Read & Write**, scoped to that bucket alone |
| `R2_REGION` | Leave blank for R2. Set it for MinIO, Ceph or S3, where it is part of the signature |
| `TRUSTED_PROXY_HOPS` | Count the proxies between the internet and the app: `1` behind one reverse proxy, `2` with a CDN in front |
| `TRUSTED_PROXY_IPS` | The address your proxy connects *from*: `172.16.0.0/12` for a container network, `127.0.0.1` for a proxy on the host |
| `AGENT_RELEASE_BASE_URL` | Leave blank unless you serve the agent binaries from somewhere other than your own origin |

### Required

| Variable | |
|---|---|
| `BETTER_AUTH_SECRET` | Signs session cookies. Rotating it signs everyone out |
| `RELAY_SECRET` | Shared with the relay. The control plane signs a token naming the exact host and port; the relay verifies it. **If these two do not match, every connection is refused with 401** |
| `POSTGRES_PASSWORD` | |
| `DATABASE_URL` | Written out rather than assembled from `POSTGRES_*`, because `env_file` does no interpolation. Keep the password in step with the one above |
| `BETTER_AUTH_URL` | Where users reach the app |
| `NEXT_PUBLIC_RELAY_URL` | Where the browser reaches the relay. **Must be `wss://` if the app is `https://`** — browsers refuse a plaintext WebSocket from a secure page |
| `CRON_SECRET` | Bearer token for `POST /api/cron`. Blank means scheduled cleanup never runs |

### Optional — blank switches the feature off

Blank is a supported deployment for every one of these. Nothing 500s and nothing
is silently granted: the app says on screen that the feature is not configured
rather than showing a control that fails when pressed.

| Variable | Blank means |
|---|---|
| `RELAY_USAGE_SECRET` | Bytes are counted in memory and discarded; the monthly transfer allowance is never enforced. The right default for a relay you host — the cap exists because relay bandwidth costs the hosted deployment money, and bandwidth you already pay for is not ours to ration |
| `RELAY_AGENT_SECRET` | Machines with no public address cannot be enrolled. The relay refuses agent connections and the dashboard says so, rather than minting a token for an agent that could never connect |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`, `STRIPE_WEBHOOK_SECRET` | Nothing is sold. Every account is whatever the `subscription` table says, which on an install that has never taken a payment is Free. **All three or none** — with the webhook secret missing, checkout would work and no subscription would ever be recorded |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | No "Continue with GitHub" button. Register the app with callback `<BETTER_AUTH_URL>/api/auth/callback/github` |
| `R2_*` (four, plus optional `R2_REGION`) | Recordings are stored as a `bytea` column in Postgres. **All four or none** — three of four is a typo and is treated as one. See [Recording storage](#recording-storage) |
| `TRUSTED_PROXY_HOPS`, `TRUSTED_PROXY_IPS` | No client address is recorded on any audit row, and every unauthenticated rate limit shares one bucket that any caller can spend for everybody. Set both once a proxy is in front |
| `AGENT_RELEASE_BASE_URL` | Agent binaries are served from `<your origin>/agent-bin`, which is what `bun run agent` writes |
| `AGENT_VERSION` | Defaults to `dev`, and then no agent in the field ever self-updates: a machine updates when the manifest's value **differs** from its own, and `dev` never differs from `dev`. Set it per release. See [Agent versions](#agent-versions) |

### Agent versions

`AGENT_VERSION` is stamped into the agent binaries (`main.version`) and into the
`manifest.json` beside them, from one build arg in one Docker stage — so the
binary and the manifest cannot disagree about what they are.

An agent checks it once, at startup: it fetches the manifest and replaces itself
if the version there **differs** from its own. Differs, not exceeds. These are
build identifiers rather than an ordering, and inventing a comparison for them
would be inventing a wrong one — which also means a rollback pulls agents back,
deliberately.

Two consequences worth planning around:

- **Bump it when you ship a new agent, and not otherwise.** Wiring it to the
  commit hash means every web-only redeploy hands every machine a new binary to
  download and re-exec into, for no change at all.
- **It only takes effect on an agent restart.** `selfUpdate` runs before the
  control connection opens, so nothing is replaced mid-session — and a machine
  that stays up for months is running whatever it was installed with until
  something restarts it. `systemctl restart weirdvault-agent`, or a reboot.

Tag the release too, so the string points at a commit:

```bash
git tag -a v1.0.0 -m "v1.0.0" && git push --tags
```

Nothing enforces that the tag and `AGENT_VERSION` match. If they drift, the
version an agent reports is a label that leads nowhere.

**Why three separate relay secrets.** `RELAY_SECRET` is an HMAC signing key that
is never transmitted, and whose compromise turns the relay into an open proxy.
`RELAY_USAGE_SECRET` and `RELAY_AGENT_SECRET` are bearer tokens that travel on
the wire on every call and will end up in a proxy log somewhere. Different
lifetimes, different blast radii — and separating usage from agents means
turning one on cannot silently turn the other on. `CRON_SECRET` is a fourth for
the same reason.

### Defaults

| Variable | Default | |
|---|---|---|
| `POSTGRES_USER`, `POSTGRES_DB` | `weirdvault` | |
| `WEB_PORT`, `RELAY_PORT` | `3000`, `8080` | Published on the host |
| `RELAY_PORTS` | `22` | Destination port allowlist. Every extra port widens what the relay can be aimed at |
| `CRON_SCHEDULE` | `15 4 * * *` | Read only by the `cron` service |
| `RELAY_USAGE_INTERVAL_SECS` | `60` | Also the most one failed flush can lose — a batch that cannot be delivered is dropped rather than retried |
| `RUST_LOG` | `weirdvault_relay=info` | |

`RELAY_ALLOW_PRIVATE` is deliberately absent from the template. It disables the
SSRF guard; see the production checklist.

---

## Recording storage

Session recordings are the one thing this app stores that is measured in
megabytes. By default the encrypted blob is a `bytea` column, and for a
self-hosted install that is the right answer: the recordings are in the backup
you already take, deleting one is a foreign key rather than a reconciliation
job, and there is nothing to sweep.

Set all four `R2_*` variables and new recordings go to a bucket instead, leaving
the row with its metadata and an object key. What that buys is a `pg_dump` whose
size tracks data volume rather than recording volume — which is a hosted
deployment's problem and not a home server's.

```bash
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com   # the bucket's S3 API endpoint
R2_BUCKET=weirdvault-recordings
R2_ACCESS_KEY_ID=...        # an API token scoped to Object Read & Write, this bucket only
R2_SECRET_ACCESS_KEY=...
```

Any S3-compatible endpoint works — MinIO, Ceph, S3 itself — in which case set
`R2_REGION` too, since it is part of the signature and a wrong one is a 403. R2
has one region and it defaults to `auto`.

Three things to get right, in descending order of how badly they go wrong:

- **The bucket must have no public URL.** Not the `r2.dev` development
  subdomain, not a custom domain. Neither is on by default and neither should be
  turned on. Objects are fetched by the server with these credentials and
  proxied to the browser through a route that has already checked who is asking;
  there is no presigned-URL path anywhere in the codebase, deliberately.
- **Set all four or none.** Three of four is a typo, and it is treated as one:
  the app names the missing variable at startup and keeps writing to Postgres,
  rather than quietly doing that on a deployment whose operator believes
  otherwise.
- **Give the token the narrowest scope that works.** Object Read & Write on this
  bucket. It never needs to create a bucket or see any other one.

Switching it on is not a migration. Rows written before and after are both
readable, in both directions, so old recordings keep playing and turning it back
off does not strand anything. Nothing backfills, either — existing blobs stay in
Postgres until they are deleted.

**Orphans.** There is no transaction spanning Postgres and a bucket, so every
write is two steps. The ordering is chosen so a half-failure always leaves an
object nothing points at rather than a row pointing at nothing: an orphan costs
storage and is findable, a dangling row is a recording that cannot be played.
The routes clean up after themselves, and the one case they cannot is an account
deletion whose purge could not reach the bucket — the rows are already gone by
then. The scheduled maintenance sweep deletes objects no row claims — see
below — and skips anything written in the last hour, so a save in flight is
never mistaken for an orphan.

**Deleting an account** cancels the Stripe subscription first — if that fails,
the deletion is refused rather than leaving a charge running with no way to
reach it — then deletes the rows, then purges `rec/<user-id>/` and
`share/<user-id>/` from the bucket. A purge that fails leaves orphans for the
sweep; it does not fail the deletion, because there is no account left to refuse
on behalf of.

---

## Scheduled maintenance

Four things have to be removed on a timer, and none of them are optional once
the app has been running for a while:

| | |
|---|---|
| Audit rows past their retention window | 30 days, or 12 months with a subscription |
| Abandoned enrollment tokens | minted for "Add a machine" and never used |
| Stale rate-limit counters | one row per bucket, so the table grows with callers |
| Orphaned recording objects | in the bucket, claimed by no row — these cost money |

`POST /api/cron` does all four. **`compose.prod.yaml` ships a `cron` service that
calls it**, so a self-hosted deployment schedules itself and the only thing to
set is `CRON_SECRET`:

```bash
openssl rand -base64 48        # CRON_SECRET
# optional, default 04:15 daily:
CRON_SCHEDULE="15 4 * * *"
```

It is busybox `crond` and `wget` in the alpine base image — nothing to install,
no network needed to start — and `docker compose logs cron` shows the report
from each run. To use something else instead (a systemd timer, a crontab on the
host, Upstash, a GitHub Action), delete the service and POST to the same route:

```bash
curl -X POST -H "authorization: Bearer $CRON_SECRET" https://your-app/api/cron
curl -X POST -H "authorization: Bearer $CRON_SECRET" 'https://your-app/api/cron?dryRun=1'
```

On Vercel there is no cron container, so an external scheduler is the only
option and this is the route to point it at.

`?dryRun=1` counts what each job would do and changes nothing — worth running
once against real data before letting a schedule loose on it.

**Blank `CRON_SECRET` means the route answers 503 to everybody and nothing is
ever pruned.** That is deliberate: an endpoint that deletes rows must not become
reachable because a variable was forgotten. It is its own secret rather than a
reuse of `RELAY_SECRET` or `BETTER_AUTH_SECRET`, because it travels on the wire
on every invocation and will end up in a proxy log; those two are signing keys
that are never transmitted.

Every job is bounded, reports when it stopped short, and is safe to run twice —
they delete only what is already unreferenced or already outside a window. A job
that fails does not stop the others, and the response is a 500 so a scheduler
with retries notices.

---

## Production checklist

Ordered by how badly it goes wrong if you skip it.

- [ ] **`RELAY_ALLOW_PRIVATE` is not set.** It disables the SSRF guard. On a
      publicly reachable relay this turns it into an open proxy into whatever
      network it sits on — including cloud metadata endpoints. The compose file
      omits it deliberately.
- [ ] **`RELAY_SECRET` matches** between web and relay. If it doesn't, every
      connection is rejected with 401 and the browser reports something vague.
- [ ] **The relay has no cloud IAM role attached.** It dials arbitrary hosts by
      design; it should have no credentials worth stealing.
- [ ] **`RELAY_PORTS` is as narrow as you can stand.** Default `22`. Each extra
      port widens what the relay can be aimed at.
- [ ] **TLS on both**, with a websocket-aware proxy and a long read timeout.
- [ ] **Postgres is not published to the host.** The compose file uses `expose`,
      not `ports`, for exactly this reason.
- [ ] **`CRON_SECRET` is set**, or nothing is ever pruned: audit rows accumulate
      past the window the app promises on screen, and orphaned recording objects
      accumulate in a bucket you pay for.
- [ ] **`TRUSTED_PROXY_HOPS` and `TRUSTED_PROXY_IPS` are both set** once a proxy
      is in front. Without them every unauthenticated rate limit — sign-up,
      sign-in, share links, agent enrollment, recovery codes — shares a single
      bucket that one caller can spend for everybody.
- [ ] **The recordings bucket has no public URL**, if you configured one. No
      `r2.dev` subdomain, no custom domain. See above.
- [ ] Back up the `pgdata` volume. It holds encrypted vault blobs — useless to
      an attacker, and irreplaceable to your users, since **you cannot decrypt
      them to help someone who lost their password.** If recordings are in a
      bucket, they are not in that backup and need their own.
- [ ] Publish your relay's egress IPs so users can allowlist them.

## Scaling

The relay is stateless: run as many as you like behind a load balancer, ideally
near your users, because relay latency is felt directly in typing. Quotas are
per-process (see `apps/relay/src/quota.rs`), so a user spread across instances
gets a looser limit than the number suggests — that is a deliberate trade to
keep a network round trip out of the data path.

The web app is a normal stateless Next.js server; scale it horizontally and put
Postgres behind a pooler.

## Upgrading

```bash
git pull
docker compose -f compose.prod.yaml up -d --build
```

The new web container migrates before it accepts traffic.

`scripts/deploy.sh` is those two commands with the checks around them: that
`.env` exists before compose reads a missing one, that the pull is a
fast-forward rather than a merge commit created unattended on a server, and that
a release touching `apps/agent` says so — because agent binaries ship in the web
image but no enrolled machine replaces itself until `AGENT_VERSION` changes.
`--no-pull` deploys what is checked out, `--prune` deletes the images the build
replaced.

The relay and web can be upgraded independently — the only contract between
them is the token format in `apps/relay/src/token.rs`, which is versioned by
its claims shape. Roll the relay first.

## What you are trusting

Self-hosting removes the relay-metadata exposure and the "we serve the
JavaScript" risk both, because you serve it. What it cannot remove: a
compromised endpoint, and traffic analysis on your own network. See
[`THREAT-MODEL.md`](THREAT-MODEL.md).
