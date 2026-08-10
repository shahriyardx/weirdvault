import { eq } from "drizzle-orm";
import type Stripe from "stripe";

import { db, schema } from "@/lib/db";
import { BillingNotConfiguredError, stripeClient, webhookSecret } from "@/lib/billing/stripe";
import { mirrorSubscription } from "@/lib/billing/subscription";

/**
 * Stripe's webhook. The only unauthenticated write path in this application.
 *
 * ── The signature is the entire security model
 *
 * There is no session, no cookie and no bearer token here, by design: Stripe's
 * servers have none of those. What stands between a stranger and granting
 * themselves a Pro subscription is `constructEventAsync` verifying an HMAC over
 * the request body against STRIPE_WEBHOOK_SECRET. Everything downstream of that
 * call treats the event as true, so nothing may run before it.
 *
 * Which makes the raw body the thing to be careful about. The signature covers
 * the exact bytes Stripe sent, so the body must be read as text and handed to
 * the verifier untouched. `await request.json()` and then re-serialising is the
 * classic way to break this: JSON.stringify does not reproduce Stripe's key
 * order, spacing or number formatting, the HMAC does not match, and every
 * delivery fails with a signature error that looks like a wrong secret. Read
 * `.text()`, verify that, and parse nothing by hand.
 *
 * ── Idempotency
 *
 * Stripe retries on any non-2xx and can deliver the same event twice even
 * without a retry. The event id is inserted into `stripe_event` before anything
 * is processed, and its primary key is the deduplication: a second delivery
 * conflicts, writes nothing, and is answered 200 as already done. That makes
 * "exactly once" a property of the database rather than of this function's
 * control flow, which is the only place it can be a property when two deliveries
 * can be in flight at the same time.
 *
 * The marker is deleted again if processing throws, and the response is a 500 so
 * Stripe retries. Without that, a transient database failure halfway through
 * would leave the event permanently marked as handled and the mirror
 * permanently behind.
 *
 * ── Status codes
 *
 * Anything other than a 2xx makes Stripe retry, for days. So an event this app
 * deliberately ignores — and it ignores most of them — is answered 200 with a
 * note saying so. A 400 is reserved for a delivery that could not have come from
 * Stripe; a 500 for one that could and that this server failed to handle.
 *
 * ── Logging
 *
 * The event id and type are logged. The payload is not, and neither is the
 * signing secret, the signature header or anything from the customer object. An
 * event body carries email addresses and billing details, and a webhook handler
 * that logs the whole thing turns a log aggregator into a place customer data
 * lives.
 */

/**
 * The events that change the mirror. Everything else is a 200 and a shrug.
 *
 * `checkout.session.completed` is the one that starts a subscription. The other
 * three follow it for the rest of the subscription's life: renewals, plan
 * changes, cancellations, and the pause and resume that a failed card produces.
 * `invoice.payment_failed` is here because it is the earliest signal that a card
 * has stopped working — Stripe also sends a subscription update, but arriving at
 * the same conclusion twice is cheap and arriving late is not.
 */
const HANDLED = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
]);

export async function POST(request: Request) {
  // Both the secret and the client are resolved before the verification attempt
  // rather than inside it. A missing STRIPE_SECRET_KEY would otherwise surface
  // from `stripeClient()` inside the try below and be reported as a signature
  // failure, which is a 400 telling Stripe its own signature was wrong and an
  // operator to go looking for the wrong variable.
  let secret: string;
  let stripe: ReturnType<typeof stripeClient>;
  try {
    secret = webhookSecret();
    stripe = stripeClient();
  } catch (e) {
    if (e instanceof BillingNotConfiguredError) {
      // 503 rather than 200: a deployment that cannot verify a delivery must not
      // let Stripe believe it succeeded, or the event is lost. A retry gives an
      // operator time to set the variable, which is named in the log and not in
      // the response.
      console.error(`webhook rejected: ${e.missing} is not set`);
      return Response.json({ error: e.message }, { status: 503 });
    }
    throw e;
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ error: "missing stripe-signature" }, { status: 400 });
  }

  // The raw bytes, exactly as sent. Nothing may parse this before the verifier
  // has seen it — see the note above about re-serialisation.
  const raw = await request.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, signature, secret);
  } catch (e) {
    // Deliberately vague to the caller and specific in the log. Somebody probing
    // this endpoint learns only that their signature was wrong; the operator
    // learns why, without the body or the header being written anywhere.
    console.warn("webhook signature verification failed", e instanceof Error ? e.message : "");
    return Response.json({ error: "signature verification failed" }, { status: 400 });
  }

  // Claim the event before doing anything with it. The insert either wins, and
  // this delivery owns the processing, or it conflicts, and some other delivery
  // already did the work.
  let claimed: { id: string }[];
  try {
    claimed = await db
      .insert(schema.stripeEvent)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing({ target: schema.stripeEvent.id })
      .returning({ id: schema.stripeEvent.id });
  } catch (e) {
    console.error(`webhook ${event.id} could not be recorded`, e instanceof Error ? e.message : e);
    return Response.json({ error: "could not record event" }, { status: 500 });
  }

  if (claimed.length === 0) {
    // Already processed. Not an error and not worth a log line — Stripe redelivers
    // routinely and this is the mechanism working.
    return Response.json({ ok: true, deduplicated: true });
  }

  if (!HANDLED.has(event.type)) {
    // 200, or Stripe retries an event we will never do anything with until it
    // gives up days later. The marker row stays, which is correct: it has been
    // dealt with, and the decision was to ignore it.
    return Response.json({ ok: true, ignored: event.type });
  }

  try {
    await handle(event);
  } catch (e) {
    // Release the claim so the retry can do the work, then fail loudly enough
    // that Stripe sends one.
    await db
      .delete(schema.stripeEvent)
      .where(eq(schema.stripeEvent.id, event.id))
      .catch(() => {
        // If even this fails the event is stuck marked-as-done and the mirror is
        // behind. Say so: it is the one state that needs a human.
        console.error(
          `webhook ${event.id} (${event.type}) failed and its marker could not be cleared; ` +
            "the subscription mirror may be stale for that account",
        );
      });
    console.error(`webhook ${event.id} (${event.type}) failed`, e instanceof Error ? e.message : e);
    return Response.json({ error: "processing failed" }, { status: 500 });
  }

  return Response.json({ ok: true, type: event.type });
}

/**
 * Turns one event into one mirror write.
 *
 * Every branch converges on `mirrorSubscription`, which is given a Stripe
 * Subscription object and works out whose it is. Nothing here decides a status
 * itself: the status written is always the one Stripe reported, because a status
 * this code inferred would be a second opinion competing with the source of
 * truth.
 */
async function handle(event: Stripe.Event): Promise<void> {
  const stripe = stripeClient();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      // A one-off payment session, if this account ever grows one, has no
      // subscription to mirror. Ignoring it is correct rather than a gap.
      if (session.mode !== "subscription") return;

      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : (session.subscription?.id ?? null);
      if (!subscriptionId) return;

      // Fetched rather than read from the session, because the session's copy is
      // a summary and this needs the items — which is where the period end lives
      // in this API version.
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      await mirror(subscription, event);
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      // The event carries the whole subscription, including the item periods, so
      // there is nothing to fetch. `deleted` is not a deletion of anything here:
      // it arrives with status `canceled`, which is what gets written, and
      // tiers.ts decides whether a cancellation still grants anything.
      await mirror(event.data.object, event);
      return;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      // `invoice.subscription` was removed from the Invoice object; a
      // subscription invoice now names its subscription under `parent`. An
      // invoice with no subscription parent is a one-off charge and is not ours
      // to act on.
      const parent = invoice.parent?.subscription_details?.subscription;
      const subscriptionId = typeof parent === "string" ? parent : (parent?.id ?? null);
      if (!subscriptionId) return;

      // Re-read rather than assume `past_due`. Stripe decides what a failed
      // payment does to a subscription — the first failure of a retry schedule
      // and the last one produce very different statuses — and guessing would be
      // this file inventing a billing state.
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      await mirror(subscription, event);
      return;
    }

    default:
      return;
  }
}

/**
 * One mirror write, and a log line for each way it can decline to make one.
 *
 * `event.created` is passed through as the ordering key. It is Stripe's clock
 * rather than ours, which is the point: this server sees deliveries in whatever
 * order the network and the retry schedule produce, and the retry schedule is
 * one this route deliberately triggers by answering 500. The mirror needs to
 * know which of two answers Stripe formed later, and only Stripe can say.
 */
async function mirror(subscription: Stripe.Subscription, event: Stripe.Event): Promise<void> {
  const { skipped } = await mirrorSubscription(subscription, new Date(event.created * 1000));
  if (!skipped) return;

  const prefix = `webhook ${event.id} (${event.type}): subscription ${subscription.id}`;
  switch (skipped) {
    case "unattributable":
      // Created directly in the Stripe dashboard against a customer we have
      // never seen, or against one whose local row has been deleted with its
      // user. Nothing is written, because the alternative is granting somebody
      // else's subscription to an account picked by guesswork.
      console.warn(`${prefix} matches no local account; nothing was written`);
      return;
    case "stale-event":
      // A redelivery that arrived after a newer one. Routine, and the
      // deduplication working rather than failing — logged at info because a
      // run of these is how a delivery backlog looks from here.
      console.info(`${prefix} carried an older event than the mirror already has; ignored`);
      return;
    case "other-subscription":
      // One customer with two subscriptions. Should not happen, is not fixed by
      // anything here, and somebody is probably being charged twice.
      console.error(
        `${prefix} would have overwritten a different subscription that still grants Pro for ` +
          "this account; nothing was written. That customer has two subscriptions in Stripe",
      );
      return;
  }
}
