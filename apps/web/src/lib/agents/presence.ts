import { createHmac } from "node:crypto"

/**
 * Which of an account's machines are reachable right now.
 *
 * `last_seen_at` is stamped when an agent authenticates — on connect and on
 * every reconnect, never on a timer — so a machine that has been up and idle
 * for a week carries a week-old timestamp and is perfectly reachable. It
 * distinguishes "enrolled and never came back" from "has connected at some
 * point", and nothing finer. This asks the only process that knows.
 *
 * The relay's registry of control connections is that knowledge, and it is the
 * same thing /ws consults before agreeing to open a session. Asking it here
 * means the dashboard and the connect path cannot disagree about whether a
 * machine is there.
 *
 * ## Why a token rather than a shared secret header
 *
 * The relay already verifies HMAC tokens minted with RELAY_SECRET, so this
 * needs no new credential — and the token carries the account, which is what
 * scopes the answer. `RELAY_AGENT_SECRET` was the alternative and is the wrong
 * one: it is the relay's credential for calling *us*, and lending it to the
 * reverse direction would make one leaked bearer token work both ways.
 *
 * The token is scoped (see `scope` in apps/relay/src/token.rs) so it cannot
 * open a socket, and a token that can open a socket cannot ask this question.
 */

/** Must match SCOPE_PRESENCE in apps/relay/src/token.rs. */
const SCOPE_PRESENCE = "presence"

/**
 * Seconds a presence token is good for.
 *
 * Short because it is minted per request and used immediately, one hop away on
 * a private network. It exists to be spent, not carried.
 */
const TOKEN_TTL_SECONDS = 30

/**
 * How long to wait for the relay.
 *
 * The machines page must render whether or not the relay answers, so this is a
 * budget rather than a deadline for correctness: exceed it and every row falls
 * back to "unknown", which is a true statement.
 */
const TIMEOUT_MS = 2000

/**
 * What the relay is reachable at from the server, which is not what a browser
 * uses.
 *
 * NEXT_PUBLIC_RELAY_URL is the public wss:// address, through whatever proxy
 * terminates TLS. Server to relay is an internal hop — `http://relay:8080` in
 * the compose deployment — and going out through the public name would mean a
 * page that cannot say whether a machine is online because the *proxy* is
 * having a bad day.
 *
 * Derived from the public URL when unset, so a deployment that never heard of
 * this variable still works: same host, http(s) instead of ws(s), no path. That
 * derivation is a fallback and not a design — set RELAY_INTERNAL_URL.
 */
export function relayInternalUrl(): string | null {
  const explicit = process.env.RELAY_INTERNAL_URL?.replace(/\/$/, "")
  if (explicit) return explicit

  const publicUrl = process.env.NEXT_PUBLIC_RELAY_URL
  if (!publicUrl) return null

  try {
    const url = new URL(publicUrl)
    url.protocol =
      url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol
    url.pathname = ""
    url.search = ""
    url.hash = ""
    return url.toString().replace(/\/$/, "")
  } catch {
    return null
  }
}

/** Mints the scoped token the relay will verify. Exported for the fixture test. */
export function mintPresenceToken(secret: string, accountId: string, nowSeconds: number): string {
  const claims = {
    sub: accountId,
    scope: SCOPE_PRESENCE,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
  }
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")
  const signature = createHmac("sha256", secret).update(payload).digest("base64url")
  return `${payload}.${signature}`
}

/**
 * Three states, because there are three.
 *
 * "Unknown" is not a hedge — reporting every machine offline because one
 * internal call timed out would be a screen full of alarming and false
 * statements, and the user would go looking at machines that are fine.
 */
export type Presence = { status: "ok"; online: Set<string> } | { status: "unknown"; reason: string }

export async function agentPresence(accountId: string, agentIds: string[]): Promise<Presence> {
  if (agentIds.length === 0) return { status: "ok", online: new Set() }

  const secret = process.env.RELAY_SECRET
  if (!secret) return { status: "unknown", reason: "no relay is configured" }

  const base = relayInternalUrl()
  if (!base) return { status: "unknown", reason: "no relay address" }

  const token = mintPresenceToken(secret, accountId, Math.floor(Date.now() / 1000))

  try {
    const res = await fetch(`${base}/agents/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ agentIds }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    })
    if (!res.ok) return { status: "unknown", reason: `relay answered ${res.status}` }

    const body = (await res.json()) as { online?: unknown }
    if (!Array.isArray(body.online)) return { status: "unknown", reason: "unreadable answer" }

    return { status: "ok", online: new Set(body.online.filter((id) => typeof id === "string")) }
  } catch (e) {
    // Includes the timeout. Not logged as an error: a relay being restarted is
    // an ordinary thing that this page is designed to render through.
    return { status: "unknown", reason: e instanceof Error ? e.message : "unreachable" }
  }
}
