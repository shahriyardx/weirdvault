/**
 * Tier resolution, which is the function that decides whether somebody who has
 * paid us gets what they paid for.
 *
 * It is worth testing exhaustively for a reason the other pure tests here do not
 * have: both directions of a wrong answer cost something real and neither is
 * visible from the outside. Resolving Free for a paying customer is a support
 * ticket and a refund; resolving Pro for a lapsed one is a feature given away
 * indefinitely, and nothing in the product would ever surface it. There is no
 * Stripe access in the test environment and no database, so this is the only
 * automated check the money path gets — the rest of it (a signature check, a
 * webhook, an upsert) can only be exercised against a real Stripe.
 *
 * The statuses below are Stripe's, from the `subscription.status` enum. The
 * `none` case is ours: subscription.ts writes a row with that status when it
 * creates a customer before any checkout has completed, so that the customer id
 * survives to be reused.
 */

import { describe, expect, test } from "bun:test";

import {
  PRO_PRICE_USD,
  RELAY_ALLOWANCE_BYTES,
  SESSION_RECORDING,
  canRecordOnTier,
  relayAllowanceForTier,
  tierForSubscription,
  type SubscriptionAccess,
} from "./tiers";

const NOW = new Date("2026-08-09T12:00:00Z");
const LATER = new Date("2026-09-01T00:00:00Z");
const EARLIER = new Date("2026-07-01T00:00:00Z");

function sub(over: Partial<SubscriptionAccess>): SubscriptionAccess {
  return {
    status: "active",
    currentPeriodEnd: LATER,
    cancelAtPeriodEnd: false,
    ...over,
  };
}

describe("no subscription at all", () => {
  test("is Free", () => {
    expect(tierForSubscription(null, NOW)).toBe("free");
  });

  test("a customer with no subscription yet is Free", () => {
    // The row subscription.ts writes to hold a Stripe customer id before the
    // first checkout completes. It exists so invoice history cannot fork; it is
    // not evidence of a payment.
    expect(tierForSubscription(sub({ status: "none", currentPeriodEnd: null }), NOW)).toBe("free");
  });
});

describe("statuses that grant outright", () => {
  test("active is Pro", () => {
    expect(tierForSubscription(sub({ status: "active" }), NOW)).toBe("pro");
  });

  test("trialing is Pro", () => {
    expect(tierForSubscription(sub({ status: "trialing" }), NOW)).toBe("pro");
  });

  test("and stay Pro even with a period end in the past", () => {
    // The mirror can lag: a renewal that has already happened at Stripe may not
    // have reached this table yet, and the status is the stronger signal. An
    // active subscription is active.
    expect(tierForSubscription(sub({ status: "active", currentPeriodEnd: EARLIER }), NOW)).toBe(
      "pro",
    );
  });
});

describe("a card still being retried", () => {
  for (const status of ["past_due", "unpaid"]) {
    test(`${status} grants until the period ends`, () => {
      expect(tierForSubscription(sub({ status, currentPeriodEnd: LATER }), NOW)).toBe("pro");
    });

    test(`${status} stops granting once the period has ended`, () => {
      expect(tierForSubscription(sub({ status, currentPeriodEnd: EARLIER }), NOW)).toBe("free");
    });

    test(`${status} with no period end grants, because unknown is not expired`, () => {
      // Deliberately the generous reading, and the one place this file is
      // unbounded on its own. What bounds it is Stripe: when the retry schedule
      // runs out the subscription is cancelled and the deleted event arrives.
      expect(tierForSubscription(sub({ status, currentPeriodEnd: null }), NOW)).toBe("pro");
    });
  }
});

describe("cancellation", () => {
  test("canceled with no scheduled end is Free", () => {
    expect(
      tierForSubscription(
        sub({ status: "canceled", cancelAtPeriodEnd: false, currentPeriodEnd: LATER }),
        NOW,
      ),
    ).toBe("free");
  });

  test("cancelled at period end keeps Pro until that moment", () => {
    expect(
      tierForSubscription(
        sub({ status: "canceled", cancelAtPeriodEnd: true, currentPeriodEnd: LATER }),
        NOW,
      ),
    ).toBe("pro");
  });

  test("and drops to Free once it passes", () => {
    expect(
      tierForSubscription(
        sub({ status: "canceled", cancelAtPeriodEnd: true, currentPeriodEnd: EARLIER }),
        NOW,
      ),
    ).toBe("free");
  });

  test("the boundary is exclusive: the end instant itself is over", () => {
    expect(
      tierForSubscription(
        sub({ status: "canceled", cancelAtPeriodEnd: true, currentPeriodEnd: NOW }),
        NOW,
      ),
    ).toBe("free");
  });

  test("cancelled at period end with no end date is Free", () => {
    expect(
      tierForSubscription(
        sub({ status: "canceled", cancelAtPeriodEnd: true, currentPeriodEnd: null }),
        NOW,
      ),
    ).toBe("free");
  });
});

describe("statuses that do not grant", () => {
  // incomplete and incomplete_expired are checkouts that never completed;
  // paused is a trial that ended with no payment method attached.
  for (const status of ["incomplete", "incomplete_expired", "paused"]) {
    test(`${status} is Free`, () => {
      expect(tierForSubscription(sub({ status }), NOW)).toBe("free");
    });
  }

  test("a status this build has never heard of is Free", () => {
    // The safe direction for an unrecognised value. Resolving Pro here would
    // mean a status Stripe adds in future silently granting a paid feature.
    expect(tierForSubscription(sub({ status: "something_stripe_added_later" }), NOW)).toBe("free");
  });
});

describe("what a tier is worth", () => {
  test("Pro carries more relay transfer than Free", () => {
    expect(relayAllowanceForTier("pro")).toBeGreaterThan(relayAllowanceForTier("free"));
    expect(relayAllowanceForTier("free")).toBe(RELAY_ALLOWANCE_BYTES.free);
  });

  test("session recording is the Pro-only feature", () => {
    expect(canRecordOnTier("pro")).toBe(true);
    expect(canRecordOnTier("free")).toBe(false);
    expect(SESSION_RECORDING.free).toBe(false);
  });

  test("the price is a whole number of dollars", () => {
    // /pricing renders `$${PRO_PRICE_USD}`, so a fractional value would render
    // as "$4.99999" rather than a price. This is not a check that the number
    // matches Stripe — nothing can check that from here.
    expect(Number.isInteger(PRO_PRICE_USD)).toBe(true);
    expect(PRO_PRICE_USD).toBeGreaterThan(0);
  });
});
