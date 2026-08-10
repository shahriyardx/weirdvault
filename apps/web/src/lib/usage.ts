/**
 * The wire shapes for relay transfer accounting, and the meter's client half.
 *
 * Three parties exchange these and none of them shares a compiler with the
 * others: the relay in Rust posts byte counts, the route handler accumulates
 * them, and a Client Component renders the total. Every shape that crosses one
 * of those boundaries lives here, so that a rename is one edit and a test can
 * see both ends of it. Nothing in this file may import the database, next/server
 * or anything Node-only — a browser imports it.
 *
 * A cap the user cannot see is a cap that arrives as an unexplained failure, so
 * this also exists to make the number visible before it bites rather than after.
 * The derivations below are pure and deliberately so: what counts as "close to
 * the limit" is a product decision, and it should be one function rather than a
 * threshold repeated in whatever renders it next.
 */

/* ------------------------------------------------- relay → control plane */

/**
 * One account's bytes from one relay flush window, as the relay encodes it.
 *
 * The field names are the contract, and they are the fragile part: the ingest
 * route ignores what it does not recognise, so a rename on either side would
 * post batches that are accepted and count nothing — enforcement would quietly
 * stop and the meter would read zero. `encode_batch` in apps/relay/src/reporter.rs
 * is the other end, its own test asserts the names it emits, and usage.test.ts
 * here asserts this validator accepts exactly those.
 */
export type RelayUsageEntry = {
  /** A user id, or `anon:<uuid>` for a signed-out visitor. */
  subject: string
  bytesUp: number
  bytesDown: number
}

/* ------------------------------------------- relay → control plane: events */

/**
 * One thing that happened to one connection, as the relay reports it.
 *
 * These become `connection.opened` and `connection.closed` rows in the audit
 * log — the two event types that have sat in the catalogue with validators and
 * nothing emitting them since it was written, while the README promised "every
 * connection, key and device, in one place".
 *
 * The relay cannot write them itself: it holds no database credentials by
 * design. So it buffers and posts them the way it already posts byte counts,
 * on the same timer, endpoint and secret. `encode_events` in
 * apps/relay/src/reporter.rs is the other end.
 *
 * `targetRef` is the browser's blinded host reference, carried through the
 * relay token and echoed back. Neither the relay nor this side can turn it into
 * a hostname; it exists so a timeline can be grouped by host without either of
 * them storing one. Absent when the token was minted without one, which is a
 * row with no target rather than no row.
 */
export type RelayConnectionEvent = {
  kind: "connection.opened" | "connection.closed"
  /** A user id, or `anon:<uuid>` — those are dropped, having no account. */
  subject: string
  targetRef?: string
  port: number
  /** Present on `connection.closed` only. */
  bytesUp?: number
  bytesDown?: number
  durationMs?: number
}

/**
 * The ceiling the audit metadata validators already enforce, repeated here so
 * a bad number is refused at the edge rather than at the insert.
 */
const MAX_AUDIT_INT = 1e12

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < MAX_AUDIT_INT

/**
 * Validates one event off the wire.
 *
 * Strict for the same reason the usage validator is: this is an outside process
 * writing into a table somebody reads to decide whether they were compromised.
 * A row that cannot be trusted is worse than a row that is missing.
 */
export function isRelayConnectionEvent(value: unknown): value is RelayConnectionEvent {
  if (typeof value !== "object" || value === null) return false
  const e = value as Record<string, unknown>

  if (e.kind !== "connection.opened" && e.kind !== "connection.closed") return false
  if (typeof e.subject !== "string" || !e.subject || e.subject.length > 128) return false
  if (!Number.isInteger(e.port) || (e.port as number) < 1 || (e.port as number) > 65535)
    return false

  // Opaque and short. Not decoded, not resolved — only stored and compared.
  if (e.targetRef !== undefined) {
    if (typeof e.targetRef !== "string" || !e.targetRef || e.targetRef.length > 64) return false
  }

  if (e.kind === "connection.closed") {
    if (!isCount(e.bytesUp) || !isCount(e.bytesDown) || !isCount(e.durationMs)) return false
  }
  return true
}

/** The most events one POST may carry. Matches MAX_ENTRIES_PER_BATCH in the relay. */
export const MAX_EVENTS_PER_BATCH = 500

/**
 * The largest byte count one flush window may carry.
 *
 * A petabyte. No relay moved that in a minute, so anything above it is a bug or
 * a forgery rather than traffic — and accepting one would poison a month's
 * total permanently, since the row is a running sum with no way to walk it back.
 */
export const MAX_BYTES_PER_ENTRY = 1_000_000_000_000_000

/** The most accounts one POST may carry. Matches MAX_ENTRIES_PER_BATCH in apps/relay/src/reporter.rs. */
export const MAX_ENTRIES_PER_BATCH = 500

/**
 * Validates one entry off the wire.
 *
 * Strict about the numbers rather than trusting the sender: this is the only
 * point where an outside process writes into a table that decides whether
 * somebody can connect. A non-integer, a negative, or a value past the ceiling
 * is rejected rather than clamped — clamping would record a number nobody sent
 * and nobody can explain.
 */
export function isRelayUsageEntry(value: unknown): value is RelayUsageEntry {
  if (typeof value !== "object" || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.subject === "string" &&
    e.subject.length > 0 &&
    e.subject.length <= 256 &&
    typeof e.bytesUp === "number" &&
    typeof e.bytesDown === "number" &&
    Number.isSafeInteger(e.bytesUp) &&
    Number.isSafeInteger(e.bytesDown) &&
    e.bytesUp >= 0 &&
    e.bytesDown >= 0 &&
    e.bytesUp <= MAX_BYTES_PER_ENTRY &&
    e.bytesDown <= MAX_BYTES_PER_ENTRY
  )
}

/**
 * Anonymous subjects carry no user row, so nothing can be stored against them.
 *
 * `subjectFor` in the relay-token route hands signed-out visitors an
 * `anon:<uuid>` in a cookie. There is no account behind one — the foreign key on
 * relay_usage would reject it — and a monthly total for an id its owner can
 * clear buys nothing anyway. What bounds anonymous use is the relay's global
 * connection cap and its port allowlist, as the token route already says.
 */
export function isAnonymousSubject(subject: string): boolean {
  return subject.startsWith("anon:")
}

/* ------------------------------------------------- control plane → browser */

/**
 * The `code` POST /api/relay-token returns, with status 402, when an account
 * has used its monthly transfer allowance.
 *
 * A code rather than a status alone, because the caller has to tell this
 * refusal apart from every other reason a mint can fail. Every one of them ends
 * the attempt — our relay verifies a token before it carries anything, so there
 * is no connecting without one — but only this one is a decision about the
 * account rather than a configuration, a session or a network, and only this
 * one can be answered with a date. `relayUrl` in lib/ssh/wasm.ts is where that
 * split is made.
 *
 * It lives in this module rather than in the route because a route file should
 * export nothing but its handlers, and because the code is only useful to the
 * client that has to render it.
 */
export const RELAY_QUOTA_EXCEEDED = "relay_allowance_exhausted"

/**
 * The body that comes back with it. `resetsAt` is what turns "refused" into
 * something actionable: the one thing the user can do is wait, and they are
 * owed the date.
 */
export type RelayQuotaRefusal = {
  error: string
  code: typeof RELAY_QUOTA_EXCEEDED
  usedBytes: number
  allowanceBytes: number
  /** ISO 8601, midnight UTC on the first of next month. */
  resetsAt: string
}

/** Exactly what GET /api/relay/usage returns. */
export type RelayUsage = {
  /** "YYYY-MM", UTC. */
  period: string
  /** Midnight UTC on the first of next month, ISO 8601. */
  resetsAt: string
  bytesUp: number
  bytesDown: number
  bytesTotal: number
  allowanceBytes: number
  /** Display name of the plan the allowance came from. */
  tier: string
  /**
   * False when no relay can report into this deployment, which makes the totals
   * structurally zero rather than genuinely small. The meter has to say so:
   * "0 bytes used" and "nothing is counting" look identical and mean opposite
   * things.
   */
  reportingConfigured: boolean
  /** Null until a relay has reported anything for this account this period. */
  updatedAt: string | null
}

/**
 * How the meter should read.
 *
 * `over` is the state in which /api/relay-token refuses to mint, so it is the
 * one that has to be phrased as a present-tense consequence rather than a
 * warning about the future.
 */
export type UsageState = "ok" | "approaching" | "over"

/**
 * Warn at four fifths. Early enough that a person who moves data on a schedule
 * can plan around it, late enough that it is not shouting at somebody who has
 * used a fifth of a month's allowance in the first week and will use no more.
 */
export const APPROACHING_FRACTION = 0.8

export function usageState(usage: RelayUsage): UsageState {
  if (usage.allowanceBytes <= 0) return "ok"
  const used = usage.bytesTotal / usage.allowanceBytes
  if (used >= 1) return "over"
  return used >= APPROACHING_FRACTION ? "approaching" : "ok"
}

/** Clamped, because a bar past 100% renders as a lie about the remainder. */
export function usagePercent(usage: RelayUsage): number {
  if (usage.allowanceBytes <= 0) return 0
  return Math.min(100, Math.round((usage.bytesTotal / usage.allowanceBytes) * 100))
}

export function bytesRemaining(usage: RelayUsage): number {
  return Math.max(0, usage.allowanceBytes - usage.bytesTotal)
}

/**
 * Decimal units, matching how the activity log formats transfer and how the
 * allowance itself is expressed. A gigabyte here is 1,000,000,000 bytes, which
 * is the same gigabyte the cap is written in — mixing the two conventions would
 * put a 7% gap between the meter and the refusal.
 */
export function formatBytes(n: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"]
  let value = n
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  const rounded = unit === 0 || value >= 100 ? Math.round(value) : Number(value.toFixed(1))
  return `${rounded} ${units[unit]}`
}

/**
 * Thrown when the token mint refuses on allowance grounds.
 *
 * A distinct type so a caller can `instanceof` it instead of matching on
 * message text, and so the one failure that must never be swallowed is
 * syntactically hard to swallow.
 */
export class RelayQuotaError extends Error {
  readonly code = RELAY_QUOTA_EXCEEDED
  readonly refusal: RelayQuotaRefusal | null

  constructor(refusal: RelayQuotaRefusal | null) {
    super(
      refusal
        ? `You have used this month's relay transfer allowance (${formatBytes(refusal.usedBytes)} of ${formatBytes(refusal.allowanceBytes)}). ` +
            `New connections through our relay are refused until it resets on ${refusal.resetsAt.slice(0, 10)}; sessions already open are unaffected. ` +
            `Running your own relay removes the limit entirely.`
        : "You have used this month's relay transfer allowance. New connections through our relay are refused until it resets; sessions already open are unaffected.",
    )
    this.name = "RelayQuotaError"
    this.refusal = refusal
  }
}

/**
 * Reads a 402 from /api/relay-token, or returns null for any other response.
 *
 * A 402 whose body will not parse still produces an error rather than a null.
 * The status is the decision; the body is only the detail, and treating an
 * unreadable body as "not a quota refusal" would be exactly the silent
 * fall-through this exists to prevent.
 */
export async function relayQuotaError(res: Response): Promise<RelayQuotaError | null> {
  if (res.status !== 402) return null
  try {
    const body = (await res.json()) as RelayQuotaRefusal
    return new RelayQuotaError(body.code === RELAY_QUOTA_EXCEEDED ? body : null)
  } catch {
    return new RelayQuotaError(null)
  }
}

/**
 * Reads this account's usage for the current period.
 *
 * Throws on anything but a 200. The caller renders the error rather than a
 * zero: a meter that shows "0 of 1 GB" because the request failed is worse than
 * one that shows nothing, since it reads as reassurance.
 */
export async function fetchRelayUsage(): Promise<RelayUsage> {
  const res = await fetch("/api/relay/usage", { cache: "no-store" })
  if (res.status === 401) throw new Error("Session expired. Sign in again.")
  if (!res.ok) throw new Error(`The server returned ${res.status}.`)
  return (await res.json()) as RelayUsage
}
