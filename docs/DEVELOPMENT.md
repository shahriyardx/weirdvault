# Working on weirdvault

Four programs, each with its own README covering how to run and test it in
detail. This is the top of that tree.

| | | |
|---|---|---|
| [`apps/web/`](../apps/web/README.md) | TypeScript | The app and control plane. Serves the pages, holds the encrypted vault it cannot read |
| [`apps/ssh/`](../apps/ssh/README.md) | Go → WASM | The SSH and SFTP client that runs in the tab. Where the encryption happens |
| [`apps/relay/`](../apps/relay/README.md) | Rust | The WebSocket-to-TCP bridge. Forwards ciphertext, guards against SSRF |
| [`apps/agent/`](../apps/agent/README.md) | Go | The daemon for a machine that cannot be dialled |

Each app owns its own manifest — `apps/web/package.json`, `apps/ssh/go.mod`,
`apps/relay/Cargo.toml`, `apps/agent/go.mod` — so nothing at the root has to
know how any of them build.

## Running it

Needs Go 1.26+, Bun, Rust and Docker.

```bash
bun install --cwd apps/web         # the only package with dependencies
bun run wasm                       # apps/ssh → apps/web/public/ssh.wasm
bun run agent                      # apps/agent → apps/web/public/agent-bin

docker compose up -d postgres
bun run --cwd apps/web db:push     # local only; production applies drizzle/*.sql
bun run --cwd apps/web dev         # :3000
```

Without `ssh.wasm` in `apps/web/public/` the app loads and cannot connect to
anything. Without the agent binaries, "Add a machine" hands out an install
command that 404s.

The relay runs from its own directory, because it takes several environment
variables that matter — [`apps/relay/README.md`](../apps/relay/README.md) lists
them.

Then open http://localhost:3000/dashboard.

## Develop against a real server

Over the network, on port 22. There is no local sshd container and deliberately
no longer one: reaching a target on loopback means running the relay with
`RELAY_ALLOW_PRIVATE=1`, which disables the SSRF guard — the relay's single most
important control. Every local test would then exercise a configuration that
must never exist in production, and the guard itself would never run.

## Verifying

```bash
cd apps/relay && cargo test     # SSRF guards, token binding, quotas, rendezvous
cd apps/ssh   && go test ./...  # key and ssh_config parsing
cd apps/agent && go test ./...  # control-connection liveness, the port allowlist
cd apps/web   && bun test       # audit shapes, vault merge, recovery codes, SigV4
```

Two of those deliberately cross a language boundary, because a round-trip test
written in one language passes just as happily with both halves wrong in the
same way:

- `apps/web/src/lib/agents/verify.test.ts` checks a signature fixture that Go
  actually produced. Regenerate it by running the real `signingMessage` from
  `apps/agent/main.go` if the format is ever versioned — do not edit the
  expected signature by hand, or the test proves nothing.
- `apps/web/src/lib/storage/sigv4.test.ts` pins the S3 request signer against
  AWS's published vectors, and `objects.test.ts` drives the whole client against
  a real server when one is pointed at it:

```bash
docker run -d --name weirdvault-minio -p 9000:9000 \
  -e MINIO_ROOT_USER=weirdvaulttest -e MINIO_ROOT_PASSWORD=weirdvaulttestsecret \
  minio/minio server /data
TEST_S3_ENDPOINT=http://127.0.0.1:9000 bun test   # those tests skip without it
```

Two scripts cover what a unit test cannot, because the thing being checked is
what Postgres does under concurrency rather than what a function returns. Both
need the app running and `DATABASE_URL` pointing at the same database it uses;
both create throwaway accounts and delete them afterwards.

```bash
bun run --cwd apps/web dev
node apps/web/scripts/check-rate-limit.mjs    # window arithmetic, and the burst
node apps/web/scripts/check-write-paths.mjs   # vault versioning, device ids, FKs
```

There is no automated coverage of the browser path — connecting, SFTP, host-key
pinning, the two-device sync loop. Check those by hand.

## Schema changes

Edit `apps/web/src/lib/db/schema.ts`, then:

```bash
bun run --cwd apps/web db:generate   # writes apps/web/drizzle/*.sql
```

**Commit the generated file.** It is the migration history; without it an
upgrade cannot tell a fresh database from one three versions behind. `db:push`
diffs the schema straight at a live database and is for local iteration only.

## Deploying

See [`DEPLOY.md`](DEPLOY.md).
