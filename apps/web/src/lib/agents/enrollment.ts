import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * Enrollment tokens: the one-time secret that turns a machine into an agent.
 *
 * A machine being enrolled has no session and no browser — the person is at a
 * keyboard on a box behind a router. So the only authentication available is
 * something they can carry across on a copy-paste, which means a bearer secret,
 * which means the usual three defences: make it short-lived, make it single-use,
 * and never store the thing itself.
 */

/** Long enough that guessing is not a strategy; the prefix is for humans. */
const TOKEN_BYTES = 32
const PREFIX = "ENROLL_"

/**
 * Ten minutes: long enough to walk to another room and paste it, short enough
 * that a token left in a scrollback is worthless by the time anyone reads it.
 */
export const ENROLLMENT_TTL_MS = 10 * 60 * 1000

/**
 * How many unspent tokens one account may hold at once.
 *
 * Not a security boundary — they expire on their own — but without it a stuck
 * "add a machine" page that retries on error mints one per attempt, and the
 * table grows for as long as the tab is open.
 */
export const MAX_PENDING_ENROLLMENTS = 10

export function mintEnrollmentToken(): { token: string; hash: string } {
  const token = PREFIX + randomBytes(TOKEN_BYTES).toString("base64url")
  return { token, hash: hashEnrollmentToken(token) }
}

/**
 * Hashed, not encrypted and not stored raw.
 *
 * A leaked database should not be a leaked set of live enrollment tokens, for
 * the same reason session tokens are not stored in the clear. SHA-256 with no
 * salt or stretching is correct here and would not be for a password: the input
 * is 32 bytes of CSPRNG output, so there is no dictionary to run and nothing a
 * work factor would buy.
 */
export function hashEnrollmentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

/** Cheap shape check, so an obviously-wrong token never reaches the database. */
export function looksLikeEnrollmentToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(PREFIX) &&
    value.length > PREFIX.length + 20 &&
    value.length < 200
  )
}

/**
 * Constant-time comparison, for callers that hold both halves.
 *
 * The lookup path does not need this — it selects by hash, and an index lookup
 * leaks nothing useful about a value it either finds or does not — but anything
 * that ever compares two tokens directly should use this rather than `===`.
 */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Where an agent should connect, derived from where browsers connect.
 *
 * One deployment, one relay, and the agent paths are siblings of the browser's
 * /ws on the same origin — so an operator who has configured the relay at all
 * has already configured this. A second environment variable would be a second
 * thing to get wrong, and getting it wrong produces agents that enroll happily
 * and then never appear.
 *
 * Returns null when the relay is not configured, which the enrollment route
 * turns into a refusal rather than handing the agent a URL to nowhere.
 */
/**
 * Where an agent looks for a newer build of itself.
 *
 * Handed out at enrolment and written into the agent's config, rather than
 * compiled in, so a self-hosted deployment updates its own machines from its own
 * origin and never phones anywhere else.
 *
 * Same value `/install.sh` downloads from, deliberately: the binary an agent
 * replaces itself with must be the one a fresh install would get, or a machine's
 * behaviour would depend on how it was set up.
 *
 * The agent refuses plaintext http from anything but loopback — it is fetching
 * something it will execute as root, unattended, forever — so a deployment
 * served over http:// simply will not self-update, which is the correct outcome
 * rather than an error to work around.
 */
export function agentReleaseUrl(origin: string): string {
  return process.env.AGENT_RELEASE_BASE_URL?.replace(/\/$/, "") || `${origin}/agent-bin`
}

export function agentRelayUrl(): string | null {
  const relay = process.env.NEXT_PUBLIC_RELAY_URL
  if (!relay) return null

  try {
    const url = new URL(relay)
    url.pathname = "/agent"
    url.search = ""
    url.hash = ""
    return url.toString().replace(/\/$/, "")
  } catch {
    return null
  }
}
