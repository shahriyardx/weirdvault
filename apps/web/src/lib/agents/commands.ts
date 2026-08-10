import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto"

/**
 * Instructions an agent can verify came from here.
 *
 * ## Why this key exists
 *
 * The agent proves who it is with an Ed25519 key. Nothing proved anything to the
 * agent: "you are revoked" arrives as a WebSocket close code, and every control
 * message arrives as unauthenticated JSON on a socket the relay owns. The agent
 * trusted the relay because it had no way not to.
 *
 * That was survivable while the worst a rogue relay could do was deny service —
 * an agent that is refused exits, systemd holds it down, and a reboot recovers
 * it. It stops being survivable the moment a command can stop a daemon
 * persistently or delete an identity, because the same forgery becomes "strand
 * every machine this deployment has, permanently, requiring physical access".
 *
 * So the control plane signs. The relay carries the envelope and cannot read
 * the authority in it: it may drop, delay or reorder commands, and it may not
 * invent one.
 *
 * ## The message
 *
 *   weirdvault-command-v1\n<agentId>\n<command>\n<nonce>\n<expiresAt>
 *
 * Domain-separated, like the agent's own proof, because a signature over
 * unstructured bytes is a signature over anything of that shape. The agent id
 * binds it to one identity — which on a shared machine is also what says whose
 * identity is being addressed — the nonce bounds replay, and the expiry makes a
 * captured command useless within the minute.
 *
 * This must stay byte-identical to signingMessageFor in apps/agent/command.go.
 * There is a fixture test on each side, pinned against output the other one
 * produced: a round trip written in one language passes just as happily with
 * both halves wrong in the same way.
 */

/** Commands an agent will act on. Anything else is refused by both ends. */
export const AGENT_COMMANDS = ["restart", "upgrade", "stop", "revoke"] as const
export type AgentCommand = (typeof AGENT_COMMANDS)[number]

/**
 * Adding a key this deployment will sign with in future.
 *
 * Not in the list above because nobody presses a button for it: it is issued by
 * the rotation sweep, and it carries an argument, which none of the others do.
 * The new public key travels *inside* the command string, so the signature
 * covers it — a key carried in a field beside the signature is a key the relay
 * could swap in transit, which is the one thing this mechanism exists to stop.
 */
export const ROTATE_KEY = "rotate-key"

/**
 * How long a signed command is good for.
 *
 * A command is an instruction about now. Sixty seconds covers a slow hop to the
 * relay and a busy agent, and leaves a captured envelope worthless very quickly
 * — which matters because the relay sees every one of them.
 */
export const COMMAND_TTL_SECONDS = 60

/** The exact bytes both ends sign and verify. */
export function commandMessage(
  agentId: string,
  command: string,
  nonce: string,
  expiresAt: number,
): Buffer {
  return Buffer.from(
    `weirdvault-command-v1\n${agentId}\n${command}\n${nonce}\n${expiresAt}`,
    "utf8",
  )
}

/**
 * The signing key, from a 32-byte seed in the environment.
 *
 * A seed rather than a PEM so it is generated the same way as every other secret
 * this deployment holds — `openssl rand -base64 32` — and so `.env` stays a file
 * of single-line values.
 *
 * Absent means remote control is off. That is a supported configuration and not
 * an error: agents refuse unsigned commands, the dashboard does not offer them,
 * and everything else about the product works.
 */
function signingKey(
  seed = process.env.AGENT_COMMAND_SECRET,
): ReturnType<typeof createPrivateKey> | null {
  if (!seed) return null

  const raw = Buffer.from(seed, "base64")
  if (raw.length !== 32) {
    // Named loudly rather than throwing at the first command: a wrong-length
    // key is an operator mistake at deploy time, and the place it would
    // otherwise surface is somebody's failed revoke.
    console.error(
      `AGENT_COMMAND_SECRET must be 32 bytes base64 (openssl rand -base64 32); got ${raw.length}`,
    )
    return null
  }

  // Ed25519 seeds have a fixed PKCS#8 prefix, so wrapping one is concatenation
  // rather than a dependency.
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), raw])
  return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })
}

/**
 * The public half, base64, as it is written into an agent's config at
 * enrolment. Null when this deployment has no key, which the agent stores as an
 * empty list and treats as "refuse every command".
 */
export function commandPublicKey(): string | null {
  const key = signingKey()
  if (!key) return null

  const der = createPublicKey(key).export({ format: "der", type: "spki" })
  // The last 32 bytes of an Ed25519 SPKI are the raw key, which is what the Go
  // side wants — it parses raw keys, not DER.
  return Buffer.from(der.subarray(der.length - 32)).toString("base64")
}

export function remoteControlConfigured(): boolean {
  return signingKey() !== null
}

/**
 * The key being rotated away from, while a rotation is in progress.
 *
 * Rotation has a chicken-and-egg shape: the instruction that teaches a machine
 * the new key cannot be signed by the new key, because the machine does not
 * trust it yet. So an operator sets `AGENT_COMMAND_SECRET` to the new seed and
 * `AGENT_COMMAND_SECRET_PREVIOUS` to the old one, and the sweep signs with the
 * old one — which every machine already trusts — to hand out the new public
 * half.
 *
 * Unset once the fleet has moved, which `weirdvault status` on each machine can
 * confirm. Leaving it set is not dangerous so much as pointless: it keeps a
 * retired key able to command the fleet.
 */
function previousSigningKey() {
  return signingKey(process.env.AGENT_COMMAND_SECRET_PREVIOUS)
}

export function rotationInProgress(): boolean {
  return previousSigningKey() !== null && signingKey() !== null
}

/**
 * Signs the instruction that adds this deployment's current key to an agent.
 *
 * Signed with the *previous* key, because that is the one the agent trusts
 * today. Returns null when there is nothing to rotate — no previous key set, or
 * no current key to hand out — which the caller reads as "no rotation is
 * happening" rather than as a failure.
 */
export function signRotation(agentId: string): SignedCommand | null {
  const previous = previousSigningKey()
  const publicKey = commandPublicKey()
  if (!previous || !publicKey) return null

  const command = `${ROTATE_KEY}:${publicKey}`
  const nonce = randomBytes(32).toString("base64")
  const expiresAt = Math.floor(Date.now() / 1000) + COMMAND_TTL_SECONDS
  const signature = sign(null, commandMessage(agentId, command, nonce, expiresAt), previous)

  return {
    command: command as AgentCommand,
    nonce,
    expiresAt,
    signature: signature.toString("base64"),
  }
}

export interface SignedCommand {
  command: AgentCommand
  nonce: string
  expiresAt: number
  signature: string
}

/**
 * Signs one command for one agent.
 *
 * Returns null when no key is configured, which callers turn into a refusal
 * that says so — never into an unsigned command, because an agent that accepted
 * one would undo everything above.
 */
export function signCommand(agentId: string, command: AgentCommand): SignedCommand | null {
  const key = signingKey()
  if (!key) return null

  const nonce = randomBytes(32).toString("base64")
  const expiresAt = Math.floor(Date.now() / 1000) + COMMAND_TTL_SECONDS
  const signature = sign(null, commandMessage(agentId, command, nonce, expiresAt), key)

  return { command, nonce, expiresAt, signature: signature.toString("base64") }
}

/**
 * An opaque, stable reference to an account.
 *
 * Written into the identity file so the installer can refuse a second enrolment
 * for an account that already has one on this machine — the check that used to
 * be "does agent.json exist", which stops working the moment several accounts
 * legitimately share a directory.
 *
 * Hashed with the deployment's own signing key as the salt, so it is stable for
 * one account on one deployment and meaningless anywhere else. Everyone with a
 * shell on a shared machine can read these files; this lets them see that two
 * identities belong to different people without learning who either is.
 *
 * Falls back to a fixed salt when there is no key. A predictable reference is
 * not a leak — it identifies nothing on its own — and the alternative is
 * dropping the duplicate check for deployments that have not turned on remote
 * control.
 */
export function accountRef(userId: string): string {
  const salt = process.env.AGENT_COMMAND_SECRET || "weirdvault-account-ref-v1"
  return createHash("sha256").update(`${salt}\n${userId}`).digest("base64url").slice(0, 22)
}
