import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { headers } from "next/headers"

import { auth } from "@/lib/auth"
import { clientAddress } from "@/lib/audit/address"
import { ipPrefix } from "@/lib/audit/events"
import { db, schema } from "@/lib/db"
import { enforce } from "@/lib/rate-limit"

/**
 * Recovery envelopes.
 *
 * The construction is in lib/vault/recovery.ts and nothing here can undo it:
 * every envelope is AES-GCM ciphertext under a key derived from a code this
 * server has never seen and never will. What arrives on redemption is the hash
 * of a code, which is enough to find the right envelope and no help at all in
 * opening it.
 *
 * Three operations on one path, because they are three views of one row:
 *
 *   GET     authenticated — how many codes are left, when they were made.
 *   POST    action:"enrol"  authenticated — replace the set wholesale.
 *   POST    action:"redeem" UNAUTHENTICATED — the whole point; the caller has
 *           forgotten their password and has nothing but an email and a code.
 *   DELETE  authenticated — remove the set.
 *
 * ---------------------------------------------------------------------------
 * The redeem path is the dangerous one, and it is dangerous in a specific way
 *
 * It takes an email and answers. A naive implementation therefore tells the
 * whole internet which email addresses have accounts here, which is a real harm
 * to a product whose users are administrators of the machines they store in it.
 *
 * So it never says no. An unknown email, an unknown code id and an already-spent
 * code all produce a *decoy* envelope: correctly shaped, correctly sized, and
 * deterministically derived from a server secret so that repeating the request
 * repeats the answer. The caller runs Argon2id over it, AES-GCM refuses, and the
 * client reports "that email and code do not open anything" — the same sentence
 * it would print for a typo. Nothing in the response distinguishes the cases.
 *
 * What this does not equalise is time. Both paths run the same single query, so
 * the existence of the *account* is not timeable; what differs is the DELETE and
 * the audit insert that only a genuinely correct code triggers. An attacker who
 * can time that already holds a working code, so the leak is not one worth
 * closing at the cost of writing a fake row.
 *
 * Rate limiting is in Postgres now (lib/rate-limit.ts), which it did not used
 * to be: it was a Map in this process, so a second container had a second budget
 * and a redeploy emptied it. It is still only as good as the address it keys on
 * — without TRUSTED_PROXY_HOPS set there is no address this process can believe
 * and every caller shares one bucket. Said plainly here so nobody reads this and
 * assumes the protection is stronger than it is. What makes brute force
 * pointless is the 120-bit code; this bounds the noise around it.
 */

/* -------------------------------------------------------------- envelope shape */

/**
 * Mirrors the constants in lib/vault/recovery.ts, deliberately duplicated: that
 * module carries "use client", so importing it here would yield client
 * references rather than numbers and pull hash-wasm into the server bundle. If
 * the payload layout changes, both ends move together or enrolment starts
 * failing this validation, which is the loud failure rather than the quiet one.
 */
const ID_HEX_CHARS = 32
const SALT_BYTES = 16
const IV_BYTES = 12
const CIPHERTEXT_BYTES = 113 // 1 version byte + three 32-byte branches + GCM tag

const MIN_ENVELOPES = 1
const MAX_ENVELOPES = 32

interface StoredEnvelope {
  id: string
  salt: string
  iv: string
  ciphertext: string
}

function isStoredEnvelope(value: unknown): value is StoredEnvelope {
  if (typeof value !== "object" || value === null) return false
  const e = value as Record<string, unknown>
  if (typeof e.id !== "string" || !new RegExp(`^[0-9a-f]{${ID_HEX_CHARS}}$`).test(e.id)) {
    return false
  }
  for (const [field, bytes] of [
    ["salt", SALT_BYTES],
    ["iv", IV_BYTES],
    ["ciphertext", CIPHERTEXT_BYTES],
  ] as const) {
    const v = e[field]
    if (typeof v !== "string") return false
    const buf = Buffer.from(v, "base64")
    // Exact lengths, not maxima. A ciphertext of an unexpected size would be
    // storage this route cannot account for, and would make the decoy above
    // distinguishable from the real thing by length alone.
    if (
      buf.length !== bytes ||
      buf.toString("base64").replace(/=+$/, "") !== v.replace(/=+$/, "")
    ) {
      return false
    }
  }
  return true
}

function envelopesOf(row: { envelopes: unknown }): StoredEnvelope[] {
  return Array.isArray(row.envelopes) ? (row.envelopes as StoredEnvelope[]) : []
}

/* ------------------------------------------------------------------- decoys */

/**
 * The secret the decoys hang off.
 *
 * BETTER_AUTH_SECRET is already required for the deployment to be secure at all,
 * so reusing it avoids inventing a second thing to configure. Without it the
 * fallback is per-process randomness: decoys then differ between instances and
 * across restarts, which weakens the "repeating the request repeats the answer"
 * property. It does not make any decoy openable — they are all wrong — so this
 * degrades rather than breaks, and it degrades on a deployment that is already
 * misconfigured.
 */
const DECOY_SECRET = process.env.BETTER_AUTH_SECRET ?? randomBytes(32).toString("hex")

function decoyBytes(label: string, length: number): Buffer {
  const out = Buffer.alloc(length)
  let written = 0
  let counter = 0
  while (written < length) {
    const block = createHmac("sha256", DECOY_SECRET)
      .update(`weirdvault/recovery/decoy/v1:${label}:${counter}`)
      .digest()
    const take = Math.min(block.length, length - written)
    block.copy(out, written, 0, take)
    written += take
    counter++
  }
  return out
}

/** An envelope that is indistinguishable from a real one and opens for nobody. */
function decoyEnvelope(email: string, codeId: string): StoredEnvelope {
  const label = `${email}:${codeId}`
  return {
    id: codeId,
    salt: decoyBytes(`${label}:salt`, SALT_BYTES).toString("base64"),
    iv: decoyBytes(`${label}:iv`, IV_BYTES).toString("base64"),
    ciphertext: decoyBytes(`${label}:ct`, CIPHERTEXT_BYTES).toString("base64"),
  }
}

/* ------------------------------------------------------------ rate limiting */

/**
 * Twenty attempts per ten minutes, keyed on the truncated network — so a single
 * caller cannot spend the budget of a whole /24, and a whole /24 cannot be used
 * to multiply one caller's attempts by 256.
 *
 * That last sentence is only true when the address is real. It used to be taken
 * from the left-most X-Forwarded-For value, which the client writes, so the key
 * was chosen by the caller and the limit was decorative. The address now comes
 * from lib/audit/address.ts and is null unless TRUSTED_PROXY_HOPS says a proxy
 * is in front — a dev server, or a deployment publishing the app's port
 * directly, therefore shares one bucket.
 *
 * A shared bucket is trippable by anyone, which means a stranger can spend the
 * budget and make legitimate recovery return 429 for ten minutes. That is
 * unpleasant and it is still the right way round: the alternative is a limiter
 * that stops nobody.
 */
const REDEEM_LIMIT = { max: 20, windowSeconds: 600 }

/* ------------------------------------------------------------------ helpers */

async function requireUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  return session ?? null
}

/** Null unless a trusted proxy is configured — see lib/audit/address.ts. */
async function clientIp(): Promise<string | null> {
  return clientAddress(await headers())
}

/** Constant-time id comparison, so envelope selection cannot be timed apart. */
function idMatches(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  return left.length === right.length && timingSafeEqual(left, right)
}

/* ---------------------------------------------------------------------- GET */

export async function GET() {
  const session = await requireUser()
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 })

  const [row] = await db
    .select()
    .from(schema.recoveryBlob)
    .where(eq(schema.recoveryBlob.userId, session.user.id))
    .limit(1)

  if (!row) {
    return Response.json({
      enrolled: false,
      remaining: 0,
      createdAt: null,
      lastUsedAt: null,
    })
  }

  return Response.json({
    enrolled: true,
    remaining: envelopesOf(row).length,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  })
}

/* --------------------------------------------------------------------- POST */

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 })
  }

  // The action decides whether a session is required, so it is read before any
  // authentication happens. Redemption exists precisely for callers who have
  // none.
  if (body.action === "redeem") return redeem(request, body)
  if (body.action === "enrol") return enrol(body)
  return Response.json({ error: 'action must be "enrol" or "redeem"' }, { status: 400 })
}

async function enrol(body: Record<string, unknown>) {
  const session = await requireUser()
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { envelopes } = body
  if (!Array.isArray(envelopes)) {
    return Response.json({ error: "envelopes must be an array" }, { status: 400 })
  }
  if (envelopes.length < MIN_ENVELOPES || envelopes.length > MAX_ENVELOPES) {
    return Response.json(
      { error: `between ${MIN_ENVELOPES} and ${MAX_ENVELOPES} envelopes` },
      { status: 400 },
    )
  }
  if (!envelopes.every(isStoredEnvelope)) {
    return Response.json(
      { error: "each envelope must be { id, salt, iv, ciphertext } with exact lengths" },
      { status: 400 },
    )
  }

  const ids = new Set(envelopes.map((e) => e.id))
  if (ids.size !== envelopes.length) {
    // Two identical ids would mean two identical codes, which would silently
    // halve the set. Better to reject a client bug than to store it.
    return Response.json({ error: "duplicate envelope id" }, { status: 400 })
  }

  const clean: StoredEnvelope[] = envelopes.map((e) => ({
    id: e.id,
    salt: e.salt,
    iv: e.iv,
    ciphertext: e.ciphertext,
  }))
  const now = new Date()

  // Replace, never merge. "Regenerate my codes" has to retire the old ones, or
  // a leaked card of codes stays live after the user believes they revoked it.
  await db
    .insert(schema.recoveryBlob)
    .values({
      id: crypto.randomUUID(),
      userId: session.user.id,
      envelopes: clean,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    })
    .onConflictDoUpdate({
      target: schema.recoveryBlob.userId,
      set: { envelopes: clean, updatedAt: now, lastUsedAt: null },
    })

  await db.insert(schema.auditEvent).values({
    id: crypto.randomUUID(),
    userId: session.user.id,
    eventType: "recovery.enrolled",
    source: "server",
    ipPrefix: ipPrefix(await clientIp()),
    metadata: { codes: clean.length },
  })

  return Response.json({ enrolled: true, remaining: clean.length }, { status: 201 })
}

/**
 * Hands back the envelope for a code and consumes it.
 *
 * Consumption happens here rather than after the client confirms success,
 * because there is no honest way to confirm: the only party who can tell whether
 * the envelope opened is the one holding the code, and taking their word for it
 * would let a stolen code be replayed indefinitely by simply never confirming.
 * At-most-once is the property worth having; the cost is that a code fetched and
 * then lost to a closed tab is spent, which is why ten are issued.
 */
async function redeem(request: Request, body: Record<string, unknown>) {
  // The limiter applies the rule this route used to apply here by hand: a
  // resolved network gets its own bucket, and without a trusted proxy in front
  // everybody shares one — because inventing an address from a client-supplied
  // header would hand every caller a private budget.
  const limited = await enforce("recovery-redeem", request, REDEEM_LIMIT, {
    message: "Too many recovery attempts. Wait ten minutes and try again.",
  })
  if (limited) return limited

  const { email, codeId } = body
  if (typeof email !== "string" || typeof codeId !== "string") {
    return Response.json({ error: "email and codeId required" }, { status: 400 })
  }
  const normalisedEmail = email.trim().toLowerCase()
  if (!new RegExp(`^[0-9a-f]{${ID_HEX_CHARS}}$`).test(codeId)) {
    // A malformed id cannot match anything, but answering "bad request" here
    // would still be a different answer than a well-formed miss gets. The decoy
    // keeps the two indistinguishable.
    return Response.json({ envelope: decoyEnvelope(normalisedEmail, codeId) })
  }

  // One query for every caller, whether or not the account exists: the join is
  // what stops "is there a row" from being timeable separately from "is there a
  // matching envelope".
  const [row] = await db
    .select({
      id: schema.recoveryBlob.id,
      userId: schema.recoveryBlob.userId,
      envelopes: schema.recoveryBlob.envelopes,
    })
    .from(schema.recoveryBlob)
    .innerJoin(schema.user, eq(schema.user.id, schema.recoveryBlob.userId))
    .where(sql`lower(${schema.user.email}) = ${normalisedEmail}`)
    .limit(1)

  const stored = row ? envelopesOf(row) : []
  const match = stored.find((e) => idMatches(e.id, codeId))

  if (!row || !match) {
    return Response.json({ envelope: decoyEnvelope(normalisedEmail, codeId) })
  }

  const remaining = stored.filter((e) => !idMatches(e.id, codeId))
  await db
    .update(schema.recoveryBlob)
    .set({ envelopes: remaining, updatedAt: new Date(), lastUsedAt: new Date() })
    .where(eq(schema.recoveryBlob.id, row.id))

  await db.insert(schema.auditEvent).values({
    id: crypto.randomUUID(),
    userId: row.userId,
    eventType: "recovery.redeemed",
    source: "server",
    // Resolved here rather than reused from the limiter: the limiter's subject
    // falls back to a shared bucket string when there is no trusted address,
    // and writing "unresolved" into an audit row would be inventing a location.
    // A null column is the honest answer. See lib/audit/address.ts.
    ipPrefix: ipPrefix(await clientIp()),
    metadata: { remaining: remaining.length },
  })

  return Response.json({ envelope: match })
}

/* ------------------------------------------------------------------- DELETE */

export async function DELETE() {
  const session = await requireUser()
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 })

  const deleted = await db
    .delete(schema.recoveryBlob)
    .where(eq(schema.recoveryBlob.userId, session.user.id))
    .returning({ id: schema.recoveryBlob.id })

  // Only logged when something was actually removed. An audit row for a no-op
  // would be a record of an event that did not happen.
  if (deleted.length > 0) {
    await db.insert(schema.auditEvent).values({
      id: crypto.randomUUID(),
      userId: session.user.id,
      eventType: "recovery.disabled",
      source: "server",
      ipPrefix: ipPrefix(await clientIp()),
      metadata: {},
    })
  }

  return Response.json({ enrolled: false, remaining: 0, removed: deleted.length > 0 })
}
