/**
 * The split key derivation.
 *
 * The obvious design — send the password to Better Auth and also use it to
 * unlock the vault — quietly destroys zero-knowledge: the server sees the
 * password at every sign-in, and therefore could derive the vault key.
 *
 * So the password is stretched once in the browser and then split into three
 * independent branches:
 *
 *     master     = Argon2id(password, salt)
 *     authToken  = HKDF(master, "weirdvault/auth/v1")   → sent to the server
 *     vaultKey   = HKDF(master, "weirdvault/vault/v1")  → NEVER leaves the device
 *     auditKey   = HKDF(master, "weirdvault/audit/v1")  → NEVER leaves the device
 *
 * HKDF is one-way and the branches are domain-separated, so possession of
 * authToken says nothing about vaultKey. The server stores only a hash of
 * authToken. One password for the user; nothing decryptable for us.
 *
 * The audit branch is the youngest of the three and does a narrower job: it is
 * an HMAC key that blinds hostnames before an audit row is written, so the
 * activity log can say "this host" without the server ever learning which host
 * that is. It is a separate branch rather than a reuse of vaultKey because the
 * two are used under different algorithms, and one key doing double duty across
 * AES-GCM and HMAC is the kind of shortcut that turns into a paper.
 *
 * This must be settled before any auth code ships: changing it later means
 * re-deriving and re-encrypting every user's vault.
 *
 * ---------------------------------------------------------------------------
 * The raw-bytes escape hatch, and why it is here
 *
 * deriveSecrets imports the vault and audit branches as non-extractable
 * CryptoKeys on purpose: once derived, not even this module can read them back,
 * only hand them to encrypt/decrypt/sign. That is the right default and every
 * caller in the app uses it.
 *
 * Recovery codes cannot. A recovery code works by *wrapping* the key material
 * under a key derived from the code, which means the material has to exist as
 * bytes for the instant it takes to encrypt it — and on redemption it comes back
 * as bytes with no password anywhere in sight. So there are exactly two extra
 * exports:
 *
 *   withRawSecretBytes_DANGEROUS — derives the same three branches and hands the
 *     raw bytes to a callback, zeroing them in a finally. Only lib/vault/
 *     recovery.ts calls it, only at enrolment.
 *   importRawSecretBytes — the inverse, for redemption: bytes in, the same
 *     non-extractable CryptoKeys out. It never sees a password.
 *
 * Nothing else may use either one. A caller that only needs to encrypt, decrypt
 * or sign already has deriveSecrets, and reaching for raw bytes instead would
 * put a readable copy of the vault key into JS memory for no gain — the exact
 * property the non-extractable import exists to deny.
 *
 * Neither export changes the derivation. The Argon2 parameters, the salt
 * construction and the three info strings below are load-bearing for every
 * vault already written: altering any of them would strand them all. The raw
 * path deliberately runs through the *same* private deriveBranches as
 * deriveSecrets, so the two cannot drift.
 */

import { argon2id } from "hash-wasm"

/** OWASP-recommended Argon2id parameters, tuned to stay tolerable on mobile. */
export const ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65536, // 64 MiB
  hashLength: 32,
} as const

const AUTH_INFO = "weirdvault/auth/v1"
const VAULT_INFO = "weirdvault/vault/v1"
const AUDIT_INFO = "weirdvault/audit/v1"

const enc = new TextEncoder()

/**
 * Per-user salt.
 *
 * Deterministic from the email so a brand new device can derive the same key
 * with nothing but the password — no server round trip before unlock. The
 * cost is that the salt is not random, which weakens cross-user rainbow-table
 * resistance; Argon2id's memory hardness is what carries that load. (Bitwarden
 * uses the same construction.)
 *
 * Upgrade path: have the server issue a random per-user salt from a pre-login
 * endpoint that returns an indistinguishable HMAC-derived value for unknown
 * emails, so it cannot be used as an account-existence oracle.
 */
async function saltFor(email: string): Promise<Uint8Array> {
  const material = enc.encode(`weirdvault/salt/v1:${email.trim().toLowerCase()}`)
  return new Uint8Array(await crypto.subtle.digest("SHA-256", material))
}

async function hkdf(master: Uint8Array, info: string, bytes = 32): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", master as BufferSource, "HKDF", false, [
    "deriveBits",
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32), // master is already high-entropy
      info: enc.encode(info),
    },
    key,
    bytes * 8,
  )
  return new Uint8Array(bits)
}

export interface DerivedSecrets {
  /** Sent to the server in place of a password. Useless for decryption. */
  authToken: string
  /** Stays on the device. Unwraps everything in the vault. */
  vaultKey: CryptoKey
  /**
   * Blinds hostnames before they reach the audit log. Stays on the device.
   *
   * An audit table with a plaintext hostname column, indexed by user and time,
   * rebuilds in the clear exactly the infrastructure map the vault exists to
   * hide — and does it durably and queryably, which is worse than the relay's
   * transient view of the same fact. HMAC under this key gives the server a
   * stable opaque handle it can group a timeline by, and nothing more.
   */
  auditKey: CryptoKey
}

/**
 * The one place the password becomes bytes. Everything else builds on this.
 *
 * Branches are domain-separated by the info string, so adding one leaves the
 * existing ones byte-identical — no vault re-encryption, no migration.
 */
async function deriveBranches(email: string, password: string): Promise<RawSecretBytes> {
  const salt = await saltFor(email)

  const master = await argon2id({
    password,
    salt,
    ...ARGON2_PARAMS,
    outputType: "binary",
  })

  const [authToken, vaultKey, auditKey] = await Promise.all([
    hkdf(master, AUTH_INFO),
    hkdf(master, VAULT_INFO),
    hkdf(master, AUDIT_INFO),
  ])

  master.fill(0)
  return { authToken, vaultKey, auditKey }
}

export async function deriveSecrets(email: string, password: string): Promise<DerivedSecrets> {
  const raw = await deriveBranches(email, password)
  try {
    return await importRawSecretBytes(raw)
  } finally {
    // Wipe what we can. JS gives no guarantees here, but leaving copies around
    // deliberately would be worse.
    zeroRawSecretBytes(raw)
  }
}

/* ------------------------------------------------------- the raw branches --- */

/**
 * The three HKDF branches as bytes, before any of them becomes a CryptoKey.
 *
 * Read the file header before touching this. A value of this type is a readable
 * copy of the vault key; it exists only inside the recovery-code enrolment and
 * redemption paths, and only for as long as it takes to wrap or unwrap it.
 *
 * `authToken` is the pre-base64 form of DerivedSecrets.authToken — the same 32
 * bytes, so importRawSecretBytes reproduces the string exactly.
 */
export interface RawSecretBytes {
  authToken: Uint8Array
  vaultKey: Uint8Array
  auditKey: Uint8Array
}

export const SECRET_BRANCH_BYTES = 32

/** Best-effort erasure of a raw branch set. Call it; JS will not do it for you. */
export function zeroRawSecretBytes(raw: RawSecretBytes): void {
  raw.authToken.fill(0)
  raw.vaultKey.fill(0)
  raw.auditKey.fill(0)
}

/**
 * Derives the branches and hands the *raw bytes* to `consume`.
 *
 * Named to be alarming because it is: for the duration of the callback there is
 * a readable copy of the vault key in JS memory, which is precisely what the
 * non-extractable import in importRawSecretBytes exists to prevent. It is
 * justified in exactly one place — wrapping the key material under a recovery
 * code, which cannot be done through a non-extractable handle — and nowhere
 * else. The callback shape is not decoration: it is what makes the zeroing
 * unconditional, including when `consume` throws.
 *
 * The bytes are dead the moment this returns. Anything the caller wants to keep
 * must be copied or, better, turned into CryptoKeys by importRawSecretBytes.
 */
export async function withRawSecretBytes_DANGEROUS<T>(
  email: string,
  password: string,
  consume: (raw: RawSecretBytes) => Promise<T>,
): Promise<T> {
  const raw = await deriveBranches(email, password)
  try {
    return await consume(raw)
  } finally {
    zeroRawSecretBytes(raw)
  }
}

/**
 * Bytes back to keys, with no password involved.
 *
 * Used by deriveSecrets on the normal path and by recovery redemption on the
 * abnormal one, where the bytes came out of an envelope rather than out of
 * Argon2id. Both end up with the same non-extractable handles, so nothing
 * downstream can tell — or needs to tell — how the session was unlocked.
 *
 * The input is *not* zeroed here: withRawSecretBytes_DANGEROUS owns that on the
 * enrolment path, and the redemption path zeroes its own buffer. Doing it in
 * both places would leave one of them silently operating on cleared bytes.
 */
export async function importRawSecretBytes(raw: RawSecretBytes): Promise<DerivedSecrets> {
  // Non-extractable: once derived, these cannot be read back out, only used.
  // Same principle as the SSH keys.
  const vaultKey = await crypto.subtle.importKey(
    "raw",
    raw.vaultKey as BufferSource,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  )
  const auditKey = await crypto.subtle.importKey(
    "raw",
    raw.auditKey as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )

  return { authToken: b64(raw.authToken), vaultKey, auditKey }
}

function b64(b: Uint8Array): string {
  let s = ""
  for (const byte of b) s += String.fromCharCode(byte)
  return btoa(s)
}
