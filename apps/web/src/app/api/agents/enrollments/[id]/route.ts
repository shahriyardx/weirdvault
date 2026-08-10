import { headers } from "next/headers"
import { and, eq } from "drizzle-orm"

import { auth } from "@/lib/auth"
import { db, schema } from "@/lib/db"

/**
 * Has the machine called home yet?
 *
 * The enrollment page polls this while the user runs the install command on the
 * other box. When the token is spent this starts returning the agent, including
 * its fingerprint — which is the whole reason the page waits rather than saying
 * "probably done": the user compares that fingerprint against the one the
 * command printed on the machine in front of them before adopting it.
 *
 * Polling rather than a stream. The wait is bounded by a ten-minute token and
 * ends the moment the user closes the tab, and a WebSocket or an SSE stream to
 * carry one state change would be a connection to hold open, reconnect and
 * clean up for the sake of a few seconds' latency nobody is watching for.
 */

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await params

  const [row] = await db
    .select({
      expiresAt: schema.agentEnrollment.expiresAt,
      usedAt: schema.agentEnrollment.usedAt,
      agentId: schema.agentEnrollment.agentId,
    })
    .from(schema.agentEnrollment)
    .where(
      and(eq(schema.agentEnrollment.id, id), eq(schema.agentEnrollment.userId, session.user.id)),
    )
    .limit(1)

  if (!row) return Response.json({ error: "not found" }, { status: 404 })

  if (!row.usedAt || !row.agentId) {
    // Expiry is reported rather than left for the caller to work out from a
    // timestamp, so the page can stop polling and offer a fresh token instead
    // of spinning against a token that can no longer be spent.
    const expired = row.expiresAt.getTime() <= Date.now()
    return Response.json({
      status: expired ? "expired" : "waiting",
      expiresAt: row.expiresAt.toISOString(),
    })
  }

  const [agent] = await db
    .select({
      id: schema.agent.id,
      label: schema.agent.label,
      fingerprint: schema.agent.fingerprint,
      hostname: schema.agent.hostname,
      os: schema.agent.os,
      arch: schema.agent.arch,
      agentVersion: schema.agent.agentVersion,
      lastSeenAt: schema.agent.lastSeenAt,
      createdAt: schema.agent.createdAt,
    })
    .from(schema.agent)
    .where(and(eq(schema.agent.id, row.agentId), eq(schema.agent.userId, session.user.id)))
    .limit(1)

  if (!agent) {
    // The agent was revoked and cascaded away between the token being spent and
    // this poll. Rare, but "claimed by something that no longer exists" is not a
    // state the page should render as success.
    return Response.json({ status: "expired", expiresAt: row.expiresAt.toISOString() })
  }

  return Response.json({ status: "claimed", agent })
}
