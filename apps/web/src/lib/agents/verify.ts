import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto"

/**
 * Proving an agent is the machine it claims to be.
 *
 * The relay cannot do this itself: it holds no public keys and no database, and
 * giving the internet-facing process the material to authenticate agents would
 * put an agent-impersonation credential on the most exposed component to save a
 * round trip that happens once per agent per reconnect. So it asks here.
 */

/**
 * The bytes an agent signs.
 *
 * Domain-separated and structured, rather than a bare nonce. A signature over
 * unstructured random bytes is a signature over *anything* of that length, which
 * is how a key issued for one purpose ends up validating in another; the prefix
 * means an Ed25519 signature produced here can never be replayed as a signature
 * for some other protocol that also signs 32 random bytes. The agent id is
 * inside it so a nonce captured from one agent's handshake cannot be replayed
 * into another agent's.
 *
 * Must stay byte-identical to signingMessage in apps/agent/main.go. There is a
 * test below that pins it against a fixture the Go implementation produced.
 */
export function verifyingMessage(agentId: string, nonce: string): Buffer {
  return Buffer.from(`weirdvault-agent-v1\n${agentId}\n${nonce}`, "utf8")
}

/**
 * DER prefix for an Ed25519 SubjectPublicKeyInfo.
 *
 * Node will not take a bare 32-byte public key; it wants SPKI. For Ed25519 the
 * encoding is entirely fixed — algorithm identifier 1.3.101.112 and a 32-byte
 * bit string — so the whole structure is this constant followed by the key.
 * Building it by hand avoids a dependency for twelve bytes that cannot vary.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

const ED25519_PUBLIC_KEY_BYTES = 32
const ED25519_SIGNATURE_BYTES = 64

/**
 * The fingerprint shown to the user, in the format SSH uses for host keys.
 *
 * Same format because it appears beside one, and because the whole point of a
 * fingerprint is that a person compares two renderings of it — one on screen,
 * one from `weirdvault-agent status` on the machine in front of them. Two formats
 * for one idea is one too many.
 *
 * Must match `fingerprint` in apps/agent/main.go.
 */
export function fingerprintFor(publicKeyBase64: string): string {
  const raw = Buffer.from(publicKeyBase64, "base64")
  return `SHA256:${createHash("sha256").update(raw).digest("base64").replace(/=+$/, "")}`
}

/**
 * Whether this signature was made by the holder of this public key.
 *
 * Returns false rather than throwing on malformed input. Every caller's next
 * move is the same — refuse the agent — and a thrown error on a bad base64 blob
 * would turn a routine rejection into a 500, which is both noisier and a way to
 * tell malformed from merely wrong by watching status codes.
 */
export function verifyAgentSignature(args: {
  publicKeyBase64: string
  agentId: string
  nonce: string
  signatureBase64: string
}): boolean {
  try {
    const publicKey = Buffer.from(args.publicKeyBase64, "base64")
    const signature = Buffer.from(args.signatureBase64, "base64")

    // Checked explicitly because base64 decoding is forgiving: a truncated or
    // padded blob decodes to the wrong length rather than failing, and handing
    // that to createPublicKey produces an exception several frames away from
    // the actual problem.
    if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES) return false
    if (signature.length !== ED25519_SIGNATURE_BYTES) return false

    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
      format: "der",
      type: "spki",
    })

    // Ed25519 signs the message directly; the algorithm argument must be null.
    return cryptoVerify(null, verifyingMessage(args.agentId, args.nonce), key, signature)
  } catch {
    return false
  }
}
