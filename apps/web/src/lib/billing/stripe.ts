import Stripe from "stripe"

/**
 * The configured Stripe client, and the three environment variables it needs.
 *
 * Everything in this file is about one rule: a missing variable must produce a
 * loud, named failure and never a guess. There is no fallback price id, no
 * development default key, and no branch that decides somebody is on Pro because
 * a lookup could not be performed. Billing is either configured on this
 * deployment or it is not, and both states are visible — `billingConfigured()`
 * is what the UI reads so it can say "billing is not set up here" rather than
 * offering a button that answers 500.
 *
 * The variables:
 *
 *   STRIPE_SECRET_KEY      Server-side API key. Never sent anywhere, never
 *                          logged, never rendered.
 *   STRIPE_PRICE_PRO       The Price object checkout charges against. There is
 *                          exactly one — two tiers, one price, no quantity.
 *   STRIPE_WEBHOOK_SECRET  Verifies that a webhook delivery came from Stripe.
 *                          The only thing standing between a stranger and a
 *                          free Pro subscription; see the webhook route.
 *
 * Nothing here ever puts a secret in a message, a log line or a response body.
 * The errors below name the *variable* that is unset, which is the fact an
 * operator needs, and carry none of its value — a "misconfigured" log line that
 * helpfully prints what it found is how a key ends up in a log aggregator.
 */

/** Named so the error messages, the UI copy and the README cannot drift. */
export const STRIPE_SECRET_ENV = "STRIPE_SECRET_KEY"
export const STRIPE_PRICE_ENV = "STRIPE_PRICE_PRO"
export const STRIPE_WEBHOOK_ENV = "STRIPE_WEBHOOK_SECRET"

/**
 * Thrown when a route needs something the deployment has not been given.
 *
 * A distinct class rather than a plain Error so route handlers can answer 503
 * with the variable's name instead of letting it fall through as a 500 with a
 * stack trace. 503 is the honest status: the request was fine, this server is
 * not equipped to serve it.
 */
export class BillingNotConfiguredError extends Error {
  /** The environment variable that is unset. Safe to show an operator. */
  readonly missing: string

  constructor(missing: string) {
    super(
      `Billing is not configured on this deployment: ${missing} is not set. ` +
        "Nothing was charged and nothing was changed.",
    )
    this.name = "BillingNotConfiguredError"
    this.missing = missing
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new BillingNotConfiguredError(name)
  return value
}

/**
 * The SDK client, built once.
 *
 * Cached on globalThis for the same reason the database pool is: Next
 * re-evaluates modules on every hot reload in development, and a fresh Stripe
 * client per edit means a fresh agent and connection pool per edit.
 *
 * `apiVersion` is pinned rather than left to the account default. The account
 * default can be changed from the Stripe dashboard by somebody who is not
 * looking at this code, and this SDK's types describe exactly one version — the
 * one it shipped with. Pinning means a dashboard change cannot silently reshape
 * an object this code destructures. It also means upgrading is a deliberate act:
 * bump the SDK, bump this, read the changelog for the fields that moved.
 */
const globalForStripe = globalThis as unknown as { stripe?: Stripe }

export function stripeClient(): Stripe {
  const key = required(STRIPE_SECRET_ENV)
  globalForStripe.stripe ??= new Stripe(key, {
    apiVersion: "2026-07-29.dahlia",
    typescript: true,
    // One retry on a network-level failure. Stripe's client adds an idempotency
    // key to the retry, so a create that actually landed is not repeated.
    maxNetworkRetries: 1,
    appInfo: { name: "weirdvault" },
  })
  return globalForStripe.stripe
}

/**
 * The Price id Pro is sold at.
 *
 * Read from the environment on every call rather than captured at module load,
 * so a deployment that adds the variable and restarts does not need a rebuild,
 * and so the "not configured" state is a live fact rather than a snapshot taken
 * at import time.
 *
 * There is deliberately no fallback. A hardcoded price id would be a live price
 * in somebody's Stripe account — ours, in a test build, or a stale one after the
 * product is re-created — and charging the wrong price is worse in every
 * direction than refusing to charge at all.
 */
export function proPriceId(): string {
  return required(STRIPE_PRICE_ENV)
}

/** The webhook signing secret. Its value never leaves this module. */
export function webhookSecret(): string {
  return required(STRIPE_WEBHOOK_ENV)
}

/**
 * Whether this deployment can sell anything.
 *
 * Both the key and the price, because either one missing makes checkout
 * impossible and the UI has one thing to say about it. The webhook secret is not
 * part of this: a deployment could in principle have checkout configured and the
 * webhook not, which is a broken state rather than an unconfigured one, and the
 * webhook route says so itself when a delivery arrives.
 *
 * Returns a boolean and never throws, because it is called from a render path
 * that has to produce a page either way.
 */
export function billingConfigured(): boolean {
  return Boolean(process.env[STRIPE_SECRET_ENV] && process.env[STRIPE_PRICE_ENV])
}

/**
 * Where Stripe should send the browser back to.
 *
 * `BETTER_AUTH_URL` first, because it is the one variable this app already
 * treats as its canonical public origin and it is set by configuration rather
 * than by the request. Falling back to the request's own origin is a deliberate
 * second choice: it is derived from a Host header, which a caller controls, so
 * on a deployment that has not set the variable a crafted Host could send a
 * paying user somewhere else after checkout. That is a redirect, not a
 * disclosure — Stripe holds the card details and the session is bound to our
 * account either way — but it is the reason the environment variable is first
 * and this fallback exists only so local development works without ceremony.
 */
export function appOrigin(request: Request): string {
  const configured = process.env.BETTER_AUTH_URL
  if (configured) return configured.replace(/\/$/, "")
  return new URL(request.url).origin
}
