import { headers } from "next/headers"
import { and, eq, isNull } from "drizzle-orm"

import { auth } from "@/lib/auth"
import { clientAddress } from "@/lib/audit/address"
import { ipPrefix } from "@/lib/audit/events"
import { db, schema } from "@/lib/db"
import { AGENT_COMMANDS, type AgentCommand } from "@/lib/agents/commands"
import { dispatchCommand } from "@/lib/agents/dispatch"
import { enforce } from "@/lib/rate-limit"

/**
 * Telling a machine to do something.
 *
 * The authorisation is here and the proof of it is at the other end: this route
 * checks the session and puts the owner in the WHERE clause, then signs an
 * envelope the agent verifies for itself before acting. The relay in between
 * carries it and cannot forge one — which is what makes it safe for a command to
 * stop a daemon or delete an identity, and is the reason
 * docs/MULTI-ACCOUNT-AGENTS.md treats signing as the load-bearing part.
 *
 * A revoked agent is excluded by the WHERE clause rather than checked
 * afterwards, on the same rule the rest of this feature follows: a comparison is
 * a line that survives being deleted, a missing clause is not.
 */

/**
 * How many commands one account may send a minute.
 *
 * Generous for a person pressing buttons and far below what would make this a
 * way to keep somebody's machine restarting. Each one costs a round trip to a
 * daemon on somebody's home connection, which is the real reason to bound it.
 */
const COMMAND_LIMIT = { max: 20, windowSeconds: 60 }

function isCommand(value: unknown): value is AgentCommand {
  return typeof value === "string" && (AGENT_COMMANDS as readonly string[]).includes(value)
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() })
  const user = session?.user
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { id } = await params

  let body: { command?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 })
  }
  if (!isCommand(body.command)) {
    return Response.json(
      { error: `command must be one of ${AGENT_COMMANDS.join(", ")}` },
      { status: 400 },
    )
  }
  const command = body.command

  const limited = await enforce("agent-command", request, COMMAND_LIMIT, {
    userId: user.id,
    message: "Too many commands in the last minute. Wait a moment and try again.",
  })
  if (limited) return limited

  const [agent] = await db
    .select({ id: schema.agent.id, label: schema.agent.label })
    .from(schema.agent)
    .where(
      and(
        eq(schema.agent.id, id),
        eq(schema.agent.userId, user.id),
        isNull(schema.agent.revokedAt),
      ),
    )
    .limit(1)

  // 404 rather than 403, because 403 confirms the id names a real agent — a
  // fact about another account's machines.
  if (!agent) return Response.json({ error: "no such machine" }, { status: 404 })

  const result = await dispatchCommand(user.id, agent.id, command)

  // Written whatever the outcome. The refusals are the interesting rows: "three
  // sessions are open" belongs in the log as much as a restart that worked, and
  // a person wondering why their machine bounced needs the row to exist even
  // when the answer never reached the browser.
  try {
    await db.insert(schema.auditEvent).values({
      id: crypto.randomUUID(),
      userId: user.id,
      eventType: "agent.commanded",
      source: "server",
      ipPrefix: ipPrefix(clientAddress(request.headers)),
      metadata: { command, ok: result.ok },
    })
  } catch (e) {
    // A missing audit row must not turn a command that worked into an error the
    // user sees. It is logged here instead.
    console.warn("could not record agent.commanded", e)
  }

  return Response.json(result)
}
