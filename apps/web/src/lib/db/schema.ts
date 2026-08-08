import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ *
 * Better Auth core tables.
 * Object keys are the model names Better Auth looks up, so they must
 * stay camelCase even though the columns are snake_case.
 * ------------------------------------------------------------------ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // Added by the organization plugin.
  activeOrganizationId: text("active_organization_id"),
  /**
   * Which registered device this session belongs to, so revoking a device can
   * end exactly its sessions. Without it, "revoked" would only mean "cannot
   * register again" while the existing cookie kept working.
   */
  deviceId: text("device_id"),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  // For credential accounts this holds the hash of the *auth token*, which is
  // already a KDF branch derived in the browser — never the user's password
  // and never anything that can decrypt a vault. See lib/vault/kdf.ts.
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/* ------------------------------------------------------------------ *
 * Organization plugin — teams, membership, invitations.
 * ------------------------------------------------------------------ */

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("member_org_user_idx").on(t.organizationId, t.userId)],
);

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

/* ------------------------------------------------------------------ *
 * webxterm tables.
 * ------------------------------------------------------------------ */

const bytea = customType<{ data: Buffer; default: false }>({
  dataType: () => "bytea",
});

/**
 * The entire sync system.
 *
 * `ciphertext` is an opaque blob: hosts, folders, tags, snippets, port
 * forwards, and wrapped keys, encrypted in the browser with a key the server
 * never receives. Nothing here is queryable by design — search happens
 * client-side after decryption, and no feature may assume otherwise.
 *
 * `version` drives optimistic concurrency: a write carrying a stale version is
 * rejected so a second device can merge rather than clobber.
 */
export const vaultBlob = pgTable(
  "vault_blob",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ciphertext: bytea("ciphertext").notNull(),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("vault_blob_user_idx").on(t.userId)],
);

/** Registered devices, for revocation and "where am I signed in". */
export const device = pgTable(
  "device",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    platform: text("platform"),
    /** Ed25519 identity of this browser. Distinct from the X25519 key below. */
    signingKey: text("signing_key"),
    /** X25519 public key used to wrap team keys to this device. */
    publicKey: text("public_key"),
    /** Truncated: /24 for v4, /48 for v6. Enough for "was that me?", no more. */
    lastSeenIpPrefix: text("last_seen_ip_prefix"),
    /**
     * Tombstone rather than delete: audit rows keep a resolvable reference, and
     * a revoked device id can never be re-claimed.
     */
    revokedAt: timestamp("revoked_at"),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("device_user_idx").on(t.userId),
    uniqueIndex("device_user_signing_key_idx").on(t.userId, t.signingKey),
  ],
);

/**
 * Audit trail.
 *
 * Records that something happened and roughly where — never what was typed or
 * transferred, which the server cannot see anyway.
 *
 * `targetRef` is deliberately NOT a hostname. A plaintext hostname column
 * indexed by user and time rebuilds, in the clear and durably, precisely the
 * infrastructure map the vault exists to hide (THREAT-MODEL §1). Instead the
 * browser writes HMAC(auditKey, host|port) truncated to 16 bytes, so the server
 * can group a timeline by host without ever learning which host.
 *
 * The accepted, deliberate leak: the ref is deterministic, so the server can
 * correlate the same host across time and count connections to it. That
 * correlation IS the feature — a timeline you cannot group is not an audit log.
 *
 * `source` records provenance because the three sources have very different
 * integrity: server- and relay-written rows cannot be suppressed by a
 * compromised tab, client-written rows are self-reported. Recording that stops
 * the log from over-claiming what it proves.
 */
export const auditEvent = pgTable(
  "audit_event",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    deviceId: text("device_id").references(() => device.id, { onDelete: "set null" }),
    /** Closed enum, validated server-side. Never free text. */
    eventType: text("event_type").notNull(),
    /** "server" | "relay" | "client" */
    source: text("source").notNull(),
    /** Blinded host reference. Never a hostname. */
    targetRef: text("target_ref"),
    /** Truncated network, not the full address. */
    ipPrefix: text("ip_prefix"),
    /** Per-eventType allowlist, enforced server-side. Never free text. */
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_org_time_idx").on(t.organizationId, t.createdAt),
    index("audit_user_time_idx").on(t.userId, t.createdAt),
    index("audit_user_target_idx").on(t.userId, t.targetRef, t.createdAt),
    index("audit_created_idx").on(t.createdAt),
  ],
);
