/**
 * What a failed query is allowed to say in a log line.
 *
 * This exists because the obvious code is wrong in a way nothing else would
 * catch. `console.warn("lookup failed", e)` reads as harmless, and on drizzle it
 * writes `Failed query: select ... where user_id = $1 / params: <user id>` into
 * whatever aggregates the logs. The call sites that use this helper carry
 * comments promising they log no user id and no query; this is the check that
 * the promise is kept.
 *
 * The DrizzleQueryError shape is reproduced here rather than imported, because
 * what matters is the property — an error whose *message* embeds the SQL and the
 * parameters must not reach a log — and that property holds for any library that
 * does the same thing. A test that imported the real class would break on a
 * drizzle upgrade for reasons unrelated to what it is asserting.
 */

import { describe, expect, test } from "bun:test"

import { dbErrorSummary } from "./errors"

/** The shape drizzle 0.45 throws: SQL and bound parameters inside the message. */
function drizzleLike(sql: string, params: unknown[], cause?: unknown): Error {
  const e = new Error(`Failed query: ${sql}\nparams: ${params}`)
  e.name = "DrizzleQueryError"
  if (cause !== undefined) (e as { cause?: unknown }).cause = cause
  return e
}

const USER_ID = "user_2fXq7bNvKcT1"
const SQL = `select "subscription"."status" from "subscription" where "user_id" = $1`

describe("dbErrorSummary", () => {
  test("carries neither the query nor its parameters", () => {
    const summary = dbErrorSummary(drizzleLike(SQL, [USER_ID]))
    expect(summary).not.toContain(USER_ID)
    expect(summary).not.toContain("select")
    expect(summary).not.toContain("subscription")
  })

  test("names the error class, which is the useful half", () => {
    expect(dbErrorSummary(drizzleLike(SQL, [USER_ID]))).toBe("DrizzleQueryError")
  })

  test("includes the driver code from the cause when there is one", () => {
    // 57014 is statement_timeout, which is a different incident from a
    // connection refusal and the one fact worth having at three in the morning.
    const e = drizzleLike(SQL, [USER_ID], { code: "57014" })
    expect(dbErrorSummary(e)).toBe("DrizzleQueryError (57014)")
  })

  test("reads a code set directly on the error, as node-postgres does", () => {
    const e = new Error("connection terminated")
    e.name = "Error"
    ;(e as { code?: string }).code = "ECONNREFUSED"
    expect(dbErrorSummary(e)).toBe("Error (ECONNREFUSED)")
  })

  test("says so rather than guessing when what was thrown is not an Error", () => {
    expect(dbErrorSummary("boom")).toBe("unknown error")
    expect(dbErrorSummary(undefined)).toBe("unknown error")
  })
})
