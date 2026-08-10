import { betterAuth } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { twoFactor } from "better-auth/plugins/two-factor"
import { passkey } from "@better-auth/passkey"
import { getTableColumns } from "drizzle-orm"

import { db, schema } from "@/lib/db"
import { dbErrorSummary } from "@/lib/db/errors"
import { ipPrefix, type AuditEventType } from "@/lib/audit/events"
import { clientAddress } from "@/lib/audit/address"
import { BillingNotConfiguredError } from "@/lib/billing/stripe"
import { cancelSubscriptionForDeletion } from "@/lib/billing/subscription"
import { authRateLimitStorage } from "@/lib/rate-limit"
import { purgeAccountObjects } from "@/lib/storage/purge"

/**
 * Better Auth owns accounts and sessions. That is the whole list.
 *
 * Note what it does NOT own: the vault key. The "password" arriving here is
 * already an HKDF branch derived in the browser (see lib/vault/kdf.ts), so the
 * strongest thing an attacker gets from this database is the ability to
 * impersonate a session — never to decrypt a host list or an SSH key.
 *
 * The organization plugin used to be configured here and is deliberately gone.
 * An account is a person: no organizations, no members, no invitations, no
 * seats. The tables it created are still declared in lib/db/schema.ts and still
 * migrated, because dropping them is destructive and reversing this decision
 * should not need a data migration to undo — but nothing reads or writes them
 * now. The inferred Session type loses `activeOrganizationId` with the plugin,
 * so anything that read it stopped compiling rather than silently reading
 * undefined; `session.active_organization_id` survives as a column nobody
 * fills.
 *
 * ---------------------------------------------------------------------------
 * GitHub, and the hole it opens
 *
 * OAuth hands back a session and no secret. Every other route into this app
 * arrives carrying an HKDF branch of a password that was stretched in the
 * browser; a GitHub callback arrives carrying an access token that says who
 * somebody is at GitHub and nothing that could derive a vault key. So a GitHub
 * account is authenticated and has no vault: it cannot save a host, and finding
 * that out by trying is the worst possible way to learn it.
 *
 * The answer is the bootstrap at /set-vault-password, and `hasVaultCredential`
 * below is what the dashboard layout gates on. Note where the substance lives —
 * registering the provider is four lines, and everything that matters is the
 * page that follows it.
 */
/** Named so the error messages, the UI copy and the README cannot drift. */
export const GITHUB_ID_ENV = "GITHUB_CLIENT_ID"
export const GITHUB_SECRET_ENV = "GITHUB_CLIENT_SECRET"

/**
 * The GitHub OAuth app's credentials, or null if this deployment has none.
 *
 * Read once, at module load, and deliberately not on every call the way
 * lib/billing/stripe.ts reads its variables. The difference is not carelessness:
 * `betterAuth()` below is evaluated at import time, so the set of registered
 * providers is fixed for the life of the process whatever the environment does
 * afterwards. A `githubConfigured()` that re-read the variable could therefore
 * answer true while the running server has no github provider registered, and
 * the sign-in page would render a button whose callback 404s. One snapshot,
 * read once, used by both — so the button on screen is a statement about the
 * server that is actually running. Adding the variables needs a restart, which
 * is what it needed anyway.
 *
 * There is no fallback and no development default. An OAuth client id compiled
 * into the image would be somebody's real GitHub app, and a half-configured
 * provider fails at the redirect with an error page from github.com, which is
 * the least debuggable place for it to go wrong.
 */
const githubCredentials = (() => {
  const clientId = process.env[GITHUB_ID_ENV]
  const clientSecret = process.env[GITHUB_SECRET_ENV]
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
})()

/**
 * Whether "Continue with GitHub" exists on this deployment.
 *
 * The sign-in form asks through a Server Action, because this module runs only
 * on the server and the answer is not in the browser bundle. Absent means
 * absent: with the variables unset the provider is not registered and the
 * button is not rendered at all, rather than rendered and failing when pressed.
 */
export function githubConfigured(): boolean {
  return githubCredentials !== null
}

/* ------------------------------------------------------------ second factors */

/**
 * TOTP and passkeys, and the line they do not cross.
 *
 * Both authenticate the ACCOUNT. Neither opens the vault, and that is a decision
 * with a name: the WebAuthn PRF extension can return a stable per-credential
 * secret that would wrap a vault key, which is how a password manager offers
 * passkey unlock. It is not implemented here and is not being designed toward.
 * One derivation, from the password, means one sentence describing how the vault
 * opens and one answer to what a password change does. Two would mean two of
 * everything, including two ways to be wrong.
 *
 * The visible consequence, which the UI is responsible for stating rather than
 * hiding: a passkey sign-in types no password, so it derives no key, so the
 * dashboard it lands on is authenticated and locked. That is the same state a
 * GitHub sign-in produces, and components/vault-unlock.tsx explains both from one
 * place so the two explanations cannot drift.
 */

/**
 * The WebAuthn relying party, pinned to the deployment's own URL.
 *
 * This is the one setting here that cannot be corrected later. A credential is
 * bound to the RP ID at the moment it is created, and a passkey registered under
 * the wrong one is not repairable — it simply never matches again, and the user
 * finds out at the worst moment. The plugin's default is the literal string
 * "localhost", which is right for exactly one machine, so it is derived from
 * BETTER_AUTH_URL instead: the same value the callbacks and the cookie domain
 * already depend on, so a deployment that has it wrong is already broken in
 * louder ways.
 *
 * `origin` is pinned for the same reason, and pinning it is what makes the
 * registration ceremony refuse a request forwarded from somewhere else. Leaving
 * it unset would take the Origin header from the request, which is the value an
 * attacker controls.
 */
const relyingParty = (() => {
  const raw = process.env.BETTER_AUTH_URL ?? "http://localhost:3000"
  try {
    const url = new URL(raw)
    return { rpID: url.hostname, origin: url.origin }
  } catch {
    // A malformed BETTER_AUTH_URL is a configuration error, not something to
    // paper over with a guess: an RP ID invented here would mint credentials
    // that never work again. localhost is the only defensible fallback because
    // it is also the only value that is right by accident.
    return { rpID: "localhost", origin: "http://localhost:3000" }
  }
})()

/**
 * That better-auth's two-factor plugin can actually store an enrolment here.
 *
 * It could not, for a while. `two_factor` was first migrated with only
 * (id, user_id, secret, backup_codes), read from a partial look at the plugin's
 * schema. The installed plugin also writes `verified` on enable and on the first
 * successful code, and `failed_verification_count` / `locked_until` for its
 * account-level lockout. The drizzle adapter refuses an insert naming a column
 * its table does not have — see checkMissingFields in the drizzle adapter — so
 * enabling TOTP answered 500 rather than degrading, and the whole feature was
 * unreachable on every deployment. Migration 0008 added the three columns and
 * this check now passes; it is kept rather than deleted because it is what
 * turned a silent 500 into a stated reason, and the next plugin upgrade that
 * adds a column will land the same way.
 *
 * Checked against the drizzle table object at module load, which costs nothing
 * and is the same shape the github credentials check has: the deployment answers
 * once, and the UI renders a control only if the server behind it can honour it.
 * The check is on the drizzle schema rather than on the database because that is
 * what the adapter validates against; a table that has the columns while the
 * schema does not would still fail, and the schema is the thing under review.
 *
 * Note what it does NOT check: that the migration has been applied. A schema
 * carrying the columns and a database that has not run 0008 will pass here and
 * fail at the insert. `bun run db:migrate` is the answer, and the container
 * runs it at start.
 */
const TWO_FACTOR_PLUGIN_COLUMNS = ["verified", "failedVerificationCount", "lockedUntil"] as const

const missingTwoFactorColumns: readonly string[] = (() => {
  const present = new Set(Object.keys(getTableColumns(schema.twoFactor)))
  return TWO_FACTOR_PLUGIN_COLUMNS.filter((column) => !present.has(column))
})()

/** Whether this deployment can actually store a TOTP enrolment. */
export function totpStorageReady(): boolean {
  return missingTwoFactorColumns.length === 0
}

/**
 * What is missing, for the message on screen. Column names rather than a
 * sentence, because the person who can act on this is reading a migration.
 */
export function missingTwoFactorStorage(): readonly string[] {
  return missingTwoFactorColumns
}

if (missingTwoFactorColumns.length > 0) {
  console.warn(
    "two-factor (TOTP) is disabled in the UI: the two_factor table is missing " +
      `${missingTwoFactorColumns.join(", ")}, which better-auth writes. Passkeys are unaffected.`,
  )
}

/* ------------------------------------------------------- second-factor audit */

/** One catalogued event and the metadata the allowlist permits for it. */
interface FactorEvent {
  type: AuditEventType
  metadata: Record<string, unknown>
}

/**
 * Writes the audit row for a second-factor change, from the endpoint that made
 * it.
 *
 * Server-written, like the recovery events and for the same reason: these rows
 * are the record of who can sign in as this person. A browser allowed to post
 * them could post a plausible history around a factor it had just added for
 * itself, which is precisely the story the log exists to contradict. /api/audit
 * refuses them from a client — they are `source: "server"` in the catalogue, and
 * the route checks.
 *
 * Runs on every Better Auth request, because the top-level `after` hook has no
 * matcher; the switch below returns immediately for everything else. Nothing in
 * here is allowed to fail loudly: a database that cannot take an audit row must
 * not turn a successful sign-in into an error, so the insert is caught and
 * summarised. The honest cost is that the log can be quietly incomplete during a
 * database incident, which is the same trade lib/audit/client.ts already makes
 * and the reason the Activity page never claims completeness.
 *
 * How enrolment is told from a sign-in challenge, since one endpoint serves
 * both: `verifyTwoFactor` calls `getSessionFromCtx` first, which caches its
 * answer on `ctx.context.session` — the session object when the caller was
 * already signed in (confirming a new enrolment), and null when it was not (the
 * challenge after an email sign-in). The one case this reads wrong is a
 * signed-in user re-verifying an already-enabled factor, which nothing in this
 * app does; it would log an extra "enrolled" rather than miss a real one.
 */
const WATCHED_PATHS = new Set([
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
  "/passkey/verify-authentication",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
])

const secondFactorAudit = createAuthMiddleware(async (ctx) => {
  // This runs on every Better Auth request, /get-session included, so the first
  // thing it does is decide it has nothing to do.
  if (!WATCHED_PATHS.has(ctx.path)) return

  // After-hooks run on failure too, with the error in `returned`. A row written
  // here would say a factor changed when the request was refused.
  const returned: unknown = ctx.context.returned
  if (returned instanceof APIError) return

  // The endpoint either had a session (an authenticated change) or has just
  // created one (a sign-in). Both are on the context by the time this runs.
  const priorSession = ctx.context.session ?? null
  const userId = priorSession?.user?.id ?? ctx.context.newSession?.user?.id ?? null
  if (!userId) return

  let event: FactorEvent | null = null

  switch (ctx.path) {
    case "/passkey/verify-registration": {
      // Read off the row the plugin just created rather than off the request,
      // so what is logged is what was stored. Absent keys are omitted rather
      // than defaulted: "not recorded" and "not backed up" are different facts.
      const row = returned as { backedUp?: unknown; deviceType?: unknown } | null
      const metadata: Record<string, unknown> = {}
      if (typeof row?.backedUp === "boolean") metadata.backedUp = row.backedUp
      if (row?.deviceType === "singleDevice" || row?.deviceType === "multiDevice") {
        metadata.deviceType = row.deviceType
      }
      event = { type: "passkey.registered", metadata }
      break
    }
    case "/passkey/delete-passkey":
      // No credential id in the metadata. It is the server's handle on a
      // credential, it is meaningless once the row is gone, and a timeline is
      // not where it belongs.
      event = { type: "passkey.removed", metadata: {} }
      break
    case "/passkey/verify-authentication":
      event = { type: "passkey.used", metadata: {} }
      break
    case "/two-factor/verify-totp":
      event = priorSession
        ? { type: "totp.enrolled", metadata: {} }
        : { type: "totp.verified", metadata: { factor: "totp" } }
      break
    case "/two-factor/verify-backup-code":
      event = { type: "totp.verified", metadata: { factor: "backup-code" } }
      break
    case "/two-factor/disable":
      event = { type: "totp.disabled", metadata: {} }
      break
    case "/two-factor/generate-backup-codes": {
      const codes = (returned as { backupCodes?: unknown } | null)?.backupCodes
      event = {
        type: "totp.codes-reissued",
        metadata: Array.isArray(codes) ? { backupCodes: codes.length } : {},
      }
      break
    }
    default:
      return
  }

  try {
    await db.insert(schema.auditEvent).values({
      id: crypto.randomUUID(),
      userId,
      // No device id. Registering a device is a browser-side call with its own
      // identifier, and this hook has no access to it; a null here says "not
      // attributed" rather than naming the wrong machine.
      deviceId: null,
      eventType: event.type,
      source: "server",
      targetRef: null,
      // Null unless a trusted proxy is configured — see lib/audit/address.ts.
      // A client-chosen prefix would be a fabricated record.
      ipPrefix: ipPrefix(ctx.headers ? clientAddress(ctx.headers) : null),
      metadata: event.metadata,
    })
  } catch (e) {
    // Summarised, never logged whole: a drizzle failure's message is the SQL and
    // the values bound to it, and one of those is a user id.
    console.error(`audit row for ${event.type} was not written`, dbErrorSummary(e))
  }
})

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      // Named explicitly like the four above. The adapter looks a model up by
      // name and throws if it is absent, so a plugin registered without its
      // table here fails on its first write rather than at start-up.
      twoFactor: schema.twoFactor,
      passkey: schema.passkey,
    },
  }),

  plugins: [
    twoFactor({
      // What an authenticator app shows above the code. The account's email is
      // the label; this is the line beside it.
      issuer: "webxterm",
      /**
       * Backup codes encrypted at rest, which is NOT the default.
       *
       * better-auth 1.6.26 stores them as a plain JSON array unless told
       * otherwise — the TOTP secret beside them is encrypted with the server
       * secret, and the codes that bypass that secret are not. A backup code is
       * a sign-in in text form, so a dump of `two_factor` would be ten working
       * credentials per enrolled account.
       *
       * This raises the bar to "the database and BETTER_AUTH_SECRET", which is
       * the same bar the TOTP secret already sits behind. It is not the bar the
       * vault sits behind and it cannot be: verifying a code requires comparing
       * it, so the server has to be able to read them back. That is the honest
       * difference between an account credential and vault key material, and it
       * is why enabling this does not make 2FA protect the vault.
       */
      backupCodeOptions: { storeBackupCodes: "encrypted" },
      /**
       * No `skipVerificationOnEnable`. A factor that is switched on before a
       * code from it has ever been checked is a factor that can lock somebody
       * out of their own account on a clock skew or a mistyped secret — and this
       * account has a vault behind it that nobody else can open on their behalf.
       * The enable step hands back a secret and backup codes, and nothing is
       * enabled until /two-factor/verify-totp accepts a code the authenticator
       * produced.
       */
      /**
       * No `allowPasswordless` either, so every one of these endpoints demands
       * the password. In this app that means the HKDF auth branch — the browser
       * re-derives it and sends the same token it would send at sign-in, so
       * "confirm your password" is a real proof and not a form field.
       */
    }),
    passkey({
      ...relyingParty,
      rpName: "webxterm",
      /**
       * Registration keeps its default of requiring a session, and better-auth
       * enforces that with `freshSessionMiddleware`: the session must have been
       * created within `session.freshAge`, which is 24 hours here because
       * nothing overrides it. So adding a passkey after a long-lived session has
       * been idle for a day needs a fresh sign-in first. That is the correct
       * behaviour for a control that adds a way into the account, and the
       * settings page says so when the server refuses.
       *
       * There is no `extensions` block, and specifically no `prf`. See the note
       * at the top of this section: a passkey never carries key material here.
       */
    }),
  ],

  emailAndPassword: {
    enabled: true,
    // The client already ran Argon2id; this is the server-side hash of the
    // derived auth token, not of a user-chosen password.
    minPasswordLength: 32,
    autoSignIn: true,
  },

  /**
   * GitHub, registered only when both variables are set.
   *
   * Spreading an empty object leaves `socialProviders` with no github key, so
   * /api/auth/sign-in/social rejects the provider and the authorize URL is
   * never built. That is the state an unconfigured deployment should be in:
   * there is nothing to press and nothing to fail.
   */
  socialProviders: {
    ...(githubCredentials && {
      github: {
        ...githubCredentials,

        /**
         * The salt hazard, pinned.
         *
         * lib/vault/kdf.ts derives the Argon2id salt from the email address, so
         * the address on the user row is load-bearing key material: change it
         * and the same password stops producing the same vault key, and every
         * existing ciphertext becomes unopenable. A password sign-up cannot hit
         * that by accident, because the address came from the user and this app
         * has no way to change it afterwards. A GitHub sign-in can: the address
         * comes from GitHub, and somebody can change their primary email there
         * without ever visiting us.
         *
         * `overrideUserInfoOnSignIn: false` is already the default. It is
         * written out because the default is the only thing standing between a
         * routine GitHub profile edit and a stranded vault, and a default that
         * important should be a decision in the file rather than a fact
         * somebody has to go and look up. With it off, the email is captured at
         * registration and never updated by a later sign-in — which is exactly
         * the pin the vault needs.
         *
         * What this does NOT fix: the salt is still derived from whatever
         * address is on the row, by every caller of deriveSecrets, rather than
         * from a column that says "this is the address your key was derived
         * from". Any future feature that lets a user change their email — from
         * a settings form, from an admin tool, from a support script — strands
         * that account's vault silently, GitHub or not. The durable fix is a
         * `vault_salt_email` column, written once at sign-up, read by
         * lib/vault/kdf.ts instead of user.email; that touches the derivation,
         * which must stay byte-identical for every vault already written, so it
         * is deliberately not attempted here.
         */
        overrideUserInfoOnSignIn: false,
      },
    }),
  },

  account: {
    /**
     * Account linking, decided rather than defaulted.
     *
     * The default in better-auth 1.6 is implicit linking with two conditions:
     * the provider must report the email as verified, and the *local* user must
     * already have `emailVerified` set (`requireLocalEmailVerified`, default
     * true). This app has no email verification at all — no mailer, no
     * verification route, nothing that ever sets that column — so on the
     * defaults linking would be refused every time, but for a reason nobody
     * chose and that a later "let's send emails" commit would silently reverse.
     *
     * So it is off explicitly. The reasoning, in order of weight:
     *
     *  - We do not verify email addresses, so an address on a local account is
     *    not evidence that its owner controls it. Anyone can register
     *    victim@example.com here today. If GitHub sign-in linked into that
     *    account, the pre-registrant would be waiting inside the account the
     *    real owner lands in — the classic pre-registration takeover, and the
     *    thing `requireLocalEmailVerified` exists to prevent. GitHub verifies
     *    its side; that is what makes linking defensible in general, and it is
     *    only ever half of what is needed. Our half is missing.
     *  - An account here is a vault, and linking two sign-in routes onto one
     *    account puts two identities in front of one set of ciphertext. The
     *    vault key comes from the password, so whoever set the password can
     *    read everything the account ever stores, including what somebody who
     *    arrived later via GitHub put there.
     *
     * The cost is real and lands on an honest user: sign up with a password,
     * come back and press "Continue with GitHub" on the same address, and the
     * callback refuses with `account_not_linked` instead of signing you in.
     * components/auth-form.tsx catches that code and says so in words — that
     * the address already has a password account and the password is the way
     * in — because the raw code on an error page would read as a bug.
     *
     * Turning this on later needs email verification first, not a config edit.
     */
    accountLinking: { enabled: false },
  },

  user: {
    deleteUser: {
      /**
       * Deletion is verified with the derived auth token, which is the only
       * credential this server has ever held — see deleteAccountWithVault in
       * lib/auth-client.ts.
       *
       * No email confirmation step. It would send a link to prove control of an
       * address the session already proves control of, and the destructive part
       * is not reversible by us either way: the vault blob goes with the row and
       * we have never had a key for it. The confirmation that matters is the one
       * in the UI, where the user types their address and their password.
       */
      enabled: true,

      /**
       * Cancel the subscription before the row that names it is destroyed.
       *
       * `subscription.user_id` cascades, so the moment the user row goes, the
       * customer id, the subscription id and every route from this app back to
       * Stripe go with it. A subscription still running at that point renews
       * monthly with nobody able to stop it: the person cannot sign in to reach
       * the portal, and the webhook can no longer attribute their events to an
       * account. Warning them in the dialog was the old answer and it is still
       * there, but a warning is not a mechanism.
       *
       * Throwing here aborts the deletion, which is the intended behaviour when
       * Stripe cannot be reached. Deleting the last local record of a live
       * charge is worse than asking somebody to try again, and this is the only
       * point in the flow where the two are still separable.
       *
       * The cancellation is not reversible by retrying the delete: if this
       * succeeds and something after it fails, the subscription is already
       * cancelled and the account survives on Free. That is the safer half of
       * an ordering that has no transaction spanning both systems.
       */
      beforeDelete: async (user) => {
        try {
          const cancelled = await cancelSubscriptionForDeletion(user.id)
          if (cancelled) console.info(`subscription ${cancelled} cancelled before account deletion`)
        } catch (e) {
          // Summarised rather than logged whole: this path reads the database
          // before it calls Stripe, and a drizzle failure's message is the SQL
          // and the user id it was bound to. See lib/db/errors.ts.
          console.error(
            "account deletion refused: the subscription could not be cancelled",
            dbErrorSummary(e),
          )
          throw new APIError("SERVICE_UNAVAILABLE", {
            message:
              e instanceof BillingNotConfiguredError
                ? "This account has a subscription and this deployment is not configured to " +
                  "cancel it, so the account was not deleted — deleting it would leave the " +
                  "subscription charging with no way to reach it. The operator has to set the " +
                  "Stripe variables, or cancel it in the Stripe dashboard, first."
                : "Your subscription could not be cancelled at Stripe, so the account was not " +
                  "deleted — deleting it now would leave the subscription charging with no way " +
                  "to reach it. Nothing was changed. Try again, or cancel in the billing portal " +
                  "first.",
          })
        }
      },

      /**
       * Take the recordings out of the bucket, once the rows are gone.
       *
       * Everything else this account had is a foreign key away: the vault blob,
       * the audit trail, the devices, the agents, the recordings themselves all
       * cascade from the user row. Object storage is the one thing Postgres
       * cannot reach, and a recording is the single most sensitive artefact the
       * product produces — a transcript of somebody's work on their servers.
       * Leaving them in a bucket after "delete my account" is the gap this
       * closes.
       *
       * After rather than before, and it does not throw. lib/storage/purge.ts
       * sets out both choices at length; the short version is that purging first
       * would let a failed deletion destroy the recordings of an account that
       * still exists, and throwing here would show an error for a deletion that
       * has already happened. An object left behind is orphaned rather than
       * lost, and `scripts/sweep-recordings.mjs` finds it by exactly the
       * property that makes it an orphan.
       *
       * On a deployment with no bucket configured this is a no-op that says
       * nothing, because there is nothing to say: the ciphertext was in the row
       * and went with it.
       */
      afterDelete: async (user) => {
        const purged = await purgeAccountObjects(user.id)
        if (!purged.attempted) return
        console.info(
          `account deletion: purged ${purged.deleted} stored recording object(s)` +
            (purged.failed > 0
              ? `, ${purged.failed} could not be removed and are now orphaned`
              : ""),
        )
      },
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },

  /**
   * Rate limiting on every /api/auth route.
   *
   * On always, rather than Better Auth's default of production-only. A limiter
   * that is absent in development is a limiter nobody ever sees working, and the
   * first time it runs is against real traffic — which is also the first chance
   * it has to be wrong. The numbers are loose enough that ordinary use never
   * reaches them.
   *
   * Storage is ours (`lib/rate-limit.ts`) rather than either of the built-ins.
   * `memory` is per process, so a second container would silently double every
   * limit and a restart would forget them. `database` is durable but slides its
   * window forward on each allowed request, so a caller staying *under* the
   * limit still accumulates count until they are blocked, which is not what the
   * fixed window used everywhere else in this app does. One algorithm, described
   * in one place.
   *
   * The default below is per IP per path. What makes that mean anything is
   * `ipAddress` further down; without it the key is a value the caller writes.
   */
  rateLimit: {
    enabled: true,
    /** The floor for anything not named in customRules: 100 requests a minute. */
    window: 60,
    max: 100,
    customStorage: authRateLimitStorage,

    /**
     * The endpoints where a limit is the point rather than hygiene.
     *
     * Each of these either guesses at a secret, creates something that costs
     * money, or is expensive to serve. The windows are minutes rather than
     * seconds because the thing being stopped is a script working through a
     * list, not a double-click.
     */
    customRules: {
      // Password guessing. Ten a minute is generous for a person and useless
      // for a dictionary. Two-factor puts a second gate behind this, and
      // `two_factor.locked_until` already bounds code guessing separately.
      "/sign-in/email": { window: 60, max: 10 },
      // Account creation is the one that costs real money: every account is
      // entitled to a gigabyte of recording storage in a bucket somebody pays
      // for. Five an hour from one network is far past any honest use.
      "/sign-up/email": { window: 3600, max: 5 },
      // Destructive, and gated on the derived auth token — so a wrong guess
      // here is the same guess as sign-in and deserves the same budget.
      "/delete-user": { window: 3600, max: 10 },
      // A six-digit code is a million possibilities and would fall in an
      // afternoon at any generous rate. The plugin's own lockout is the real
      // control; this stops the attempt reaching it a thousand times a second.
      "/two-factor/verify-totp": { window: 300, max: 10 },
      "/two-factor/verify-backup-code": { window: 300, max: 10 },
      // Changing the password re-derives and re-wraps every portable key, so it
      // is both sensitive and expensive.
      "/change-password": { window: 3600, max: 10 },
      "/update-user": { window: 3600, max: 30 },
    },
  },

  advanced: {
    cookiePrefix: "webxterm",

    /**
     * Which X-Forwarded-For entry is real.
     *
     * The rate limit above keys on the client address, so if that address is
     * one the caller chose, every request gets a fresh budget and the limit does
     * not exist. This is the same problem lib/audit/address.ts solves for the
     * audit log, and it is worth knowing that the two solve it differently
     * because they are given the fact in different shapes: our own code takes a
     * hop count (`TRUSTED_PROXY_HOPS`), Better Auth takes a list of proxy
     * addresses. Neither can be derived from the other, so both exist and
     * .env.example says to set them together.
     *
     * Unset is safe rather than convenient. Better Auth trusts a
     * single-valued X-Forwarded-For and refuses a chain it cannot attribute,
     * falling back to one bucket shared by everybody — trippable by a stranger,
     * which is a real nuisance, and still the right way round against a limiter
     * that stops nobody.
     */
    ipAddress: {
      trustedProxies: (process.env.TRUSTED_PROXY_IPS ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    },
  },

  hooks: {
    after: secondFactorAudit,
  },

  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
})

export type Session = typeof auth.$Infer.Session

/**
 * Better Auth's provider id for a password account. It is what `setPassword`
 * writes and what `signIn.email` reads, so it is also — in this app — the name
 * of the row that says "this account has a vault key behind it".
 */
const CREDENTIAL_PROVIDER = "credential"

/** What the dashboard layout needs to know before it renders anything. */
export type AccountGate = "signed-out" | "no-vault-password" | "ready"

/**
 * Whether this request may enter the dashboard, and if not, why not.
 *
 * The second state is the one that exists because of OAuth. A credential row is
 * this server's only evidence that a vault password was ever chosen: it holds
 * the hash of the derived auth token, which is produced by the same Argon2id
 * run that produces the vault key. No credential row means no password was ever
 * stretched on a device for this account, which means there is no vault key and
 * nothing the app stores can be encrypted. "Ready" is therefore a statement
 * about key material, not about permissions.
 *
 * It costs a query per call — `getSession` usually answers from the five-minute
 * cookie cache, `listUserAccounts` always goes to the database. That is paid on
 * entry to the dashboard rather than on every navigation inside it, because
 * Next's partial rendering does not re-run a layout on a client-side transition
 * between its own children.
 *
 * Nothing is caught here. A database failure has to reach the error boundary:
 * answering "signed-out" would sign people out during an incident, and
 * answering "no-vault-password" would send an account that has one to a page
 * that would refuse to set a second one.
 */
export async function accountGate(requestHeaders: Headers): Promise<AccountGate> {
  const session = await auth.api.getSession({ headers: requestHeaders })
  if (!session) return "signed-out"

  const accounts = await auth.api.listUserAccounts({ headers: requestHeaders })
  return accounts.some((a) => a.providerId === CREDENTIAL_PROVIDER) ? "ready" : "no-vault-password"
}

/**
 * Whether this account already has a vault password.
 *
 * The bootstrap page's own guard, separate from `accountGate` because it asks a
 * narrower question and answers it after the session is known to exist.
 */
export async function hasVaultCredential(requestHeaders: Headers): Promise<boolean> {
  const accounts = await auth.api.listUserAccounts({ headers: requestHeaders })
  return accounts.some((a) => a.providerId === CREDENTIAL_PROVIDER)
}
