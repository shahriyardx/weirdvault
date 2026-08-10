import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { BillingNotConfiguredError, appOrigin, stripeClient } from "@/lib/billing/stripe";
import { subscriptionFor } from "@/lib/billing/subscription";

/**
 * Opens Stripe's billing portal for the signed-in user.
 *
 * Cards, invoices, changing a payment method and cancelling all happen there
 * rather than here, and that is a deliberate refusal to build them. A cancel
 * button in this app would be a second implementation of a state machine Stripe
 * already owns, and it would have to be right about proration, trials and
 * mid-period changes to be worth anything. Handing the user to Stripe means this
 * app never sees a card number, not even in transit.
 *
 * The one thing this route must get right is whose portal it opens. The customer
 * id is read from this user's own row, keyed by the session's user id — it is
 * never accepted from the request, and there is no body here that could carry
 * one. A portal session is a bearer link to somebody's complete billing history;
 * minting one from a caller-supplied customer id would be an account takeover
 * with extra steps.
 *
 * A user with no customer row gets a 404 rather than a customer created on the
 * spot. Somebody who has never started a checkout has nothing to manage, and
 * creating a Stripe customer as a side effect of viewing a page would leave
 * empty customers behind for every curious click.
 */

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const row = await subscriptionFor(session.user.id);
    if (!row) {
      return Response.json(
        {
          error:
            "There is no billing customer for this account yet — nothing has ever been " +
            "purchased, so there is nothing to manage.",
          code: "no-customer",
        },
        { status: 404 },
      );
    }

    const portal = await stripeClient().billingPortal.sessions.create({
      customer: row.stripeCustomerId,
      // The marker is not a claim that anything changed — a portal visit may
      // have been someone reading an invoice. It tells Settings to re-read and
      // to say that the plan on screen is a local mirror which Stripe's changes
      // reach through a webhook. Without it, cancelling and coming straight back
      // shows "Renews" with nothing on the page admitting the lag, and the user
      // reasonably concludes the cancellation did not take.
      return_url: `${appOrigin(request)}/dashboard/settings?tab=account&portal=returned`,
    });

    return Response.json({ url: portal.url });
  } catch (e) {
    if (e instanceof BillingNotConfiguredError) {
      return Response.json(
        { error: e.message, missing: e.missing, code: "billing-not-configured" },
        { status: 503 },
      );
    }
    // The most common real cause of a failure here is that the billing portal
    // has never been configured in the Stripe dashboard, which is a setting
    // rather than a bug, so the message says so instead of blaming the request.
    console.error(
      "billing portal session could not be created",
      e instanceof Error ? e.message : e,
    );
    return Response.json(
      {
        error:
          "Stripe would not open the billing portal. Nothing about the subscription changed. " +
          "The portal has to be enabled once in the Stripe dashboard before it will open.",
      },
      { status: 502 },
    );
  }
}
