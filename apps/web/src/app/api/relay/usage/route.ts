import { timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { and, eq, inArray, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";
// The per-user lookups moved to lib/billing/subscription.ts when Pro became a
// real subscription: they read the database now, and lib/billing/tiers.ts is
// deliberately kept free of it so /pricing and the landing page can quote a
// limit without dragging a connection pool behind them. The periods and the
// labels are still plain constants and still come from tiers.ts.
import { relayAllowanceFor, tierFor } from "@/lib/billing/subscription";
import { periodFor, periodResetsAt, TIER_LABELS } from "@/lib/billing/tiers";
import {
  isAnonymousSubject,
  isRelayUsageEntry,
  MAX_ENTRIES_PER_BATCH,
  type RelayUsage,
} from "@/lib/usage";

/**
 * Relay transfer accounting: the ingest side, and the meter's read side.
 *
 * The relay counts bytes in memory and posts batched per-account totals here
 * every minute or so (apps/relay/src/reporter.rs). This route accumulates them
 * into relay_usage. It exists so that the relay never needs database
 * credentials: it is the internet-facing component, and widening its blast
 * radius to include Postgres to save a network hop would be a bad trade.
 *
 * Nothing here enforces anything. Enforcement happens at token mint, in
 * /api/relay-token, which already identifies the subject and already refuses
 * bad destinations. An account over its allowance is refused a new token, so
 * new connections stop and sessions already running are never cut mid-byte.
 *
 * Two callers, two authentications, and they share nothing:
 *
 *   POST — the relay, holding RELAY_USAGE_SECRET. Writes.
 *   GET  — a signed-in browser, holding a session cookie. Reads its own row.
 *
 * The GET lives here rather than in its own route because it is the same
 * resource, and because a meter that reads from somewhere other than the table
 * the relay writes to is a meter that can drift from the thing it claims to
 * show.
 */

/**
 * Bearer check in constant time.
 *
 * A dedicated secret rather than RELAY_SECRET, which the relay also holds. That
 * one is an HMAC signing key: it is never transmitted, and a copy of it lets
 * the holder mint a token for any destination the SSRF rules permit — which is
 * to say, use the relay as a proxy. This one is a bearer credential and travels
 * in a header on every flush, so it will end up in a proxy log somewhere. Two
 * purposes, two secrets, two blast radii.
 */
function authorised(request: Request): boolean {
  const secret = process.env.RELAY_USAGE_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/* --------------------------------------------------------------------- POST */

export async function POST(request: Request) {
  if (!authorised(request)) {
    // Also the answer when RELAY_USAGE_SECRET is unset on this deployment. The
    // relay logs loudly at startup when its own half is missing; this side has
    // no one to tell but the caller.
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { entries?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { entries } = body;
  if (!Array.isArray(entries)) {
    return Response.json({ error: "entries (array) required" }, { status: 400 });
  }
  if (entries.length > MAX_ENTRIES_PER_BATCH) {
    return Response.json(
      { error: `at most ${MAX_ENTRIES_PER_BATCH} entries per batch` },
      { status: 413 },
    );
  }

  const valid = entries.filter(isRelayUsageEntry);
  const malformed = entries.length - valid.length;

  /**
   * The period is decided here, from this server's clock, and not taken from
   * the request. A relay with a skewed clock would otherwise write into a month
   * that has not happened. The cost is that a batch flushed a few seconds after
   * midnight UTC on the first lands in the new month with the previous month's
   * bytes in it — under a minute of traffic on a monthly counter, and the
   * alternative is trusting a timestamp from outside.
   */
  const period = periodFor();

  // Anonymous subjects are dropped, not stored — see isAnonymousSubject for
  // why there is nothing they could be stored against.
  const named = valid.filter((e) => !isAnonymousSubject(e.subject));
  const anonymous = valid.length - named.length;

  // Fold duplicates before writing: one flush should be one row touch per
  // account even if the relay ever splits an account across entries.
  const totals = new Map<string, { bytesUp: number; bytesDown: number }>();
  for (const entry of named) {
    const running = totals.get(entry.subject) ?? { bytesUp: 0, bytesDown: 0 };
    running.bytesUp += entry.bytesUp;
    running.bytesDown += entry.bytesDown;
    totals.set(entry.subject, running);
  }

  /**
   * Subjects with no user row are skipped rather than attempted. A deleted
   * account can still have connections draining through a relay that has not
   * noticed, and letting that batch fail on a foreign key would discard the
   * usage of every other account in it.
   */
  let known = new Set<string>();
  if (totals.size > 0) {
    const rows = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(inArray(schema.user.id, [...totals.keys()]));
    known = new Set(rows.map((r) => r.id));
  }

  const rows = [...totals]
    .filter(([userId, t]) => known.has(userId) && (t.bytesUp > 0 || t.bytesDown > 0))
    .map(([userId, t]) => ({
      id: crypto.randomUUID(),
      userId,
      period,
      bytesUp: t.bytesUp,
      bytesDown: t.bytesDown,
    }));

  if (rows.length > 0) {
    // One statement for the whole batch, and add rather than set.
    //
    // The row is a running total that several relays report into
    // independently, so the increment has to happen in the database — a
    // read-modify-write here would lose one relay's flush whenever two landed
    // together. `excluded` is the row this insert tried to add, which is how
    // Postgres exposes the incoming values to the conflict branch.
    //
    // Duplicates were folded above, which matters: Postgres refuses an
    // ON CONFLICT DO UPDATE that would touch the same row twice in one
    // statement.
    await db
      .insert(schema.relayUsage)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.relayUsage.userId, schema.relayUsage.period],
        set: {
          bytesUp: sql`${schema.relayUsage.bytesUp} + excluded.bytes_up`,
          bytesDown: sql`${schema.relayUsage.bytesDown} + excluded.bytes_down`,
          updatedAt: new Date(),
        },
      });
  }

  // Counts rather than "ok": the relay logs this, and an operator chasing a
  // meter that reads low needs to see which bucket the bytes fell into.
  return Response.json({
    period,
    recorded: rows.length,
    anonymous,
    unknownSubjects: totals.size - known.size,
    malformed,
  });
}

/* ---------------------------------------------------------------------- GET */

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const now = new Date();
  const period = periodFor(now);

  const [row] = await db
    .select()
    .from(schema.relayUsage)
    .where(and(eq(schema.relayUsage.userId, session.user.id), eq(schema.relayUsage.period, period)))
    .limit(1);

  const bytesUp = row?.bytesUp ?? 0;
  const bytesDown = row?.bytesDown ?? 0;
  const tier = await tierFor(session.user.id);

  const payload: RelayUsage = {
    period,
    resetsAt: periodResetsAt(now).toISOString(),
    bytesUp,
    bytesDown,
    bytesTotal: bytesUp + bytesDown,
    allowanceBytes: await relayAllowanceFor(session.user.id),
    tier: TIER_LABELS[tier],
    reportingConfigured: Boolean(process.env.RELAY_USAGE_SECRET),
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };

  return Response.json(payload);
}
