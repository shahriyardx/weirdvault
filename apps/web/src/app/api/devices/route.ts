import { and, desc, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";

import { ipPrefix } from "@/lib/audit/events";
import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";

/**
 * Device registry.
 *
 * Registration is idempotent on (userId, signingKey): the same browser
 * re-registering refreshes last-seen rather than accumulating rows. Revocation
 * tombstones rather than deletes, so audit rows keep a resolvable device
 * reference and a revoked id cannot be re-claimed by a client that simply
 * remembers it.
 */

async function requireUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
}

async function clientIpPrefix(): Promise<string | null> {
  const h = await headers();
  return ipPrefix(h.get("x-forwarded-for") ?? h.get("x-real-ip"));
}

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      id: schema.device.id,
      label: schema.device.label,
      platform: schema.device.platform,
      lastSeenAt: schema.device.lastSeenAt,
      lastSeenIpPrefix: schema.device.lastSeenIpPrefix,
      createdAt: schema.device.createdAt,
      revokedAt: schema.device.revokedAt,
    })
    .from(schema.device)
    .where(eq(schema.device.userId, user.id))
    .orderBy(desc(schema.device.lastSeenAt));

  return Response.json({ devices: rows });
}

export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { id, label, platform, signingKey } = body;
  if (typeof id !== "string" || typeof label !== "string" || typeof signingKey !== "string") {
    return Response.json({ error: "id, label and signingKey required" }, { status: 400 });
  }
  if (label.length > 80 || signingKey.length > 128) {
    return Response.json({ error: "field too long" }, { status: 400 });
  }

  const prefix = await clientIpPrefix();

  const [existing] = await db
    .select()
    .from(schema.device)
    .where(and(eq(schema.device.userId, user.id), eq(schema.device.signingKey, signingKey)))
    .limit(1);

  if (existing) {
    // A revoked device may not quietly come back by re-registering; that would
    // make revocation meaningless.
    if (existing.revokedAt) {
      return Response.json({ error: "device revoked" }, { status: 403 });
    }
    await db
      .update(schema.device)
      .set({ lastSeenAt: new Date(), lastSeenIpPrefix: prefix })
      .where(eq(schema.device.id, existing.id));
    return Response.json({ id: existing.id });
  }

  await db.insert(schema.device).values({
    id,
    userId: user.id,
    label,
    platform: typeof platform === "string" ? platform : null,
    signingKey,
    lastSeenIpPrefix: prefix,
  });

  await db.insert(schema.auditEvent).values({
    id: crypto.randomUUID(),
    userId: user.id,
    deviceId: id,
    eventType: "device.registered",
    source: "server",
    ipPrefix: prefix,
    metadata: typeof platform === "string" ? { platform } : {},
  });

  return Response.json({ id }, { status: 201 });
}

export async function DELETE(request: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const result = await db
    .update(schema.device)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(schema.device.id, id),
      eq(schema.device.userId, user.id),
      isNull(schema.device.revokedAt),
    ))
    .returning({ id: schema.device.id });

  if (result.length === 0) {
    return Response.json({ error: "not found or already revoked" }, { status: 404 });
  }

  // Revoking the device must also end its sessions, or "revoked" only means
  // "cannot register again" while the existing cookie keeps working.
  await db.delete(schema.session).where(
    and(eq(schema.session.userId, user.id), eq(schema.session.deviceId, id)),
  );

  await db.insert(schema.auditEvent).values({
    id: crypto.randomUUID(),
    userId: user.id,
    eventType: "device.revoked",
    source: "server",
    ipPrefix: await clientIpPrefix(),
    metadata: { revokedDeviceId: id },
  });

  return Response.json({ ok: true });
}
