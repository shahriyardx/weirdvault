import { sql } from "drizzle-orm"

import { AUDIT_RETENTION_DAYS } from "@/lib/audit/retention"
import { db } from "@/lib/db"

/**
 * Deleting audit events that have aged out of their retention window.
 *
 * Thirty days without a subscription, twelve months with one, and the numbers
 * are imported rather than retyped. That is the point of this file existing at
 * all: the pruner used to be `scripts/prune-audit.mjs`, a plain node script that
 * could not import TypeScript, so it carried a second copy of the windows and a
 * test read it as *text* to check the literals still matched. The copy is gone,
 * the test that policed it is gone, and the retention promise now has one
 * source.
 *
 * ── Over-keeping, deliberately
 *
 * The tier a row is judged against is decided by whether the account has a
 * `subscription` row at all — any row, whatever its status, however long ago it
 * lapsed. That is not `tierForSubscription`, which also weighs status and period
 * end, and the difference is chosen rather than lazy.
 *
 * The two failures are not symmetrical. Over-keeping leaves rows on disk that
 * `GET /api/audit` refuses to return, so the window the user is shown stays true
 * whether or not this ever runs — the retention claim is enforced twice, and
 * this is the half that is merely tidying. Over-deleting destroys history a
 * customer was promised and nothing brings it back. When the cheap rule and the
 * exact rule disagree, the one that keeps more wins.
 *
 * What that costs: somebody who subscribed once and cancelled a year ago keeps
 * twelve months of rows on disk rather than thirty days, invisible through the
 * app. If that ever matters for a deletion promise, teach this the real rule —
 * do not shorten the window it applies.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Rows per DELETE.
 *
 * Bounded so a table that has been accumulating since before anyone thought
 * about retention cannot hold a lock long enough to stall writes. An audit
 * insert blocking on a cleanup job would mean losing the record of whatever the
 * user was doing at the time, which is the one outcome a cleanup job must not
 * cause.
 */
const BATCH = 5000

/**
 * Batches per run.
 *
 * This runs inside a request now rather than as a script somebody watched, so
 * the bound is about the request finishing rather than about a runaway loop.
 * Twenty batches is a hundred thousand rows — far more than a day accumulates —
 * and stopping short is safe: the next run picks up where this one left off,
 * and the report says it was truncated rather than implying it finished.
 */
const MAX_BATCHES = 20

export interface AuditPruneResult {
  deleted: number
  /** True when the batch ceiling was reached and rows are still expired. */
  truncated: boolean
  /** How many rows were outside the window when the run started. */
  expired: number
}

/**
 * The cutoff each row is judged against.
 *
 * `EXISTS` rather than a join, so an account with no subscription row is simply
 * false and a duplicate row could not multiply the result. It looks up through
 * the unique `subscription_user_idx`, so no new index is needed.
 */
function cutoffCase(freeCutoff: Date, proCutoff: Date) {
  return sql`case when exists (
    select 1 from "subscription" s where s.user_id = a.user_id
  ) then ${proCutoff}::timestamptz else ${freeCutoff}::timestamptz end`
}

export async function pruneAuditEvents(dryRun: boolean): Promise<AuditPruneResult> {
  const now = Date.now()
  const freeCutoff = new Date(now - AUDIT_RETENTION_DAYS.free * DAY_MS)
  const proCutoff = new Date(now - AUDIT_RETENTION_DAYS.pro * DAY_MS)
  const cutoff = cutoffCase(freeCutoff, proCutoff)

  const counted = await db.execute<{ n: string }>(sql`
    select count(*)::bigint as n from "audit_event" a where a.created_at < ${cutoff}
  `)
  const expired = Number(counted.rows[0]?.n ?? 0)

  if (dryRun || expired === 0) return { deleted: 0, truncated: false, expired }

  // One statement per batch, each its own implicit transaction. Deliberately
  // not one transaction across batches: that would hold every row lock until
  // the end and undo the point of batching. Stopping part way leaves fewer
  // expired rows than it found, which is a fine place to stop.
  let deleted = 0
  let batches = 0
  for (; batches < MAX_BATCHES; batches += 1) {
    const result = await db.execute(sql`
      delete from "audit_event" where id in (
        select a.id from "audit_event" a
         where a.created_at < ${cutoff}
         order by a.created_at
         limit ${BATCH}
      )
    `)
    const removed = result.rowCount ?? 0
    if (removed === 0) break
    deleted += removed
  }

  return { deleted, truncated: batches === MAX_BATCHES, expired }
}
