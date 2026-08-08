import { and, desc, eq, lt } from "drizzle-orm";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import {
  AUDIT_EVENTS,
  CLIENT_REPORTABLE,
  ipPrefix,
  isAuditEventType,
  validateMetadata,
  type AuditEventType,
} from "@/lib/audit/events";
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

async function requireUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  return session ?? null;
}

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? null;
}

export async function GET(request: Request) {
  const session = await requireUser();
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, MAX_PAGE);
  const before = url.searchParams.get("before");
  const type = url.searchParams.get("type");

  const conditions = [eq(schema.auditEvent.userId, session.user.id)];
  if (before) {
    const cursor = new Date(before);
    if (!Number.isNaN(cursor.valueOf())) {
      conditions.push(lt(schema.auditEvent.createdAt, cursor));
    }
  }
  if (type && isAuditEventType(type)) {
    conditions.push(eq(schema.auditEvent.eventType, type));
  }

  const rows = await db
    .select()
    .from(schema.auditEvent)
    .where(and(...conditions))
    .orderBy(desc(schema.auditEvent.createdAt))
    .limit(limit);

  return Response.json({
    events: rows,
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt : null,
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
    return Response.json(
      { error: `${eventType} is not client-reportable` },
      { status: 403 },
    );
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
    organizationId: session.session.activeOrganizationId ?? null,
    deviceId: typeof deviceId === "string" ? deviceId : null,
    eventType,
    source: AUDIT_EVENTS[eventType].source,
    targetRef: (targetRef as string) ?? null,
    ipPrefix: ipPrefix(await clientIp()),
    metadata: meta.value,
  });

  return Response.json({ ok: true }, { status: 201 });
}
