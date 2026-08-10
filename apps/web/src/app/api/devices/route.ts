import { and, desc, eq, isNull } from "drizzle-orm"
import { headers } from "next/headers"

import { clientAddress } from "@/lib/audit/address"
import { ipPrefix } from "@/lib/audit/events"
import { auth } from "@/lib/auth"
import { db, schema } from "@/lib/db"

/**
 * Device registry.
 *
 * Registration is idempotent on (userId, signingKey): the same browser
 * re-registering refreshes last-seen rather than accumulating rows. Revocation
 * tombstones rather than deletes, so audit rows keep a resolvable device
 * reference and a revoked id cannot be re-claimed by a client that simply
 * remembers it.
 *
 * Registration used to also publish an X25519 public key — the address a team
 * key was wrapped to. The team surface is gone, so this route neither accepts
 * nor writes that field any more. `device.public_key` stays in the schema and
 * keeps whatever rows already hold; it is simply never written again, and a
 * client that still sends the field is ignored rather than refused.
 *
 * ---------------------------------------------------------------------------
 * Registration is also what ties a session to a device
 *
 * session.device_id exists so that revoking a device can end exactly its
 * sessions, and this route is the only thing that fills it in. Better Auth
 * creates every session row and knows nothing about devices; the device
 * identity lives in the browser's IndexedDB and cannot be seen server-side at
 * sign-in. So the link is made here, on the request that carries both: the
 * session cookie identifies the row, the body identifies the device, and the
 * client calls this on every sign-in (lib/auth-client.ts).
 *
 * Before this the column had no writer at all, which made the DELETE below a
 * guaranteed no-op — the delete matched zero rows for every device, on every
 * revocation, while the UI told the user the lost laptop had been signed out. A
 * revoked device kept working for the remaining thirty days of its cookie.
 *
 * What it still does not cover, and the revoke dialog says so: a session that
 * signed in before this browser ever registered carries a null device_id and is
 * not matched. "Sign out everywhere" is what ends those.
 */

async function requireSession() {
  return (await auth.api.getSession({ headers: await headers() })) ?? null
}

async function requireUser() {
  return (await requireSession())?.user ?? null
}

/**
 * Records that this session is being used from this device.
 *
 * Best-effort on purpose: a failure here must not fail a registration. The cost
 * of missing it is that revoking this device will not end this particular
 * session, which is the state the column was in for every session before it
 * existed — bad, but not worse than refusing to register the device at all.
 */
async function bindSessionToDevice(sessionId: string, deviceId: string): Promise<void> {
  try {
    await db.update(schema.session).set({ deviceId }).where(eq(schema.session.id, sessionId))
  } catch {
    /* see above */
  }
}

/** Null unless a trusted proxy is configured — see lib/audit/address.ts. */
async function clientIpPrefix(): Promise<string | null> {
  return ipPrefix(clientAddress(await headers()))
}

export async function GET() {
  const user = await requireUser()
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 })

  const rows = await db
    .select({
      id: schema.device.id,
      label: schema.device.label,
      platform: schema.device.platform,
      lastSeenAt: schema.device.lastSeenAt,
      lastSeenIpPrefix: schema.device.lastSeenIpPrefix,
      // device.publicKey is deliberately not selected. Nothing writes it now
      // and nothing renders it, so returning a column that is null on every new
      // device would invite a caller to read meaning into the difference
      // between an old row and a new one where there is none.
      createdAt: schema.device.createdAt,
      revokedAt: schema.device.revokedAt,
    })
    .from(schema.device)
    .where(eq(schema.device.userId, user.id))
    .orderBy(desc(schema.device.lastSeenAt))

  return Response.json({ devices: rows })
}

export async function POST(request: Request) {
  const session = await requireSession()
  const user = session?.user
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 })
  }

  const { id, label, platform, signingKey } = body
  if (typeof id !== "string" || typeof label !== "string" || typeof signingKey !== "string") {
    return Response.json({ error: "id, label and signingKey required" }, { status: 400 })
  }
  if (label.length > 80 || signingKey.length > 128) {
    return Response.json({ error: "field too long" }, { status: 400 })
  }

  const prefix = await clientIpPrefix()

  const [existing] = await db
    .select()
    .from(schema.device)
    .where(and(eq(schema.device.userId, user.id), eq(schema.device.signingKey, signingKey)))
    .limit(1)

  if (existing) {
    // A revoked device may not quietly come back by re-registering; that would
    // make revocation meaningless.
    if (existing.revokedAt) {
      return Response.json({ error: "device revoked" }, { status: 403 })
    }

    await db
      .update(schema.device)
      .set({ lastSeenAt: new Date(), lastSeenIpPrefix: prefix })
      .where(eq(schema.device.id, existing.id))

    await bindSessionToDevice(session.session.id, existing.id)

    return Response.json({ id: existing.id })
  }

  await db.insert(schema.device).values({
    id,
    userId: user.id,
    label,
    platform: typeof platform === "string" ? platform : null,
    signingKey,
    lastSeenIpPrefix: prefix,
  })

  await db.insert(schema.auditEvent).values({
    id: crypto.randomUUID(),
    userId: user.id,
    deviceId: id,
    eventType: "device.registered",
    source: "server",
    ipPrefix: prefix,
    metadata: typeof platform === "string" ? { platform } : {},
  })

  await bindSessionToDevice(session.session.id, id)

  return Response.json({ id }, { status: 201 })
}

export async function DELETE(request: Request) {
  const user = await requireUser()
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 })

  const id = new URL(request.url).searchParams.get("id")
  if (!id) return Response.json({ error: "id required" }, { status: 400 })

  const result = await db
    .update(schema.device)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.device.id, id),
        eq(schema.device.userId, user.id),
        isNull(schema.device.revokedAt),
      ),
    )
    .returning({ id: schema.device.id })

  if (result.length === 0) {
    return Response.json({ error: "not found or already revoked" }, { status: 404 })
  }

  // Revoking the device must also end its sessions, or "revoked" only means
  // "cannot register again" while the existing cookie keeps working. The column
  // this matches on is stamped by POST above, on every sign-in; a session from
  // before that browser registered is not matched and survives until it expires
  // or "sign out everywhere" ends it.
  //
  // One more gap, from auth.ts: session.cookieCache is enabled with a five
  // minute maxAge, so a browser holding a fresh cache cookie is served from it
  // without a database read and keeps working for up to that long after the row
  // is gone. The UI says so rather than promising an instant cut-off.
  await db
    .delete(schema.session)
    .where(and(eq(schema.session.userId, user.id), eq(schema.session.deviceId, id)))

  await db.insert(schema.auditEvent).values({
    id: crypto.randomUUID(),
    userId: user.id,
    eventType: "device.revoked",
    source: "server",
    ipPrefix: await clientIpPrefix(),
    metadata: { revokedDeviceId: id },
  })

  return Response.json({ ok: true })
}
