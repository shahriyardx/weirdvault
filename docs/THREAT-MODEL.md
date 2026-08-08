# webxterm Threat Model

**Status:** living document. Written late — the split KDF shipped before this
existed, which is the wrong order and is corrected here while there is still no
production data to migrate.

The point of this document is to state precisely what webxterm protects, what it
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
| Connection metadata | Relay logs, `audit_event` | Reveals which hosts exist and when they're used |

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
│  accounts · ciphertext blobs · org membership · audit     │
│  Cannot decrypt anything it stores.                       │
└──────────────────────────────────────────────────────────┘
```

**Design rule:** compromise of the relay *and* the control plane together must
not yield plaintext sessions or vault contents. Everything below is judged
against that rule.

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
- Email, account and session records, org membership and roles
- Vault blob **size** and update frequency
- Audit events we choose to record: who connected to which host, when

### The control plane CANNOT see
- Vault plaintext: host lists, usernames, snippets, wrapped keys
- The vault key or the user's password
- Session contents

### What we do NOT protect against
Stated plainly rather than buried:

1. **A malicious or compromised webxterm frontend.** We serve the JavaScript. A
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
authToken  = HKDF(master, "webxterm/auth/v1")    → sent to the server
vaultKey   = HKDF(master, "webxterm/vault/v1")   → never transmitted
```

The server stores only a hash of `authToken`. HKDF is one-way and the branches
are domain-separated, so a full database dump does not yield `vaultKey`.

**Known weakness — deterministic salt.** `salt = SHA-256("webxterm/salt/v1:" +
lowercase(email))` so a new device can derive the key with only the password.
The cost is that salts are not random, weakening cross-user precomputation
resistance; Argon2id's memory hardness carries that load. Bitwarden uses the
same construction.

*Upgrade path:* a pre-login endpoint issuing a random per-user salt, returning
an indistinguishable HMAC-derived value for unknown emails so it cannot be used
as an account-existence oracle.

**Vault key lifetime.** Memory only, never persisted — `localStorage`,
`sessionStorage`, and IndexedDB are all readable by any script on the origin.
Cost: a reload requires re-entering the password. That is the correct trade.

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

Still to add: bandwidth quotas, IP-level rate limits, and running with no cloud
IAM role attached.

---

## 8. Multi-tenancy and teams

- Vault blobs are per-user rows keyed by `user_id`; every query must be scoped
  by the session's user. Postgres row-level security as defence in depth.
- Team vaults (Phase 5) wrap a per-team key to each member's X25519 public key,
  so the server distributes ciphertext it cannot open. Removing a member must
  rotate the team key — otherwise they retain what they already fetched.
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
5. **No third-party audit yet.** Must happen before charging for Team.

---

## 10. Rules that follow

1. No feature may require the server to read vault plaintext. If one seems to,
   the feature is wrong, not the model.
2. Ship a CSP that forbids inline script and any third-party origin.
3. Never persist the vault key.
4. Never ship a "trust this host anyway" button that is easier than reading the
   warning.
5. Publish what the relay can see, in the product, not just here.
6. Third-party audit before Team billing.
