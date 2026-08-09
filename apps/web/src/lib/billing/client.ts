"use client";

/**
 * The browser's half of billing: the plan this tab has been told about, and the
 * two buttons that hand the user to Stripe.
 *
 * A tab knows which account it is signed into and nothing about what that
 * account pays. Everything here follows from that: there is no tier table in
 * this module, no copy of a limit, and no local decision about what somebody is
 * entitled to. There is one fetch of /api/billing/subscription and a cache of
 * the answer, and every number rendered anywhere in the client comes out of that
 * answer rather than out of a constant that happened to be importable.
 *
 * ── Why there is a module-level cache
 *
 * Several unrelated places want the plan — the settings page, the recordings
 * page, the recorder itself — and none of them are parents of the others. The
 * same shape lib/recording/store.ts and lib/snippets.ts use is used here: a
 * module-scope snapshot, a listener set, and useSyncExternalStore, because that
 * hook needs a synchronous snapshot and a fetch cannot give one. The cost is a
 * stale plan after an upgrade completes in another tab, and the reload button on
 * the settings card is the answer to that; there is no push channel here to do
 * better with.
 *
 * ── Why the unknown case grants
 *
 * `canRecordNow` returns true when the plan has not been read yet. That is the
 * same fail-toward-access direction the server takes, and it matters more here
 * than there: the client check exists so somebody is told they cannot save a
 * recording *before* they record for ten minutes, not to be a second
 * enforcement. The enforcement is POST /api/recordings, which reads the
 * subscription table itself and refuses. A client that guessed "no" while
 * offline would take a feature away from somebody who has paid for it, on no
 * evidence, and the server would have allowed it.
 */

import { useEffect, useSyncExternalStore } from "react";

/** The plan, exactly as /api/billing/subscription describes it. */
export interface BillingSnapshot {
  tier: "free" | "pro";
  /** "Free" or "Pro", for rendering. */
  label: string;
  /** Stripe's status string, or null for an account that has never subscribed. */
  status: string | null;
  /** ISO timestamp, or null. Renewal date, or lapse date when cancelling. */
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasCustomer: boolean;
  /** The server could not read the subscription table and assumed access. */
  degraded: boolean;
  /** False on a deployment with no Stripe keys. Nothing can be bought there. */
  billingConfigured: boolean;
  price: { label: string; unit: string };
  limits: {
    relayAllowanceBytes: number;
    auditRetentionDays: number;
    auditRetentionLabel: string;
    sessionRecording: boolean;
  };
}

/** What a consumer sees: the plan, whether it is still loading, and why not. */
export interface BillingView {
  billing: BillingSnapshot | null;
  loading: boolean;
  /** Set when the read failed. The plan below is then the last one that worked, or null. */
  error: string | null;
}

/* ------------------------------------------------------------------- store */

let view: BillingView = { billing: null, loading: false, error: null };
const listeners = new Set<() => void>();
let inFlight: Promise<BillingSnapshot | null> | null = null;

function publish(next: BillingView) {
  view = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The last plan this tab was told, or null if it has not been told one. */
export function getBilling(): BillingSnapshot | null {
  return view.billing;
}

/**
 * Whether this tab believes a new recording can be saved.
 *
 * True when the plan is unknown. See the note at the top of this file: this is a
 * check that exists to explain itself early, not the enforcement, and refusing
 * on no information would take a paid feature away from somebody who has paid.
 */
export function canRecordNow(): boolean {
  return view.billing === null ? true : view.billing.limits.sessionRecording;
}

/* ------------------------------------------------------------------ fetches */

/**
 * Reads the plan, at most once concurrently.
 *
 * `force` re-reads even when a plan is already cached — what the reload button
 * and the return from checkout use. Without it a tab that upgraded would keep
 * showing Free until it was reloaded, which is exactly the moment the number
 * matters most.
 */
export async function loadBilling(force = false): Promise<BillingSnapshot | null> {
  if (!force && view.billing) return view.billing;
  if (inFlight) return inFlight;

  publish({ ...view, loading: true, error: null });

  inFlight = (async () => {
    try {
      const res = await fetch("/api/billing/subscription", { cache: "no-store" });
      if (res.status === 401) {
        // Not an error worth showing on a page that is about to redirect to
        // sign-in anyway; the plan is simply not knowable while signed out.
        publish({ billing: null, loading: false, error: null });
        return null;
      }
      if (!res.ok) throw new Error(`The server returned ${res.status}.`);
      const snapshot = (await res.json()) as BillingSnapshot;
      publish({ billing: snapshot, loading: false, error: null });
      return snapshot;
    } catch (e) {
      // The previous plan is kept rather than cleared. A dropped request is not
      // evidence that somebody's subscription ended.
      publish({
        ...view,
        loading: false,
        error: e instanceof Error ? e.message : "The plan could not be read.",
      });
      return view.billing;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** The plan, read once on mount. Re-read with `loadBilling(true)`. */
export function useBilling(): BillingView {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => view,
    // Server render: the plan comes from an authenticated fetch this browser
    // makes, so there is nothing to render on the server but "not known yet".
    () => SERVER_VIEW,
  );

  useEffect(() => {
    void loadBilling();
  }, []);

  return snapshot;
}

const SERVER_VIEW: BillingView = { billing: null, loading: true, error: null };

/* ------------------------------------------------------------------ actions */

/**
 * Why a billing action failed, so a caller can say the right thing. The one that
 * needs distinguishing is `not-configured`: a deployment with no Stripe keys is
 * a supported configuration rather than a broken one, and telling somebody their
 * payment failed would be wrong on both counts.
 */
export type BillingActionFailure = "not-configured" | "unauthorized" | "conflict" | "failed";

export class BillingActionError extends Error {
  readonly kind: BillingActionFailure;

  constructor(kind: BillingActionFailure, message: string) {
    super(message);
    this.name = "BillingActionError";
    this.kind = kind;
  }
}

/**
 * Starts checkout and returns the URL to send the browser to.
 *
 * Returns rather than navigates, so the caller owns the navigation and can put
 * a button back into a usable state if it never happens. Nothing about the price
 * or the plan is sent: the route takes no body, reads the user from the session
 * and the price from the environment.
 */
export async function startCheckout(): Promise<string> {
  return post("/api/billing/checkout");
}

/** Opens the Stripe billing portal for this user. Same contract as above. */
export async function openPortal(): Promise<string> {
  return post("/api/billing/portal");
}

async function post(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", cache: "no-store" });
  } catch {
    throw new BillingActionError(
      "failed",
      "The request never reached the server. Nothing was charged.",
    );
  }

  const body = (await res.json().catch(() => ({}))) as {
    url?: unknown;
    error?: unknown;
    code?: unknown;
  };
  const detail = typeof body.error === "string" ? body.error : null;

  if (res.ok) {
    if (typeof body.url !== "string" || body.url === "") {
      throw new BillingActionError("failed", "Stripe did not return a page to send you to.");
    }
    return body.url;
  }

  if (res.status === 401) {
    throw new BillingActionError("unauthorized", "This browser is no longer signed in.");
  }
  if (body.code === "billing-not-configured" || res.status === 503) {
    throw new BillingActionError(
      "not-configured",
      detail ?? "Billing is not configured on this deployment.",
    );
  }
  if (res.status === 409 || res.status === 404) {
    throw new BillingActionError("conflict", detail ?? `The server returned ${res.status}.`);
  }
  throw new BillingActionError("failed", detail ?? `The server returned ${res.status}.`);
}
