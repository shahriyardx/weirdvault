# TODO

Work that is understood and deliberately not done yet. Each entry says what the
current state is, what should replace it, and what triggers the change — an
entry with no trigger is a wish, not a task.

---

## Move recording storage to R2

**Now:** `recording.ciphertext` is a `bytea` column in Postgres, written by
`POST /api/recordings` and read back whole by `GET /api/recordings/:id`.
`recording_share.ciphertext` holds a second, separately re-encrypted copy. Limits
are in `apps/web/src/lib/recording/limits.ts`: 4 MB captured per session, 12 MB
per stored blob, 1 GB per account.

**Why this is fine today.** Deletion is a foreign key rather than a
reconciliation job, there is one set of credentials rather than two, and there
are no orphaned objects to sweep. At current volume it costs nothing.

**Why it does not stay fine.** At 1 GB × N accounts the blobs are in every
`pg_dump`, so backup size and restore time track recording volume rather than
data volume. TOAST churn from large writes and deletes lands on a table that is
also queried for listings, which is the read path a user waits on.

**What to do instead.** Object storage — R2, since egress is free and the app is
already on Hetzner where egress is not. The row keeps its metadata and gains an
object key; the ciphertext moves out.

The migration is unusually cheap here, and the reason is worth stating: the blob
is **already ciphertext the server cannot read**. The vault key never leaves the
browser, so the storage backend is not a trust boundary and moving the bytes to
a third party does not weaken the threat model. That is not true of most systems
that make this move, and it is the thing that makes it a plumbing change rather
than a security decision.

Sketch:

- `recording.storage_key text` and `recording.ciphertext bytea` both nullable,
  so rows can be read from either place while the backfill runs.
- Write new recordings to R2 and set `storage_key`; read prefers `storage_key`
  and falls back to `ciphertext`.
- Backfill existing rows, then drop the column.
- Deletion becomes two steps and can half-fail. Delete the object first and the
  row second: a row pointing at a missing object is a broken playback, an object
  with no row is invisible and merely costs storage. Reconcile the second case
  with a sweep, not with a transaction that cannot exist across two systems.
- `MAX_ACCOUNT_RECORDING_BYTES` stays enforced in Postgres from `size_bytes`.
  The ceiling is an accounting question and does not move with the bytes.
- Shares get the same treatment; `revoke` currently empties `ciphertext` and
  zeroes `size_bytes`, which becomes an object delete.

**Who can read the object.** An R2 bucket is private. There is no public URL for
an object unless the bucket is deliberately given one — the `r2.dev` development
subdomain, or a custom domain attached to it. Neither is on by default and
neither should be turned on here. Without them the only ways to read an object
are the S3 API with an access key, a presigned URL, or a Worker binding, and all
three are things the server does on purpose.

So the question is not how to hide the object; it is what serves the bytes to the
browser. Two answers, and the cheap-looking one is wrong:

- **Proxy through the route.** `GET /api/recordings/[id]` keeps its shape and
  swaps `row.ciphertext` for a fetch from R2 with server-side credentials. The
  authorization surface does not change at all — same `id = ? AND user_id = ?`
  WHERE clause — and no URL exists that works without a session cookie.
- **Presign and redirect.** The route authorizes as it does now, then hands back
  a short-lived signed URL and the bytes go R2 → browser. This adds a second
  thing that grants access: the URL is a bearer credential, good for its whole
  lifetime, to anyone who ends up holding it — browser history, a `Referer`
  header, a proxy log, a screenshot of the address bar.

Take the proxy. Presigning saves server egress on a blob capped at 12 MB, and
buys an authorization surface that is not the one the route file was written to
keep singular.

For shares it is not a preference. `/api/shares/[token]` authenticates nobody and
revocation is a row stamp: `revoked_at` is checked when the request arrives. A
presigned URL minted before revocation keeps working until it expires, because
R2 has never heard of `revoked_at`. Presigning a share object means revoke stops
meaning revoked, which is the one promise that route makes. Shares proxy.

**Neither of those is the last line.** The object is ciphertext the vault key
opens, and that key is derived in the browser and never sent. A leaked presigned
URL, a leaked access key, a compromised bucket — each yields an AES-GCM envelope
and nothing else. That is the property that makes this a plumbing change, and it
is a reason the access-control story can be simple rather than a reason it can be
skipped: unguessable is not authorized, and neither is unreadable. Give object
keys a `rec/<user_id>/<recording_id>` shape so account deletion and orphan sweeps
can work by prefix, and treat that shape as filing, not as a secret.

**Trigger:** before real users have real recordings. Doing it after means a
backfill against live data for no benefit that waiting bought.
