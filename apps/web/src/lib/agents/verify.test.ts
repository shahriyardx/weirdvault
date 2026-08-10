import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto"

import { fingerprintFor, verifyAgentSignature, verifyingMessage } from "./verify"

/**
 * The agent signs in Go and this verifies in Node, so the only failure that
 * matters is the one where both halves are individually correct and disagree
 * about what was signed. A round-trip test written entirely in Node cannot
 * catch that — it would happily pass with the newlines in the wrong order, on
 * both sides, forever.
 *
 * So the fixture below was produced by the Go implementation and is pasted in
 * verbatim: an Ed25519 key from a fixed seed, signing a fixed agent id and
 * nonce. If apps/agent/main.go changes the message format, this fails. If this
 * file changes it, this fails. That is the point.
 *
 * Regenerate with the seed `bytes.Repeat([]byte{7}, 32)` and the same inputs if
 * the format is ever deliberately versioned.
 */
const GO = {
  agentId: "agent_01HZX9K2QW",
  nonce: "yJ3n0Qn8bC1sVv2mF7xLpR4tZ6aD5eG9hK0jN8uW1oI",
  publicKey: "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=",
  signature:
    "9dHClQV+iZI4q/V4Gz7LlFyEHX8lmF9RYZBBmm9u2Sfv1ul68ODTqWPJg81Zik2Nfcu+ttc6Ap38XFdGyn2iDg==",
  fingerprint: "SHA256:/oEsEvOrTOasXbaaw1L5BssbEe9D+zPiUu9/9VImOIk",
}

describe("agent signatures", () => {
  test("accepts a signature the Go agent actually produced", () => {
    expect(
      verifyAgentSignature({
        publicKeyBase64: GO.publicKey,
        agentId: GO.agentId,
        nonce: GO.nonce,
        signatureBase64: GO.signature,
      }),
    ).toBe(true)
  })

  test("renders the same fingerprint the agent prints on the machine", () => {
    // The user compares these two strings by eye. A difference in padding or
    // case makes them look like different keys and makes the check useless.
    expect(fingerprintFor(GO.publicKey)).toBe(GO.fingerprint)
  })

  test("the signed message is exactly what both sides build", () => {
    expect(verifyingMessage("a", "b").toString("utf8")).toBe("webxterm-agent-v1\na\nb")
  })

  test("a signature for one agent does not verify for another", () => {
    // The reason the agent id is inside the signed message: without it, a nonce
    // and signature captured from one agent's handshake would authenticate any
    // other agent whose key you also happened to know.
    expect(
      verifyAgentSignature({
        publicKeyBase64: GO.publicKey,
        agentId: "agent_SOMEONE_ELSE",
        nonce: GO.nonce,
        signatureBase64: GO.signature,
      }),
    ).toBe(false)
  })

  test("a signature for one nonce does not verify for another", () => {
    // The replay protection. The relay generates a fresh nonce per connection,
    // so a captured signature is worth exactly one already-finished handshake.
    expect(
      verifyAgentSignature({
        publicKeyBase64: GO.publicKey,
        agentId: GO.agentId,
        nonce: "a-different-nonce",
        signatureBase64: GO.signature,
      }),
    ).toBe(false)
  })

  test("a signature does not verify against a different key", () => {
    const { publicKey } = generateKeyPairSync("ed25519")
    const other = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64")

    expect(
      verifyAgentSignature({
        publicKeyBase64: other,
        agentId: GO.agentId,
        nonce: GO.nonce,
        signatureBase64: GO.signature,
      }),
    ).toBe(false)
  })

  test("verifies a signature made here, too", () => {
    // Proves the fixture above is testing the format rather than a quirk of one
    // implementation: a key generated and signed entirely in Node verifies by
    // the same path.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32)
    const signature = cryptoSign(null, verifyingMessage("x", "y"), privateKey)

    expect(
      verifyAgentSignature({
        publicKeyBase64: raw.toString("base64"),
        agentId: "x",
        nonce: "y",
        signatureBase64: signature.toString("base64"),
      }),
    ).toBe(true)
  })

  test("malformed input is refused, not thrown", () => {
    // Every caller's next move is to refuse the agent. A throw would turn a
    // routine rejection into a 500 and let a prober tell malformed from merely
    // wrong by watching status codes.
    const base = {
      publicKeyBase64: GO.publicKey,
      agentId: GO.agentId,
      nonce: GO.nonce,
      signatureBase64: GO.signature,
    }
    expect(verifyAgentSignature({ ...base, publicKeyBase64: "" })).toBe(false)
    expect(verifyAgentSignature({ ...base, publicKeyBase64: "not base64 !!" })).toBe(false)
    expect(verifyAgentSignature({ ...base, signatureBase64: "AAAA" })).toBe(false)
    // A 31-byte key: decodes fine, wrong length.
    expect(
      verifyAgentSignature({
        ...base,
        publicKeyBase64: Buffer.alloc(31).toString("base64"),
      }),
    ).toBe(false)
  })
})
