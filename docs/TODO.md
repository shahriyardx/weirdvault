# TODO

Work that is understood and deliberately not done yet. Each entry says what the
current state is, what should replace it, and what triggers the change — an
entry with no trigger is a wish, not a task.

---

## (nothing here right now)

The last entry was "schedule the two maintenance scripts", and it is done — see
below. Add the next one when there is one; an entry with no trigger is a wish,
not a task.

---

## Done, kept here for the reasoning

### Recording storage moved to object storage

Shipped. `recording.storage_key` and `recording_share.storage_key` name an
object; `ciphertext` is still there and still used when no bucket is configured.
A check constraint forbids both at once. `lib/storage/` holds the SigV4 signer
and the client, `lib/recording/blobs.ts` is the only code that knows there are
two places bytes can be, and `lib/storage/purge.ts` removes an account's objects
after the account is deleted.

Three decisions from the original plan that are worth not re-litigating:

- **Proxy, never presign.** `GET /api/recordings/[id]` fetches the object with
  server credentials and serves it through the same `id = ? AND user_id = ?`
  WHERE clause it always had. A presigned URL would be a second thing that
  grants access — a bearer credential good for its whole lifetime to whoever
  ends up holding it, in browser history, a `Referer` header, a proxy log. There
  is no presign function in `sigv4.ts`, which is how that stays decided.

  For `/api/shares/[token]` it is not a preference at all. That route
  authenticates nobody and enforces `revoked_at` when the request arrives; a
  signed URL minted before a revocation keeps working after it, because a bucket
  has never heard of `revoked_at`.

- **Postgres was not replaced, and there was no backfill.** Both backends are
  read, always, in both directions. A deployment can turn a bucket on after a
  year and every existing recording keeps playing; turning it off gives the old
  ones back. The fallback is not scaffolding to remove later.

- **The ordering is the design.** Object before row on the way in, object before
  row on the way out, so a half-failure always leaves an orphan rather than a
  row pointing at nothing — the first is recoverable and the second is a
  recording that cannot be played. A delete whose object cannot be destroyed
  refuses rather than deleting the row anyway.

What is **not** solved: nothing backfills, so a deployment that switches on a
bucket keeps its old blobs in `pg_dump` until they are deleted.

### The maintenance scripts became a route with a scheduler

Shipped. `prune-audit.mjs` and `sweep-recordings.mjs` are gone. The work is
`src/lib/maintenance/`, triggered by `POST /api/cron`, and `compose.prod.yaml`
ships a `cron` service that calls it — so the default deployment does the work
rather than documenting it. An external scheduler can call the same route, which
is the only option on a serverless deployment.

The part worth keeping: moving the jobs out of node scripts deleted two
duplications that existed **only** because a plain script cannot import from
`src/`. The audit retention windows had a second copy, policed by a test that
read a script as *text* and compared number literals. AWS SigV4 had a second
complete implementation, policed by a test that signed the same five requests
with both signers and compared the Authorization headers. Both copies and both
guard tests are gone; there is one of each again.

That is the argument against reaching for a standalone script next time
something needs scheduling. The runtime image ships no `src/` and no TypeScript,
so a script cannot import anything — and whatever it needs, it ends up carrying.
