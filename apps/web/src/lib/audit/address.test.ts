import { describe, expect, test } from "bun:test"

/**
 * clientAddress reads TRUSTED_PROXY_HOPS once, at module load, so each case has
 * to load its own copy of the module with the environment already set. A dynamic
 * import plus a cache-busting query is the smallest way to do that under bun's
 * runner, and it keeps the parse-once behaviour under test rather than working
 * around it.
 */
async function load(hops: string | undefined, nonce: number) {
  if (hops === undefined) delete process.env.TRUSTED_PROXY_HOPS
  else process.env.TRUSTED_PROXY_HOPS = hops
  return (await import(`./address.ts?case=${nonce}`)) as typeof import("./address")
}

const headers = (forwarded?: string) =>
  new Headers(forwarded === undefined ? {} : { "x-forwarded-for": forwarded })

describe("clientAddress", () => {
  test("returns null when no proxy is configured, whatever the caller claims", async () => {
    const { clientAddress, proxyConfigured } = await load(undefined, 1)
    expect(proxyConfigured).toBe(false)
    expect(clientAddress(headers("203.0.113.42"))).toBeNull()
    expect(clientAddress(headers("1.2.3.4, 203.0.113.42"))).toBeNull()
  })

  test("with one proxy, takes the entry that proxy appended", async () => {
    const { clientAddress } = await load("1", 2)
    // The right-most entry is the address the trusted proxy observed. Everything
    // to the left of it was written by the caller.
    expect(clientAddress(headers("198.51.100.9, 203.0.113.42"))).toBe("203.0.113.42")
  })

  test("a forged left-most entry cannot become the answer", async () => {
    const { clientAddress } = await load("1", 3)
    const forged = clientAddress(headers("10.0.0.1, 10.0.0.2, 203.0.113.42"))
    expect(forged).toBe("203.0.113.42")
  })

  test("two proxies read one hop further left", async () => {
    const { clientAddress } = await load("2", 4)
    expect(clientAddress(headers("10.0.0.1, 203.0.113.42, 172.16.0.1"))).toBe("203.0.113.42")
  })

  test("a chain shorter than the configured hop count answers null", async () => {
    const { clientAddress } = await load("3", 5)
    expect(clientAddress(headers("203.0.113.42"))).toBeNull()
  })

  test("a missing header and a junk hop count both answer null", async () => {
    const missing = await load("1", 6)
    expect(missing.clientAddress(headers())).toBeNull()

    const junk = await load("true", 7)
    expect(junk.proxyConfigured).toBe(false)
    expect(junk.clientAddress(headers("203.0.113.42"))).toBeNull()
  })
})
