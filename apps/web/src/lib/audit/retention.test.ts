/**
 * The retention windows, and the one design decision around them worth pinning.
 *
 * This file used to be mostly a drift guard. `scripts/prune-audit.mjs` was the
 * thing that actually deleted rows and it could not import this module — plain
 * node, run against Next's standalone output, which ships neither `src/` nor a
 * TypeScript toolchain — so it carried its own `RETENTION_DAYS` literal, and
 * these tests read that script as *text* to check the numbers still matched.
 *
 * The pruner is `lib/maintenance/audit.ts` now and imports
 * `AUDIT_RETENTION_DAYS` directly, so there is one copy and nothing to compare.
 * Those tests are deleted rather than weakened into something that still looks
 * like a check.
 *
 * What survives is the rule the numbers are applied by, which is a decision
 * about SQL that no unit test can execute: the pruner chooses a window by
 * whether the account has a subscription row *at all*, not by re-deriving
 * `tierForSubscription`'s status logic. That asymmetry is deliberate and is the
 * kind of thing a later reader tidies into "correctness" — with row deletion as
 * the failure mode — so there is a tripwire for it below.
 */

import { describe, expect, test } from "bun:test"

import { AUDIT_RETENTION_DAYS, auditRetentionCutoff } from "./retention"
import { RELAY_ALLOWANCE_BYTES, tierForSubscription } from "@/lib/billing/tiers"

const PRUNER = new URL("../maintenance/audit.ts", import.meta.url).pathname

describe("the pruner over-keeps, on purpose", () => {
  test("both windows reach the statement", async () => {
    const source = await Bun.file(PRUNER).text()

    // A statement carrying only one of them is the old single-window pruner,
    // which would delete a Pro account's year of history at the Free cutoff.
    expect(source).toContain("AUDIT_RETENTION_DAYS.free")
    expect(source).toContain("AUDIT_RETENTION_DAYS.pro")
  })

  test("the choice consults the subscription table and nothing about status", async () => {
    const source = await Bun.file(PRUNER).text()

    // Presence of a row, not a resolution of it. `tierForSubscription` weighs
    // status and period end; transcribing that into SQL would be a second copy
    // of a non-trivial rule in a language it cannot be tested in. Over-keeping
    // is invisible through the API — GET /api/audit filters on read — and
    // recoverable. Over-deleting is neither.
    expect(source).toMatch(/from\s+"subscription"/i)
    expect(source).not.toMatch(/status\s+in\s*\(/i)
    // Not imported, rather than not mentioned. The doc comment names it to
    // explain why it is deliberately *not* used, and a check that forbade the
    // word would push somebody to delete the explanation to make a test pass.
    expect(source).not.toMatch(/import\s*\{[^}]*\btierForSubscription\b/)
  })
})

describe("one tier, app-wide", () => {
  test("the audit window and the relay allowance are keyed by the same tier", () => {
    // The point is not what either number is — it is that both are indexed by
    // the answer tierForSubscription gives. A tier meaning 30 days to the audit
    // log and 5 GB to the relay would be worse than no tier at all.
    for (const tier of ["free", "pro"] as const) {
      expect(AUDIT_RETENTION_DAYS[tier]).toBeGreaterThan(0)
      expect(RELAY_ALLOWANCE_BYTES[tier]).toBeGreaterThan(0)
    }
    expect(AUDIT_RETENTION_DAYS.pro).toBeGreaterThan(AUDIT_RETENTION_DAYS.free)
  })

  test("an account with no subscription gets the Free window", () => {
    expect(AUDIT_RETENTION_DAYS[tierForSubscription(null)]).toBe(AUDIT_RETENTION_DAYS.free)
  })
})

describe("the cutoff", () => {
  test("is a rolling window measured back from now", () => {
    const now = new Date("2026-08-09T12:00:00Z")
    expect(auditRetentionCutoff("free", now).toISOString()).toBe("2026-07-10T12:00:00.000Z")
    expect(auditRetentionCutoff("pro", now).toISOString()).toBe("2025-08-09T12:00:00.000Z")
  })
})
