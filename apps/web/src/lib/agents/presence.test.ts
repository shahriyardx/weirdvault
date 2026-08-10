import { afterEach, describe, expect, test } from "bun:test"

import { mintPresenceToken, relayInternalUrl } from "./presence"

/**
 * The two things in this module that can be wrong silently.
 *
 * The token shape is checked from the other side as well —
 * `verifies_a_token_the_control_plane_minted` in apps/relay/src/token.rs pins a
 * token this function produced. What is asserted here is the part Rust cannot
 * see: that the claims say what they are supposed to say.
 */

const ENV_KEYS = ["RELAY_INTERNAL_URL", "NEXT_PUBLIC_RELAY_URL"] as const
const saved = new Map<string, string | undefined>()

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined) {
  if (!saved.has(key)) saved.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
})

describe("mintPresenceToken", () => {
  test("names the account, the scope and an expiry", () => {
    const token = mintPresenceToken("secret", "user-1", 1_000)
    const [payload, signature] = token.split(".")
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))

    expect(claims.sub).toBe("user-1")
    expect(claims.scope).toBe("presence")
    expect(claims.exp).toBeGreaterThan(1_000)
    expect(signature.length).toBeGreaterThan(0)
  })

  test("carries no destination", () => {
    // The relay refuses a scoped token on both connect paths, but the claim
    // should not be there to refuse in the first place: a presence token is not
    // a destination that happens to be unused.
    const [payload] = mintPresenceToken("secret", "user-1", 1_000).split(".")
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))

    expect(claims.host).toBeUndefined()
    expect(claims.port).toBeUndefined()
    expect(claims.agent).toBeUndefined()
  })

  test("a different secret is a different signature", () => {
    const a = mintPresenceToken("secret-a", "user-1", 1_000)
    const b = mintPresenceToken("secret-b", "user-1", 1_000)

    expect(a.split(".")[0]).toBe(b.split(".")[0])
    expect(a.split(".")[1]).not.toBe(b.split(".")[1])
  })

  test("expires in well under a minute", () => {
    // It is minted per request and spent one hop away on a private network. A
    // long-lived one would be a bearer credential sitting in a log somewhere.
    const [payload] = mintPresenceToken("secret", "user-1", 1_000).split(".")
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))

    expect(exp - 1_000).toBeLessThanOrEqual(60)
  })
})

describe("relayInternalUrl", () => {
  test("prefers the explicit internal address", () => {
    setEnv("RELAY_INTERNAL_URL", "http://relay:8080")
    setEnv("NEXT_PUBLIC_RELAY_URL", "wss://vault.example.com/ws")

    expect(relayInternalUrl()).toBe("http://relay:8080")
  })

  test("derives an http address from the public websocket one", () => {
    // The fallback for a deployment that never heard of the variable. Same
    // host, no path — /ws is the browser's route and not this one.
    setEnv("RELAY_INTERNAL_URL", undefined)
    setEnv("NEXT_PUBLIC_RELAY_URL", "wss://vault.example.com/ws")

    expect(relayInternalUrl()).toBe("https://vault.example.com")
  })

  test("derives from an insecure public address too", () => {
    setEnv("RELAY_INTERNAL_URL", undefined)
    setEnv("NEXT_PUBLIC_RELAY_URL", "ws://127.0.0.1:8080/ws")

    expect(relayInternalUrl()).toBe("http://127.0.0.1:8080")
  })

  test("is null when there is nothing to derive from", () => {
    // Which the caller turns into "unknown" rather than "offline".
    setEnv("RELAY_INTERNAL_URL", undefined)
    setEnv("NEXT_PUBLIC_RELAY_URL", undefined)

    expect(relayInternalUrl()).toBeNull()
  })

  test("is null rather than throwing on an unparseable address", () => {
    setEnv("RELAY_INTERNAL_URL", undefined)
    setEnv("NEXT_PUBLIC_RELAY_URL", "not a url")

    expect(relayInternalUrl()).toBeNull()
  })
})
