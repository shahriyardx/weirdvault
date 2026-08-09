# webxterm

Zero-install web SSH client. Open a browser, generate or import a key, connect
to any server — terminal, file explorer, uploads, remote editing, nothing to install
on either end.

- [`PLAN.md`](PLAN.md) — product and architecture plan
- [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) — what each party can and cannot see
- [`docs/PHASE0-RESULTS.md`](docs/PHASE0-RESULTS.md) · [`docs/PHASE2-SPIKE.md`](docs/PHASE2-SPIKE.md) — de-risking results

## How it works

The SSH client runs **inside the browser tab** as WebAssembly. A stateless Rust
relay bridges WebSocket to TCP but only ever forwards ciphertext — the handshake
and all encryption terminate in the tab. Private keys are generated
non-extractable in WebCrypto, so the WASM core, our own JavaScript, an injected
script, and a browser extension are all equally unable to read them;
authentication works by handing the challenge to WebCrypto and getting back a
signature. An imported key gets the same custody from the moment it is parsed,
which is a weaker claim and is written as one: the file existed as readable
bytes before it arrived, and nothing here can undo that.

Host keys are pinned on first use and verified on every reconnect. That check is
what keeps the relay honest — without it, a hostile relay could present its own
key and the encryption would be end-to-relay rather than end-to-end.

**On the server: nothing to install.** One line, once:

```bash
echo 'ssh-ed25519 AAAA… you@webxterm' >> ~/.ssh/authorized_keys
```

Or tick "use password once" and webxterm installs the key itself.

## Working today

| | |
|---|---|
| Terminal | xterm.js + WebGL, tabs, split panes, full VT, touch modifier bar |
| Keys | Ed25519, non-extractable; portable (vault-wrapped, syncs) or device-bound |
| Key import | OpenSSH and PKCS#8, encrypted keys included; Ed25519 only, since that is all `connect` can sign with |
| Hosts | manual entry, plus bulk import from `~/.ssh/config` with a per-entry review of what was and was not understood |
| Host keys | pinned on first use, hard refusal on mismatch, pins sync between devices |
| Files | SFTP explorer on the same connection, context menu, transfer queue |
| Uploads | streaming, drag-and-drop folders, tar fast path for many small files |
| Downloads | streaming to disk via File System Access API, service worker fallback |
| Editing | Monaco, lazy-loaded, saves back over SFTP |
| Snippets | saved commands with tags, synced in the vault, run into a live session |
| Accounts | Better Auth, one account per person; split KDF (auth / vault / audit) keeps two of the three branches local |
| Sign-in | three routes — password, a passkey, or GitHub where the deployment sets the OAuth variables — and one way to the vault key, which is typing the password. A passkey or GitHub session therefore arrives authenticated with the vault shut and asks for the password before it can show a host: it saves the sign-in, not the password. A passkey never carries key material; WebAuthn PRF is deliberately not used |
| Two-factor | TOTP with backup codes encrypted at rest, enrolled only after a code has been verified. The Settings control checks that `two_factor` has the columns better-auth writes and renders disabled, naming the missing ones, where it does not — it passes as of migration `0008`, having failed on every deployment before it. A recovery code does not answer the challenge and is spent trying, which the card says before you enrol |
| Sync | zero-knowledge vault blob with optimistic concurrency and per-record merge |
| Password change | re-derives all three branches and re-wraps every portable key individually; ordered so a dropped connection is repairable rather than a lockout |
| Recovery codes | ten single-use codes, each a sealed copy of the key material; password-equivalent by construction and labelled as such |
| Backup | encrypted vault export, and a restore that merges rather than overwrites |
| Activity | audit log with hostnames blinded under the audit key, resolved locally; kept 30 days on Free and 12 months on Pro, enforced by the query and by `bun run audit:prune` |
| Recording | session capture encrypted in the browser under the vault key, replayed here, exportable as an asciicast. Saving a new recording and creating a share link need Pro; listing, playing, downloading and revoking are ungated on both tiers |
| Recording share links | a second copy of one transcript, re-encrypted in the tab under a key generated for that link alone and carried in the URL fragment, so it opens with no account and the server never holds the key. Expiry required, optional view limit, revocable — and revoking deletes that copy |
| Devices | per-browser Ed25519 identity, listed and revocable; revoking ends the sessions stamped with that device id and refuses the key again |
| Relay | Rust, SSRF-guarded, destination-bound tokens, per-account connection quotas |
| Transfer limit | the relay counts bytes and reports them; 1 GB a month per account on Free and 5 GB on Pro, refused at token mint so live sessions are never cut. Off unless `RELAY_USAGE_SECRET` is set, and absent entirely on a relay you host |

Not built, and named here rather than left to be discovered: there is no port
forwarding. Mosh is not on the list at all — it needs UDP, which a browser tab
does not have.

An account is a person. There are no organizations, no members, no invitations
and no seats. Organizations, invitations, roles and team-key distribution were
built and worked, and were withdrawn: the shared vault they existed to protect
was never built, so what remained was a roster. `PLAN.md` Phase 5 records what
existed, and git history has the code — start there rather than from scratch.

Two tiers, one price, no quantity. Free is the two limits above, on the Free
side of each. Pro is $5 a month, flat, one subscription per account: 5 GB of
relay transfer, 12 months of activity history, and session recording. Stripe
takes the money and a signed webhook mirrors the result into a `subscription`
table that every gate reads — [`apps/web/README.md`](apps/web/README.md#billing)
has the variables, the failure directions and how to run the webhook locally.
Leaving the three Stripe variables unset is a supported deployment: nothing is
sold, nothing 500s, and every account is whatever that table says, which on an
install that has never taken a payment is Free.

## Layout

Three programs, each with its own README covering how to run and test it.

| | | |
|---|---|---|
| [`apps/web/`](apps/web/README.md) | TypeScript | The app and control plane. Serves the pages, holds the encrypted vault it cannot read |
| [`apps/ssh/`](apps/ssh/README.md) | Go → WASM | The SSH and SFTP client that runs in the tab. Where the encryption actually happens |
| [`apps/relay/`](apps/relay/README.md) | Rust | The WebSocket-to-TCP bridge. Forwards ciphertext, guards against SSRF |
| `sshd/` | | A stock OpenSSH container to develop against, on :2222 |
| `docs/` | | Threat model, deployment, and the spike results behind the architecture |

Each app owns its own manifest — `apps/web/package.json`, `apps/ssh/go.mod`,
`apps/relay/Cargo.toml` — so nothing at the root has to know how any of them
build.

## Running it

Needs Go 1.26+, Bun, Rust, and Docker. Start here, then read the app you are
working on:

```bash
bun install --cwd apps/web         # the only package with dependencies
bun run wasm                       # apps/ssh → apps/web/public/ssh.wasm

docker compose up -d postgres      # database
bun run --cwd apps/web db:push     # schema
bun run --cwd apps/web dev         # app on :3000
```

The relay runs from its own directory, because it takes several environment
variables that matter — [`apps/relay/README.md`](apps/relay/README.md) lists
them.

Open http://localhost:3000/dashboard.

## Verifying

```bash
bun run sshd                    # a stock OpenSSH target on :2222
cd apps/relay && cargo test     # SSRF guards, token binding, quotas
cd apps/ssh   && go test ./...  # key and ssh_config parsing
cd apps/web   && bun test       # audit event shapes, vault merge, recovery codes
```

There is no automated coverage of the browser path — connecting, SFTP, pinning,
vault sync. Exercise those against `bun run sshd` by hand.

## Deploying

```bash
cp .env.example .env      # fill in the secrets
docker compose -f compose.prod.yaml up -d --build
```

The web container applies database migrations at start, before it serves.
Full guide, including TLS: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Notes

- `RELAY_ALLOW_PRIVATE=1` makes the local test container reachable by disabling
  the SSRF guard. It must never be set in production.
- This machine's npm cache has root-owned files from an old npm bug, which
  breaks `npx`. The project uses Bun, so it rarely matters; fix with
  `sudo chown -R 501:20 ~/.npm`.
