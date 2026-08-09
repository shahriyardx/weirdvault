import { eq } from "drizzle-orm";
import type Stripe from "stripe";

import { db, schema } from "@/lib/db";
import { dbErrorSummary } from "@/lib/db/errors";
import {
  relayAllowanceForTier,
  tierForSubscription,
  type SubscriptionAccess,
  type Tier,
} from "@/lib/billing/tiers";
import { stripeClient } from "@/lib/billing/stripe";

/**
 * The local mirror of Stripe's subscription state.
 *
 * Stripe owns whether an account is paid. This module owns a copy of that
 * answer, because the question is asked on paths that cannot afford an API call
 * — every relay token mint, every audit query, every attempt to save a
 * recording — and a payment provider's uptime should not be a dependency of
 * somebody's SSH session. The webhook writes here; everything else reads.
 *
 * ── Staleness, and which way to be wrong
 *
 * A mirror is stale between the event happening and the webhook landing, and
 * occasionally for much longer: a delivery can fail, a deployment can be down,
 * an event can be dropped. The direction of the error is chosen rather than
 * accepted. Refusing a paid feature to somebody who has just paid is a support
 * ticket, a refund and a person who cannot get at their servers; granting it
 * briefly to somebody who has just cancelled costs us a few days of a five
 * dollar subscription. So every read here fails toward access:
 *
 *  - A query that throws grants Pro and logs. The same choice /api/relay-token
 *    already made for its quota check, for the same reason — refusing paid
 *    features across the site because one query timed out is the worse outcome.
 *  - `past_due` and `unpaid` keep granting until the period ends. That rule
 *    lives in tiers.ts with the rest of the resolution.
 *
 * What bounds most of it is `currentPeriodEnd`: the statuses that depend on a
 * date stop at the date, so a stale row carrying one of them cannot grant
 * forever. `active` and `trialing` are the exception — they grant with no expiry
 * check at all, because a working subscription has no end to check against — and
 * that is why writes are ordered rather than last-one-wins. An older `active`
 * landing on top of a newer `canceled` would be a grant nothing ever takes back.
 * `mirrorSubscription` refuses it; see the note there.
 *
 * ── The customer id
 *
 * One row per user, and `stripeCustomerId` on it survives cancellation. A
 * returning customer must reuse their Stripe customer or their invoice history
 * forks in two and neither half is the truth — so `customerIdFor` looks before
 * it creates, and the row is written the moment a customer exists, before any
 * checkout has completed. That row carries the local `"none"` status, which is
 * not one of Stripe's: it means a customer exists and no subscription has ever
 * been attached to it. tiers.ts resolves it to Free, along with every other
 * status it does not recognise.
 *
 * ── What is not here
 *
 * No card details, no billing address, no invoice contents, no amounts. Stripe
 * holds all of that and has the compliance to justify holding it. Anything a
 * user wants to do with a payment method happens in Stripe's billing portal —
 * see /api/billing/portal — so this app never handles a card number, not even
 * in transit.
 */

/** The subscription facts this app keeps. Nothing about money is in here. */
export interface SubscriptionRecord {
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  status: string;
  stripePriceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /**
   * Stripe's timestamp for the event this row was written from, or null when no
   * event has ever been applied to it. Read by mirrorSubscription to refuse a
   * delivery older than the one already applied; nothing else uses it.
   */
  lastEventAt: Date | null;
}

/**
 * A tier, plus enough context for a page to explain it.
 *
 * `degraded` is the one field that is about this server rather than about the
 * account: it is set when the subscription table could not be read and the tier
 * below is the fail-toward-access answer rather than a looked-up one. The UI
 * shows it, because "you are on Pro" and "we could not check, so we are
 * assuming Pro" are different statements and only one of them should be made
 * without evidence.
 */
export interface BillingState {
  tier: Tier;
  /** Null when this account has never had a subscription row. */
  status: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Whether a Stripe customer exists, which is what the portal needs. */
  hasCustomer: boolean;
  /** True when the answer above is a fallback rather than a read. */
  degraded: boolean;
}

/* --------------------------------------------------------------------- read */

/** This account's subscription row, or null if it has never had one. */
export async function subscriptionFor(userId: string): Promise<SubscriptionRecord | null> {
  const [row] = await db
    .select({
      stripeCustomerId: schema.subscription.stripeCustomerId,
      stripeSubscriptionId: schema.subscription.stripeSubscriptionId,
      status: schema.subscription.status,
      stripePriceId: schema.subscription.stripePriceId,
      currentPeriodEnd: schema.subscription.currentPeriodEnd,
      cancelAtPeriodEnd: schema.subscription.cancelAtPeriodEnd,
      lastEventAt: schema.subscription.lastEventAt,
    })
    .from(schema.subscription)
    .where(eq(schema.subscription.userId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Everything a caller needs to describe this account's plan.
 *
 * The one entry point that swallows a database failure, so that the fail-toward
 * -access decision is made in exactly one place and every caller inherits it
 * rather than each re-deciding. `tierFor` below is this function with the
 * context thrown away.
 */
export async function billingStateFor(userId: string): Promise<BillingState> {
  try {
    const row = await subscriptionFor(userId);
    return {
      tier: tierForSubscription(row),
      status: row?.status ?? null,
      currentPeriodEnd: row?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
      hasCustomer: row !== null,
      degraded: false,
    };
  } catch (e) {
    // Logged rather than swallowed silently: this branch grants a paid feature
    // on no evidence, and an incident where that happened for an hour should be
    // findable afterwards. No user id, no row, no query — just that it failed,
    // which is why the error is summarised rather than passed to console.warn.
    // A drizzle query error's message is the SQL and its bound parameters, so
    // logging the object would write the user id this comment promises it does
    // not. See lib/db/errors.ts.
    console.warn("subscription lookup failed; granting Pro for this request", dbErrorSummary(e));
    return {
      tier: "pro",
      status: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      hasCustomer: false,
      degraded: true,
    };
  }
}

/**
 * The tier an account is on.
 *
 * The signature this had when every account was Free, so the call sites that
 * already awaited it did not have to change when the answer started coming from
 * a database.
 */
export async function tierFor(userId: string): Promise<Tier> {
  return (await billingStateFor(userId)).tier;
}

/** The account's monthly relay allowance in bytes. */
export async function relayAllowanceFor(userId: string): Promise<number> {
  return relayAllowanceForTier(await tierFor(userId));
}

/* -------------------------------------------------------------------- write */

/**
 * The local status for "a customer exists, no subscription has ever attached".
 *
 * Not a Stripe status. It is here so the customer id can be stored before
 * checkout completes, which is what makes reuse possible at all. tiers.ts
 * resolves it to Free along with every other status it does not recognise, so
 * this value granting anything would take a deliberate change there.
 */
export const NO_SUBSCRIPTION = "none";

/**
 * Statuses that cannot start charging anybody again.
 *
 * Deliberately narrower than "does not grant Pro". `incomplete` and `paused`
 * grant nothing today and can still turn into a charge tomorrow, so for the
 * purpose of deciding whether there is something to cancel they count as live.
 */
const TERMINAL_STATUSES = new Set([NO_SUBSCRIPTION, "canceled", "incomplete_expired"]);

/**
 * Cancels this account's Stripe subscription, for account deletion.
 *
 * Deleting a user cascades the subscription row away, taking the customer id
 * with it — and with it every route back to the subscription from inside this
 * app. If the subscription at Stripe is still running at that point, it renews
 * every month forever: the person cannot sign in to reach the portal, the
 * webhook can no longer attribute their events to an account, and the only
 * remaining fix is an operator opening the Stripe dashboard. So the cancellation
 * happens first, while the row that names the subscription still exists.
 *
 * Immediate rather than at the period end, because there is no account left to
 * use the rest of the period with. Stripe does not refund the remainder and
 * nothing here asks it to; what this prevents is the *next* charge.
 *
 * Throws if Stripe cannot be reached or refuses. That is deliberate and it
 * blocks the deletion: making somebody try again in five minutes is a smaller
 * harm than destroying the last local record of a live charge. It is also the
 * one place in this module that does not fail toward access, because here the
 * two directions are "a retry" and "an unstoppable subscription".
 *
 * Returns the subscription it cancelled, or null when there was nothing live.
 */
export async function cancelSubscriptionForDeletion(userId: string): Promise<string | null> {
  const row = await subscriptionFor(userId);
  if (!row?.stripeSubscriptionId) return null;
  if (TERMINAL_STATUSES.has(row.status)) return null;

  try {
    await stripeClient().subscriptions.cancel(row.stripeSubscriptionId);
  } catch (e) {
    // A 404 means Stripe has no such subscription, which is the outcome this
    // function exists to produce. The local row is simply behind, and it is
    // about to be deleted anyway.
    if (typeof e === "object" && e !== null && (e as { statusCode?: number }).statusCode === 404) {
      return null;
    }
    throw e;
  }

  return row.stripeSubscriptionId;
}

/**
 * The Stripe customer for this user, reused if there is one and created if not.
 *
 * Reuse is the whole point. A second customer for the same person means two
 * invoice histories, two payment methods, and a billing portal that shows half
 * of what they have paid — and it is unrecoverable without a manual merge in the
 * Stripe dashboard. So the local row is consulted first, and the customer id it
 * holds is kept even after a cancellation.
 *
 * The customer carries `metadata.userId`. That is not how this app resolves a
 * customer back to a user — the indexed `stripe_customer_id` column is — but it
 * is what makes a row in the Stripe dashboard mean something to a human staring
 * at it during an incident.
 *
 * The email is passed so Stripe's receipts go somewhere. It is the same address
 * the account already has; nothing new about the user is disclosed by it.
 */
export async function customerIdFor(user: {
  id: string;
  email: string;
  name?: string | null;
}): Promise<string> {
  const existing = await subscriptionFor(user.id);
  if (existing) return existing.stripeCustomerId;

  const customer = await stripeClient().customers.create({
    email: user.email,
    name: user.name ?? undefined,
    metadata: { userId: user.id },
  });

  // `onConflictDoNothing` rather than a plain insert, because two checkout
  // attempts started in two tabs can both find no row and both get here. The
  // conflict target is the unique index on user_id, so the second one keeps the
  // first one's customer instead of overwriting it — a second Stripe customer
  // may exist and be unused, which is untidy, but the alternative is the local
  // row pointing at a customer whose checkout was abandoned.
  await db
    .insert(schema.subscription)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      stripeCustomerId: customer.id,
      status: NO_SUBSCRIPTION,
    })
    .onConflictDoNothing({ target: schema.subscription.userId });

  const settled = await subscriptionFor(user.id);
  return settled?.stripeCustomerId ?? customer.id;
}

/**
 * When the current billing period ends, from a Stripe subscription.
 *
 * This is not `subscription.current_period_end` any more. That field was removed
 * from the Subscription object in the 2025-03-31 API version and now lives on
 * each subscription item, because a subscription can bill its items on different
 * schedules. Ours has exactly one item — two tiers, one price, no quantity — so
 * in practice this reads that one value, and the maximum is taken so that a
 * subscription which somehow grew a second item grants access through the later
 * of the two rather than cutting off at the earlier.
 *
 * Null when there are no items at all, which should not happen and is not worth
 * inventing a date for. tiers.ts treats a null end as "we were not told",
 * not as "expired".
 */
export function periodEndOf(subscription: Stripe.Subscription): Date | null {
  let latest: number | null = null;
  for (const item of subscription.items.data) {
    if (typeof item.current_period_end === "number") {
      latest = latest === null ? item.current_period_end : Math.max(latest, item.current_period_end);
    }
  }
  return latest === null ? null : new Date(latest * 1000);
}

/** The price this subscription is billed at, if it has exactly one item. */
function priceIdOf(subscription: Stripe.Subscription): string | null {
  return subscription.items.data[0]?.price?.id ?? null;
}

/** A Stripe customer reference in any of the shapes the SDK returns it in. */
function customerIdOf(subscription: Stripe.Subscription): string | null {
  const c = subscription.customer;
  return typeof c === "string" ? c : (c?.id ?? null);
}

/**
 * Why a mirror write did not happen. Null means it did.
 *
 * The webhook logs these rather than treating them all as one failure, because
 * they mean different things to whoever reads the log: `unattributable` is
 * routine and usually somebody else's subscription, `stale-event` is Stripe
 * redelivering in the wrong order and is the mechanism working, and
 * `other-subscription` is a customer with two subscriptions, which should not
 * happen and needs a person.
 */
export type MirrorSkip = "unattributable" | "stale-event" | "other-subscription";

export interface MirrorOutcome {
  /** Whose subscription this is, or null when it could not be attributed. */
  userId: string | null;
  /** Why the row was left alone, or null when it was written. */
  skipped: MirrorSkip | null;
}

/**
 * Writes a Stripe subscription into the mirror.
 *
 * ── Whose is it
 *
 * Resolving which user this belongs to is done from data we put there ourselves
 * rather than from anything a caller supplied. Three sources, in order of how
 * much they are trusted:
 *
 *  1. An existing row carrying this subscription id. The strongest: we wrote it.
 *  2. An existing row carrying this customer id. Also ours, and the ordinary
 *     path for the first `customer.subscription.created` after a checkout.
 *  3. `metadata.userId` on the subscription, which /api/billing/checkout sets
 *     when it creates the session. Only reachable for a subscription created
 *     through this app, and only readable from a signature-verified webhook.
 *
 * If none of them resolve, nothing is written and the caller is told. That
 * happens for subscriptions created directly in the Stripe dashboard against a
 * customer this app has never seen, and inventing a user for one of those would
 * be granting an account somebody else's subscription.
 *
 * ── Which of two answers is newer
 *
 * `eventAt` is Stripe's own timestamp for the event that carried this object,
 * and it is compared against the one already on the row. Stripe does not
 * guarantee delivery order, and this app's own webhook answers 500 and asks for
 * a retry whenever processing fails, so "an older event arrives after a newer
 * one" is a case this code creates for itself. Without the comparison, a
 * redelivered `active` landing after a `canceled` would write `active` — and
 * `active` grants Pro with no expiry check at all, so nothing would ever take it
 * back. That is the one way a stale row escapes the bound the rest of this
 * module leans on, which is why it is guarded here rather than argued away.
 *
 * Equal stamps are applied rather than refused: Stripe's `created` has one
 * second of resolution, two events about one subscription can share a second,
 * and refusing the second one would drop a real change.
 *
 * The comparison only applies when the event is about the subscription the row
 * already carries, because that is the only thing `last_event_at` orders.
 * Across two subscriptions the stamps say nothing useful — somebody who
 * subscribes again and then cancels the old one produces a new subscription
 * whose creation is *older* than the cancellation of the previous one, and
 * comparing the two would refuse to mirror the subscription they are paying
 * for. Conflicts between two subscriptions are the next guard's problem.
 *
 * ── Two subscriptions, one row
 *
 * The table holds one row per user, so an event about subscription A would
 * otherwise overwrite a row mirroring subscription B. For a customer who ended
 * up with two — a second checkout that slipped through, a subscription added in
 * the Stripe dashboard — a cancellation of the abandoned one would then read as
 * a cancellation of the one being paid for, and the account would drop to Free
 * while still being charged.
 *
 * So a write that names a different subscription than the row carries is
 * allowed only when it does not take access away, or when the subscription the
 * row is about has genuinely stopped granting. Deciding that needs Stripe,
 * because the row itself is the thing under suspicion — hence the retrieve. It
 * is on a rare branch, not on the ordinary path.
 *
 * What is NOT solved: nothing merges two live subscriptions, and nothing
 * cancels the surplus one. The account keeps whichever is mirrored and somebody
 * is being charged twice until an operator looks. Refusing the write only stops
 * this app from making that worse.
 */
export async function mirrorSubscription(
  subscription: Stripe.Subscription,
  eventAt: Date,
): Promise<MirrorOutcome> {
  const customerId = customerIdOf(subscription);

  const userId =
    (await userIdBySubscription(subscription.id)) ??
    (customerId ? await userIdByCustomer(customerId) : null) ??
    metadataUserId(subscription);

  if (!userId || !customerId) return { userId: null, skipped: "unattributable" };

  const existing = await subscriptionFor(userId);
  const sameSubscription = existing?.stripeSubscriptionId === subscription.id;

  if (sameSubscription && existing?.lastEventAt && eventAt < existing.lastEventAt) {
    return { userId, skipped: "stale-event" };
  }

  const incoming: SubscriptionAccess = {
    status: subscription.status,
    currentPeriodEnd: periodEndOf(subscription),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };

  if (
    existing &&
    existing.stripeSubscriptionId !== null &&
    !sameSubscription &&
    tierForSubscription(existing) === "pro" &&
    tierForSubscription(incoming) !== "pro" &&
    (await stillGranting(existing.stripeSubscriptionId))
  ) {
    return { userId, skipped: "other-subscription" };
  }

  const values = {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    status: subscription.status,
    stripePriceId: priceIdOf(subscription),
    currentPeriodEnd: incoming.currentPeriodEnd,
    cancelAtPeriodEnd: incoming.cancelAtPeriodEnd,
    lastEventAt: eventAt,
    updatedAt: new Date(),
  };

  await db
    .insert(schema.subscription)
    .values({ id: crypto.randomUUID(), userId, ...values })
    .onConflictDoUpdate({ target: schema.subscription.userId, set: values });

  return { userId, skipped: null };
}

/**
 * Whether the subscription currently mirrored is still one that grants Pro.
 *
 * Asked of Stripe rather than of the row, because the row is exactly what is in
 * doubt at the point this is called. A 404 means the subscription is gone and
 * the row is describing something that no longer exists, so the incoming event
 * is the better answer and the write goes ahead.
 *
 * Any other failure answers true, which refuses the write and leaves the account
 * on Pro. That is the direction this whole module takes: an unreachable Stripe
 * should not cancel somebody's access, and the cost of being wrong is a few days
 * of a five dollar subscription against somebody losing their servers.
 */
async function stillGranting(subscriptionId: string): Promise<boolean> {
  try {
    const current = await stripeClient().subscriptions.retrieve(subscriptionId);
    return (
      tierForSubscription({
        status: current.status,
        currentPeriodEnd: periodEndOf(current),
        cancelAtPeriodEnd: current.cancel_at_period_end,
      }) === "pro"
    );
  } catch (e) {
    if (
      typeof e === "object" &&
      e !== null &&
      (e as { statusCode?: number }).statusCode === 404
    ) {
      return false;
    }
    console.warn(
      `could not check whether mirrored subscription ${subscriptionId} still grants; ` +
        "keeping the row as it is",
      e instanceof Error ? e.message : "unknown error",
    );
    return true;
  }
}

async function userIdBySubscription(subscriptionId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: schema.subscription.userId })
    .from(schema.subscription)
    .where(eq(schema.subscription.stripeSubscriptionId, subscriptionId))
    .limit(1);
  return row?.userId ?? null;
}

async function userIdByCustomer(customerId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: schema.subscription.userId })
    .from(schema.subscription)
    .where(eq(schema.subscription.stripeCustomerId, customerId))
    .limit(1);
  return row?.userId ?? null;
}

function metadataUserId(subscription: Stripe.Subscription): string | null {
  const raw = subscription.metadata?.userId;
  return typeof raw === "string" && raw !== "" ? raw : null;
}
