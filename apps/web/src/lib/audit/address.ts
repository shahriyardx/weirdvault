/**
 * Where a request came from, or an honest null.
 *
 * X-Forwarded-For is written by whoever sent the request. Nothing in HTTP makes
 * it trustworthy; it becomes trustworthy only when a proxy you control
 * *overwrites* the part of it you read. Taking `split(",")[0]` — the left-most
 * value — reads the part every proxy in the world leaves under the client's
 * control, because the standard behaviour (nginx's `proxy_add_x_forwarded_for`,
 * Caddy's `reverse_proxy`) is to append the peer address, preserving whatever
 * the client sent ahead of it. So the left-most entry is not "the client's
 * address"; it is a string the client chose.
 *
 * Two things depend on getting this right, and both were wrong:
 *
 *   The audit log. Every server-written row stores a network prefix, and the
 *   activity page presents it as where the event happened. `recovery.redeemed`
 *   is the worst case: it is written on an unauthenticated request, and it is
 *   the one line in the log that says somebody got in without the password. An
 *   attacker spending a stolen code got to choose what the victim's own log
 *   recorded as the source. A fabricated record is worse than a missing field.
 *
 *   The rate limit on the unauthenticated redeem endpoint, whose bucket key is
 *   this value. A client-chosen key is a fresh budget on every request, so the
 *   limit did not exist.
 *
 * The fix is a hop count rather than a list of proxy addresses: containers get
 * their addresses from an orchestrator and an allowlist would be stale within a
 * deploy. TRUSTED_PROXY_HOPS says how many proxies you have put in front of this
 * app; the address that many hops from the right-hand end is the one the closest
 * one observed and the furthest one a client can still forge. Unset means "no
 * proxy is known to be in front", and then this returns null and every caller
 * stores null. A Route Handler cannot see the socket address, so null is the
 * complete truth available in that configuration — which is the default, because
 * compose.prod.yaml publishes the app's port directly.
 *
 * Server-only by construction: it reads process.env. Nothing in a browser bundle
 * should import it.
 */

/**
 * Parsed once. A malformed value is treated as unset rather than as 1 — silently
 * trusting one hop because somebody typed "true" is the failure this whole
 * module exists to stop.
 */
const TRUSTED_HOPS = (() => {
  const raw = process.env.TRUSTED_PROXY_HOPS
  if (!raw) return 0
  const n = Number.parseInt(raw, 10)
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 0
})()

/** True when a proxy is configured, so callers can say why an address is null. */
export const proxyConfigured = TRUSTED_HOPS > 0

/**
 * The client address, or null when it cannot be established.
 *
 * `x-real-ip` is deliberately not consulted. It carries no hop information, so
 * there is no way to tell a value your proxy set from one a client sent, and a
 * single-valued header that looks authoritative is the more dangerous of the
 * two.
 */
export function clientAddress(h: Headers): string | null {
  if (TRUSTED_HOPS === 0) return null

  const forwarded = h.get("x-forwarded-for")
  if (!forwarded) return null

  const hops = forwarded
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  // Fewer entries than proxies means the chain is not what the configuration
  // says it is. Guessing at that point would hand back a client-written value,
  // so it answers null instead.
  const index = hops.length - TRUSTED_HOPS
  return index >= 0 ? (hops[index] ?? null) : null
}
