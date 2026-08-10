import { headers } from "next/headers"
import { and, eq, isNotNull, isNull } from "drizzle-orm"

import { auth } from "@/lib/auth"
import { db, schema } from "@/lib/db"

/**
 * One agent: rename it, or revoke it.
 *
 * Both handlers put the owner in the WHERE clause. A row belonging to someone
 * else answers 404 rather than 403, because 403 confirms the id names a real
 * agent — a fact about another account's machines.
 */

const MAX_LABEL = 80

async function requireUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  return session?.user ?? null
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await params

  let body: { label?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 })
  }

  // Control characters stripped rather than escaped: a label carrying an ANSI
  // escape would render as something other than what the user typed.
  const cleanLabel = (value: string) =>
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
      .trim()
      .slice(0, MAX_LABEL)

  const label = typeof body.label === "string" ? cleanLabel(body.label) : ""
  if (!label) {
    return Response.json({ error: "label (non-empty string) required" }, { status: 400 })
  }

  const updated = await db
    .update(schema.agent)
    .set({ label })
    .where(and(eq(schema.agent.id, id), eq(schema.agent.userId, user.id)))
    .returning({ id: schema.agent.id, label: schema.agent.label })

  if (updated.length === 0) return Response.json({ error: "not found" }, { status: 404 })
  return Response.json(updated[0])
}

/**
 * Revoke: a tombstone, not a delete.
 *
 * The row is what holds the unique index over `public_key`, so keeping it
 * retires that keypair for good. Delete instead and a machine still holding its
 * agent.json could enrol the same key and rejoin under a new id — which needs a
 * token only the owner can mint, so it is not an attack, but "I revoked that
 * laptop" ought to mean the key is dead rather than dormant. Pass ?forget=1
 * afterwards to delete it for real and free the key.
 *
 * Revoking takes effect immediately in both directions that matter.
 * /api/agents/verify reads `revoked_at`, so the agent's next reconnect fails;
 * /api/relay-token reads it too, so no new session can start in the meantime.
 * A session already open keeps running to its natural end, which is the same
 * choice the transfer allowance makes and for the same reason: nobody's file
 * transfer should be severed because a row changed.
 *
 * What it does NOT do is reach into the relay and drop the live control socket.
 * That would need the control plane to talk to every relay instance, which is
 * the coupling the whole token design exists to avoid. The window is one live
 * control connection carrying no new sessions.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await params

  /**
   * Forget: a real delete, and only for a row that is already revoked.
   *
   * Revoking retires the keypair, because the row is what holds the unique
   * index over public_key. That is usually what you want and occasionally not:
   * a machine you are rebuilding, a test enrolment, a list you would like to
   * stop reading. Forgetting frees the key so that exact machine can enrol
   * again with the config it still has.
   *
   * Gated on already-revoked rather than offered outright, so that "stop this
   * machine connecting" and "and also let it back in later" stay two decisions.
   * Deleting a live agent in one click would quietly make revocation weaker
   * than the word implies.
   */
  if (new URL(request.url).searchParams.get("forget") === "1") {
    const forgotten = await db
      .delete(schema.agent)
      .where(
        and(
          eq(schema.agent.id, id),
          eq(schema.agent.userId, user.id),
          isNotNull(schema.agent.revokedAt),
        ),
      )
      .returning({ id: schema.agent.id })

    if (forgotten.length === 0) {
      return Response.json({ error: "not found, or not revoked yet" }, { status: 404 })
    }
    return Response.json({ ok: true, forgotten: true })
  }

  const revoked = await db
    .update(schema.agent)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.agent.id, id),
        eq(schema.agent.userId, user.id),
        // Already-revoked returns 404 rather than reporting success a second
        // time and moving the timestamp. The first revocation is the one that
        // matters and its time is worth keeping.
        isNull(schema.agent.revokedAt),
      ),
    )
    .returning({ id: schema.agent.id })

  if (revoked.length === 0) return Response.json({ error: "not found" }, { status: 404 })
  return Response.json({ ok: true })
}
