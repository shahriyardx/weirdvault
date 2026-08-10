# TODO

Work that is understood and deliberately not done yet. Each entry says what the
current state is, what should replace it, and what triggers the change — an
entry with no trigger is a wish, not a task.

---

## Schedule the two maintenance scripts

**Now:** `apps/web/scripts/prune-audit.mjs` deletes audit rows past their
retention window, and `apps/web/scripts/sweep-recordings.mjs` deletes stored
recording objects no row claims. Both are safe to run repeatedly, against a live
deployment, and neither has ever run: nothing schedules them and neither is in
the runtime image.

**What is survivable about that, and what is not.** Pruning is invisible when
skipped, because `GET /api/audit` applies the same cutoff on read — an unpruned
row is already gone as far as the app is concerned, and running the script is
what makes it gone from disk. The sweep is not: an orphaned object costs storage
forever and no read path hides it.

**What to do instead.** An authenticated route per script, called by an external
scheduler (Upstash QStash or similar) rather than a cron container this repo
would have to assume exists. That means a shared secret in the same shape as
`RELAY_USAGE_SECRET` — a bearer token the endpoint checks, distinct from every
other secret, blank meaning the route refuses rather than runs unauthenticated.

Two things the routes need that the scripts get for free from being scripts: a
bound on how long one call may run, since a serverless invocation has a limit
and a sweep over a large bucket does not, and an answer for concurrent
invocations. Both are already safe to interrupt — they make real progress and
resume — so the bound can be a batch count rather than a lock.

**Trigger:** the first real deployment with a bucket. Until then a checkout with
production credentials is a fine way to run something only needed after a
failure.

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
bucket keeps its old blobs in `pg_dump` until they are deleted. And the sweep
that recovers orphans is still a script somebody has to run — see above.
