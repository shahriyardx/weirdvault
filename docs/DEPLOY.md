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
cp deploy/.env.example deploy/.env
# fill in the secrets, then:
openssl rand -base64 48        # BETTER_AUTH_SECRET
openssl rand -base64 48        # RELAY_SECRET
openssl rand -base64 32        # POSTGRES_PASSWORD

docker compose -f deploy/compose.prod.yaml up -d --build
docker compose -f deploy/compose.prod.yaml run --rm migrate
```

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

---

## Option B — web on Vercel, relay on Fly.io

```bash
# relay
fly launch --dockerfile deploy/relay.Dockerfile --no-deploy
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
| `NEXT_PUBLIC_RELAY_URL` | `wss://your-relay/ws` |

`NEXT_PUBLIC_*` is inlined at build time, so changing the relay URL means a
rebuild, not a restart.

Run migrations from CI or locally with `DATABASE_URL` pointed at production:
`bun run --cwd apps/web db:push`.

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
- [ ] Back up the `pgdata` volume. It holds encrypted vault blobs — useless to
      an attacker, and irreplaceable to your users, since **you cannot decrypt
      them to help someone who lost their password.**
- [ ] Publish your relay's egress IPs so users can allowlist them.

## Scaling

The relay is stateless: run as many as you like behind a load balancer, ideally
near your users, because relay latency is felt directly in typing. Quotas are
per-process (see `crates/relay/src/quota.rs`), so a user spread across instances
gets a looser limit than the number suggests — that is a deliberate trade to
keep a network round trip out of the data path.

The web app is a normal stateless Next.js server; scale it horizontally and put
Postgres behind a pooler.

## Upgrading

```bash
git pull
docker compose -f deploy/compose.prod.yaml up -d --build
docker compose -f deploy/compose.prod.yaml run --rm migrate
```

The relay and web can be upgraded independently — the only contract between
them is the token format in `crates/relay/src/token.rs`, which is versioned by
its claims shape. Roll the relay first.

## What you are trusting

Self-hosting removes the relay-metadata exposure and the "we serve the
JavaScript" risk both, because you serve it. What it cannot remove: a
compromised endpoint, and traffic analysis on your own network. See
[`THREAT-MODEL.md`](THREAT-MODEL.md).
