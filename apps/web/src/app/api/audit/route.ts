import { and, desc, eq, gte, lt } from "drizzle-orm";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { clientAddress } from "@/lib/audit/address";
import {
  AUDIT_EVENTS,
  CLIENT_REPORTABLE,
  ipPrefix,
  isAuditEventType,
  validateMetadata,
  type AuditEventType,
} from "@/lib/audit/events";
import { auditRetentionCutoff, auditRetentionDays } from "@/lib/audit/retention";
import { tierFor } from "@/lib/billing/subscription";
import { db, schema } from "@/lib/db";

/**
 * Audit ingest and query.
 *
 * The server writes what it can observe itself and accepts a narrow set of
 * self-reported client events. Those are marked `source: "client"` rather than
 * being laundered into looking authoritative — a compromised tab can simply not
 * send them, and the log should say so rather than imply completeness.
 */

const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

/**
 * A page size, clamped at both ends.
 *
 * The lower bound is the one that mattered: `?limit=-1` passed `Math.min`
 * untouched and reached Postgres, which refuses a negative LIMIT, so a one
 * character query string answered 500 and left a database exception in the log
 * for every attempt. Unreadable input falls back to the default rather than
 * refusing the request — the same rule /api/recordings uses.
 */
function pageSize(raw: string | null): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE;
  return Math.min(n, MAX_PAGE);
}

async function requireUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  return session ?? null;
}

/**
 * Null unless a trusted proxy is configured — see lib/audit/address.ts. A null
 * prefix is a field we cannot fill; a client-chosen one would be a fabricated
 * record, which is worse on a page whose whole job is to be believed.
 */
async function clientIp(): Promise<string | null> {
  return clientAddress(await headers());
}

export async function GET(request: Request) {
  const session = await requireUser();
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const limit = pageSize(url.searchParams.get("limit"));
  const before = url.searchParams.get("before");
  const type = url.searchParams.get("type");

  /**
   * The retention window is enforced here as well as in the pruner.
   *
   * Nothing schedules the pruner — that is the operator's job and the README
   * says so — which means the table can hold rows past their window for as long
   * as nobody runs it. Filtering on read is what makes "we keep 30 days" a
   * property of the product rather than a property of somebody's crontab.
   *
   * The tier is a database read now, not a constant. `tierFor` fails toward
   * access — a subscription table that cannot be read resolves to Pro — so an
   * incident widens somebody's window rather than silently deleting a year of
   * their history from a page. That direction is deliberate and it is the same
   * one /api/relay-token takes for its quota check.
   *
   * The pruner is the one place the two enforcements can now disagree, because
   * it cannot resolve a tier the way this can. It compensates by over-keeping:
   * see the note at the top of scripts/prune-audit.mjs. Over-keeping means a row
   * on disk this query refuses to return, which is the survivable direction.
   */
  const tier = await tierFor(session.user.id);
  const cutoff = auditRetentionCutoff(tier);

  const conditions = [
    eq(schema.auditEvent.userId, session.user.id),
    gte(schema.auditEvent.createdAt, cutoff),
  ];
  if (before) {
    const cursor = new Date(before);
    if (!Number.isNaN(cursor.valueOf())) {
      conditions.push(lt(schema.auditEvent.createdAt, cursor));
    }
  }
  if (type && isAuditEventType(type)) {
    conditions.push(eq(schema.auditEvent.eventType, type));
  }

  /**
   * `select()` means every column, so `organizationId` comes back on each row —
   * populated on rows written while the team surface existed, null on
   * everything since. Nothing writes it any more: organizations were withdrawn
   * (an account is a person), the session no longer carries an
   * activeOrganizationId, and the column was left in place rather than dropped
   * because a destructive migration buys nothing here.
   *
   * So a null there is the absence of a concept, not lost data, and the mix of
   * populated and null rows in one response is the history of the product
   * rather than a bug. Nothing on the client reads the field.
   */
  const rows = await db
    .select()
    .from(schema.auditEvent)
    .where(and(...conditions))
    .orderBy(desc(schema.auditEvent.createdAt))
    .limit(limit);

  return Response.json({
    events: rows,
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt : null,
    /**
     * The window, stated in the response, and the only place the browser can
     * learn it.
     *
     * It used to be a courtesy for a caller reading this API directly — an
     * export script, a future CLI, telling a short log from a truncated one. It
     * is now load-bearing for the app itself: the Activity page renders this
     * block rather than resolving a tier locally, because a browser knows which
     * account it is signed into and not what that account pays. Everything on
     * that page which names a window reads these three fields, so the sentence
     * on screen and the cutoff in the WHERE clause above are the same fact.
     *
     * An empty page from a `before` cursor older than `retention.since` still
     * means the rows are gone rather than that nothing happened.
     */
    retention: {
      tier,
      days: auditRetentionDays(tier),
      since: cutoff.toISOString(),
    },
  });
}

export async function POST(request: Request) {
  const session = await requireUser();
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { eventType, targetRef, metadata, deviceId } = body;

  if (!isAuditEventType(eventType)) {
    return Response.json({ error: "unknown event type" }, { status: 400 });
  }
  // A browser may only report events it is the natural source of. Letting it
  // post connection.opened would let a compromised tab fabricate relay-grade
  // evidence, which is precisely what the source column exists to prevent.
  if (!CLIENT_REPORTABLE.includes(eventType as AuditEventType)) {
    return Response.json({ error: `${eventType} is not client-reportable` }, { status: 403 });
  }

  const meta = validateMetadata(eventType, metadata);
  if (!meta.ok) return Response.json({ error: meta.error }, { status: 400 });

  if (targetRef !== undefined && targetRef !== null) {
    // Opaque by contract; enforce the shape so a hostname cannot be smuggled in.
    if (typeof targetRef !== "string" || !/^[A-Za-z0-9_-]{16,32}$/.test(targetRef)) {
      return Response.json(
        { error: "targetRef must be a blinded reference, not a hostname" },
        { status: 400 },
      );
    }
  }

  await db.insert(schema.auditEvent).values({
    id: crypto.randomUUID(),
    userId: session.user.id,
    // organizationId is not set. See the note in GET above.
    deviceId: typeof deviceId === "string" ? deviceId : null,
    eventType,
    source: AUDIT_EVENTS[eventType].source,
    targetRef: (targetRef as string) ?? null,
    ipPrefix: ipPrefix(await clientIp()),
    metadata: meta.value,
  });

  return Response.json({ ok: true }, { status: 201 });
}
