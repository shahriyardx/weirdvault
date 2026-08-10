# weirdvault Threat Model

**Status:** living document. Written late — the split KDF shipped before this
existed, which is the wrong order and is corrected here while there is still no
production data to migrate.

The point of this document is to state precisely what weirdvault protects, what it
does not, and who has to be trusted. A security claim that isn't written down
this way isn't a claim, it's marketing.

---

## 1. Assets

| Asset | Where it lives | Worst case if lost |
|---|---|---|
| SSH private keys | WebCrypto, non-extractable | Attacker can log into the user's servers |
| Vault contents (hosts, users, ports, jump chains, snippets) | Encrypted blob; plaintext only in the tab | Reconnaissance map of the user's infrastructure |
| Vault key | Derived in-browser, memory only | Decrypts everything above |
| Session contents (keystrokes, output, files) | In the tab and on the wire, encrypted | Credentials typed at the prompt, file contents |
| Account credentials | `account.password` = hash of a derived auth token | Session impersonation — **not** vault decryption |
| Passkey credentials | `passkey.public_key`, `credential_id`, `aaguid` | Nothing on their own: the public half is public by construction and the private half never leaves the authenticator. They are an additional *route* to a session, so the account's exposure is now the weakest of password, passkey and GitHub — not the strongest |
| Authenticator secret and backup codes | `two_factor.secret` and `two_factor.backup_codes`, both encrypted under `BETTER_AUTH_SECRET` (`storeBackupCodes: "encrypted"`, set in `lib/auth.ts`) | Session impersonation, at a higher bar than the row above: it needs a database dump **and** the application secret, because verifying a code means the server can read it back. Ten working sign-in credentials per enrolled account if both are held. Still **not** vault decryption — nothing here derives a key |
| Connection metadata | Relay logs, `audit_event` | Reveals which hosts exist and when they're used |
| Transfer volume | `relay_usage` | Per-account bytes moved through the relay, totalled by month. Names no host and no destination — it is one row per account per month — but it is the one piece of connection metadata we now retain in a database rather than only in a log, and it says when an account was busy |
| Session recordings | `recording.ciphertext`, or an object in a bucket that `recording.storage_key` names — encrypted under the vault key either way | Terminal output verbatim, including anything a shell echoed back. Undecryptable without the user's password, and deleted only when the user deletes it — nothing expires them |
| Shared recordings | `recording_share.ciphertext`, or its own object under `recording_share.storage_key` — the same transcript again, encrypted under a key that exists only for that link | The same contents, with a different exposure: the key is in the link's fragment and never reaches us, but possession of the link *is* access. `GET /api/shares/[token]` serves this copy with no session, so anyone the link is forwarded to can read it. Bounded by a required expiry and an optional view limit; revoking destroys this copy, expiry only stops it being served |

---

## 2. Trust boundaries

```
┌─ USER'S BROWSER ────────────── trusted ──────────────────┐
│  plaintext session · vault key · non-extractable SSH keys │
└────────────────────────┬─────────────────────────────────┘
                         │ SSH ciphertext over WebSocket
┌────────────────────────▼─── semi-trusted ────────────────┐
│  RELAY — routes bytes it cannot read. Sees metadata.      │
└────────────────────────┬─────────────────────────────────┘
                         │ TCP
┌────────────────────────▼─── trusted by the user ─────────┐
│  THEIR SSH SERVER — unmodified sshd                       │
└──────────────────────────────────────────────────────────┘

┌─ CONTROL PLANE (separate) ──── semi-trusted ─────────────┐
│  accounts · ciphertext blobs · subscriptions · audit      │
│  Cannot decrypt anything it stores.                       │
└──────────────────────────────────────────────────────────┘
```

For a machine with no public address the middle hop is longer, and the trust
placed in it is not:

```
┌─ USER'S BROWSER ─────────────────────────────────────────┐
└────────────────────────┬─────────────────────────────────┘
                         │ SSH ciphertext over WebSocket
┌────────────────────────▼─── semi-trusted ────────────────┐
│  RELAY — pairs two sockets it cannot read                 │
└────────────────────────┬─────────────────────────────────┘
                         │ the SAME ciphertext, over a second
                         │ WebSocket the agent dialled outward
┌────────────────────────▼─── semi-trusted ────────────────┐
│  AGENT on the user's own machine — a pipe to a port.      │
│  Holds no SSH credentials. Cannot decrypt.                │
└────────────────────────┬─────────────────────────────────┘
                         │ TCP to 127.0.0.1
┌────────────────────────▼─── trusted by the user ─────────┐
│  THEIR SSH SERVER — unmodified sshd                       │
└──────────────────────────────────────────────────────────┘
```

The agent is deliberately *not* a new trust boundary. It sees what the relay
sees: ciphertext and metadata. Its Ed25519 key authenticates the machine to the
relay and authorises nothing else — it cannot log in, cannot read the session,
and cannot present a different SSH host key without host-key pinning in the
browser catching it. See §6.

**Design rule:** compromise of the relay *and* the control plane together must
not yield plaintext sessions or vault contents. Everything below is judged
against that rule. Adding the agent does not change it: compromise of all three
still yields ciphertext.

---

## 3. What each party can see

### The relay CAN see
- Source IP, account identity (authenticated sessions only)
- **Destination host and port** — it has to dial them
- Connection timing, duration, byte volume and direction
- Traffic-analysis signals: typing rhythm, bulk-transfer shapes

### The relay CANNOT see
- Any plaintext byte of the session
- Private keys, passwords, file contents
- Which commands were run

Justification: SSH terminates in the browser. The relay does `io.Copy` over
bytes already encrypted by the tab. This is structural, not policy — there is no
code path where the relay holds a session key.

### The control plane CAN see
- Email, account and session records
- Which authentication routes an account has: a password credential row, any
  registered passkeys (public keys, so seeing them is not a compromise), and
  whether an authenticator is enrolled. The authenticator's secret and backup
  codes are readable to it too, given `BETTER_AUTH_SECRET` — verifying a code
  requires it. None of this derives a vault key
- Subscription state mirrored from Stripe: a customer id, a subscription id, a
  status and a renewal date. No card number, no billing address, no invoice
  contents — Stripe holds those and this app never sees one, not even in transit
- Vault blob **size** and update frequency
- Audit events we choose to record, with hostnames blinded under a key derived
  from the password — so the row is a stable opaque handle, resolvable only in
  the user's own browser. What is written today: device registrations and
  revocations, recovery-code enrolment, use and removal, host keys pinned or
  found mismatched, and keys installed on a host. Connection events are in the
  catalogue and nothing emits them; the relay has no database and no audit code,
  so "who connected to which host, when" is not currently recorded anywhere

### The control plane CANNOT see
- Vault plaintext: host lists, usernames, snippets, wrapped keys
- The vault key or the user's password
- Session contents

### The one endpoint that authorizes nobody

Every other route in the control plane resolves a session and scopes its queries
by that session's user. `GET /api/shares/[token]` does not, by design: a share
link has to work for a colleague with no account. The token in the path is the
whole access decision, and the confidentiality that remains is the per-share key
in the fragment, which we never receive. Expired, revoked, over its view limit
and never existed all answer an identical 404, so the endpoint cannot be used to
learn which tokens are real.

**Rate-limited per network, at thirty fetches a minute.** What makes a token
unguessable is its 256 bits, not the limit; what the limit bounds is somebody
working through guesses and the cost of serving a multi-megabyte transcript to
whoever asks. A 429 and a 404 are distinguishable, and deliberately say nothing
about each other: the 429 is a statement about the caller's rate, not about
whether the token was real. Without a trusted proxy configured there is no
address to key on and every caller shares one bucket — see §7.

Nothing prunes expired shares: an expired link stops being served at once, but
its ciphertext stays until the owner revokes it or deletes the recording.

**Never presigned.** When recordings are configured to live in a bucket, this
route still fetches the object with server credentials and serves the bytes
itself. It is the one place where handing back a signed URL would break a
promise rather than merely widen a surface: revocation is enforced here, when
the request arrives, and a signed URL is redeemed at a bucket that has never
heard of `revoked_at`. There is no presign function anywhere in the codebase,
which is how that stays true rather than being a convention.

### Where the recording bytes are

A bucket, when one is configured, and a `bytea` column otherwise. The
distinction is deliberately *not* a trust boundary: what is stored is an AES-GCM
envelope whose key is derived from the user's password in their browser and
never transmitted, so a compromised bucket, a leaked access key or a
misconfigured public URL each yield ciphertext and nothing else. That is why
moving the bytes out was a plumbing change and not a security decision.

It is not a reason to be casual about the bucket. The object key is
`rec/<user-id>/<recording-id>`, which is filing rather than a capability —
unguessable is not authorized, and neither is unreadable. The bucket must have
no public URL (no `r2.dev` subdomain, no custom domain); every read goes through
a route that has already checked who is asking. The credentials belong to the
control plane only. The relay never touches a recording and holds none of them.

### What we do NOT protect against
Stated plainly rather than buried:

1. **A malicious or compromised weirdvault frontend.** We serve the JavaScript. A
   backdoored build could exfiltrate the vault key or misuse the signing oracle
   while keys stay "non-extractable". Non-extractability defeats *injected* and
   *third-party* code, not us. Mitigations: strict CSP, SRI, reproducible
   builds, published hashes, self-hosting. **This is the single largest residual
   risk and no amount of client-side crypto removes it.**
2. **A compromised endpoint.** Malware or a hostile extension with page access
   can use the signing oracle for as long as the tab is open, and read the
   plaintext session directly.
3. **Traffic analysis.** Timing and volume leak a lot. We do not pad.
4. **The user's own server.** If their sshd is compromised, we cannot help.
5. **Nation-state adversaries** with browser zero-days.

---

## 4. Key custody

Three modes, chosen per key (PLAN.md §3.6):

| Mode | Private key | Survives device loss | Threat traded |
|---|---|---|---|
| **Device-bound** | Non-extractable from birth; never syncs | No | Strongest; costs a server touch per device |
| **Portable** (default) | Extractable for ~1 ms, wrapped with `vault_key`, re-imported non-extractable per device | Yes, via the vault | Key bytes exist momentarily in JS heap |
| **SSH CA** (Phase 5) | Short-lived cert per device | Yes | Requires one `sshd_config` change |

**Signing oracle.** In every mode the WASM SSH core holds *no key material*; it
calls into WebCrypto. This means an attacker with script execution gets an
oracle that signs arbitrary challenges while the tab is open — strictly weaker
than key theft (bounded in time, non-exportable), but not nothing.

**Non-extractability is not a backup.** If a user clears site data with no
portable copy, the key is gone. Onboarding must make this impossible to miss.

---

## 5. The split KDF

```
master     = Argon2id(password, salt, m=64MiB, t=3, p=1)
authToken  = HKDF(master, "weirdvault/auth/v1")    → sent to the server
vaultKey   = HKDF(master, "weirdvault/vault/v1")   → never transmitted
```

The server stores only a hash of `authToken`. HKDF is one-way and the branches
are domain-separated, so a full database dump does not yield `vaultKey`.

**Known weakness — deterministic salt.** `salt = SHA-256("weirdvault/salt/v1:" +
lowercase(email))` so a new device can derive the key with only the password.
The cost is that salts are not random, weakening cross-user precomputation
resistance; Argon2id's memory hardness carries that load. Bitwarden uses the
same construction.

*Upgrade path:* a pre-login endpoint issuing a random per-user salt, returning
an indistinguishable HMAC-derived value for unknown emails so it cannot be used
as an account-existence oracle.

**Vault key lifetime.** Memory only, never persisted — `localStorage`,
`sessionStorage`, and IndexedDB are all readable by any script on the origin.
Cost: a reload requires re-entering the password, *and* any sign-in that typed
no password lands with no key at all (below). That is the correct trade.

### Three ways to authenticate, one way to the key

An account can be authenticated by a password, by a passkey, or by GitHub. Only
the password produces the Argon2id run above, so only the password produces a
vault key. A passkey ceremony returns an assertion and a GitHub callback returns
an access token; neither carries key material, and neither can be made to,
because nothing on those paths ever sees the password.

The consequence is a state that has to be handled rather than hidden: a user who
signs in with a passkey or with GitHub is fully authenticated and cannot read a
single host until they type their password. `components/vault-unlock.tsx` names
the reason from one place so the two explanations cannot drift, and
`accountGate` in `lib/auth.ts` sends a GitHub account with no credential row to
`/set-vault-password` before the dashboard renders at all.

**PRF is deliberately not used.** The WebAuthn PRF extension can return a stable
per-credential secret, which is how a password manager offers passkey unlock. It
is not implemented here and is not being designed toward. Two derivations would
mean two answers to what a password change does, two things to get right in a
rekey, and two places for the zero-knowledge claim to leak. The cost is paid by
the user in typing, once per tab, and it is the cost we chose.

**Second factors do not protect the vault either.** TOTP and backup codes gate a
session, and the server can read the codes back by design (see §1). A recovery
code, conversely, decrypts the vault but does not answer a second factor: the
sign-in it attempts is challenged like any other and `/recover` has no field for
the answer, while the sealed copy is consumed on hand-out. So on a TOTP-enrolled
account a redeemed code opens the vault, fails the sign-in, and is spent —
refused in words at `signInWithRecoveredToken` in `lib/auth-client.ts` and warned
about on the two-factor card before enrolment. A second-factor step on `/recover`
is the fix and is not built.

---

## 6. Transport and server identity

- **Browser → relay:** WSS. The relay is authenticated by TLS.
- **Relay → server:** raw TCP carrying the SSH stream.
- **End to end:** SSH's own encryption, terminating in the tab.

**Host key verification is what makes the above meaningful.** Without pinning,
a hostile relay could MITM the SSH connection: it controls the bytes and could
present its own host key. SSH host key checking is therefore not a nicety here —
it is the control that keeps the relay honest.

Requirements: pin on first use, store per (host, port), **refuse to connect on
mismatch** with an unmissable warning, and never offer a one-click "trust
anyway" that is easier than reading the message.

**Implemented.** Keys are pinned on first use, verified on every reconnect, and
a mismatch aborts the handshake in the WASM core before any authentication is
attempted. Clearing a pin requires typing a confirmation phrase; there is no
button beside the warning that does it in one click. Pins sync through the
vault, so a second device inherits the decision instead of trusting on first
use all over again.

---

## 7. Relay abuse

An authenticated WebSocket-to-TCP bridge is an SSRF engine if built carelessly.
Implemented controls (`apps/relay/src/ssrf.rs`, unit-tested by `bun run relay:test`):

- Destination port allowlist (22 by default)
- Reject loopback, RFC1918, link-local, CGNAT, multicast, unspecified
- Explicit reject of `169.254.169.254` and `fd00:ec2::254` — the addresses that
  turn an SSRF into cloud credential theft
- Resolve first, vet **every** answer, then dial the vetted IP, closing the
  DNS-rebinding window
- `-allow-private` exists for local development and must never be set in
  production

**Access control.** The relay verifies an HMAC token minted by the control
plane and **bound to the exact host and port**. That binding is the point: a
token proving only "a real user" would let any account use the relay as a
general-purpose TCP proxy to anywhere the rules above permit.

**Anonymous use, stated plainly.** Signing in is not required — the free tier
works with local storage and no account, and the product says so. Anonymous
visitors therefore get a token under a random cookie id. That id is trivially
rotatable, so per-subject quotas are weak for them; what actually bounds abuse
is the port allowlist, the destination binding, and the relay's global
connection cap. Signed-in users get a stable subject, a longer token TTL, and
per-account limits that mean something. This is a deliberate trade of some
abuse resistance for not putting a signup wall in front of a tool people need
before they trust us.

A monthly transfer allowance now exists — the relay counts the bytes it
forwards, the control plane refuses to mint a new token once an account is over,
and the figure differs by tier. It bounds cost rather than abuse: it is per
account and per month, so it does nothing about a burst, and it is off entirely
unless `RELAY_USAGE_SECRET` is set.

**Request rate limits exist now**, on the control plane rather than the relay.
Every `/api/auth` route is limited, with tighter rules on sign-in, sign-up,
account deletion and second-factor verification; so are share fetches, recording
saves, share creation, relay-token minting, agent enrollment and recovery
redemption. Counters are rows in Postgres (`lib/rate-limit.ts`), not a map in a
process, so replicas share one budget and a restart does not reset them.

Two things they are not. They are not what makes anything unguessable — a share
token is 256 bits, a recovery code 120, and truncating the table would not change
that; what they bound is cost and noise, chiefly unbounded account creation,
since every account is entitled to a gigabyte of recording storage. And they are
only as good as the subject they key on: a session gives a user id, and an
unauthenticated caller gives a network **only** when `TRUSTED_PROXY_HOPS` and
`TRUSTED_PROXY_IPS` say which forwarded entry the deployment's own proxy wrote.
Unset, every unauthenticated caller shares one bucket per endpoint, which one
caller can spend for everybody. That is a deliberate choice of nuisance over a
limiter with a client-chosen key, which would not be a limiter at all.

They fail open. A limiter that refused requests when Postgres was slow would
trade a bounded abuse problem for a total outage.

Still to add: per-second bandwidth limits, limits in the relay itself rather
than only at the token mint, and running with no cloud IAM role attached.

---

## 8. Multi-tenancy

- An account is a person. There are no organizations, no members and no shared
  vaults, so there is no sharing boundary inside an account to get wrong.
- Vault blobs are per-user rows keyed by `user_id`; every query must be scoped
  by the session's user. Postgres row-level security as defence in depth.
- Team key distribution — X25519 device keys, ECDH-wrapped per-team keys,
  rotation on member removal — was built and has been withdrawn (PLAN.md
  Phase 5). If it returns, the property that must come back with it is the one
  that was easiest to lose: rotation on removal does not reach what a removed
  member already fetched, so rotation limits the future and nothing else.
- Audit events record *that* a connection happened, never content.

---

## 9. Residual risks, ranked

1. **We serve the JavaScript.** A strict CSP is now enforced (`src/proxy.ts`):
   `script-src` is nonce + `strict-dynamic`, with `'wasm-unsafe-eval'` because
   the SSH core is WebAssembly. `style-src` permits `'unsafe-inline'` — a
   deliberate, documented weakening, because xterm.js and Monaco both inject
   `<style>` at runtime and neither can be nonced; inline styles cannot execute
   code, and script-src is the control that protects the vault key. Still
   outstanding: SRI, reproducible builds. Never fully eliminated for a hosted
   web app.
2. **Relay metadata.** Removed only by self-hosting.
3. **Deterministic KDF salt.** Acceptable, with a known upgrade path.
4. **Signing oracle while the tab is open.** Inherent to the design.
5. **An agent pins its machine to one relay instance.** The registry is
   in-memory, so a fleet behind a load balancer needs `/ws` and `/agent/control`
   to land on the same instance. Availability, not confidentiality — a
   mis-routed request finds no agent and is refused rather than being sent
   anywhere it should not go — but it is the one place the relay stopped being
   stateless, and it is worth knowing before scaling out.
6. **Revoking an agent does not drop its live control socket.** It takes effect
   immediately for anything new: `/api/agents/verify` refuses the next
   reconnect, and `/api/relay-token` refuses to mint. The window is one already
   open control connection carrying no new sessions. Closing it would require
   the control plane to reach into every relay instance, which is the coupling
   the token design exists to avoid.
7. **Recording objects can outlive the account that owned them.** Deleting an
   account cascades the rows away and then purges `rec/<user-id>/` and
   `share/<user-id>/` from the bucket. The purge runs after the deletion has
   committed — deliberately, because running it first would let a deletion that
   then failed destroy the recordings of an account that still exists — so a
   bucket that is unreachable at that moment leaves objects nothing points at.
   They are ciphertext with no surviving key holder and no row naming them, and
   the scheduled maintenance sweep removes them by exactly that property, and
   `compose.prod.yaml` now ships the scheduler that runs it — so this is a
   handled case on a self-hosted deployment and an outstanding one anywhere
   `CRON_SECRET` is unset and no external scheduler is pointed at
   `POST /api/cron`. Deployments with no bucket configured are unaffected: the bytes
   are in the row and go with it.
8. **No third-party audit yet.** This document used to say one had to happen
   before charging for anything. Billing shipped first, so that commitment was
   broken rather than met, and recording it here is more useful than quietly
   rewording it. No outside firm has reviewed this code and there is no SOC 2 or
   ISO 27001 — `/security` says the same in the product. It is still the thing to
   do next on this list.

---

## 10. Rules that follow

1. No feature may require the server to read vault plaintext. If one seems to,
   the feature is wrong, not the model.
2. Ship a CSP that forbids inline script and any third-party origin.
3. Never persist the vault key.
4. Never ship a "trust this host anyway" button that is easier than reading the
   warning.
5. Publish what the relay can see, in the product, not just here.
6. Get a third-party audit. This was written as "before billing anyone" and
   billing shipped without one; see residual risk 8.
7. If recordings are in a bucket, the bucket has no public URL and no route
   hands out a presigned one. Proxying is the only way bytes reach a browser.
