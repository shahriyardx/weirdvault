import { lt, sql } from "drizzle-orm"

import { db, schema } from "@/lib/db"

/**
 * Deleting rate-limit counters whose window closed long ago.
 *
 * `rate_limit` holds one row per bucket — a route plus a user id or a network —
 * so it grows with distinct callers and never shrinks on its own. A counter
 * whose window closed a month ago is read by nothing: the next request from that
 * subject overwrites it in place. It is simply litter.
 *
 * A day is far longer than the longest window any caller configures, which is an
 * hour (`/sign-up/email`, agent enrollment, recording saves), so this can only
 * ever remove rows nobody is counting against. Deleting a live one would fail
 * open anyway — the next request re-creates it with a fresh count, which is the
 * direction lib/rate-limit.ts fails in everywhere — but there is no reason to
 * lean on that when a generous cutoff costs nothing.
 */

/** Comfortably longer than the longest window in use. */
const KEEP_MS = 24 * 60 * 60 * 1000

export interface CounterPruneResult {
  deleted: number
  stale: number
}

export async function clearStaleCounters(dryRun: boolean): Promise<CounterPruneResult> {
  const cutoff = Date.now() - KEEP_MS
  const expired = lt(schema.rateLimit.windowStart, cutoff)

  const counted = await db
    .select({ n: sql<string>`count(*)::bigint` })
    .from(schema.rateLimit)
    .where(expired)
  const stale = Number(counted[0]?.n ?? 0)

  if (dryRun || stale === 0) return { deleted: 0, stale }

  const result = await db.delete(schema.rateLimit).where(expired)
  return { deleted: result.rowCount ?? 0, stale }
}
