/**
 * The audit event catalogue.
 *
 * Both the type and the metadata shape are closed. Free-text metadata is how a
 * log that promises "we never record content" quietly stops being true — the
 * first time somebody stuffs a command or a path into a jsonb column, the claim
 * is false and nothing in the code says so. So unknown event types and unknown
 * metadata keys are rejected at the API boundary rather than stored.
 *
 * Shared by client and server, so it must stay dependency-free.
 */

export const AUDIT_SOURCES = ["server", "relay", "client"] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export const AUDIT_EVENTS = {
  "auth.signin": { source: "server", ip: "full" },
  "auth.signout": { source: "server", ip: "prefix" },
  "device.registered": { source: "server", ip: "full" },
  "device.revoked": { source: "server", ip: "prefix" },
  "vault.synced": { source: "server", ip: "prefix" },
  "connection.opened": { source: "relay", ip: "prefix" },
  "connection.closed": { source: "relay", ip: "prefix" },
  "key.installed": { source: "client", ip: "prefix" },
  "hostkey.pinned": { source: "client", ip: "prefix" },
  "hostkey.mismatch": { source: "client", ip: "prefix" },
  "hostkey.cleared": { source: "client", ip: "prefix" },
} as const;

export type AuditEventType = keyof typeof AUDIT_EVENTS;

export const isAuditEventType = (v: unknown): v is AuditEventType =>
  typeof v === "string" && v in AUDIT_EVENTS;

/**
 * Allowed metadata keys per event, with a validator each.
 *
 * Note what is absent and must stay absent: hostnames, usernames, ports as
 * free text, commands, keystrokes, terminal output, file paths and names,
 * transfer contents, the authorized_keys comment (user-chosen free text — the
 * key fingerprint carries the same audit value and no free text), passwords.
 */
type Validator = (v: unknown) => boolean;

const isFingerprint: Validator = (v) =>
  typeof v === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/.test(v);
const isUuid: Validator = (v) =>
  typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const isSmallInt: Validator = (v) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e12;
const isEnum =
  (...allowed: string[]): Validator =>
  (v) =>
    typeof v === "string" && allowed.includes(v);

export const AUDIT_METADATA: Record<AuditEventType, Record<string, Validator>> = {
  "auth.signin": { method: isEnum("password", "passkey", "sso") },
  "auth.signout": { scope: isEnum("device", "all") },
  "device.registered": { platform: isEnum("macos", "windows", "linux", "ios", "android", "other") },
  "device.revoked": { revokedDeviceId: isUuid },
  "vault.synced": { version: isSmallInt, records: isSmallInt },
  "connection.opened": { port: isSmallInt },
  "connection.closed": { bytesUp: isSmallInt, bytesDown: isSmallInt, durationMs: isSmallInt },
  "key.installed": { keyId: isUuid, fingerprint: isFingerprint, result: isEnum("installed", "already-present") },
  "hostkey.pinned": { fingerprint: isFingerprint, keyType: isEnum("ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256") },
  "hostkey.mismatch": { expected: isFingerprint, presented: isFingerprint },
  "hostkey.cleared": { fingerprint: isFingerprint },
};

const MAX_METADATA_BYTES = 512;

export interface MetadataResult {
  ok: boolean;
  error?: string;
  value?: Record<string, unknown>;
}

/**
 * Validates metadata against the allowlist. Unknown keys are an error, not a
 * silent drop — a caller sending something unexpected should find out.
 */
export function validateMetadata(type: AuditEventType, meta: unknown): MetadataResult {
  if (meta === undefined || meta === null) return { ok: true, value: {} };
  if (typeof meta !== "object" || Array.isArray(meta)) {
    return { ok: false, error: "metadata must be an object" };
  }

  const allowed = AUDIT_METADATA[type];
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    const validator = allowed[key];
    if (!validator) {
      return { ok: false, error: `metadata key "${key}" is not allowed for ${type}` };
    }
    if (!validator(value)) {
      return { ok: false, error: `metadata value for "${key}" failed validation` };
    }
    out[key] = value;
  }

  if (JSON.stringify(out).length > MAX_METADATA_BYTES) {
    return { ok: false, error: "metadata too large" };
  }
  return { ok: true, value: out };
}

/**
 * Truncates an address to a network. Enough to answer "was that me, or someone
 * in another country?" without retaining a precise locator for every session.
 */
export function ipPrefix(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const addr = ip.split(",")[0].trim();

  if (addr.includes(":")) {
    // IPv6 -> /48
    const groups = addr.split(":").filter(Boolean);
    return groups.length >= 3 ? `${groups.slice(0, 3).join(":")}::/48` : null;
  }
  const octets = addr.split(".");
  if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o))) return null;
  return `${octets.slice(0, 3).join(".")}.0/24`;
}

/** Events a browser is allowed to self-report. Everything else is server-only. */
export const CLIENT_REPORTABLE: readonly AuditEventType[] = Object.entries(AUDIT_EVENTS)
  .filter(([, def]) => def.source === "client")
  .map(([type]) => type as AuditEventType);
