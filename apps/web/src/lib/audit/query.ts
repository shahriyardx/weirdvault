"use client"

/**
 * Reading the audit log.
 *
 * GET /api/audit hands back rows exactly as they are stored: a closed event
 * type, the source that wrote them, a blinded host reference, a truncated
 * network and an allowlisted metadata object. None of that is readable on its
 * own. Making it readable means resolving device ids against /api/devices and
 * host references against the vault — the second of which the server cannot do
 * even if it wanted to, because the reference is HMAC(auditKey, host|port) and
 * the audit key never leaves the browser.
 *
 * So the mapping lives here, on the client, and the page stays a rendering
 * problem. Everything in this module runs after the response has landed; none
 * of it can be moved to the server without breaking the blinding.
 *
 * What is deliberately NOT done here: no row is dropped for being unfamiliar.
 * An event type or source outside the catalogue this build knows about is
 * carried through with its raw value so the page can show it as-is. A log that
 * quietly hides the rows it cannot label is worse than one that admits it does
 * not recognise them. The only rows discarded are those without an id or a
 * parseable timestamp, which cannot be keyed or ordered at all.
 */

import { buildRefIndex } from "./blind"
import { AUDIT_EVENTS, type AuditEventType } from "./events"
import { AUDIT_RETENTION_DAYS, type AuditRetentionWindow } from "./retention"
import { listHosts } from "@/lib/hosts"

/* ------------------------------------------------------------------- model */

/** One row as the API returns it, with the timestamp parsed for sorting. */
export interface AuditRow {
  id: string
  /**
   * The stored event type. Usually a key of AUDIT_EVENTS — the API rejects
   * anything else on write — but kept as a plain string so a row written by a
   * newer build than this one still renders instead of vanishing.
   */
  eventType: string
  /**
   * The source column as stored, not one re-derived from the event type. The
   * two agree today because the server sets `source` from the catalogue, but
   * the stored value is the record of what actually wrote the row and that is
   * what the page must show.
   */
  source: string
  /** HMAC(auditKey, host|port). Null on account-level events, which have no host. */
  targetRef: string | null
  /** Truncated network, or null when the address could not be read on write. */
  ipPrefix: string | null
  /** Allowlisted metadata; validated server-side, never free text. */
  metadata: Record<string, unknown>
  deviceId: string | null
  /** Milliseconds since the epoch, for filtering and display. */
  at: number
  /** The ISO string as received. Also what the cursor is expressed in. */
  createdAt: string
}

export interface AuditPage {
  rows: AuditRow[]
  /** Pass back as `before` to fetch the next page. Null when the server had no more. */
  nextCursor: string | null
  /**
   * The retention window the server applied to this response, and the only way
   * this browser can know it.
   *
   * The tier an account is on is a subscription lookup, which a tab cannot do:
   * it knows which account it is signed into and nothing about what that account
   * pays. So the window arrives with the rows, from the side that enforced it,
   * and the page renders what it is told. Null when the response did not carry
   * one — an older server, or a shape that failed validation — in which case the
   * page says nothing about retention rather than assuming a window.
   */
  retention: AuditRetentionWindow | null
}

export interface DeviceSummary {
  id: string
  label: string
  /** Set once the device has been revoked; the record is kept so ids still resolve. */
  revokedAt: string | null
}

/**
 * Why a read failed, so the caller can offer the right way out. A 401 wants a
 * sign-in link, a dead network wants a retry; a toast saying "something went
 * wrong" serves neither.
 */
export type AuditFailureKind = "unauthorized" | "network" | "server"

export class AuditFetchError extends Error {
  readonly kind: AuditFailureKind

  constructor(kind: AuditFailureKind, message: string) {
    super(message)
    this.name = "AuditFetchError"
    this.kind = kind
  }
}

/**
 * Rows per request. The route caps at 200; a hundred keeps the first paint
 * quick while still covering a normal month of activity in one page, and
 * anything older is an explicit "Load older" away.
 */
export const AUDIT_PAGE_SIZE = 100

/* ------------------------------------------------------------------ fetches */

export async function fetchAuditPage(
  opts: { before?: string | null; limit?: number } = {},
): Promise<AuditPage> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? AUDIT_PAGE_SIZE) })
  if (opts.before) params.set("before", opts.before)

  const res = await request(`/api/audit?${params.toString()}`)
  const body = (await res.json()) as {
    events?: unknown
    nextCursor?: unknown
    retention?: unknown
  }

  const rows = Array.isArray(body.events)
    ? body.events.map(toRow).filter((row): row is AuditRow => row !== null)
    : []

  return {
    rows,
    nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : null,
    retention: toRetention(body.retention),
  }
}

/**
 * Validates the retention block, and returns null rather than a partial one.
 *
 * Half a window is worse than none: a page that knew the tier but not the cutoff
 * would render "Pro, kept 12 months" next to a date it had computed itself, and
 * the date is the part somebody plans around. The tier is checked against the
 * windows this build knows so that a value from a newer server is refused rather
 * than used to index an object and produce `undefined` on screen.
 */
function toRetention(raw: unknown): AuditRetentionWindow | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (typeof r.tier !== "string" || !(r.tier in AUDIT_RETENTION_DAYS)) return null
  if (typeof r.days !== "number" || !Number.isFinite(r.days) || r.days <= 0) return null
  if (typeof r.since !== "string" || Number.isNaN(Date.parse(r.since))) return null
  return {
    tier: r.tier as AuditRetentionWindow["tier"],
    days: r.days,
    since: r.since,
  }
}

/**
 * Device labels. Revoked devices are still returned by the route and still
 * listed here: their rows are the ones you most want to be able to read.
 */
export async function fetchDevices(): Promise<DeviceSummary[]> {
  const res = await request("/api/devices")
  const body = (await res.json()) as { devices?: unknown }
  if (!Array.isArray(body.devices)) return []

  return body.devices.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return []
    const d = raw as Record<string, unknown>
    if (typeof d.id !== "string") return []
    return [
      {
        id: d.id,
        label: typeof d.label === "string" && d.label !== "" ? d.label : "Unnamed device",
        revokedAt: typeof d.revokedAt === "string" ? d.revokedAt : null,
      },
    ]
  })
}

async function request(url: string): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, { cache: "no-store" })
  } catch {
    throw new AuditFetchError(
      "network",
      "The request never reached the server. You may be offline.",
    )
  }
  if (res.status === 401) {
    throw new AuditFetchError("unauthorized", "This browser is no longer signed in.")
  }
  if (!res.ok) {
    throw new AuditFetchError("server", `The server returned ${res.status}.`)
  }
  return res
}

function toRow(raw: unknown): AuditRow | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>

  const createdAt = typeof r.createdAt === "string" ? r.createdAt : null
  const at = createdAt ? Date.parse(createdAt) : Number.NaN
  if (typeof r.id !== "string" || !createdAt || Number.isNaN(at)) return null

  return {
    id: r.id,
    eventType: typeof r.eventType === "string" ? r.eventType : "unrecognised",
    source: typeof r.source === "string" ? r.source : "unrecognised",
    targetRef: typeof r.targetRef === "string" ? r.targetRef : null,
    ipPrefix: typeof r.ipPrefix === "string" ? r.ipPrefix : null,
    metadata:
      r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)
        ? (r.metadata as Record<string, unknown>)
        : {},
    deviceId: typeof r.deviceId === "string" ? r.deviceId : null,
    at,
    createdAt,
  }
}

/**
 * Merges a newly fetched page into the rows already held, keyed by id.
 *
 * The route's cursor is `createdAt < before`, which is exclusive on the
 * timestamp rather than on the row. Two rows written in the same millisecond
 * either side of a page boundary can therefore be skipped by the server — a
 * property of the route, recorded here rather than papered over, since nothing
 * this module can do will bring a row back that was never sent. De-duplicating
 * by id is the half we can fix: it costs nothing and keeps a repeated page from
 * doubling the table.
 */
export function mergePages(existing: AuditRow[], incoming: AuditRow[]): AuditRow[] {
  const byId = new Map(existing.map((row) => [row.id, row]))
  for (const row of incoming) byId.set(row.id, row)
  return [...byId.values()].sort((a, b) => b.at - a.at)
}

/* ------------------------------------------------------------- resolution */

/**
 * Builds the ref -> host label index for this device.
 *
 * Only hosts saved in this vault can be resolved. Everything else stays a
 * reference, here and on the server, which is the whole point of blinding it.
 */
export async function buildHostLabels(auditKey: CryptoKey): Promise<Map<string, string>> {
  return buildRefIndex(auditKey, await listHosts())
}

/** The reference, shortened for display. Never expands to anything readable. */
export function shortRef(ref: string): string {
  return `h/${ref.slice(0, 10)}…`
}

/** A device id, shortened. Shown only when there is no label to show instead. */
export function shortId(id: string): string {
  return `d/${id.slice(0, 8)}…`
}

/** True when this build has a label and an icon for the type. */
export function isKnownEvent(type: string): type is AuditEventType {
  return type in AUDIT_EVENTS
}

/* -------------------------------------------------------------- metadata */

/**
 * Renders the allowlisted metadata for a row into one line.
 *
 * Every key is optional: validateMetadata accepts a partial object, so a
 * writer that only had half the numbers to hand produces a row with half the
 * keys. Each formatter therefore reports what is present and stays quiet about
 * what is not, rather than substituting a zero and implying it was measured.
 *
 * `deviceLabel` resolves the one metadata field that is itself an id —
 * device.revoked names the device it revoked.
 */
export function describeEvent(
  row: AuditRow,
  deviceLabel: (id: string) => string | null,
): string | null {
  const m = row.metadata
  const parts: string[] = []

  switch (row.eventType) {
    case "auth.signin": {
      const method = str(m.method)
      if (method) parts.push(METHOD_LABELS[method] ?? method)
      break
    }
    case "auth.signout": {
      const scope = str(m.scope)
      if (scope) parts.push(scope === "all" ? "all sessions" : "this device only")
      break
    }
    case "device.registered": {
      const platform = str(m.platform)
      if (platform) parts.push(PLATFORM_LABELS[platform] ?? platform)
      break
    }
    case "device.revoked": {
      const id = str(m.revokedDeviceId)
      if (id) parts.push(deviceLabel(id) ?? `device ${shortId(id)}`)
      break
    }
    case "vault.synced": {
      const version = num(m.version)
      const records = num(m.records)
      if (version !== null) parts.push(`version ${version}`)
      if (records !== null) parts.push(`${records} ${records === 1 ? "record" : "records"}`)
      break
    }
    case "recovery.enrolled": {
      const codes = num(m.codes)
      if (codes !== null) parts.push(`${codes} ${codes === 1 ? "code" : "codes"}`)
      break
    }
    case "recovery.redeemed": {
      const remaining = num(m.remaining)
      if (remaining !== null) parts.push(`${remaining} left`)
      break
    }
    case "recovery.disabled":
      break
    case "totp.enrolled":
      break
    case "totp.codes-reissued": {
      const codes = num(m.backupCodes)
      if (codes !== null) parts.push(`${codes} new ${codes === 1 ? "code" : "codes"}`)
      break
    }
    case "totp.verified": {
      const factor = str(m.factor)
      // Spelled out rather than shown as the stored slug: "backup-code" on this
      // row means somebody could not use their authenticator, which is the one
      // thing on the timeline most worth noticing.
      if (factor) parts.push(factor === "backup-code" ? "backup code" : "authenticator code")
      break
    }
    case "totp.disabled":
      break
    case "passkey.registered": {
      const deviceType = str(m.deviceType)
      const backedUp = m.backedUp
      if (deviceType === "multiDevice" || backedUp === true) parts.push("synced")
      else if (deviceType === "singleDevice" || backedUp === false) parts.push("this device only")
      break
    }
    case "passkey.removed":
    case "passkey.used":
      break
    case "connection.opened": {
      const port = num(m.port)
      if (port !== null) parts.push(`port ${port}`)
      break
    }
    case "connection.closed": {
      const ms = num(m.durationMs)
      const up = num(m.bytesUp)
      const down = num(m.bytesDown)
      if (ms !== null) parts.push(duration(ms))
      if (up !== null) parts.push(`${bytes(up)} up`)
      if (down !== null) parts.push(`${bytes(down)} down`)
      break
    }
    case "key.installed": {
      const result = str(m.result)
      const fingerprint = str(m.fingerprint)
      if (result) parts.push(result === "already-present" ? "already present" : "installed")
      if (fingerprint) parts.push(shortFingerprint(fingerprint))
      break
    }
    case "hostkey.pinned": {
      const keyType = str(m.keyType)
      const fingerprint = str(m.fingerprint)
      if (keyType) parts.push(keyType)
      if (fingerprint) parts.push(shortFingerprint(fingerprint))
      break
    }
    case "hostkey.mismatch": {
      const expected = str(m.expected)
      const presented = str(m.presented)
      if (expected) parts.push(`expected ${shortFingerprint(expected)}`)
      if (presented) parts.push(`presented ${shortFingerprint(presented)}`)
      break
    }
    case "hostkey.cleared": {
      const fingerprint = str(m.fingerprint)
      if (fingerprint) parts.push(shortFingerprint(fingerprint))
      break
    }
    default:
      // An event type this build does not know. Its metadata was still
      // allowlisted by whatever wrote it, but this build has no formatter for
      // it and guessing at one would be inventing a reading.
      return null
  }

  return parts.length > 0 ? parts.join(" · ") : null
}

const METHOD_LABELS: Record<string, string> = {
  password: "password",
  passkey: "passkey",
  sso: "single sign-on",
}

const PLATFORM_LABELS: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
  other: "unknown platform",
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/** Enough of the fingerprint to recognise, not enough to mistake for the whole. */
function shortFingerprint(fingerprint: string): string {
  return fingerprint.length > 13 ? `${fingerprint.slice(0, 13)}…` : fingerprint
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${minutes % 60} min`
}

/** Decimal units, because that is what transfer counters elsewhere report. */
function bytes(n: number): string {
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
