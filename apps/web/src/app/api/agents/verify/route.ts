import { timingSafeEqual } from "node:crypto"
import { eq } from "drizzle-orm"

import { db, schema } from "@/lib/db"
import { verifyAgentSignature } from "@/lib/agents/verify"

/**
 * The relay asking whether an agent is who it says it is.
 *
 * The relay holds no public keys and no database — that is the point of the
 * token design, and giving the internet-facing process the material to
 * authenticate agents would hand it an agent-impersonation credential to save a
 * round trip that happens once per agent per reconnect. So it sends the
 * challenge it issued and the signature it received, and this decides.
 *
 * Deciding here rather than at the relay is also what makes revocation
 * immediate. `revoked_at` is read on this path, so a revoked agent fails its
 * very next reconnect — and /api/relay-token reads it too, so it cannot start a
 * new session in the meantime either. Nothing has to be pushed to the relay and
 * no cache has to expire.
 *
 * ## This endpoint fails closed
 *
 * Unlike /api/relay/usage next door, which mints tokens through a database
 * outage rather than locking people out of their servers. The direction is
 * opposite here on purpose: under-counting bytes costs money, whereas admitting
 * an unverified agent would let anyone who learns an agent id stand in for the
 * machine behind it. So every failure below is a refusal.
 */

/**
 * The relay's credential for this endpoint.
 *
 * Its own variable rather than RELAY_SECRET, which is an HMAC signing key that
 * is never transmitted — a copy of that one lets the holder mint relay tokens.
 * This one rides in a header on every agent reconnect and will end up in a proxy
 * log somewhere. Separate from RELAY_USAGE_SECRET as well, so that a deployment
 * can run agents without usage reporting, or the reverse, without one feature's
 * configuration silently enabling the other's.
 */
function authorised(request: Request): boolean {
  const secret = process.env.RELAY_AGENT_SECRET
  if (!secret) return false

  const header = request.headers.get("authorization") ?? ""
  const presented = header.startsWith("Bearer ") ? header.slice(7) : ""
  const a = Buffer.from(presented, "utf8")
  const b = Buffer.from(secret, "utf8")
  return a.length === b.length && timingSafeEqual(a, b)
}

function refuse(error: string) {
  // 200 with ok:false, not an HTTP error. The relay distinguishes "the control
  // plane said no" from "the control plane could not be reached", and both must
  // refuse the agent — but only the first should be reported to an operator as
  // a decision rather than an outage.
  return Response.json({ ok: false, error })
}

export async function POST(request: Request) {
  if (!authorised(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  let body: { agentId?: unknown; nonce?: unknown; signature?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 })
  }

  const { agentId, nonce, signature } = body
  if (
    typeof agentId !== "string" ||
    typeof nonce !== "string" ||
    typeof signature !== "string" ||
    !agentId ||
    !nonce ||
    !signature
  ) {
    return Response.json(
      { error: "agentId, nonce and signature (strings) required" },
      { status: 400 },
    )
  }

  const [row] = await db
    .select({
      id: schema.agent.id,
      userId: schema.agent.userId,
      publicKey: schema.agent.publicKey,
      revokedAt: schema.agent.revokedAt,
    })
    .from(schema.agent)
    .where(eq(schema.agent.id, agentId))
    .limit(1)

  // Same words for "no such agent" and "wrong signature". The relay logs this
  // and an operator reading the log learns nothing either way, which is correct:
  // whoever is guessing agent ids should not be told when they guess one right.
  if (!row) return refuse("unknown or revoked agent")
  if (row.revokedAt) return refuse("unknown or revoked agent")

  const valid = verifyAgentSignature({
    publicKeyBase64: row.publicKey,
    agentId,
    nonce,
    signatureBase64: signature,
  })
  if (!valid) return refuse("signature did not verify")

  // Best-effort. A failed stamp is a stale "last seen" in the dashboard, and
  // refusing a verified agent over a cosmetic write would take somebody's
  // machine offline for it.
  try {
    await db
      .update(schema.agent)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.agent.id, agentId))
  } catch (e) {
    console.warn("could not stamp agent lastSeenAt", e)
  }

  return Response.json({ ok: true, userId: row.userId })
}
