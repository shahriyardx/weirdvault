import { isNull } from "drizzle-orm"

import { rotationInProgress } from "@/lib/agents/commands"
import { dispatchRotation } from "@/lib/agents/dispatch"
import { agentPresence } from "@/lib/agents/presence"
import { db, schema } from "@/lib/db"

/**
 * Moving the fleet onto a new command signing key.
 *
 * Rotation has a shape that makes it awkward to do by hand: the instruction
 * teaching a machine the new key cannot be signed by the new key, because the
 * machine does not trust it yet. So it is signed by the old one, which means
 * there is a window during which both exist and every machine has to be visited.
 *
 * An operator sets `AGENT_COMMAND_SECRET` to the new seed and
 * `AGENT_COMMAND_SECRET_PREVIOUS` to the old one, and this sweep does the
 * visiting: each night it hands the new public half to whichever machines are
 * connected. A machine that was asleep gets it the next night, and the one after
 * that, until it is awake — which is the entire reason this is a recurring job
 * rather than a button somebody presses once and believes.
 *
 * When the sweep reports every machine holding the new key, the old one can be
 * removed from the environment. Nothing here does that: retiring a key is a
 * decision with a blast radius, and it should be made by a person reading the
 * number rather than by a cron job that thinks it is finished.
 *
 * ## Why it is safe for this to run unattended
 *
 * The instruction is signed by the key being retired, so a deployment that has
 * lost that key cannot rotate — which is correct, and is why a *compromised* key
 * is not rotated away with this. Then the fix is to re-enrol, because the
 * attacker holds the same key this would sign with.
 *
 * The agent keeps both keys. Nothing here can take one away, so a bug in this
 * job cannot leave a machine unable to verify anything; the worst it can do is
 * add a key that was already there, which the agent answers with "already
 * trusted" and no write.
 */

/** How many machines one sweep will visit. */
const MAX_PER_RUN = 200

export interface RotationOutcome {
  /** Machines that took the new key in this run, or already had it. */
  rotated: number
  /** Connected, asked, and did not accept — the number worth looking at. */
  failed: number
  /** Not connected, so not asked. They get it on a later run. */
  offline: number
  /** True when there are more machines than one run visits. */
  truncated: boolean
}

export async function rotateAgentKeys(dryRun: boolean): Promise<RotationOutcome> {
  const idle: RotationOutcome = { rotated: 0, failed: 0, offline: 0, truncated: false }

  // No rotation configured is the ordinary state, and it is not an error: the
  // job reports nothing to do and costs one environment read.
  if (!rotationInProgress()) return idle

  const agents = await db
    .select({ id: schema.agent.id, userId: schema.agent.userId })
    .from(schema.agent)
    .where(isNull(schema.agent.revokedAt))
    .limit(MAX_PER_RUN + 1)

  const truncated = agents.length > MAX_PER_RUN
  const batch = agents.slice(0, MAX_PER_RUN)
  if (batch.length === 0) return idle

  // Grouped by account because presence is answered per account: the relay
  // scopes its answer to the token's owner, which is what stops it being an
  // oracle for agent ids belonging to anybody else.
  const byAccount = new Map<string, string[]>()
  for (const agent of batch) {
    byAccount.set(agent.userId, [...(byAccount.get(agent.userId) ?? []), agent.id])
  }

  let rotated = 0
  let failed = 0
  let offline = 0

  for (const [accountId, ids] of byAccount) {
    const presence = await agentPresence(accountId, ids)
    // A relay that cannot be reached is not evidence that machines are offline,
    // so nothing is counted and the sweep tries again on its next run.
    if (presence.status !== "ok") continue

    for (const id of ids) {
      if (!presence.online.has(id)) {
        offline++
        continue
      }
      if (dryRun) {
        rotated++
        continue
      }

      const result = await dispatchRotation(accountId, id)
      if (result.ok) rotated++
      else failed++
    }
  }

  return { rotated, failed, offline, truncated }
}
