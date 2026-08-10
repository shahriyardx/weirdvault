import { randomUUID } from "node:crypto"
import { headers } from "next/headers"
import { and, desc, eq, gt, isNull } from "drizzle-orm"

import { auth } from "@/lib/auth"
import { db, schema } from "@/lib/db"
import {
  agentRelayUrl,
  ENROLLMENT_TTL_MS,
  MAX_PENDING_ENROLLMENTS,
  mintEnrollmentToken,
} from "@/lib/agents/enrollment"

/**
 * The owner's side of agents.
 *
 *   GET  — list this account's machines
 *   POST — mint a one-time enrollment token for a new one
 *
 * Both scope by user id in the WHERE clause rather than reading a row and
 * comparing, for the same reason /api/recordings/[id] does: a comparison is a
 * line that survives being deleted, a missing WHERE clause is not.
 */

async function requireUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  return session?.user ?? null
}

export async function GET() {
  const user = await requireUser()
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 })

  const rows = await db
    .select({
      id: schema.agent.id,
      label: schema.agent.label,
      fingerprint: schema.agent.fingerprint,
      hostname: schema.agent.hostname,
      os: schema.agent.os,
      arch: schema.agent.arch,
      agentVersion: schema.agent.agentVersion,
      lastSeenAt: schema.agent.lastSeenAt,
      revokedAt: schema.agent.revokedAt,
      createdAt: schema.agent.createdAt,
    })
    .from(schema.agent)
    .where(eq(schema.agent.userId, user.id))
    .orderBy(desc(schema.agent.createdAt))

  return Response.json({ agents: rows })
}

export async function POST() {
  const user = await requireUser()
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 })

  // Refused up front rather than after enrollment. An agent that enrolls
  // successfully and then cannot be reached is a much worse outcome than a
  // clear refusal here, and this is the one moment we can say so.
  const relayUrl = agentRelayUrl()
  if (!relayUrl) {
    return Response.json(
      {
        error:
          "This deployment has no relay configured (NEXT_PUBLIC_RELAY_URL), so an agent " +
          "would have nowhere to connect. Set it and restart before enrolling machines.",
      },
      { status: 503 },
    )
  }

  const now = new Date()
  const pending = await db
    .select({ id: schema.agentEnrollment.id })
    .from(schema.agentEnrollment)
    .where(
      and(
        eq(schema.agentEnrollment.userId, user.id),
        isNull(schema.agentEnrollment.usedAt),
        gt(schema.agentEnrollment.expiresAt, now),
      ),
    )

  if (pending.length >= MAX_PENDING_ENROLLMENTS) {
    return Response.json(
      {
        error: `You already have ${pending.length} unused enrollment tokens. Use one, or wait for them to expire.`,
      },
      { status: 429 },
    )
  }

  const { token, hash } = mintEnrollmentToken()
  const id = randomUUID()
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS)

  await db.insert(schema.agentEnrollment).values({
    id,
    userId: user.id,
    tokenHash: hash,
    expiresAt,
  })

  // The token is returned exactly once, here. Nothing stores it and no later
  // request can retrieve it: the row holds a hash, and a user who loses the
  // command mints another rather than recovering this one.
  return Response.json({
    enrollmentId: id,
    token,
    expiresAt: expiresAt.toISOString(),
  })
}
