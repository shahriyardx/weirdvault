# Deploying webxterm

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
webxterm.example.com     { reverse_proxy localhost:3000 }
relay.webxterm.example.com { reverse_proxy localhost:8080 }
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
sessions, and it will look like a webxterm bug.

Once a proxy is in front, set `TRUSTED_PROXY_HOPS` to the number of proxies
between the internet and the web container — `1` for the Caddy or nginx block
above, `2` if a CDN sits in front of that. Until it is set, the app records no
client address on any audit row and the recovery-code rate limiter shares one
bucket for everybody.

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
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Where session recordings are stored. All four or none; see below |
| `TRUSTED_PROXY_HOPS` | `1` on Vercel — its edge appends the client address; unset means no address is recorded |

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
R2_BUCKET=webxterm-recordings
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
then. `apps/web/scripts/sweep-recordings.mjs` deletes objects no row claims:

```bash
node apps/web/scripts/sweep-recordings.mjs --dry-run
node apps/web/scripts/sweep-recordings.mjs
```

It needs `DATABASE_URL` and the same four `R2_*` variables, skips anything
written in the last hour so a save in flight is never mistaken for an orphan,
and is safe to run against a live deployment. Nothing schedules it.

**Deleting an account** cancels the Stripe subscription first — if that fails,
the deletion is refused rather than leaving a charge running with no way to
reach it — then deletes the rows, then purges `rec/<user-id>/` and
`share/<user-id>/` from the bucket. A purge that fails leaves orphans for the
sweep; it does not fail the deletion, because there is no account left to refuse
on behalf of.

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

The relay and web can be upgraded independently — the only contract between
them is the token format in `apps/relay/src/token.rs`, which is versioned by
its claims shape. Roll the relay first.

## What you are trusting

Self-hosting removes the relay-metadata exposure and the "we serve the
JavaScript" risk both, because you serve it. What it cannot remove: a
compromised endpoint, and traffic analysis on your own network. See
[`THREAT-MODEL.md`](THREAT-MODEL.md).
