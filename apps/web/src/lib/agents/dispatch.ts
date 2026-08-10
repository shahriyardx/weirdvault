import { randomUUID } from "node:crypto"

import { type AgentCommand, signCommand } from "@/lib/agents/commands"
import { mintPresenceToken, relayInternalUrl } from "@/lib/agents/presence"

/**
 * Getting a signed command to a machine, and bringing back what it said.
 *
 * The chain of authority ends at the agent, not here: the route checks the
 * session and the ownership, this signs, the relay carries, and the agent
 * verifies the signature before acting. Each link can refuse; only the last one
 * can be trusted to have checked, which is the entire point of signing.
 *
 * What comes back is the agent's own words — "already running the published
 * build", "aaaa1111 has 3 sessions open" — passed through unread by the relay.
 * That is what makes a refusal legible instead of a silence.
 */

/** How long to wait for the whole round trip, a little past the relay's own. */
const TIMEOUT_MS = 25_000

export type DispatchResult = {
  ok: boolean
  detail: string
  /** True only when the reason is that this deployment cannot sign at all. */
  unconfigured?: boolean
}

export async function dispatchCommand(
  /**
   * The account that owns this agent — already proved by the caller's WHERE
   * clause, and passed in rather than looked up again here so that signing for
   * one account and addressing another is not a thing this function can do.
   */
  accountId: string,
  agentId: string,
  command: AgentCommand,
): Promise<DispatchResult> {
  const signed = signCommand(agentId, command)
  if (!signed) {
    // Never an unsigned command. An agent that accepted one would undo the
    // reason the key exists, so the honest answer is that the deployment has
    // not turned this on.
    return {
      ok: false,
      unconfigured: true,
      detail:
        "This deployment has no command signing key, so machines cannot be controlled from here. " +
        "Set AGENT_COMMAND_SECRET and re-enrol the machines that should accept commands.",
    }
  }

  const base = relayInternalUrl()
  if (!base) {
    return {
      ok: false,
      detail: "No relay is configured, so there is nothing to send this through.",
    }
  }

  const secret = process.env.RELAY_SECRET
  if (!secret) {
    return {
      ok: false,
      detail: "No relay is configured, so there is nothing to send this through.",
    }
  }

  // The id correlates the answer with the request. Chosen here rather than by
  // the relay so the log line and the reply can be tied together from this side.
  const id = randomUUID()

  // Exactly the frame the agent will verify. Built here and passed through the
  // relay verbatim: anything the relay could usefully rewrite is something it
  // could usefully forge.
  const envelope = JSON.stringify({
    type: "command",
    id,
    agentId,
    command: signed.command,
    nonce: signed.nonce,
    expiresAt: signed.expiresAt,
    signature: signed.signature,
  })

  const token = mintPresenceToken(secret, accountId, Math.floor(Date.now() / 1000))

  try {
    const res = await fetch(`${base}/agents/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ agentId, id, envelope }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    })
    if (!res.ok) {
      return { ok: false, detail: `The relay could not deliver this (${res.status}).` }
    }

    const body = (await res.json()) as { ok?: unknown; detail?: unknown }
    return {
      ok: body.ok === true,
      detail: typeof body.detail === "string" && body.detail ? body.detail : "No detail given.",
    }
  } catch {
    // Includes the timeout. Deliberately not "it failed": the command may have
    // been carried out and the answer lost, and saying otherwise would have
    // somebody press the button again.
    return {
      ok: false,
      detail: "The relay did not answer in time. The machine may still have carried this out.",
    }
  }
}
