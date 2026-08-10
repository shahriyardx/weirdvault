"use client"

/**
 * Host blinding for the audit log.
 *
 * The audit table must be able to group events by host — a timeline you cannot
 * group by host is not much of an audit log. But storing the hostname in the
 * clear, indexed by user and time, rebuilds exactly the infrastructure map the
 * vault exists to hide, and does it durably and queryably. The relay sees a
 * host transiently; a database column keeps it forever.
 *
 * So the browser sends HMAC(auditKey, host|port). The server gets a stable
 * opaque handle it can group by, and no way to learn what it refers to. The
 * client resolves refs back to labels locally, after decrypting the vault.
 *
 * The accepted, deliberate leak: the ref is deterministic, so the server can
 * correlate the same host across time and count connections to it. That is the
 * feature. Randomising it would destroy the grouping and gain nothing, since
 * the relay already observes each connection as it happens.
 */

const DOMAIN = "webxterm/audit/host/v1"
const REF_BYTES = 16

function b64url(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * @param auditKey the HMAC branch from deriveSecrets(); never leaves the device
 */
export async function blindHost(auditKey: CryptoKey, host: string, port: number): Promise<string> {
  // Normalise so the same server always produces the same ref regardless of
  // how the user typed it.
  const canonical = `${DOMAIN}|${host.trim().toLowerCase()}|${port}`
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", auditKey, new TextEncoder().encode(canonical)),
  )
  return b64url(mac.slice(0, REF_BYTES))
}

/**
 * Builds a ref -> label map for rendering the activity log locally. Only hosts
 * the device knows about can be resolved; anything else stays opaque, which is
 * the honest thing to show.
 */
export async function buildRefIndex(
  auditKey: CryptoKey,
  hosts: { hostname: string; port: number; label: string }[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  await Promise.all(
    hosts.map(async (h) => {
      index.set(await blindHost(auditKey, h.hostname, h.port), h.label)
    }),
  )
  return index
}
