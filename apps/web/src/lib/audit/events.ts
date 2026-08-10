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
  /**
   * The recovery-code lifecycle. All three are server-written, because all three
   * happen inside /api/recovery and a browser must not be able to fabricate
   * them — a redemption in particular is the one line in this log that says
   * "somebody got in without the password".
   *
   * `recovery.redeemed` is written on a request that carries no session, so it
   * is the only event here attributed to a user the request never proved it was.
   * That is correct: the row records that a code belonging to that account was
   * spent, which is true regardless of who spent it, and is exactly what the
   * owner needs to see.
   */
  "recovery.enrolled": { source: "server", ip: "prefix" },
  "recovery.redeemed": { source: "server", ip: "prefix" },
  "recovery.disabled": { source: "server", ip: "prefix" },
  /**
   * The second-factor lifecycle: TOTP and passkeys, enrolled, removed and used.
   *
   * Server-written for the same reason the recovery events are. These six rows
   * are the record of who could sign in as this person and when that changed;
   * a browser that could post them could also post a plausible history around a
   * factor it had just added for itself. They are written by the `hooks.after`
   * middleware in lib/auth.ts, from the Better Auth endpoint that actually did
   * the work, so the row exists if and only if the change landed.
   *
   * Note what they are NOT evidence of, and what the settings page says in
   * words: none of these six touches the vault. A passkey and a TOTP secret
   * authenticate a session. The vault key comes from Argon2id over the password
   * in the browser and from nothing else, so `passkey.used` means somebody
   * opened a session, never that somebody read a host.
   */
  "totp.enrolled": { source: "server", ip: "prefix" },
  "totp.disabled": { source: "server", ip: "prefix" },
  "totp.verified": { source: "server", ip: "prefix" },
  "totp.codes-reissued": { source: "server", ip: "prefix" },
  "passkey.registered": { source: "server", ip: "prefix" },
  "passkey.removed": { source: "server", ip: "prefix" },
  "passkey.used": { source: "server", ip: "prefix" },
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
const isUuid: Validator = (v) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const isSmallInt: Validator = (v) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e12;
const isBoolean: Validator = (v) => typeof v === "boolean";
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
  // Counts only. The code, its hash and the envelope are all absent by design:
  // the first two would make the log a way to open the vault, and the third is
  // ciphertext nobody reading a timeline can use.
  "recovery.enrolled": { codes: isSmallInt },
  "recovery.redeemed": { remaining: isSmallInt },
  "recovery.disabled": {},
  // Counts and shapes only, on the same rule as the recovery rows. The TOTP
  // secret, the backup codes and their hashes are all absent by design: a log
  // that carried them would be a second copy of the factor it is auditing.
  // No count on enrolment: the row is written when the first code verifies, and
  // that endpoint does not know how many backup codes the enable step issued.
  // Guessing from the plugin's default would be a number nobody measured.
  "totp.enrolled": {},
  "totp.disabled": {},
  // Reissuing retires every code from the previous set, which is the reason the
  // row exists — somebody who did not do this should see it.
  "totp.codes-reissued": { backupCodes: isSmallInt },
  // Which of the two accepted, because "a backup code was spent" is the line
  // somebody scanning for trouble is looking for. There is no row for a failed
  // attempt: the plugin's own lockout counts those, and writing one here from a
  // request that has not proved who it is would let anyone fill a stranger's log.
  "totp.verified": { factor: isEnum("totp", "backup-code") },
  // No credential id and no AAGUID. The id is the server's handle on the
  // credential and belongs in the passkey list, not in a timeline; the AAGUID
  // names an authenticator model and is a fingerprinting surface with no audit
  // value beyond what `backedUp` already says.
  "passkey.registered": { backedUp: isBoolean, deviceType: isEnum("singleDevice", "multiDevice") },
  "passkey.removed": {},
  "passkey.used": {},
  "connection.opened": { port: isSmallInt },
  "connection.closed": { bytesUp: isSmallInt, bytesDown: isSmallInt, durationMs: isSmallInt },
  "key.installed": {
    keyId: isUuid,
    fingerprint: isFingerprint,
    result: isEnum("installed", "already-present"),
  },
  "hostkey.pinned": {
    fingerprint: isFingerprint,
    keyType: isEnum("ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256"),
  },
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
 *
 * It takes one address, never a header. It used to take `X-Forwarded-For` and
 * pick the left-most value, which is the part of that header the client writes
 * and no proxy overwrites — so every prefix in the log was forgeable and the
 * rate-limit bucket keyed on it was choosable. Resolving which entry of that
 * header is real needs a trusted hop count and belongs in audit/address.ts. A
 * comma reaching this function therefore means somebody passed the raw header,
 * and answering null is better than answering with the attacker's choice.
 */
export function ipPrefix(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const addr = ip.trim();
  if (addr.includes(",")) return null;

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

/**
 * The event types something in this build actually writes.
 *
 * The catalogue above is the closed set of types the API will *accept*, which is
 * a different question from the set anything *emits* — and the activity page was
 * reading the first as though it were the second. It told the user that signing
 * in, syncing the vault and opening a connection all write a row, offered them
 * as filters, and then showed an empty log; a user checking for unauthorised
 * access could reasonably read that silence as "nobody signed in" when the truth
 * is "nothing writes that row".
 *
 * So the two sets are named separately and the UI reads this one. The five that
 * are absent, and what each would take:
 *
 *   auth.signin, auth.signout — a hook on session create and on sign-out.
 *     lib/auth.ts now has an after-hook, so this is a few lines rather than a
 *     design question, but it is deliberately not done here: a signin row that
 *     only appeared for some of the ways in would read as "nobody signed in with
 *     a password", which is worse than an honestly empty filter. The
 *     second-factor events below are separate types precisely so they could be
 *     emitted without making that claim.
 *   vault.synced — an insert in /api/vault's PUT handler, which currently writes
 *     only the blob row.
 *   connection.opened, connection.closed — these are marked source:"relay" and
 *     the relay has no database at all (no sqlx in apps/relay/Cargo.toml, no
 *     audit code in its source). It would need either a database connection or a
 *     server route it can post to with a relay credential. /api/audit will not
 *     take them from a browser, deliberately: a client that could fabricate
 *     "connection opened" could fabricate a whole session history.
 *
 * One caveat on the three totp.* rows, because it is a fact about this build
 * rather than about the code: the migrated `two_factor` table is missing three
 * columns the installed better-auth two-factor plugin writes, so enrolment is
 * gated off in the UI until an operator adds them (see totpStorageReady in
 * lib/auth.ts). The writer exists and is correct; on a deployment with the short
 * table nothing reaches it, and those three filters stay empty for that reason
 * and no other.
 *
 * Keep this list in step with reality by grepping for the writers, which are:
 * lib/ssh/connect.ts (via reportAudit), the after-hook in lib/auth.ts, and the
 * inserts in /api/devices, /api/recovery and /api/audit.
 */
export const EMITTED_EVENTS: readonly AuditEventType[] = [
  "device.registered",
  "device.revoked",
  "recovery.enrolled",
  "recovery.redeemed",
  "recovery.disabled",
  "totp.enrolled",
  "totp.disabled",
  "totp.verified",
  "totp.codes-reissued",
  "passkey.registered",
  "passkey.removed",
  "passkey.used",
  "key.installed",
  "hostkey.pinned",
  "hostkey.mismatch",
  "hostkey.cleared",
];

/** Catalogued but written by nothing. Named in the UI rather than offered as a filter. */
export const UNEMITTED_EVENTS: readonly AuditEventType[] = (
  Object.keys(AUDIT_EVENTS) as AuditEventType[]
).filter((type) => !EMITTED_EVENTS.includes(type));

/** Sources that appear on at least one row today. The relay writes nothing. */
export const EMITTED_SOURCES: readonly AuditSource[] = ["server", "client"];
