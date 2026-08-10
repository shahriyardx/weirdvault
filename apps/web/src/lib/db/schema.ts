import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

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
  /**
   * Read by Better Auth's two-factor plugin. It gates the account and the
   * session; it does not gate the vault, whose key comes from the password.
   */
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
})

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
   *
   * Nullable and stamped after the fact, because Better Auth creates the row and
   * has no idea devices exist: the device identity is a non-extractable keypair
   * in the browser's IndexedDB, invisible at sign-in. POST /api/devices carries
   * both the session cookie and the device id, so that is where the two are
   * joined, and the client calls it on every sign-in. A session that predates
   * its browser's registration keeps a null here and is not matched by a
   * revocation — the revoke dialog says so.
   */
  deviceId: text("device_id"),
})

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
})

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
})

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
})

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
)

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
})

/* ------------------------------------------------------------------ *
 * weirdvault tables.
 * ------------------------------------------------------------------ */

const bytea = customType<{ data: Buffer; default: false }>({
  dataType: () => "bytea",
})

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
)

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
)

/**
 * Recovery codes.
 *
 * A password that derives the only key to the vault has an obvious failure
 * mode: forget it and the data is gone, because we hold nothing that could
 * open it. Recovery codes are the escape hatch, and they are honest about the
 * trade they make.
 *
 * At enrolment the browser derives the secrets one more time, then encrypts
 * {vaultKey, auditKey, authToken} under a key derived from each freshly
 * generated code. What lands here is one envelope per code and nothing else —
 * the codes themselves are shown once and never transmitted.
 *
 * The trade: a recovery code is password-equivalent. Anyone holding one can
 * sign in AND decrypt, without the password. That is the point of it, and it is
 * why the codes are shown once, why using one is an audit event, and why the UI
 * says so before generating them.
 */
export const recoveryBlob = pgTable(
  "recovery_blob",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * `[{ id, salt, iv, ciphertext }]`, base64. One entry per unused code; a
     * consumed code has its entry removed, so a code cannot be replayed.
     */
    envelopes: jsonb("envelopes").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at"),
  },
  (t) => [uniqueIndex("recovery_blob_user_idx").on(t.userId)],
)

/**
 * Team keys.
 *
 * One symmetric key per organization, generated in an owner's browser and
 * wrapped separately to every member device. The server stores wrappings it
 * cannot open — it never sees the team key, exactly as it never sees a vault
 * key.
 *
 * `retiredAt` rather than delete: rotation supersedes a key, and the old
 * wrappings stay so a device that has been offline can still read what was
 * encrypted before the rotation.
 */
export const teamKey = pgTable(
  "team_key",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    retiredAt: timestamp("retired_at"),
  },
  (t) => [index("team_key_org_idx").on(t.organizationId, t.createdAt)],
)

/**
 * One team key, wrapped to one device.
 *
 * `wrapped` carries an ephemeral X25519 public key alongside the ciphertext:
 * the sender does ECDH against the device's published public key, derives a
 * wrapping key with HKDF, and throws the ephemeral private half away. So the
 * row is readable by exactly one device and by nobody who holds the database.
 */
export const teamKeyWrap = pgTable(
  "team_key_wrap",
  {
    id: text("id").primaryKey(),
    keyId: text("key_id")
      .notNull()
      .references(() => teamKey.id, { onDelete: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => device.id, { onDelete: "cascade" }),
    /** Denormalised so a member's wrappings can be revoked without a join. */
    memberUserId: text("member_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** base64 JSON: { epk, iv, ciphertext }. Opaque to the server. */
    wrapped: text("wrapped").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("team_key_wrap_key_device_idx").on(t.keyId, t.deviceId),
    index("team_key_wrap_member_idx").on(t.memberUserId),
  ],
)

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
)

/**
 * Relay transfer accounting.
 *
 * The relay must not touch a database on the data path — that constraint is
 * stated in the relay-token route and it still holds. So the split is: the
 * relay counts bytes in memory (apps/relay/src/quota.rs) and periodically posts
 * batched totals here, and enforcement happens where a token is minted, not in
 * the forwarding loop. An account over its allowance is refused a new token;
 * sessions already running are never cut at a byte boundary.
 *
 * `period` is "YYYY-MM". Rows accumulate rather than reset, so a month is
 * queried rather than zeroed, and history survives for a usage graph.
 *
 * Both directions count. The relay forwards ciphertext and cannot tell an SFTP
 * transfer from a keystroke, so there is no way to meter one and exempt the
 * other — and no honest way to describe the cap as anything but "everything".
 */
export const relayUsage = pgTable(
  "relay_usage",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** "YYYY-MM", UTC. The billing period, not a rolling window. */
    period: text("period").notNull(),
    bytesUp: bigint("bytes_up", { mode: "number" }).notNull().default(0),
    bytesDown: bigint("bytes_down", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("relay_usage_user_period_idx").on(t.userId, t.period)],
)

/**
 * Session recordings.
 *
 * The terminal output stream with timings, captured in the tab and encrypted
 * under the vault key before it goes anywhere — the same treatment the host
 * list gets, for the same reason. What lands here is a blob we cannot read and
 * the small amount of metadata a list view genuinely needs.
 *
 * `targetRef` is the blinded host reference, identical in construction to the
 * one on audit_event: HMAC(auditKey, host|port). A recording is a transcript of
 * work on a specific machine, so storing the hostname beside it would rebuild
 * the infrastructure map twice over.
 *
 * Everything a human reads — the label, the host, the shell — is inside the
 * ciphertext. Duration and size are outside it because a list has to sort and
 * a quota has to count, and neither reveals anything the row's existence does
 * not already.
 *
 * ── Where the bytes are
 *
 * Two places, and exactly one of them per row. `ciphertext` is the original
 * `bytea` column and `storage_key` names an object in a bucket; which one a
 * deployment writes is decided by whether `R2_*` is configured, and both are
 * read, so a deployment that switches on object storage keeps serving every
 * recording it already had. See lib/storage/objects.ts for why both are
 * supported rather than one being the answer.
 *
 * The check constraint is the part worth being strict about. Two sources for
 * one blob is how a read path acquires a silent preference, and a row carrying
 * both would make "which is the real one" a question about the order of two
 * `if`s in a route. Never both, enforced by Postgres. Both null is allowed and
 * means the bytes are gone — which is what a revoked share is, below.
 */
export const recording = pgTable(
  "recording",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    deviceId: text("device_id").references(() => device.id, { onDelete: "set null" }),
    /** Blinded host reference. Never a hostname. */
    targetRef: text("target_ref"),
    /** The envelope itself, when this deployment stores blobs in Postgres. */
    ciphertext: bytea("ciphertext"),
    /**
     * `rec/<user_id>/<recording_id>`, when it stores them in a bucket.
     *
     * Stored rather than derived from the two ids it is built from, because a
     * key that is recomputed on every read is a key that changes when the
     * formula does, and the objects already in the bucket would not follow.
     */
    storageKey: text("storage_key"),
    /** Outside the envelope so a quota can be counted without decrypting. */
    sizeBytes: integer("size_bytes").notNull(),
    durationMs: integer("duration_ms").notNull(),
    startedAt: timestamp("started_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("recording_user_time_idx").on(t.userId, t.createdAt),
    check(
      "recording_one_body_idx",
      sql`not (${t.ciphertext} is not null and ${t.storageKey} is not null)`,
    ),
  ],
)

/**
 * A share link for a recording.
 *
 * The decryption key is NOT here and never reaches us: it lives in the URL
 * fragment, which browsers do not transmit. The server hands out ciphertext to
 * anyone presenting the token and has no way to read what it is serving.
 *
 * Which is exactly why `expiresAt` and `maxViews` are not optional extras. The
 * link is the key, so possession is access, and the only controls that mean
 * anything are how long it lives and how many times it can be spent.
 *
 * Revoking stamps `revoked_at`, destroys the second copy of the bytes and zeroes
 * `size_bytes`, which stops the next fetch and returns the bytes to the
 * account's ceiling. The row survives so the owner can still see that a link
 * existed and when it was cut off. What it does not do is recall anything: a
 * viewer who already fetched the transcript has it, and the link still carries a
 * working key — there is simply nothing left for it to open. The UI must not
 * imply more than that.
 *
 * "Destroys the bytes" is one of two statements depending on where they are:
 * `ciphertext` is set to null, or the object `storage_key` names is deleted from
 * the bucket and the column nulled. A revoked share is therefore the row shape
 * with neither column set, which is why the check constraint forbids both being
 * present rather than requiring one of them.
 *
 * The timestamps here are `timestamptz` while the rest of this schema is not,
 * and the difference is deliberate. `expires_at` is the only timestamp in the
 * codebase compared inside SQL — /api/shares/[token] tests it against `now()` in
 * the same statement that increments the view counter — and a naive `timestamp`
 * in that comparison is promoted through the server's TimeZone setting, so on a
 * deployment whose Postgres is not UTC the enforced expiry would sit hours away
 * from the one the owner was shown. Every other timestamp is compared in
 * JavaScript, where drizzle's UTC round-trip makes the distinction invisible.
 */
export const recordingShare = pgTable(
  "recording_share",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id")
      .notNull()
      .references(() => recording.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The unguessable path segment. The key that opens it is in the fragment. */
    token: text("token").notNull().unique(),
    /**
     * The recording again, encrypted under a key that exists only for this
     * share — NOT the copy in `recording.ciphertext`.
     *
     * This column is the whole reason sharing is not a one-line feature. The
     * stored recording is sealed with the owner's vault key, and that key opens
     * their hosts, their SSH keys and every other recording they have. Putting
     * it in a link to send someone would hand over the account, so the share
     * flow decrypts in the owner's tab, generates a fresh random key, and
     * re-encrypts just this one transcript under it. The new key goes in the URL
     * fragment; this ciphertext is what it opens.
     *
     * The cost is a second copy of the bytes, which is why a share counts
     * against the account's recording storage the same as the original.
     *
     * Null when the copy lives in the bucket instead — see `storage_key` — or
     * when the share has been revoked and there is no copy at all.
     */
    ciphertext: bytea("ciphertext"),
    /** `share/<user_id>/<share_id>`, when the copy is an object. */
    storageKey: text("storage_key"),
    /** Counted against the storage ceiling, so it is stored rather than derived. */
    sizeBytes: integer("size_bytes").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxViews: integer("max_views"),
    views: integer("views").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("recording_share_recording_idx").on(t.recordingId),
    // The listing is served by the index above; this one is for the storage sum
    // on the create path, which asks for one account's total across every
    // recording and so has no `recording_id` to narrow it. Without a user-led
    // index that sum scans every share row in the deployment on every "Create
    // the link" — the same argument recording_user_time_idx exists for.
    index("recording_share_user_idx").on(t.userId),
    check(
      "recording_share_one_body_idx",
      sql`not (${t.ciphertext} is not null and ${t.storageKey} is not null)`,
    ),
  ],
)

/**
 * Stripe subscriptions.
 *
 * The mirror of Stripe's state, not a second source of truth. Stripe owns
 * whether an account is paid; this table exists so that answering "is this
 * account Pro" is one indexed local read rather than an API call on a path that
 * cannot afford one — every relay token mint, every audit query, every attempt
 * to start a recording.
 *
 * One row per user. There is no organization dimension: an account is a person,
 * and a subscription is that person's. The team surface was built and has been
 * withdrawn — the shared-vault machinery it would have needed (team_key,
 * team_key_wrap) is declared above and nothing is encrypted under it, so what
 * shipped was a roster, and charging per seat for a roster is not a product.
 * If teams return, this table grows an organization id and a seat count
 * alongside; it does not need rewriting.
 *
 * One row per user is also an assumption about Stripe, and a load-bearing one:
 * it means a user has at most one subscription. Stripe will happily give one
 * customer two, so mirrorSubscription has to decide what to do when an event
 * arrives about a subscription that is not the one this row carries. It refuses
 * to let a cancellation of one cancel the other; see the note there.
 *
 * Staleness is the thing to design around. Rows are written by the webhook, so
 * a missed or delayed event leaves this table behind. The direction of the
 * error is chosen deliberately: refusing a paid feature to someone who just
 * paid is worse than granting it briefly to someone who just cancelled, so
 * reads fail toward access and `currentPeriodEnd` bounds how long that lasts.
 *
 * `status` is Stripe's own string rather than a boolean, because "is it paid"
 * genuinely has more than two states — `past_due` and `unpaid` are subscriptions
 * still retrying a card, and collapsing them to false would cut someone off
 * mid-retry over a payment about to succeed.
 *
 * No card details, no billing address, no invoice contents. Stripe holds all of
 * that and has the compliance to justify holding it; we keep an id and a state.
 */
export const subscription = pgTable(
  "subscription",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * Survives cancellation on purpose. A returning customer must reuse their
     * Stripe customer, or their invoice history forks in two and neither half
     * is the truth.
     */
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    /** Stripe's own enum: active, trialing, past_due, canceled, unpaid, … */
    status: text("status").notNull(),
    stripePriceId: text("stripe_price_id"),
    /**
     * When access lapses if nothing renews it. Read as the bound on how long a
     * stale row can keep granting a paid feature.
     */
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    /** Set when someone has cancelled but paid through the period. */
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    /**
     * When the Stripe event that produced this row was created, at Stripe.
     *
     * Not `updated_at`, which is when we happened to write it. Stripe does not
     * guarantee delivery order and retries a failed delivery for days, so a
     * webhook that 500s can arrive after a later one succeeds — and without a
     * timestamp from Stripe's own clock there is no way to tell that the older
     * of two deliveries is the one in hand. mirrorSubscription refuses a write
     * carrying an older stamp than the row already has.
     *
     * Nullable because rows written before this column existed, and rows
     * created by `customerIdFor` before any subscription attaches, have no
     * event behind them. A null means "no event has been applied here yet" and
     * never blocks a write.
     */
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("subscription_user_idx").on(t.userId),
    index("subscription_customer_idx").on(t.stripeCustomerId),
    index("subscription_stripe_sub_idx").on(t.stripeSubscriptionId),
  ],
)

/**
 * Rate limit counters.
 *
 * One row per bucket, where a bucket is a route plus whoever is being counted —
 * a user id when there is a session, a truncated network when a trusted proxy
 * says what the address is, and one shared bucket for everybody when neither is
 * available. lib/rate-limit.ts builds the keys and explains that last case,
 * which is the uncomfortable one.
 *
 * In Postgres rather than in memory, and that is the whole reason this table
 * exists. A `Map` in the process is what /api/recovery had, and it has two
 * failures that are invisible until they matter: a second container gets a
 * second budget, so scaling out multiplies every limit by the replica count,
 * and a restart forgets everything, so a limiter is a redeploy away from being
 * disabled. Neither shows up in testing. The cost is one round trip on a path
 * that was already going to talk to Postgres.
 *
 * `window_start` is when the current window opened, not when the last request
 * arrived — a fixed window, so a caller under the limit is never pushed over it
 * by their own steady traffic. Better Auth's built-in storage slides that
 * timestamp forward on every allowed request instead, which turns a drip below
 * the limit into an eventual block; lib/rate-limit.ts hands Better Auth this
 * table through `customStorage` precisely so there is one algorithm to explain
 * rather than two that differ in a way nobody would predict from the config.
 *
 * Nothing here is authoritative about anything. A row lost, a row reset, the
 * whole table truncated — all of it fails open, and the security properties live
 * in the 120-bit recovery code, the 256-bit share token and the session check.
 * This bounds cost and noise.
 */
export const rateLimit = pgTable("rate_limit", {
  /** `<bucket>:<subject>`. Opaque, and never shown to a caller. */
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  /** Epoch milliseconds. `bigint` because a JS timestamp overflows `integer`. */
  windowStart: bigint("window_start", { mode: "number" }).notNull(),
})

/**
 * Webhook events already processed.
 *
 * Stripe retries on any non-2xx and can deliver the same event more than once
 * even without a retry, so the handler has to be idempotent. Inserting the
 * event id first and treating a unique violation as "already done" makes that a
 * property of the database rather than of the handler's control flow.
 */
export const stripeEvent = pgTable("stripe_event", {
  /** Stripe's event id. The primary key IS the deduplication. */
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
})

/* ------------------------------------------------------------------ *
 * Second factors: TOTP and passkeys.
 *
 * Both authenticate the ACCOUNT. Neither opens the vault, and that is a
 * decision rather than an omission.
 *
 * WebAuthn can carry key material — the PRF extension returns a stable secret
 * that could wrap a vault key, which is how Bitwarden and 1Password do passkey
 * unlock. It was considered and declined. The vault key is derived from the
 * password and from nothing else, so there is exactly one way in and one
 * sentence to describe it, rather than a second unlock path with its own
 * browser support matrix, its own re-wrap step in lib/vault/rekey.ts, and its
 * own answer to "what happens when you change your password".
 *
 * The consequence is visible to users and must stay visible in the UI: signing
 * in with a passkey does not derive a vault key, so the session is
 * authenticated and the vault is locked until the password is entered.
 * ------------------------------------------------------------------ */

/**
 * TOTP enrolment, one row per user.
 *
 * Better Auth's two-factor plugin owns these columns; the names are its
 * contract, not ours. `user.twoFactorEnabled` is the flag it reads.
 *
 * `secret` is the shared TOTP seed and `backupCodes` the single-use fallbacks.
 * The plugin marks both `returned: false`, so they are never included in a user
 * object sent to a browser — worth knowing before anyone adds a convenience
 * select here. `failedVerificationCount` and `lockedUntil` are marked the same
 * way, and for a better reason: they are the rate limit, and handing a caller
 * its own attempt count tells an attacker exactly how much budget is left.
 *
 * This table was first written with only the four obvious columns, from a
 * partial read of the plugin's schema. The plugin also owns `verified`,
 * `failedVerificationCount` and `lockedUntil`, and without them enrolment fails
 * on the first insert — a whole feature that could never be switched on. Adding
 * a column the plugin expects is not optional decoration: this list is its
 * contract, and anything missing surfaces as a runtime error nobody sees until
 * the first person tries to enrol.
 */
export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    /**
     * Whether the enrolment was completed by entering a code from the app.
     * Defaults true because the plugin writes the row at the point it considers
     * verification done; a row that never got there is deleted rather than left
     * false.
     */
    verified: boolean("verified").notNull().default(true),
    /** Consecutive wrong codes. The plugin resets it on a correct one. */
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    /**
     * Set once too many codes have failed. Until it passes, verification is
     * refused regardless of the code — which is what stops a six-digit space
     * from being brute-forced in an afternoon.
     */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [index("two_factor_user_idx").on(t.userId)],
)

/**
 * Registered passkeys.
 *
 * Column names are @better-auth/passkey's contract. `publicKey` here is a
 * WebAuthn credential public key and has nothing to do with the X25519 column
 * of the same name that used to sit on `device` — different key, different
 * algorithm, different purpose. Worth saying, because the coincidence has
 * already caused one confusion in this codebase.
 *
 * `counter` is the authenticator's signature counter, which exists to detect a
 * cloned credential. `backedUp` says the credential syncs through a provider
 * like iCloud Keychain or Google Password Manager, which is what makes a
 * passkey work on a second device — worth surfacing in the UI, since "this one
 * only exists on that laptop" is a materially different thing to hold.
 */
export const passkey = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    /** What the user called it. Shown in the list so the right one can go. */
    name: text("name"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The WebAuthn credential public key, base64. Not an SSH key, not X25519. */
    publicKey: text("public_key").notNull(),
    credentialID: text("credential_id").notNull(),
    /** Signature counter, for clone detection. */
    counter: integer("counter").notNull().default(0),
    /** "singleDevice" or "multiDevice". */
    deviceType: text("device_type").notNull(),
    /** Synced through a provider, so it exists on more than one machine. */
    backedUp: boolean("backed_up").notNull().default(false),
    transports: text("transports"),
    /** Identifies the authenticator model, so the UI can name it. */
    aaguid: text("aaguid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("passkey_user_idx").on(t.userId),
    uniqueIndex("passkey_credential_idx").on(t.credentialID),
  ],
)

/* ------------------------------------------------------------------ *
 * Agents: machines that cannot be dialled.
 * ------------------------------------------------------------------ */

/**
 * A machine that reaches us instead of us reaching it.
 *
 * A server behind a home router has no address the relay can connect to, so a
 * small daemon on that machine holds an outbound connection and waits. This row
 * is that machine's identity: an Ed25519 public key it generated during
 * enrollment and proves possession of on every reconnect.
 *
 * What is deliberately NOT here is anything about the host itself — no
 * username, no label the user typed, no port. Those live in the encrypted vault
 * with every other host record, because they are the user's data and the server
 * has no business reading them. This table holds only what the relay must be
 * able to check without a key: which public key, whose account, still valid or
 * not. A row here says a machine may connect; it says nothing about what is on
 * it.
 *
 * `hostname`, `os` and `arch` are the exception, and they are self-reported by
 * the agent at enrollment purely so the dashboard can say "this is the box you
 * just typed on" rather than showing a bare UUID. Nothing trusts them.
 */
export const agent = pgTable(
  "agent",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** What the user calls it. Defaults to the reported hostname. */
    label: text("label").notNull(),
    /** Ed25519 public key, base64. The only thing that authenticates the agent. */
    publicKey: text("public_key").notNull(),
    /**
     * SHA256:… over the public key, stored rather than derived on read.
     *
     * It is shown twice — on the enrollment page and by `weirdvault-agent status`
     * — and the whole point is that a person compares them. Computing it in two
     * places is how they end up formatted differently and stop comparing.
     */
    fingerprint: text("fingerprint").notNull(),
    /** Self-reported at enrollment, for display only. */
    hostname: text("hostname"),
    os: text("os"),
    arch: text("arch"),
    agentVersion: text("agent_version"),
    /**
     * Set when the user revokes it. Checked on every relay verification, so a
     * revoke takes effect on the agent's next reconnect at the latest — and
     * immediately for any new session, since /api/relay-token reads this too.
     *
     * A tombstone rather than a delete: the id must never be re-issued, and a
     * host record in somebody's vault still points at it.
     */
    revokedAt: timestamp("revoked_at"),
    /** Stamped by the relay's verification call — the last time it connected. */
    lastSeenAt: timestamp("last_seen_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("agent_user_idx").on(t.userId),
    uniqueIndex("agent_public_key_idx").on(t.publicKey),
  ],
)

/**
 * A one-time token that turns into an agent.
 *
 * Enrollment has to be authenticated by something the machine can be given over
 * a copy-paste, because the machine has no session and the person at the
 * keyboard may not have a browser on it. So: a short-lived single-use secret,
 * minted by a signed-in user, spent by the daemon.
 *
 * Only the hash is stored. The token is a bearer credential that grants
 * attaching a machine to an account, and a leaked database should not be a
 * leaked set of live enrollment tokens — the same reason session tokens are not
 * stored in the clear. It is spent by an UPDATE with `used_at IS NULL` in the
 * WHERE clause rather than a read-then-write, so two daemons racing the same
 * token produce one agent and one refusal.
 */
export const agentEnrollment = pgTable(
  "agent_enrollment",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** SHA-256 of the token, hex. Never the token itself. */
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    /** The agent it became, once spent. Lets the waiting page find it. */
    agentId: text("agent_id").references(() => agent.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_enrollment_token_idx").on(t.tokenHash),
    index("agent_enrollment_user_idx").on(t.userId),
  ],
)
