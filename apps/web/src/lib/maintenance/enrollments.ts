import { and, isNull, lt, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * Deleting enrollment tokens that were minted and never used.
 *
 * "Add a machine" mints a one-time token, stores its SHA-256 hash with a short
 * expiry, and the daemon spends it. Most of the time that works and the row has
 * a job for the rest of its life: `agent_id` points at the machine it became, so
 * the waiting page can find it, and the row is deleted along with that agent by
 * the foreign key. Used rows therefore look after themselves.
 *
 * What does not is the abandoned ones. Open the dialog, copy the command, get
 * distracted — the row is left with `used_at` null and `agent_id` null, it
 * expires a few minutes later, and then nothing in the system ever looks at it
 * again or removes it. It survives until the account is deleted.
 *
 * The scale is small and worth saying so rather than dressing up: a hundred
 * bytes per abandoned attempt. This is housekeeping, not a leak. The token was
 * only ever stored as a hash, and an expired row cannot be spent — `/api/agents/
 * enroll` claims it with `expires_at > now()` in the WHERE clause, so an expired
 * token is refused whether or not this has run.
 *
 * The grace period is why the delete is not simply `expires_at < now()`. A row
 * that expired thirty seconds ago may belong to somebody staring at the
 * enrollment page right now, and although deleting it would change nothing about
 * whether their token works — it is already refused — it would change what the
 * page can tell them, turning "that token has expired, make another" into a
 * blank. A day costs nothing and keeps the failure legible.
 */

/** How long an expired, unused row is kept so the UI can explain itself. */
const GRACE_MS = 24 * 60 * 60 * 1000;

export interface EnrollmentPruneResult {
  deleted: number;
  /** Abandoned rows old enough to remove, counted before anything was removed. */
  abandoned: number;
}

export async function pruneAbandonedEnrollments(dryRun: boolean): Promise<EnrollmentPruneResult> {
  const cutoff = new Date(Date.now() - GRACE_MS);

  // Both `used_at IS NULL` and the cutoff, together. Without the first this
  // would delete the row that ties a live agent to the enrollment it came from;
  // without the second it would delete rows out from under the page that has to
  // explain them.
  const abandoned = and(
    isNull(schema.agentEnrollment.usedAt),
    lt(schema.agentEnrollment.expiresAt, cutoff),
  );

  const counted = await db
    .select({ n: sql<string>`count(*)::bigint` })
    .from(schema.agentEnrollment)
    .where(abandoned);
  const total = Number(counted[0]?.n ?? 0);

  if (dryRun || total === 0) return { deleted: 0, abandoned: total };

  const result = await db.delete(schema.agentEnrollment).where(abandoned);
  return { deleted: result.rowCount ?? 0, abandoned: total };
}
