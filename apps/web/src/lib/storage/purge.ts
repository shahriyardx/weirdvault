import { accountPrefixes, deletePrefix, objectStore } from "./objects"

/**
 * Everything one account put in the bucket, removed after the account is gone.
 *
 * ── Why after, and not before
 *
 * Deleting a user cascades `recording` and `recording_share` away, so the rows
 * that name the objects are destroyed by the same statement that destroys the
 * account. That leaves two orderings and neither is a transaction, because
 * Postgres and a bucket cannot be in one.
 *
 * Purging first would mean a deletion that fails afterwards — a database error,
 * a Stripe refusal, a crashed process — has already destroyed the recordings of
 * an account that still exists. Somebody who asked to delete their account and
 * got an error would find their transcripts gone and everything else intact.
 * That is unrecoverable and it is the wrong half to risk.
 *
 * Purging afterwards risks the other half: the account is gone and the objects
 * are not. Those objects are recoverable — nothing in the database claims them,
 * so `scripts/sweep-recordings.mjs` finds them by exactly that property — and
 * until it runs they are AES-GCM envelopes whose key was only ever in a browser.
 *
 * So it runs afterwards, from `user.deleteUser.afterDelete`, and it does not
 * throw. There is no account left to refuse on behalf of, and Better Auth has
 * already committed the deletion by the time this is called; an exception here
 * would turn a completed deletion into an error page for the user and change
 * nothing about the bytes.
 *
 * ── Why by prefix
 *
 * By the time this runs there are no rows to enumerate — that is what makes the
 * key shape load-bearing rather than cosmetic. `rec/<user_id>/…` and
 * `share/<user_id>/…` mean a bucket listing is a complete answer to "what did
 * this account have", which is the only enumeration a bucket offers and the
 * reason lib/storage/objects.ts fixes the shape.
 */

export interface PurgeResult {
  deleted: number
  failed: number
  /** False when this deployment stores recordings in Postgres and there is nothing to purge. */
  attempted: boolean
}

/**
 * Removes an account's objects, reporting rather than throwing.
 *
 * The count is returned so a caller can log it. Nothing branches on it: a
 * partial purge and a complete one are the same outcome for the person who
 * deleted their account, and the difference is an operations problem that the
 * log and the sweep exist for.
 */
export async function purgeAccountObjects(userId: string): Promise<PurgeResult> {
  const store = objectStore()
  if (!store) return { deleted: 0, failed: 0, attempted: false }

  let deleted = 0
  let failed = 0

  for (const prefix of accountPrefixes(userId)) {
    try {
      const result = await deletePrefix(store, prefix)
      deleted += result.deleted
      failed += result.failed
    } catch (e) {
      // A listing that failed. Counted as one failure rather than as the
      // unknown number of objects behind it, and the next prefix is still
      // tried — a bucket that refuses `rec/` may well serve `share/`, and
      // stopping here would leave the shares behind for no reason.
      failed += 1
      console.error(
        `could not purge ${prefix} after account deletion; the objects are orphaned until ` +
          "scripts/sweep-recordings.mjs runs",
        e instanceof Error ? e.message : "unknown error",
      )
    }
  }

  return { deleted, failed, attempted: true }
}
