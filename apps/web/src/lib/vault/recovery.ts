"use client"

/**
 * Recovery codes.
 *
 * The problem this solves is the one the whole design creates. The vault key is
 * derived from the password and nothing else, so forgetting the password means
 * the ciphertext is unopenable — by the user and by us, permanently. Every
 * conventional answer to that (a reset email, a support override, an escrowed
 * key) requires the server to hold something that can open the vault, which
 * would quietly end the zero-knowledge claim the rest of this codebase is built
 * to keep.
 *
 * So the escrow is moved to the user. At enrolment the password is stretched
 * once more, and the three derived branches are written into a small fixed-size
 * payload which is then encrypted ten times over, each time under a key derived
 * from a freshly generated, high-entropy code:
 *
 *     code        = 120 random bits, shown once, never transmitted
 *     wrappingKey = Argon2id(code, per-envelope random salt)
 *     envelope    = { id: H(code), salt, iv, AES-GCM(wrappingKey, payload) }
 *
 * The server stores the ten envelopes. It has no code, so it has nothing; the
 * blob is as opaque to it as the vault itself.
 *
 * ---------------------------------------------------------------------------
 * What a code actually is, stated plainly
 *
 * A recovery code is password-equivalent, and stronger than a password in the
 * one way that matters to an attacker: it is not guessable, but it is also not
 * memorised, so it exists as text somewhere. The payload carries the auth token
 * *and* the vault key, which means a code both signs in and decrypts, subject to
 * any second factor on the account. That is the point — a recovery route that
 * only signed you in would hand you an account full of ciphertext you still
 * could not read — and it is the risk. A code in a screenshot in a chat log is a
 * full account compromise. The UI says this in those words rather than burying
 * it here.
 *
 * Second-order consequences, none of them hidden:
 *
 *  - The envelopes freeze the *current* secrets. Changing the password
 *    re-derives all three branches, so every stored envelope becomes a wrapping
 *    of dead material. lib/vault/rekey.ts therefore deletes the recovery blob as
 *    part of a password change and tells the user to enrol again. Codes that
 *    silently stopped working would be worse than no codes at all.
 *  - The server learns H(code) when a code is redeemed, because that is how the
 *    right envelope is found and consumed. H is one-way; the code itself never
 *    goes over the wire in either direction.
 *  - Consumption is at-most-once and happens when the envelope is handed out,
 *    not when the client confirms success. A code that is fetched and then not
 *    used is spent. That is the safe direction to be wrong in, and only someone
 *    already holding a valid code can spend one.
 *  - A code does not bypass a second factor. Redemption decrypts locally and
 *    then signs in through /sign-in/email with the recovered auth token, so an
 *    account with an authenticator enrolled is challenged on this path like any
 *    other — and the /recover page has no field to answer with. The sign-in is
 *    refused in words at signInWithRecoveredToken in lib/auth-client.ts, and the
 *    code is spent regardless, because the previous bullet consumes it before
 *    the sign-in is ever attempted. So on such an account a code decrypts and
 *    does not admit: it is strictly weaker than the password, which the
 *    sign-in form *can* pair with a second factor. The two-factor card in
 *    Settings warns about this before enrolment rather than after; the durable
 *    fix is a second-factor step on /recover, which nothing here has built.
 *
 * ---------------------------------------------------------------------------
 * Why the code KDF is cheaper than the password KDF
 *
 * ARGON2_PARAMS in kdf.ts is sized for a human-chosen password, where the KDF is
 * standing in for entropy the input does not have. A recovery code has 120 bits
 * of it from crypto.getRandomValues, so no amount of stretching is what makes it
 * unguessable — the entropy already did that, by a margin no hardware closes.
 * Argon2id is still used, at OWASP's lighter recommended point, so that a leaked
 * envelope table is not merely 2^120 work but 2^120 work at 19 MiB a guess. The
 * saving is real and visible: enrolment runs this ten times in a row, and at the
 * password parameters that is ten seconds of blocked UI on a laptop and rather
 * more on a phone.
 */

import { argon2id } from "hash-wasm"

import {
  importRawSecretBytes,
  SECRET_BRANCH_BYTES,
  zeroRawSecretBytes,
  withRawSecretBytes_DANGEROUS,
  type DerivedSecrets,
  type RawSecretBytes,
} from "./kdf"
import { fromB64, toB64 } from "./crypto"
import { getVaultKey } from "./session"

/* --------------------------------------------------------------- constants */

/** Ten is enough to survive losing a few and small enough to print on a card. */
export const RECOVERY_CODE_COUNT = 10

/** 15 bytes divides evenly into base32: 120 bits, 24 characters, no padding. */
const CODE_BYTES = 15
const CODE_CHARS = 24
const CODE_GROUP = 4

/**
 * Crockford's base32 alphabet: no I, L, O or U, so a code read off a screen and
 * typed on a phone cannot be lost to 1/I or 0/O. normalise() maps the confusable
 * pairs back rather than rejecting them.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

const RECOVERY_ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 2,
  memorySize: 19456, // 19 MiB — OWASP's second recommended point
  hashLength: 32,
} as const

const SALT_BYTES = 16
const IV_BYTES = 12

/**
 * The wrapped payload, fixed length on purpose.
 *
 * version ‖ vaultKey ‖ auditKey ‖ authToken, all raw. Fixed length means every
 * ciphertext this app produces is exactly PAYLOAD_BYTES + 16, which is what lets
 * the server answer an unknown email with a decoy envelope of the right size.
 * A variable-length payload would make the decoy detectable by inspection and
 * turn the redeem endpoint back into an account-existence oracle.
 */
const PAYLOAD_VERSION = 1
const PAYLOAD_BYTES = 1 + SECRET_BRANCH_BYTES * 3
/**
 * 113 bytes. The route validates against its own copy of this number rather
 * than importing it: this module carries "use client", and a Route Handler that
 * imported it would get a client reference instead of a constant — and would
 * drag hash-wasm into the server bundle on the way. The duplication is noted at
 * both ends.
 */
const CIPHERTEXT_BYTES = PAYLOAD_BYTES + 16

const ID_INFO = "weirdvault/recovery/id/v1:"
/** 16 bytes of SHA-256 is 128 bits of selector — collisions are not a concern. */
const ID_BYTES = 16

/* ------------------------------------------------------------- wire shapes */

/** One envelope per unused code, as stored in recovery_blob.envelopes. */
export interface RecoveryEnvelope {
  /** SHA-256 of the code, truncated and hex-encoded. Selects, never opens. */
  id: string
  salt: string // base64
  iv: string // base64
  ciphertext: string // base64
}

/** What the settings page shows about an enrolled set. No code material in it. */
export interface RecoveryStatus {
  enrolled: boolean
  remaining: number
  createdAt: string | null
  lastUsedAt: string | null
}

/**
 * The only failure the redeem path reports, deliberately.
 *
 * An unknown email, a mistyped code and a code that has already been used are
 * three different facts on the server and one message here, because telling them
 * apart is exactly the oracle the endpoint is built to deny. The server answers
 * all three with a well-formed envelope that does not decrypt; this is what that
 * looks like from the inside.
 */
export class RecoveryCodeError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "That email and recovery code do not open anything. Check the code for typos, and remember each code works only once.",
      options,
    )
    this.name = "RecoveryCodeError"
  }
}

/**
 * The typed password is not the one this account is unlocked with.
 *
 * Its own class because the alternative is unthinkable in the specific way this
 * feature is meant to prevent. Argon2id accepts any string, so a mistyped or
 * stale password produces a perfectly well-formed set of envelopes sealing key
 * material that opens nothing. Nothing downstream would notice: the server is
 * authorised by the session cookie and validates only shape, the badge reads
 * "10 of 10 unused", and the failure surfaces months later at /recover as a
 * sign-in that does not work — which reads exactly like a mistyped code, so the
 * user works through the card and burns all ten. The feature whose entire job is
 * to be correct when nothing else is would have quietly guaranteed the outcome
 * it exists to prevent.
 */
export class RecoveryPasswordError extends Error {
  constructor() {
    super(
      "That is not the password this vault is unlocked with, so the codes it produced would open nothing. No codes were generated and nothing was stored.",
    )
    this.name = "RecoveryPasswordError"
  }
}

/** The vault is locked in this tab, so there is nothing to check against. */
export class RecoveryLockedError extends Error {
  constructor() {
    super(
      "The vault is locked in this tab, so the password you typed cannot be checked against it. Unlock the vault first — enrolling without that check could seal keys that open nothing.",
    )
    this.name = "RecoveryLockedError"
  }
}

/* ------------------------------------------------------------ code formats */

/** Groups a bare 24-character code for display: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX. */
export function formatRecoveryCode(bare: string): string {
  return (bare.match(new RegExp(`.{1,${CODE_GROUP}}`, "g")) ?? []).join("-")
}

/**
 * Anything a person might paste, reduced to the 24 characters that were
 * generated. Case, dashes and spaces carry no information, and the four
 * confusable letters are folded onto the digits they are mistaken for.
 */
export function normaliseRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/[O]/g, "0")
    .replace(/[^0-9A-Z]/g, "")
    .split("")
    .filter((c) => ALPHABET.includes(c))
    .join("")
}

export function isPlausibleRecoveryCode(input: string): boolean {
  return normaliseRecoveryCode(input).length === CODE_CHARS
}

/** 15 random bytes, base32-encoded five bits at a time. */
function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_BYTES))
  let bits = 0
  let acc = 0
  let out = ""
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(acc >> bits) & 31]
    }
  }
  bytes.fill(0)
  return out
}

/**
 * The envelope selector.
 *
 * Sent to the server on redemption so it can find and consume the right
 * envelope without ever seeing the code. SHA-256 is unsalted here on purpose:
 * the id has to be computable from the code alone, before any server round trip,
 * and a 120-bit preimage is not worth salting against.
 */
export async function recoveryCodeId(code: string): Promise<string> {
  const material = new TextEncoder().encode(ID_INFO + normaliseRecoveryCode(code))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material))
  return [...digest.slice(0, ID_BYTES)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function wrappingKeyFor(code: string, salt: Uint8Array): Promise<CryptoKey> {
  const bytes = await argon2id({
    password: normaliseRecoveryCode(code),
    salt,
    ...RECOVERY_ARGON2_PARAMS,
    outputType: "binary",
  })
  try {
    return await crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ])
  } finally {
    bytes.fill(0)
  }
}

/* ---------------------------------------------------------------- payloads */

function packPayload(raw: RawSecretBytes): Uint8Array {
  const out = new Uint8Array(PAYLOAD_BYTES)
  out[0] = PAYLOAD_VERSION
  out.set(raw.vaultKey, 1)
  out.set(raw.auditKey, 1 + SECRET_BRANCH_BYTES)
  out.set(raw.authToken, 1 + SECRET_BRANCH_BYTES * 2)
  return out
}

function unpackPayload(payload: Uint8Array): RawSecretBytes {
  if (payload.length !== PAYLOAD_BYTES || payload[0] !== PAYLOAD_VERSION) {
    // A payload that decrypted but does not parse means the envelope was written
    // by a build with a different format. Nothing here can do anything with it,
    // and treating it as a wrong code is the honest simplification: either way
    // this code does not open this account on this build.
    throw new RecoveryCodeError()
  }
  return {
    vaultKey: payload.slice(1, 1 + SECRET_BRANCH_BYTES),
    auditKey: payload.slice(1 + SECRET_BRANCH_BYTES, 1 + SECRET_BRANCH_BYTES * 2),
    authToken: payload.slice(1 + SECRET_BRANCH_BYTES * 2),
  }
}

/* -------------------------------------------------------------- enrolment */

/** Sixteen bytes of nothing in particular; only whether it round-trips matters. */
const PROBE = new TextEncoder().encode("weirdvault/probe/1")

/**
 * Proves that the derived vault key is the one this session is unlocked with,
 * before a single envelope is sealed.
 *
 * The check is a round trip rather than a comparison, because there is nothing
 * to compare: the session's vault key is a non-extractable CryptoKey whose bytes
 * this module cannot read, which is the whole point of it. So a scrap is
 * encrypted under the session's key and decrypted under the derived one. AES-GCM
 * authenticates, so success means the two keys are the same key and failure
 * means the password was wrong — there is no third answer and no false positive.
 *
 * Two reasons this beats testing the derived key against the stored vault blob,
 * which was the obvious alternative. It needs no network, so a flaky connection
 * cannot be mistaken for a wrong password. And it works on an account that has
 * never pushed a vault, where there is no ciphertext to test against at all —
 * which is exactly the fresh account most likely to be enrolling codes.
 */
async function assertPasswordMatchesSession(raw: RawSecretBytes): Promise<void> {
  const sessionKey = getVaultKey()
  if (!sessionKey) throw new RecoveryLockedError()

  const derived = await importRawSecretBytes(raw)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    sessionKey,
    PROBE as BufferSource,
  )

  try {
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, derived.vaultKey, sealed)
  } catch {
    throw new RecoveryPasswordError()
  }
}

export interface EnrolmentProgress {
  /** Envelopes sealed so far, out of RECOVERY_CODE_COUNT. */
  done: number
  total: number
}

/**
 * Generates a set of codes, seals the current secrets under each, and stores the
 * envelopes. Returns the codes — the only time they exist anywhere.
 *
 * The password is re-entered by the user rather than taken from the unlocked
 * session because the session holds non-extractable CryptoKeys, which cannot be
 * wrapped. That constraint is load-bearing rather than annoying: it means the
 * only way to produce an envelope is to prove the password again.
 *
 * Any previously enrolled set is replaced wholesale by the server. There is no
 * merge to do — old codes wrap the same material, but leaving them alongside a
 * fresh set would mean "regenerate my codes" quietly failed to retire the ones
 * the user thinks they just replaced.
 *
 * The password is verified against the unlocked session before anything is
 * sealed. See assertPasswordMatchesSession for why an unverified enrolment is
 * the worst failure this file can produce.
 */
export async function enrolRecoveryCodes(
  email: string,
  password: string,
  onProgress?: (p: EnrolmentProgress) => void,
): Promise<string[]> {
  const codes: string[] = []
  const envelopes: RecoveryEnvelope[] = []

  await withRawSecretBytes_DANGEROUS(email, password, async (raw) => {
    // First, before any work and before any code exists. Ten Argon2id runs and
    // ten envelopes built on the wrong branches would still have to be thrown
    // away, and a partially-shown set of codes is worse than none.
    await assertPasswordMatchesSession(raw)

    const payload = packPayload(raw)
    try {
      for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
        const code = newCode()
        const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
        const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
        const key = await wrappingKeyFor(code, salt)
        const ciphertext = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          key,
          payload as BufferSource,
        )
        // The decoy the server serves for an unknown email is this many bytes.
        // If that ever stops matching, the redeem endpoint becomes an
        // account-existence oracle by measurement, so it is checked here rather
        // than assumed.
        if (ciphertext.byteLength !== CIPHERTEXT_BYTES) {
          throw new Error(
            `recovery envelope is ${ciphertext.byteLength} bytes, expected ${CIPHERTEXT_BYTES}`,
          )
        }

        codes.push(code)
        envelopes.push({
          id: await recoveryCodeId(code),
          salt: toB64(salt),
          iv: toB64(iv),
          ciphertext: toB64(new Uint8Array(ciphertext)),
        })
        onProgress?.({ done: i + 1, total: RECOVERY_CODE_COUNT })
      }
    } finally {
      payload.fill(0)
    }
  })

  const res = await fetch("/api/recovery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "enrol", envelopes }),
  })
  if (!res.ok) {
    // The codes are worthless if the envelopes did not land, so this must throw
    // rather than hand back a list the user might write down.
    throw new Error(await errorTextOf(res, "Recovery codes could not be stored"))
  }

  return codes
}

/* ------------------------------------------------------------- redemption */

/**
 * Turns an email and a code back into a full set of secrets.
 *
 * Note what does not happen: the code is not sent. Only its hash goes up, and
 * the envelope comes back for the browser to open. A server that wanted the
 * vault key would have to guess 120 bits.
 *
 * The caller is then holding the auth token as well, which is what makes the
 * sign-in on the /recover page possible without a password — up to the account's
 * second factor, which this token does not answer for. See the consequences list
 * in the file header and the refusal in signInWithRecoveredToken.
 */
export async function redeemRecoveryCode(email: string, code: string): Promise<DerivedSecrets> {
  const codeId = await recoveryCodeId(code)

  const res = await fetch("/api/recovery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "redeem", email: email.trim().toLowerCase(), codeId }),
  })
  if (res.status === 429) {
    throw new Error(
      "Too many recovery attempts from this address. Wait a few minutes and try again.",
    )
  }
  if (!res.ok) throw new Error(await errorTextOf(res, "Recovery is unavailable"))

  const { envelope } = (await res.json()) as { envelope: RecoveryEnvelope }

  const key = await wrappingKeyFor(code, fromB64(envelope.salt))

  let payload: Uint8Array
  try {
    payload = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64(envelope.iv) as BufferSource },
        key,
        fromB64(envelope.ciphertext) as BufferSource,
      ),
    )
  } catch (cause) {
    // The expected failure, and the only one the user is told about: this is
    // both "wrong code" and "no such account", indistinguishably.
    throw new RecoveryCodeError({ cause })
  }

  const raw = unpackPayload(payload)
  try {
    return await importRawSecretBytes(raw)
  } finally {
    zeroRawSecretBytes(raw)
    payload.fill(0)
  }
}

/* ----------------------------------------------------------------- status */

export async function getRecoveryStatus(): Promise<RecoveryStatus> {
  const res = await fetch("/api/recovery", { cache: "no-store" })
  if (res.status === 401) throw new Error("Session expired. Sign in again.")
  if (!res.ok) throw new Error(await errorTextOf(res, "Could not read recovery status"))
  return (await res.json()) as RecoveryStatus
}

/** Removes every envelope. Irreversible without a fresh enrolment. */
export async function disableRecoveryCodes(): Promise<void> {
  const res = await fetch("/api/recovery", { method: "DELETE" })
  if (!res.ok) throw new Error(await errorTextOf(res, "Recovery codes were not removed"))
}

async function errorTextOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error ? `${fallback}: ${body.error}` : `${fallback} (${res.status})`
  } catch {
    return `${fallback} (${res.status})`
  }
}
