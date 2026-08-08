# tests — the browser suites

Every claim webxterm makes is about what happens in a real browser talking to a
real SSH server, so that is what these drive: headless Chromium, a dockerized
stock `sshd`, and the actual relay. There is no mocking here, because a mock of
an SSH server would prove nothing.

| File | Covers |
|---|---|
| `signed-in.mjs` | The app with an account: portable keys, password-first key install, pinning, SFTP, tar upload, Monaco, vault sync, concurrent sessions, split panes, host key rotation |
| `signed-out.mjs` | The path with no account at all — what the landing page promises, and the easiest thing to break without noticing |
| `sshd/` | The target: `alpine:3` plus stock `openssh-server`. No agent, no patches, no webxterm-specific configuration, because the product's central claim is that none are needed |

Several checks assert a **negative**, and those are the ones worth keeping: that
the raw password never appears in a request body, that the stored vault
ciphertext contains no plaintext hostname, that a changed host key is refused
rather than silently re-pinned, that the relay rejects a token minted for a
different destination. Those properties are what the product is; they fail
silently when they regress.

## Run

Three things have to be up first:

```bash
bun run sshd                            # the target on :2222
docker compose -f compose.yaml up -d postgres
cd apps/relay && cargo run --release    # see apps/relay/README.md for env
bun run dev                             # the app on :3000
```

Then, from the repo root:

```bash
bun run test                # both suites
bun run test:signed-in
bun run test:signed-out
bun tests/signed-out.mjs --headed   # watch it happen
```

| Variable | Default |
|---|---|
| `APP_URL` | `http://localhost:3000` |
| `SSHD_CONTAINER` | `webxterm-sshd` |

`signed-in.mjs` creates a throwaway account per run, so it is safe to repeat. It
also rewrites the target's `authorized_keys` and rotates its host key, so point
it at the test container and nothing else.
