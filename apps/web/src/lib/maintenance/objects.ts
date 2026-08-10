import { isNotNull } from "drizzle-orm"

import { db, schema } from "@/lib/db"
import { deleteObject, listObjects, objectStore } from "@/lib/storage/objects"

/**
 * Deleting stored recordings that no row claims.
 *
 * The app writes an object before the row that names it and deletes the object
 * before the row, so a half-failure always leaves the same shape: an object
 * nothing points at. lib/recording/blobs.ts explains why that direction and not
 * the other. This is what recovers it.
 *
 * Three things produce an orphan:
 *
 *  - A save whose object landed and whose INSERT did not. The route removes it
 *    on the way past; if that removal also fails, it stays.
 *  - An account deletion whose purge could not reach the bucket. The rows are
 *    gone by then, so nothing but the objects is left.
 *  - A database restored from a backup taken before an object was written.
 *    Nothing detects that and nothing should — the objects are simply found
 *    afterwards.
 *
 * This used to be `scripts/sweep-recordings.mjs`, a plain node script that could
 * not import TypeScript and therefore carried its own SigV4 implementation, kept
 * honest by a test that signed the same five requests with both copies and
 * compared the headers. That whole apparatus is gone: there is one signer again,
 * in lib/storage/sigv4.ts, and this calls the same client every route does.
 *
 * ── The two orderings that make this safe
 *
 * The database is read **first** and the bucket **second**. An object written
 * between the two reads is missing from the claimed set and looks like an
 * orphan; the grace window is what makes that harmless, and reading in this
 * order keeps the window the only thing that has to be right.
 *
 * A key is deleted only when it is both unclaimed and older than the window. A
 * save in flight has written its object and not yet its row — indistinguishable
 * from an orphan by looking at the bucket — and an hour is enormous next to the
 * gap between two consecutive statements.
 */

/** How old an unclaimed object must be before it is treated as abandoned. */
const GRACE_MS = 60 * 60 * 1000

/**
 * Objects deleted per run.
 *
 * This runs inside a request, so it needs a bound that a bucket listing does
 * not have. Truncation is reported rather than swallowed — a sweep that quietly
 * stopped early would read as "nothing left to clean" — and the next run
 * continues, because an orphan does not become harder to find by being left.
 */
const MAX_DELETES = 500

/** The prefixes the app writes under. Anything else in the bucket is not ours. */
const PREFIXES = ["rec/", "share/"]

export interface ObjectSweepResult {
  /** False when no bucket is configured and recordings live in Postgres. */
  applicable: boolean
  deleted: number
  failed: number
  /** Unclaimed but inside the grace window, so deliberately left alone. */
  tooRecent: number
  /** True when MAX_DELETES was reached and orphans remain. */
  truncated: boolean
}

const NOT_APPLICABLE: ObjectSweepResult = {
  applicable: false,
  deleted: 0,
  failed: 0,
  tooRecent: 0,
  truncated: false,
}

export async function sweepOrphanedObjects(dryRun: boolean): Promise<ObjectSweepResult> {
  const store = objectStore()
  if (!store) return NOT_APPLICABLE

  // Both tables, in one set. A share's copy lives under its own key, and a sweep
  // that read only `recording` would delete every live share link's bytes.
  const [recordings, shares] = await Promise.all([
    db
      .select({ key: schema.recording.storageKey })
      .from(schema.recording)
      .where(isNotNull(schema.recording.storageKey)),
    db
      .select({ key: schema.recordingShare.storageKey })
      .from(schema.recordingShare)
      .where(isNotNull(schema.recordingShare.storageKey)),
  ])

  const claimed = new Set<string>()
  for (const row of [...recordings, ...shares]) if (row.key) claimed.add(row.key)

  const cutoff = Date.now() - GRACE_MS
  let deleted = 0
  let failed = 0
  let tooRecent = 0
  let truncated = false

  for (const prefix of PREFIXES) {
    for (const object of await listObjects(store, prefix)) {
      if (claimed.has(object.key)) continue
      if (object.lastModified > cutoff) {
        tooRecent += 1
        continue
      }
      if (deleted + failed >= MAX_DELETES) {
        truncated = true
        break
      }
      if (dryRun) {
        deleted += 1
        continue
      }
      try {
        await deleteObject(store, object.key)
        deleted += 1
      } catch {
        failed += 1
      }
    }
    if (truncated) break
  }

  return { applicable: true, deleted, failed, tooRecent, truncated }
}
