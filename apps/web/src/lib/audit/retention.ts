/**
 * How long an audit event is kept.
 *
 * Two windows, one per tier: thirty days on Free, twelve months on Pro. They
 * live here rather than being written into the query, the pruner and the page
 * separately, because three copies of a retention promise is three chances for
 * one of them to be wrong — and the one the user reads is usually the copy that
 * is not enforced.
 *
 * The window is enforced twice on purpose. The pruner (scripts/prune-audit.mjs)
 * removes the rows, and the GET handler refuses to return anything older even
 * if the pruner has not run since the last event aged out. Without the second
 * enforcement the retention claim is only as true as the last cron run, and
 * nothing schedules that cron run for the operator — see the README.
 *
 * What is NOT solved here: the pruner is a plain node script and cannot import
 * this module (the runtime image is Next's standalone output, which contains no
 * TypeScript and no src/), so it carries its own copy of these numbers. The
 * duplication is real. What checks it is retention.test.ts, which reads that
 * script as text and compares the literal — crude, and enough to turn a silent
 * divergence into a failing test.
 *
 * Node-free by design: this is imported by a route handler and by a client
 * component, so it must not pull in the database or anything server-only. Its
 * one import is type-only for that reason — lib/billing/tiers.ts is plain
 * constants and a pure resolver, but the lookup that turns a user id into a tier
 * lives in lib/billing/subscription.ts, which does open a database.
 *
 * Which is the thing that changed here. There used to be an `auditRetentionTier`
 * in this file: a synchronous function returning the one tier every account was
 * on, so that a Client Component could render its window during a render pass.
 * Its own comment said that stopped working the moment a tier could differ per
 * account, and Stripe subscriptions are that moment. It is gone. The server
 * resolves the tier and states it in the `retention` block on the /api/audit
 * response; the Activity page renders what it is told and shows nothing until it
 * is told. A window on screen that disagrees with the window the query enforces
 * is the exact failure this file exists to prevent, and a client that guessed
 * would produce one on the first Pro account.
 */

import type { Tier } from "@/lib/billing/tiers";

/**
 * The tier a retention window is chosen by — the app-wide tier, aliased rather
 * than redeclared.
 *
 * The name stays because it reads correctly at the call sites here, but it is
 * the same type lib/billing/tiers.ts uses for the relay allowance. Two separate
 * unions that happened to have the same members would drift the first time a
 * third tier existed, and a tier that means one thing to the transfer cap and
 * another to the audit window is worse than no tier at all.
 */
export type AuditRetentionTier = Tier;

/** Days of history each tier keeps. Twelve months is expressed as 365 days. */
export const AUDIT_RETENTION_DAYS: Record<AuditRetentionTier, number> = {
  free: 30,
  pro: 365,
};

/**
 * How to say each window in a sentence. "12 months" rather than "365 days":
 * the number is the implementation, the phrase is the promise on the pricing
 * page, and the two should not drift apart in the user's reading.
 */
export const AUDIT_RETENTION_LABEL: Record<AuditRetentionTier, string> = {
  free: "30 days",
  pro: "12 months",
};

/**
 * The retention block /api/audit states on every response.
 *
 * Declared here, next to the windows, because it is the contract that carries a
 * window from the side that enforces it to the side that renders it. The client
 * has no other source for these three values and must not invent one.
 */
export interface AuditRetentionWindow {
  tier: AuditRetentionTier;
  days: number;
  /** ISO timestamp: the oldest event the query will return, as of that response. */
  since: string;
}

/** Days kept for a tier. */
export function auditRetentionDays(tier: AuditRetentionTier): number {
  return AUDIT_RETENTION_DAYS[tier];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The oldest timestamp still inside the window. Events at or after this instant
 * are returned and kept; anything before it is out of retention and is deleted
 * — really deleted, by DELETE, not flagged and hidden.
 *
 * A rolling window measured from now, not a calendar boundary. It means the
 * cutoff moves continuously rather than dropping a month of history at midnight
 * on the first, which is the behaviour "30 days" describes to a reader.
 */
export function auditRetentionCutoff(
  tier: AuditRetentionTier,
  now: Date = new Date(),
): Date {
  return new Date(now.getTime() - auditRetentionDays(tier) * DAY_MS);
}
