import { timingSafeEqual } from "node:crypto";

import { runMaintenance } from "@/lib/maintenance";

/**
 * The scheduled cleanup: audit rows past their retention window, abandoned
 * enrollment tokens, stale rate-limit counters, and recording objects no row
 * claims. What each one does, and why each is safe to repeat, is in
 * lib/maintenance/.
 *
 * ── Why a route rather than a script a container runs
 *
 * The work needs the database, the bucket credentials, the retention windows and
 * the S3 signer. The web container already has all four. A sidecar that did the
 * work itself would need a copy of every one of them — a second place to
 * configure, a second thing holding `R2_SECRET_ACCESS_KEY`, and its own copy of
 * anything it could not import.
 *
 * That last part is not hypothetical. This replaced two node scripts, and
 * because the runtime image is Next's standalone output — no `src/`, no
 * TypeScript — neither could import from the app. So one carried a second copy
 * of the audit retention windows and the other carried a second complete
 * implementation of AWS SigV4, each with a test whose only job was to notice
 * when the copy drifted. Both copies are gone.
 *
 * So the scheduler holds one secret and knows one URL, and can be anything: the
 * `cron` service in compose.prod.yaml, a systemd timer, a crontab line, Upstash,
 * a GitHub Action. On a serverless deployment it has to be external, because
 * there is no long-lived process to put a loop in.
 *
 * ── The secret
 *
 * A bearer token compared in constant time, in its own variable rather than
 * reusing `RELAY_SECRET` or `BETTER_AUTH_SECRET`. Those are signing keys that
 * are never transmitted; this one travels on the wire on every invocation and
 * will end up in a proxy log somewhere. Different lifetime, different blast
 * radius, different variable — the same reasoning `RELAY_USAGE_SECRET` follows.
 *
 * Unset means the route refuses everything, including a caller with the right
 * token. It does not mean "open": an endpoint that deletes rows and objects must
 * never become reachable because a variable was forgotten. compose.prod.yaml
 * refuses to start the `cron` service without it for the same reason — a
 * scheduler quietly posting into a 503 every night is a maintenance job nobody
 * knows has never run.
 *
 * ── Why POST
 *
 * It changes things. A GET that deletes rows is one prefetch, one crawler or one
 * link preview away from running itself, and `Cache-Control` is not a defence
 * against a scheduler that retries.
 *
 * ── The status code
 *
 * A failed job produces a 500 even when the others succeeded, because the caller
 * is a scheduler and a scheduler's only lever is retry. A 200 with the failure
 * buried in the body is a failure nobody sees. The body still reports every job,
 * so the retry is informed, and every job is safe to repeat.
 */

/** Node APIs and a database; never static, never cached. */
export const dynamic = "force-dynamic";

/**
 * Long enough for a real sweep, short enough that a stuck run is noticed.
 * Each job is bounded internally, so this is a backstop rather than the control
 * — and it matters on platforms that cap a function's duration, where a run cut
 * short has still made real progress because every job commits as it goes.
 */
export const maxDuration = 300;

function authorised(request: Request): boolean {
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

  // Compared as bytes at equal length, so it cannot be timed. The length check
  // is unavoidable and leaks only the length.
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!process.env.CRON_SECRET) {
    return Response.json(
      {
        error:
          "This deployment has no CRON_SECRET, so scheduled maintenance never runs: audit rows " +
          "accumulate past the window the app promises, and orphaned recording objects " +
          "accumulate in the bucket. Set it, and point a scheduler at this route — " +
          "compose.prod.yaml ships one.",
      },
      { status: 503 },
    );
  }

  if (!authorised(request)) {
    // No detail. The only caller that should reach this is a scheduler with the
    // wrong secret, and telling anyone else what is missing helps only them.
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // `?dryRun=1` counts what each job would do and changes nothing — the first
  // thing worth doing after wiring up a scheduler is seeing what it is about to
  // delete on real data.
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  const report = await runMaintenance(dryRun);

  for (const job of report.jobs) {
    console.info(
      `maintenance: ${job.job} — ${job.summary}${job.truncated ? " (truncated; more remains)" : ""}`,
    );
  }

  return Response.json(report, { status: report.ok ? 200 : 500 });
}
