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
| `src/lib/keys.ts` | Non-extractable WebCrypto key custody |
| `src/lib/vault/` | Split KDF, vault encryption, sync with optimistic concurrency |
| `src/lib/ssh/` | Session orchestration, host key pinning policy, connect flows |
| `src/lib/transfers/` | Streaming upload and download, USTAR writer |
| `src/app/api/` | Auth, vault, devices, audit, relay tokens |
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
bun test             # audit event shapes, vault merge — pure logic only
```

The browser path — connecting, SFTP, pinning, vault sync — has no automated
coverage. Start a target with `bun run sshd` from the repo root and check it by
hand.

## Database

```bash
bun run db:push       # local development: diffs the schema straight at Postgres
bun run db:generate   # after editing src/lib/db/schema.ts — writes drizzle/*.sql
bun run db:migrate    # applies pending migrations; what the container runs at start
```

`db:push` is for local iteration only. Production applies the committed SQL in
`drizzle/`, so a schema change is not finished until `db:generate` has run and
the result is committed.

## Build the image

From the repo root, since the Dockerfile expects that context:

```bash
docker build -f apps/web/Dockerfile -t webxterm-web .
```

The image builds `ssh.wasm` itself in a Go stage, so it never ships a stale one.
It migrates the database at container start, before the server binds — see
`entrypoint.sh`.

`NEXT_PUBLIC_RELAY_URL` is inlined at build time, so changing the relay URL
means a rebuild, not a restart.
