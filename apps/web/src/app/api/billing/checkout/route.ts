import { headers } from "next/headers"

import { auth } from "@/lib/auth"
import {
  BillingNotConfiguredError,
  STRIPE_PRICE_ENV,
  appOrigin,
  proPriceId,
  stripeClient,
} from "@/lib/billing/stripe"
import { billingStateFor, customerIdFor, periodEndOf } from "@/lib/billing/subscription"
import { tierForSubscription } from "@/lib/billing/tiers"

/**
 * Starts a Stripe Checkout Session for the signed-in user.
 *
 * Two rules, and both of them are about not trusting the caller:
 *
 *  - The user comes from the session cookie, never from the body. This route
 *    takes no body at all, which is the cheapest way to guarantee it: there is
 *    no field a caller could send that this handler reads.
 *  - The price comes from STRIPE_PRICE_PRO, never from the caller. A client that
 *    could name a price could name a one-cent one. There is exactly one thing to
 *    buy here — two tiers, one price, no quantity — so there is nothing to
 *    choose and no parameter to expose.
 *
 * The customer is reused if one exists. That is the third rule and it is in
 * lib/billing/subscription.ts: a second Stripe customer for the same person
 * splits their invoice history in two and neither half is the truth.
 *
 * What this route does NOT do is grant anything. Completing a checkout does not
 * make anybody Pro; the webhook does, after Stripe has confirmed the payment
 * against a signature. The success URL below is a page to land on, not a proof
 * of purchase, and /dashboard/settings reads the mirror rather than the query
 * string it was sent with.
 *
 * ── Not selling the same person two subscriptions
 *
 * There are two guards against that and they are not redundant. The mirror is
 * read first because it is a local index lookup and it stops the ordinary case
 * — somebody already on Pro clicking Upgrade — without touching the network.
 * But the mirror only learns about a subscription when the webhook lands, so two
 * checkouts started in two tabs before the first one completes would both read
 * Free and both pass. So the second guard asks Stripe itself, after the customer
 * is resolved and before the session is created: if that customer already has a
 * subscription this app would call Pro, there is nothing to sell.
 *
 * That still leaves a window, and it is worth naming rather than implying it is
 * closed. Two requests interleaved between the `subscriptions.list` and the two
 * completed checkouts would both see nothing at Stripe either — the check is
 * read-then-act against a system with no lock to take. What it removes is the
 * wide window (minutes, until a webhook lands) and leaves the narrow one
 * (whatever passes between one API call and a human finishing a card form).
 * Closing that properly means reconciling in the webhook: seeing a second
 * subscription for a customer that already has one and cancelling it. That is
 * not built.
 */

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 })

  try {
    // Read before the Stripe call so that an account already on Pro is not
    // offered a second subscription. Stripe would happily create one, and the
    // customer would be charged twice for a product that has no quantity.
    const state = await billingStateFor(session.user.id)
    if (state.tier === "pro" && !state.degraded) {
      return Response.json(alreadySubscribed(), { status: 409 })
    }

    const origin = appOrigin(request)
    const customer = await customerIdFor({
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    })

    // The second guard, at Stripe. Same rule as everywhere else — the Stripe
    // objects are put through `tierForSubscription` rather than compared against
    // a status list written out again here, so "already on Pro" cannot come to
    // mean one thing at checkout and another at the relay.
    //
    // `status: "all"` because a scheduled cancellation is `active` until the
    // period rolls over and a mirror catching up late can carry `canceled` with
    // a future end date; both of those are still a subscription somebody is
    // paying for. An `incomplete` one is not, and does not block a retry.
    const live = await stripeClient().subscriptions.list({
      customer,
      status: "all",
      limit: 20,
    })
    const existing = live.data.find(
      (s) =>
        tierForSubscription({
          status: s.status,
          currentPeriodEnd: periodEndOf(s),
          cancelAtPeriodEnd: s.cancel_at_period_end,
        }) === "pro",
    )
    if (existing) {
      // The mirror said Free and Stripe says otherwise, which means the webhook
      // has not landed or never will. Logged with ids only, because a mirror
      // that is permanently behind for one account is invisible otherwise.
      console.warn(
        `checkout refused: customer ${customer} already has subscription ${existing.id} ` +
          `(${existing.status}) that the local mirror does not reflect`,
      )
      return Response.json(alreadySubscribed(), { status: 409 })
    }

    const checkout = await stripeClient().checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price: proPriceId(), quantity: 1 }],
      // Both of these come back to Settings rather than to a bespoke page.
      // Settings is where the plan is stated, and it reads the mirror, so a
      // webhook that has not landed yet shows as "not active yet" instead of a
      // congratulations page asserting something that has not happened.
      success_url: `${origin}/dashboard/settings?tab=account&checkout=complete`,
      cancel_url: `${origin}/dashboard/settings?tab=account&checkout=cancelled`,
      // `subscription_data.metadata.userId` is the one the code depends on: it
      // rides on the Subscription object itself, so it is there on every later
      // event about this subscription, and it is the third and last resort in
      // mirrorSubscription when no local row carries the subscription or the
      // customer.
      //
      // `client_reference_id` is not read anywhere. It lives on the Checkout
      // Session, which this app discards after taking the subscription id off
      // it, and it is set for the human staring at a session in the Stripe
      // dashboard during an incident and wondering whose it is. Do not count it
      // as a fallback; there is exactly one.
      client_reference_id: session.user.id,
      subscription_data: { metadata: { userId: session.user.id } },
      allow_promotion_codes: true,
    })

    if (!checkout.url) {
      // Stripe returns a null url for session types this app does not create
      // (embedded, custom). Refusing loudly beats handing the browser a null.
      return Response.json(
        { error: "Stripe created a checkout session with no URL to send you to." },
        { status: 502 },
      )
    }

    return Response.json({ url: checkout.url })
  } catch (e) {
    if (e instanceof BillingNotConfiguredError) {
      // Names the variable, carries none of its value, and answers 503 because
      // the request was fine and this server is not equipped to serve it.
      return Response.json(
        { error: e.message, missing: e.missing, code: "billing-not-configured" },
        { status: 503 },
      )
    }
    // Logged without the payload. A Stripe error carries request ids and
    // parameters, not keys, but the habit of logging whole error objects on the
    // money path is how a secret ends up in an aggregator eventually.
    console.error("checkout session could not be created", e instanceof Error ? e.message : e)
    return Response.json(
      {
        error:
          `Stripe would not start a checkout. Nothing was charged. If this persists, check that ` +
          `${STRIPE_PRICE_ENV} names a live recurring price.`,
      },
      { status: 502 },
    )
  }
}

/**
 * The 409 body, written once because two different guards produce it.
 *
 * Same words either way, deliberately: whether it was the mirror or Stripe that
 * knew, what the user needs to do is identical, and a message that leaked which
 * check fired would be telling them about our webhook latency.
 */
function alreadySubscribed() {
  return {
    error:
      "This account is already on Pro. Manage the subscription from the billing portal " +
      "rather than starting a second one.",
    code: "already-subscribed",
  }
}
