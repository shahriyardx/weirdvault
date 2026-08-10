import { dbErrorSummary } from "@/lib/db/errors"
import { pruneAuditEvents } from "./audit"
import { clearStaleCounters } from "./counters"
import { rotateAgentKeys } from "./rotate-keys"
import { pruneAbandonedEnrollments } from "./enrollments"
import { sweepOrphanedObjects } from "./objects"

/**
 * Everything that has to happen on a timer, in one call.
 *
 * These were two node scripts — `prune-audit.mjs` and `sweep-recordings.mjs` —
 * and nothing ever ran them, because scheduling them meant an operator writing
 * a crontab line for a machine this repo has never seen. They are a route now,
 * with a scheduler in the compose file, so the default deployment does the work
 * rather than documenting it.
 *
 * Moving them out of node and into TypeScript deleted two duplications that
 * existed only because a plain script cannot import from `src/`: the retention
 * windows, which had a test reading a script as *text* to check the numbers
 * still matched, and a whole second SigV4 implementation with a test signing the
 * same requests twice to compare the headers. One copy of each now.
 *
 * ── Jobs do not fail each other
 *
 * Each is caught separately. A bucket that is unreachable must not stop audit
 * rows being pruned, and a slow DELETE must not stop the bucket being swept —
 * they share nothing but a schedule. The report says which failed; the caller
 * decides whether that is worth a non-200, and /api/cron says it is, so a
 * scheduler with retries sees a failure rather than a cheerful 200 with an
 * error buried in the body.
 *
 * ── Everything is bounded and truncation is reported
 *
 * This runs inside a request, so every job has a ceiling on what it will do in
 * one pass. Hitting one is normal and is not an error — the next run continues —
 * but it is always reported, because a job that quietly stopped early reads as
 * "there was nothing left to do".
 *
 * ── Safe to run twice
 *
 * Every job deletes things that are already unreferenced or already outside a
 * window, so a second run finds less to do and a concurrent run duplicates
 * effort rather than causing harm. There is no lock, deliberately: a lock is a
 * thing that can be held by a process that died.
 */

export interface JobOutcome {
  job: string
  ok: boolean
  /** One line, for a log. Never includes a user id or a query. */
  summary: string
  /** Whether a ceiling was hit and work remains for the next run. */
  truncated?: boolean
}

export interface MaintenanceReport {
  dryRun: boolean
  ok: boolean
  durationMs: number
  jobs: JobOutcome[]
}

async function run(
  job: string,
  work: () => Promise<Omit<JobOutcome, "job" | "ok">>,
): Promise<JobOutcome> {
  try {
    return { job, ok: true, ...(await work()) }
  } catch (e) {
    // Summarised rather than logged whole: a drizzle error's message is the SQL
    // and its bound parameters, and those parameters include user ids. See
    // lib/db/errors.ts.
    const summary = dbErrorSummary(e)
    console.error(`maintenance: ${job} failed`, summary)
    return { job, ok: false, summary: `failed: ${summary}` }
  }
}

export async function runMaintenance(dryRun: boolean): Promise<MaintenanceReport> {
  const started = Date.now()

  // Sequential rather than parallel. They all touch the same database, and this
  // exists to run at four in the morning rather than quickly — four concurrent
  // bulk deletes competing for locks is a worse neighbour to a live request than
  // four that wait for each other.
  const jobs: JobOutcome[] = []

  jobs.push(
    await run("audit-events", async () => {
      const r = await pruneAuditEvents(dryRun)
      return {
        summary: dryRun
          ? `${r.expired} expired, none deleted`
          : `deleted ${r.deleted} of ${r.expired} expired`,
        truncated: r.truncated,
      }
    }),
  )

  jobs.push(
    await run("agent-command-keys", async () => {
      const r = await rotateAgentKeys(dryRun)
      return {
        summary:
          r.rotated + r.failed + r.offline === 0
            ? "no rotation configured"
            : `${r.rotated} ${dryRun ? "would take" : "took"} the new key, ${r.failed} refused, ${r.offline} offline`,
        truncated: r.truncated,
      }
    }),
  )

  jobs.push(
    await run("agent-enrollments", async () => {
      const r = await pruneAbandonedEnrollments(dryRun)
      return {
        summary: dryRun
          ? `${r.abandoned} abandoned, none deleted`
          : `deleted ${r.deleted} abandoned`,
      }
    }),
  )

  jobs.push(
    await run("rate-limit-counters", async () => {
      const r = await clearStaleCounters(dryRun)
      return {
        summary: dryRun ? `${r.stale} stale, none deleted` : `deleted ${r.deleted} stale`,
      }
    }),
  )

  jobs.push(
    await run("recording-objects", async () => {
      const r = await sweepOrphanedObjects(dryRun)
      if (!r.applicable) {
        return { summary: "no bucket configured; recordings are in Postgres" }
      }
      return {
        summary:
          (dryRun ? `${r.deleted} orphaned would be deleted` : `deleted ${r.deleted} orphaned`) +
          `, ${r.tooRecent} too recent to touch` +
          (r.failed > 0 ? `, ${r.failed} could not be removed` : ""),
        truncated: r.truncated,
      }
    }),
  )

  return {
    dryRun,
    ok: jobs.every((job) => job.ok),
    durationMs: Date.now() - started,
    jobs,
  }
}
