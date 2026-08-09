// Deletes audit events that have aged out of their retention window.
//
// Thirty days on Free, twelve months on Pro. Nothing schedules this: there is no
// cron container and no in-process timer, deliberately, because a scheduler is
// an operational choice and this repo does not get to make it on a machine it
// has never seen. apps/web/README.md shows a crontab line, a systemd timer and a
// compose profile; pick one. Until you do, this script has never run.
//
// That is survivable rather than a hole, because GET /api/audit applies the same
// cutoff on read (see src/lib/audit/retention.ts). An unpruned row is invisible
// through the app from the moment it ages out; running this is what makes it
// actually gone from disk, which is the part a deletion promise is about.
//
// Deliberately uses `pg` and nothing else, for the same reason migrate.mjs does:
// the runtime image is Next's standalone output, which traces only what the app
// imports. drizzle-kit is a build-time tool and is not in there, and neither is
// any TypeScript — which is why the windows below are a second copy of the
// numbers in src/lib/audit/retention.ts rather than an import of them.
//
// The copies are checked, if crudely: src/lib/audit/retention.test.ts reads this
// file as text and asserts the literal below matches AUDIT_RETENTION_DAYS. So
// changing one and not the other fails `bun test` rather than silently deleting
// rows the API would still have returned. Reshaping the declaration will fail it
// too — that is the intended outcome, and the fix is to look at both files.
//
//   node apps/web/scripts/prune-audit.mjs
//   node apps/web/scripts/prune-audit.mjs --dry-run
//   node apps/web/scripts/prune-audit.mjs --batch=2000
//
// Safe to run repeatedly and safe to run concurrently with the app: it deletes
// only rows already outside the window, so a second run finds nothing left to do
// and a run that dies half way through has still made real progress.

import pg from "pg";

/**
 * Retention windows in days. Mirrors AUDIT_RETENTION_DAYS in
 * src/lib/audit/retention.ts — see the note above about why this is a copy.
 */
const RETENTION_DAYS = { free: 30, pro: 365 };

/**
 * Two windows, chosen per account — and chosen by over-keeping.
 *
 * There used to be one constant here, because there was no billing and every
 * account was Free. Pro is a real subscription now, so a single window would
 * delete a paying customer's twelve months of history at the thirty-day Free
 * cutoff, while /pricing and the Activity page both promise twelve. That is
 * precisely the failure the two-place enforcement exists to prevent, arriving
 * from the side that does the deleting.
 *
 * The obvious fix is to transcribe `tierForSubscription` from
 * src/lib/billing/tiers.ts into SQL: active or trialing, past_due and unpaid
 * until the period ends, canceled only when it was scheduled. That is a second
 * copy of a non-trivial rule, in a language that cannot be tested against the
 * first, with row deletion as the failure mode.
 *
 * So prune-audit deliberately over-keeps instead. Any account with a
 * subscription row at all — whatever its status, however long ago it lapsed —
 * gets the Pro window. Accounts with no row, and rows whose user has been
 * deleted, get the Free window.
 *
 * The asymmetry is the point. Over-keeping leaves rows on disk that
 * `GET /api/audit` refuses to return, which is exactly the state this file's
 * header already describes as survivable: the window a user is shown is enforced
 * on read whether or not this ever runs. Over-deleting destroys data a customer
 * was promised, and nothing brings it back. When the two rules disagree, the one
 * that keeps more wins.
 *
 * What this costs, stated plainly: somebody who subscribed once and cancelled a
 * year ago keeps twelve months of audit rows on disk rather than thirty days,
 * invisible through the app. If that matters for a deletion promise, the fix is
 * to teach this script the real rule, not to shorten the window it applies.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rows per DELETE. Bounded so a table that has been accumulating since before
 * anyone thought about retention does not take a lock long enough to stall
 * writes — an audit insert blocking on a cleanup job would mean losing the
 * record of whatever the user was doing at the time.
 */
const DEFAULT_BATCH = 5000;

/** Refuses to loop forever if deletes stop making progress for any reason. */
const MAX_BATCHES = 10_000;

function flag(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
}

function positiveInt(raw, fallback, label) {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`prune-audit: --${label} must be a positive integer, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("prune-audit: DATABASE_URL is not set");
  process.exit(1);
}

const dryRun = flag("dry-run") !== null;
const batch = positiveInt(flag("batch"), DEFAULT_BATCH, "batch");

/**
 * `--days` collapses both windows to one number.
 *
 * An override for a one-off backfill or a shorter window on a test database. It
 * does not change what the app enforces on read, so a value below either tier
 * window deletes rows the API would still have been willing to return — and it
 * now applies to Pro accounts too, which is the whole reason it warns.
 */
const daysFlag = flag("days");
// A bare `--days` with no value means "no override", the same as omitting it.
// Written out rather than leaning on positiveInt's fallback, because the
// fallback here would have to be a number and there is no single number that
// could stand for two windows — a zero would delete the table.
const override = daysFlag === null || daysFlag === "" ? null : positiveInt(daysFlag, 0, "days");

const freeDays = override ?? RETENTION_DAYS.free;
const proDays = override ?? RETENTION_DAYS.pro;
const freeCutoff = new Date(Date.now() - freeDays * DAY_MS);
const proCutoff = new Date(Date.now() - proDays * DAY_MS);

if (override !== null) {
  console.warn(
    `prune-audit: --days=${override} overrides both windows ` +
      `(free ${RETENTION_DAYS.free}, pro ${RETENTION_DAYS.pro}); ` +
      "the API still filters reads at the tier window",
  );
}

/**
 * The cutoff each row is judged against.
 *
 * `EXISTS` against `subscription` rather than a join, so a user with no row is
 * simply false and a duplicate row could not multiply the result. Deliberately
 * no status test — see the note at the top about over-keeping — and no index is
 * needed beyond the unique `subscription_user_idx` this looks up through.
 */
const CUTOFF_FOR_ROW = `
  CASE WHEN EXISTS (
    SELECT 1 FROM "subscription" s WHERE s.user_id = a.user_id
  ) THEN $2::timestamptz ELSE $1::timestamptz END`;

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const { rows: [before] } = await client.query(
    `SELECT count(*)::bigint AS n, min(a.created_at) AS oldest
       FROM "audit_event" a
      WHERE a.created_at < ${CUTOFF_FOR_ROW}`,
    [freeCutoff, proCutoff],
  );
  const expired = Number(before.n);

  console.log(
    `prune-audit: windows ${freeDays} days without a subscription, ${proDays} with one ` +
      `(cutoffs ${freeCutoff.toISOString()} and ${proCutoff.toISOString()}), ` +
      `${expired} expired ${expired === 1 ? "row" : "rows"}` +
      (before.oldest ? `, oldest ${new Date(before.oldest).toISOString()}` : ""),
  );

  if (dryRun) {
    console.log("prune-audit: --dry-run, nothing deleted");
  } else {
    // One statement per batch, each its own implicit transaction. Deliberately
    // not wrapped in a single transaction across batches: that would hold every
    // row lock until the end and undo the point of batching. A crash part way
    // leaves fewer expired rows than it found, which is a fine place to stop.
    let deleted = 0;
    let batches = 0;

    for (; batches < MAX_BATCHES; batches += 1) {
      const result = await client.query(
        `DELETE FROM "audit_event"
           WHERE id IN (
             SELECT a.id FROM "audit_event" a
              WHERE a.created_at < ${CUTOFF_FOR_ROW}
              ORDER BY a.created_at
              LIMIT $3
           )`,
        [freeCutoff, proCutoff, batch],
      );
      if (result.rowCount === 0) break;
      deleted += result.rowCount;
    }

    if (batches === MAX_BATCHES) {
      console.error(
        `prune-audit: stopped at ${MAX_BATCHES} batches with rows still expired; ` +
          "run again, and check whether something is writing back-dated rows",
      );
    }

    // Reports what it actually deleted, not what it intended to. The two differ
    // when the app inserts nothing but an event ages past the cutoff mid-run, or
    // when a concurrent run got there first.
    console.log(
      deleted === 0
        ? "prune-audit: nothing to delete"
        : `prune-audit: deleted ${deleted} ${deleted === 1 ? "row" : "rows"} in ${batches} ${batches === 1 ? "batch" : "batches"}`,
    );
  }

  const { rows: [after] } = await client.query(
    'SELECT count(*)::bigint AS n, min(created_at) AS oldest FROM "audit_event"',
  );
  console.log(
    `prune-audit: ${Number(after.n)} rows remain` +
      (after.oldest ? `, oldest ${new Date(after.oldest).toISOString()}` : ""),
  );

  // No VACUUM. The rows are gone as far as every query is concerned, but the
  // space is not returned to the filesystem until autovacuum gets to the table;
  // saying "deleted" here means the rows cannot be read back, not that the disk
  // shrank. A VACUUM FULL would take an exclusive lock and is the operator's
  // call, not this script's.
} finally {
  await client.end();
}
