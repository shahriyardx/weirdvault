/**
 * The share expiry is enforced in SQL, and this is what keeps its column type
 * honest.
 *
 * `GET /api/shares/[token]` decides whether a link still opens by comparing
 * `expires_at` against `now()` inside the same statement that increments the
 * view counter. `now()` is `timestamptz`, so if the column is a naive
 * `timestamp` Postgres resolves the comparison by promoting the column through
 * the server's TimeZone setting. Every value in it was written as UTC wall
 * clock, which means on a deployment whose Postgres is not UTC the enforced
 * expiry sits hours away from the one the owner was shown — a link that the
 * share dialog reports as expired keeps serving the transcript, which is the
 * whole control failing quietly rather than loudly.
 *
 * What this asserts is only the declared type. The behaviour it stands in for
 * needs a database with a non-UTC session TimeZone, and there is no Postgres in
 * `bun test`; it was verified by hand against postgres:17-alpine with
 * `TimeZone=America/New_York`, where the naive column served an hour-expired
 * share and the `timestamptz` one refused it. So this is a tripwire for the
 * declaration being changed back, not a proof that the route refuses.
 *
 * The rest of the schema is deliberately not covered: every other timestamp is
 * compared in JavaScript, where drizzle's UTC round-trip hides the difference.
 * If a second SQL-side comparison is ever written, its column belongs here too.
 */

import { describe, expect, test } from "bun:test"

import { recordingShare } from "./schema"

describe("recording_share timestamps", () => {
  test("expires_at is timestamptz, because SQL compares it against now()", () => {
    expect(recordingShare.expiresAt.getSQLType()).toBe("timestamp with time zone")
  })

  test("the other two are timestamptz as well, so the row reads as one clock", () => {
    // Not enforcement, only display: the owner's dialog shows when a link was
    // made and when it was cut off. A row whose expiry is an instant and whose
    // creation is local wall clock would put two different clocks in one panel.
    expect(recordingShare.createdAt.getSQLType()).toBe("timestamp with time zone")
    expect(recordingShare.revokedAt.getSQLType()).toBe("timestamp with time zone")
  })
})
