/**
 * The retention windows exist twice, and this is what stops the copies drifting.
 *
 * `scripts/prune-audit.mjs` is the thing that actually deletes rows, and it
 * cannot import this module: it is plain node, run against a production image
 * that is Next's standalone output, which ships neither `src/` nor a TypeScript
 * toolchain. So it carries its own `RETENTION_DAYS` literal. Two copies of a
 * retention promise is two chances for one to be wrong, and the dangerous
 * direction is silent — a pruner with a shorter window deletes rows the API
 * would still have returned, and nobody finds out until somebody goes looking
 * for an event that is gone.
 *
 * Reading the script as text is deliberately crude, and it is the only thing
 * available: importing it would open a database connection and start deleting.
 * The parse is narrow enough to fail loudly if the declaration is reshaped,
 * which is the correct outcome — this test failing means somebody should look
 * at both files, not that the test should be relaxed.
 *
 * The second test here used to assert that the pruner applied one hardcoded
 * window to the whole table, because every account was Free. Pro is a real
 * subscription now and that assertion would be a licence to delete a paying
 * customer's history at thirty days. What replaced it is the check that the
 * pruner reads both windows and chooses per user — and, specifically, that it
 * chooses by *keeping* more rather than by re-deriving the tier rule in SQL.
 */

import { describe, expect, test } from "bun:test";

import { AUDIT_RETENTION_DAYS, auditRetentionCutoff } from "./retention";
import { RELAY_ALLOWANCE_BYTES, tierForSubscription } from "@/lib/billing/tiers";

const PRUNER = new URL("../../../scripts/prune-audit.mjs", import.meta.url).pathname;

describe("the pruner's copy of the windows", () => {
  test("matches AUDIT_RETENTION_DAYS", async () => {
    const source = await Bun.file(PRUNER).text();

    const declaration = source.match(/const RETENTION_DAYS = \{([^}]*)\}/);
    expect(
      declaration,
      "scripts/prune-audit.mjs no longer declares RETENTION_DAYS as an object literal; " +
        "if the shape changed, this test has to change with it rather than be deleted",
    ).not.toBeNull();

    const copied: Record<string, number> = {};
    for (const [, tier, days] of declaration![1].matchAll(/(\w+)\s*:\s*(\d+)/g)) {
      copied[tier] = Number(days);
    }

    expect(copied).toEqual(AUDIT_RETENTION_DAYS);
  });

  test("prunes per account rather than applying one window to the table", async () => {
    const source = await Bun.file(PRUNER).text();

    // Both cutoffs have to reach the DELETE. A statement carrying only one of
    // them is the old single-window pruner, which would delete a Pro account's
    // year of history at the Free cutoff.
    expect(source).toContain("RETENTION_DAYS.free");
    expect(source).toContain("RETENTION_DAYS.pro");

    // And the choice between them has to consult the subscription table. This is
    // a tripwire for somebody reintroducing a constant tier, not a proof that
    // the SQL is right — nothing here runs Postgres.
    expect(source).toMatch(/from\s+"?subscription"?/i);
  });

  test("keeps rather than resolves: any subscription row wins the long window", async () => {
    const source = await Bun.file(PRUNER).text();

    // The deliberate asymmetry, asserted so it is not "tidied up" later into a
    // transcription of tierForSubscription's status rules. The pruner cannot
    // import that function, and a second copy of it in SQL would be a second
    // thing to get wrong — with deletion as the failure mode. Over-keeping is
    // invisible through the API (GET /api/audit still filters on read) and
    // recoverable; over-deleting is neither.
    expect(source).toContain("prune-audit deliberately over-keeps");
    expect(source).not.toMatch(/status\s+IN\s*\(/i);
  });
});

describe("one tier, app-wide", () => {
  test("the audit window and the relay allowance are keyed by the same tier", () => {
    // The point is not what either number is — it is that both are indexed by
    // the answer tierForSubscription gives. A tier meaning 30 days to the audit
    // log and 5 GB to the relay would be worse than no tier at all.
    for (const tier of ["free", "pro"] as const) {
      expect(AUDIT_RETENTION_DAYS[tier]).toBeGreaterThan(0);
      expect(RELAY_ALLOWANCE_BYTES[tier]).toBeGreaterThan(0);
    }
    expect(AUDIT_RETENTION_DAYS.pro).toBeGreaterThan(AUDIT_RETENTION_DAYS.free);
  });

  test("an account with no subscription gets the Free window", () => {
    expect(AUDIT_RETENTION_DAYS[tierForSubscription(null)]).toBe(AUDIT_RETENTION_DAYS.free);
  });
});

describe("the cutoff", () => {
  test("is a rolling window measured back from now", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    expect(auditRetentionCutoff("free", now).toISOString()).toBe("2026-07-10T12:00:00.000Z");
    expect(auditRetentionCutoff("pro", now).toISOString()).toBe("2025-08-09T12:00:00.000Z");
  });
});
