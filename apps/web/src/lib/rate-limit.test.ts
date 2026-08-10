import { describe, expect, test } from "bun:test"

import { keyFor, subjectFor, tooManyRequests } from "./rate-limit"

/**
 * What can and cannot be tested without a database.
 *
 * `consume` is one SQL statement and its whole correctness is in that
 * statement — the window arithmetic, the atomicity, the behaviour of two
 * requests racing on the same key. A mock of `db.execute` would be asserting
 * that a string I wrote matches a string I wrote, so the real check for it is
 * scripts/check-rate-limit.mjs, which drives the running app against the real
 * Postgres and is described in apps/web/README.md.
 *
 * What is here is the part that decides *what gets counted*, and that part has
 * already been wrong once in this codebase for exactly the reason tested below:
 * a key derived from a header the caller writes is a fresh budget on every
 * request, and a limiter with a client-chosen key does not exist. See the note
 * in lib/audit/address.ts.
 */

/** `subjectFor` reads TRUSTED_PROXY_HOPS through a module parsed once at load. */
const proxyConfigured = (process.env.TRUSTED_PROXY_HOPS ?? "") !== ""

describe("who gets counted", () => {
  test("a session is the subject, and outranks anything in a header", () => {
    const spoofed = new Headers({ "x-forwarded-for": "203.0.113.9, 198.51.100.1" })
    expect(subjectFor(spoofed, "user-1")).toBe("u:user-1")
    // The same headers, a different account: two subjects, two budgets. If the
    // header were consulted at all these would collide.
    expect(subjectFor(spoofed, "user-2")).toBe("u:user-2")
  })

  test("no session and no trusted proxy means one shared bucket", () => {
    if (proxyConfigured) return

    // The uncomfortable case, asserted rather than assumed. Without a trusted
    // proxy there is no address this process can believe, so everybody shares a
    // budget — trippable by a stranger, and still better than a per-caller
    // budget the caller chooses.
    expect(subjectFor(new Headers())).toBe("unresolved")
    expect(subjectFor(new Headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("unresolved")
  })

  /**
   * The failure this whole design is arranged against. On a deployment with no
   * trusted proxy, a caller rotating X-Forwarded-For must NOT get a new bucket
   * each time — that is the bug that made the old recovery limiter decorative.
   */
  test("a rotating forwarded-for header cannot mint fresh budgets", () => {
    if (proxyConfigured) return

    const subjects = new Set(
      ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"].map((ip) =>
        subjectFor(new Headers({ "x-forwarded-for": ip })),
      ),
    )
    expect(subjects.size).toBe(1)
  })

  test("an unauthenticated subject is never the same key as an authenticated one", () => {
    // The prefixes exist so that a user whose id happened to equal a network
    // string could not share a budget with it.
    expect(subjectFor(new Headers(), "unresolved")).toBe("u:unresolved")
    expect(subjectFor(new Headers())).toBe("unresolved")
  })
})

describe("keys", () => {
  test("two routes do not share a budget", () => {
    expect(keyFor("share", "u:1")).not.toBe(keyFor("recording", "u:1"))
  })

  test("two subjects do not share a budget", () => {
    expect(keyFor("share", "u:1")).not.toBe(keyFor("share", "u:2"))
  })
})

describe("the refusal", () => {
  test("is a 429 carrying Retry-After in seconds", () => {
    const response = tooManyRequests({ allowed: false, retryAfter: 42 })
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("42")
  })

  /**
   * A `Retry-After: 0` tells a client to retry immediately, which turns a
   * refusal into a busy loop. Sub-second remainders round to zero, so the floor
   * is not decoration.
   */
  test("never tells a client to retry immediately", () => {
    const response = tooManyRequests({ allowed: false, retryAfter: 0 })
    expect(response.headers.get("Retry-After")).toBe("1")
  })

  test("says how long in words, because the app shows `error` to the user", async () => {
    const body = (await tooManyRequests({ allowed: false, retryAfter: 5 }).json()) as {
      error: string
      retryAfter: number
    }
    expect(body.error).toContain("5 seconds")
    expect(body.retryAfter).toBe(5)
  })

  test("a custom message replaces the generic one and keeps the header", async () => {
    const response = tooManyRequests({ allowed: false, retryAfter: 7 }, "Slow down.")
    expect(response.headers.get("Retry-After")).toBe("7")
    expect(((await response.json()) as { error: string }).error).toBe("Slow down.")
  })
})
