import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { AUDIT_RETENTION_DAYS, AUDIT_RETENTION_LABEL } from "@/lib/audit/retention";
import { billingConfigured } from "@/lib/billing/stripe";
import { billingStateFor } from "@/lib/billing/subscription";
import {
  PRO_PRICE_LABEL,
  PRO_PRICE_UNIT,
  SESSION_RECORDING,
  TIER_LABELS,
  relayAllowanceForTier,
} from "@/lib/billing/tiers";

/**
 * What plan this account is on, as the browser is allowed to know it.
 *
 * This route exists because of a structural fact about the product: a tab knows
 * which account it is signed into, and nothing else. It cannot know what that
 * account pays without asking, and a page that guessed would sooner or later
 * show a window or an allowance the server does not enforce — a Free account
 * told it has twelve months of history, or a Pro account told it cannot record.
 * So the tier is a value the client is *told*, once, by the side that enforces
 * it, and lib/billing/client.ts is the only thing that reads it.
 *
 * The limits travel with the tier rather than being looked up client-side from a
 * table keyed by tier name. Same argument one step further along: shipping the
 * table to the browser means two copies of every number, and the copy on screen
 * is the one that is not enforced.
 *
 * Nothing here is a secret. The tier, the status and the renewal date are facts
 * about the caller's own account, and the response carries no customer id, no
 * subscription id and no price id — a browser has no use for any of them, and
 * the two places they would be useful (the portal, checkout) take them from the
 * session server-side.
 */

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const state = await billingStateFor(session.user.id);

  return Response.json({
    tier: state.tier,
    label: TIER_LABELS[state.tier],
    /**
     * Stripe's own status string, or null for an account that has never had a
     * subscription row. Passed through rather than translated into a friendlier
     * word, because "past_due" and "unpaid" mean different things to Stripe and
     * the UI phrases each of them itself.
     */
    status: state.status,
    currentPeriodEnd: state.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    /** Whether there is a Stripe customer to open a billing portal for. */
    hasCustomer: state.hasCustomer,
    /**
     * True when the subscription table could not be read and the tier above is
     * the fail-toward-access answer rather than a looked-up one. The UI says so
     * rather than presenting an assumption as a fact.
     */
    degraded: state.degraded,
    /**
     * Whether this deployment can sell anything at all. False on a self-hosted
     * install with no Stripe keys, which is a supported configuration and not an
     * error — the UI says billing is not configured here instead of offering an
     * upgrade button that would answer 503.
     */
    billingConfigured: billingConfigured(),
    price: { label: PRO_PRICE_LABEL, unit: PRO_PRICE_UNIT },
    /** The numbers this tier is actually held to, from the modules that hold it. */
    limits: {
      relayAllowanceBytes: relayAllowanceForTier(state.tier),
      auditRetentionDays: AUDIT_RETENTION_DAYS[state.tier],
      auditRetentionLabel: AUDIT_RETENTION_LABEL[state.tier],
      sessionRecording: SESSION_RECORDING[state.tier],
    },
  });
}
