/**
 * The one place a plan limit is written down, and the one place a subscription
 * is turned into a tier.
 *
 * There are two tiers, Free and Pro, and Pro is a real subscription now: Stripe
 * takes the money, a webhook mirrors the result into the `subscription` table,
 * and lib/billing/subscription.ts reads that table. This module is the half of
 * that arrangement with no database in it — the numbers each tier gets, and the
 * pure function that decides which tier a subscription row amounts to.
 *
 * The split is deliberate and it is load-bearing. /pricing, the landing page and
 * the docs page all import the numbers below to state them, and lib/audit
 * imports the `Tier` type; none of those should open a Postgres pool. So nothing
 * here imports the database, and the async, per-user lookups live one file over
 * in subscription.ts. Keep it that way: the moment this module imports `db`,
 * every page that quotes a limit drags a connection pool behind it.
 *
 * A single constant asserting that every account was Free used to live here,
 * because nothing could make one anything else. Its own comment said it was the
 * thing to delete on the day a tier could genuinely differ per account, and that
 * its references were the list of places that had to change. That day was the
 * Stripe integration. The references were: the audit retention window (which was
 * resolved synchronously in the browser and now arrives on the /api/audit
 * response), the relay allowance, the pruner's single window, and the pricing
 * page's claim that the two columns were identical. All four changed, and none
 * of them is pinned to Free — every one of them resolves a tier per account.
 *
 * Self-hosting removes the transfer cap outright. It exists because relay
 * bandwidth costs us money; a relay you run is bandwidth you are already
 * paying for, and compose.prod.yaml is the whole product on one machine.
 */

export type Tier = "free" | "pro";

/**
 * Monthly relay transfer, in bytes. Decimal gigabytes, matching how transfer is
 * sold everywhere else and how the byte formatter elsewhere in the app reads.
 *
 * Both directions count, and there is no way to make them not count. The relay
 * forwards SSH ciphertext and cannot tell an SFTP upload from a keystroke — it
 * is not decrypting anything, which is the entire point of it. So there is no
 * honest way to describe this cap as anything narrower than "everything that
 * goes through the relay, in either direction".
 *
 * A connection that does not use the relay does not count against it. A direct
 * WebSocket to a host running a WebSocket-capable endpoint, or a self-hosted
 * relay, is invisible here because we are not carrying those bytes.
 *
 * Nor do saved session recordings, for the same reason read the other way
 * round: a recording is uploaded to the control plane over HTTPS and never
 * touches the relay, so no relay counts it and this number never moves when one
 * is saved. That is control-plane bandwidth, which nothing meters today — the
 * only bound on it is the per-capture size cap in lib/recording/capture.ts and
 * the per-account storage ceiling in lib/recording/limits.ts.
 */
export const RELAY_ALLOWANCE_BYTES: Record<Tier, number> = {
  free: 1_000_000_000,
  pro: 5_000_000_000,
};

/**
 * Audit retention is the other per-tier limit, and its windows are deliberately
 * not here.
 *
 * They live in lib/audit/retention.ts, next to the query and the pruner that
 * enforce them, because how long a log is kept is a property of the log rather
 * than of the price list. What is shared is the answer to "which tier is this
 * account on", which is `tierForSubscription` below — that module takes its type
 * from here rather than keeping a second copy, because a tier that disagrees
 * with itself between the relay cap and the audit window is worse than no tier
 * at all.
 */

export const TIER_LABELS: Record<Tier, string> = {
  free: "Free",
  pro: "Pro",
};

/**
 * Whether a tier may record sessions.
 *
 * A boolean rather than a number, because recording is the one thing that is
 * switched on rather than sized: the capture cap and the storage ceiling in
 * lib/recording/limits.ts are the same on both tiers, and only the ability to
 * put a new encrypted blob on our disk differs.
 *
 * Two routes read this, and the line between them is what is being stored
 * rather than what is being watched. `POST /api/recordings` refuses a save on
 * Free, and `POST /api/recordings/[id]/shares` refuses a new share link on Free
 * — a share is a second encrypted copy of a transcript, written to the same
 * disk, so it is the same purchase under a different name. Listing, playing,
 * downloading and revoking are ungated everywhere and must stay that way: a
 * recording already stored is the user's own data, encrypted under a key this
 * server has never held, and putting it behind a payment would be ransoming
 * something we cannot read.
 */
export const SESSION_RECORDING: Record<Tier, boolean> = {
  free: false,
  pro: true,
};

/**
 * What Pro costs, in whole US dollars a month.
 *
 * This number is the one figure on /pricing that is not imported from the code
 * that enforces it, because nothing here enforces it — Stripe does, from the
 * Price object named by STRIPE_PRICE_PRO. It is written here so the page has one
 * place to read it from rather than three, and so that a mismatch between this
 * and the Stripe price is a one-line fix in a file whose header warns about it.
 *
 * What is NOT solved: nothing checks the two agree. The app never reads the
 * Price object's amount — doing so would mean a Stripe API call on a static
 * marketing page, and a page that fails to render because a payment provider is
 * slow is a worse failure than a stale number. If the price in the Stripe
 * dashboard changes, change this too, in the same commit.
 */
export const PRO_PRICE_USD = 5;
export const PRO_PRICE_LABEL = `$${PRO_PRICE_USD}`;
export const PRO_PRICE_UNIT = "per month";

/**
 * The facts about a subscription that tier resolution reads.
 *
 * A structural type rather than the drizzle row, so this function can be called
 * with a row from the database, a shape built from a Stripe object, or a literal
 * in a test, and so that this module keeps knowing nothing about either.
 */
export interface SubscriptionAccess {
  /** Stripe's own status string, or the local "none" sentinel. See subscription.ts. */
  status: string;
  /** When access lapses if nothing renews it. Null when Stripe never told us. */
  currentPeriodEnd: Date | null;
  /** Set when the customer has cancelled but paid through the period. */
  cancelAtPeriodEnd: boolean;
}

/**
 * Statuses that grant Pro outright, with no expiry check.
 *
 * `trialing` is in here because a trial is a subscription that is working; a
 * trial that did not grant the thing being trialled would be a strange product.
 */
const GRANTS_OUTRIGHT = new Set(["active", "trialing"]);

/**
 * Statuses that are a card still being retried, and grant until the period ends.
 *
 * This is the judgement call in this file. `past_due` and `unpaid` both mean
 * Stripe is still attempting payment on a subscription the customer has not
 * cancelled — a card that expired over a weekend, a bank that declined once. The
 * alternative reading is that they are unpaid and should be cut off, and cutting
 * someone off mid-retry costs them access to their servers over a payment that
 * is usually about to succeed. Stripe's own retry schedule bounds it: when the
 * attempts run out, the subscription is cancelled and `customer.subscription.
 * deleted` arrives, which is the event that ends this.
 */
const GRANTS_WHILE_RETRYING = new Set(["past_due", "unpaid"]);

/**
 * The tier a subscription row amounts to. The whole rule, in one place.
 *
 * Pure and synchronous: it is given the row rather than a user id, so it can be
 * tested exhaustively (tiers.test.ts) and so that the database read that finds
 * the row is somebody else's problem. Everything that needs a tier goes through
 * here — the relay allowance, the audit window, the recording gate, the pricing
 * of nothing else.
 *
 * `now` is a parameter for the tests, and because two calls in one request
 * should not be able to straddle an expiry.
 *
 * Anything not named below — `incomplete`, `incomplete_expired`, `paused`, the
 * local `none` sentinel, or a status Stripe adds after this was written —
 * resolves to Free. That is the safe direction for an unrecognised value: an
 * unknown status is not evidence of a paid subscription, and the visible failure
 * (a paying customer sees Free) is one a support message fixes, where the
 * invisible one (a lapsed account keeps Pro forever) is not.
 */
export function tierForSubscription(
  sub: SubscriptionAccess | null,
  now: Date = new Date(),
): Tier {
  if (!sub) return "free";

  if (GRANTS_OUTRIGHT.has(sub.status)) return "pro";

  if (GRANTS_WHILE_RETRYING.has(sub.status)) {
    // A null period end means Stripe never told us when this one ends, which is
    // not the same as "it has ended". Granting is the fail-toward-access
    // direction this whole module takes, and it is bounded in practice by the
    // cancellation event that ends every retry schedule.
    return sub.currentPeriodEnd === null || now < sub.currentPeriodEnd ? "pro" : "free";
  }

  /**
   * A cancellation that was scheduled rather than immediate: the customer asked
   * to stop renewing, has paid through to `currentPeriodEnd`, and keeps what
   * they paid for until then. Stripe normally leaves such a subscription
   * `active` until the period rolls over, so this branch is the mirror catching
   * up late rather than the common path — but a row that says `canceled` with
   * the flag set and a future end date is a customer who is still owed the
   * month, and refusing them would be taking money for nothing.
   *
   * A cancellation with no end date, or one that has passed, is simply over.
   */
  if (sub.status === "canceled") {
    return sub.cancelAtPeriodEnd && sub.currentPeriodEnd !== null && now < sub.currentPeriodEnd
      ? "pro"
      : "free";
  }

  return "free";
}

/** The relay allowance a tier gets, in bytes. */
export function relayAllowanceForTier(tier: Tier): number {
  return RELAY_ALLOWANCE_BYTES[tier];
}

/** Whether a tier may save new session recordings. */
export function canRecordOnTier(tier: Tier): boolean {
  return SESSION_RECORDING[tier];
}

/**
 * The billing period a moment falls in, as "YYYY-MM" in UTC.
 *
 * This is the relay transfer period, which is not the Stripe billing period and
 * never has been: transfer resets at midnight UTC on the first of the month for
 * everybody, while a subscription renews on the day it started. Two different
 * clocks, deliberately — the transfer counter is a key in a table written by a
 * relay that has no idea who pays for what, and making it follow each account's
 * renewal date would mean the relay asking a database on the data path.
 *
 * UTC rather than the viewer's zone, because two processes disagreeing about
 * which month it is would split one month's usage across two rows. It also means
 * the reset happens at midnight UTC, which the meter states rather than leaving
 * the user to discover.
 */
export function periodFor(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Midnight UTC on the first of the following month: when the counter resets. */
export function periodResetsAt(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}
