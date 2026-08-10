"use client"

/**
 * SSH key custody.
 *
 * Two modes, chosen per key (PLAN.md §3.6, THREAT-MODEL.md §4):
 *
 *  - device-bound: generated non-extractable, never leaves this browser.
 *    Strongest, but a new device needs its own key added to the server.
 *
 *  - portable (default): generated extractable, wrapped with the vault key
 *    within about a millisecond, then re-imported non-extractable. The wrapped
 *    copy syncs, so signing in on a new device Just Works. The server only ever
 *    holds ciphertext.
 *
 * In both modes the private key is non-extractable *in use* — our code, an
 * injected script, and a browser extension are all equally unable to read it.
 */

import { idbDelete, idbGet, idbGetAll, idbPut } from "./idb"
import { importKey as wasmImportKey } from "./ssh/wasm"
import type { ImportedKey, SshKeyType } from "./ssh/types"
import { recordDeletion } from "./vault/tombstones"

export type KeyMode = "portable" | "device-bound"

export interface StoredKey {
  id: string
  label: string
  mode: KeyMode
  /** Raw 32-byte Ed25519 public key. */
  publicKeyRaw: ArrayBuffer
  /** Present only for portable keys: PKCS#8 encrypted with the vault key. */
  wrapped?: { iv: ArrayBuffer; ciphertext: ArrayBuffer }
  /** Present only for device-bound keys: the CryptoKey handle itself. */
  privateKey?: CryptoKey
  createdAt: number
}

export interface SshKey {
  id: string
  label: string
  mode: KeyMode
  publicKeyRaw: Uint8Array
  privateKey: CryptoKey
  createdAt: number
}

const STORE = "keys"

/* ------------------------------------------------------------- pkcs8 --- */

/**
 * The two things done with plaintext PKCS#8, in one place.
 *
 * Generation and import arrive at the same fork: either the bytes are wrapped
 * with the vault key so the key can travel, or they are not and the key stays
 * on this machine. Both then re-import non-extractably and throw the bytes
 * away. Keeping that in one function means there is exactly one piece of code
 * to check when the question is "can anything read this key afterwards".
 */
async function importPrivate(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, "Ed25519", false, ["sign"])
}

async function wrapWithVault(
  pkcs8: Uint8Array,
  vaultKey: CryptoKey,
): Promise<{ iv: ArrayBuffer; ciphertext: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    vaultKey,
    pkcs8 as BufferSource,
  )
  return { iv: iv.buffer as ArrayBuffer, ciphertext }
}

/* ------------------------------------------------------------ generation */

export async function generateKey(
  label = "weirdvault",
  mode: KeyMode = "portable",
  vaultKey?: CryptoKey,
): Promise<SshKey> {
  if (mode === "portable" && !vaultKey) {
    throw new Error(
      "A portable key needs the vault unlocked so it can be wrapped. " +
        "Sign in first, or create a device-bound key.",
    )
  }

  // Portable keys must be exportable for the instant it takes to wrap them.
  const extractable = mode === "portable"
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, extractable, [
    "sign",
    "verify",
  ])) as CryptoKeyPair

  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))

  const record: StoredKey = {
    id: crypto.randomUUID(),
    label,
    mode,
    publicKeyRaw: publicKeyRaw.buffer as ArrayBuffer,
    createdAt: Date.now(),
  }

  let privateKey = pair.privateKey

  if (mode === "portable") {
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
    record.wrapped = await wrapWithVault(pkcs8, vaultKey!)

    // Re-import non-extractable and drop the exportable handle, so from here on
    // this key behaves exactly like a device-bound one.
    privateKey = await importPrivate(pkcs8)
    pkcs8.fill(0)
  } else {
    record.privateKey = pair.privateKey
  }

  await idbPut(STORE, record.id, record)
  return { ...record, publicKeyRaw, privateKey } as SshKey
}

/* ------------------------------------------------------------------ import */

/**
 * Importing a key you already have.
 *
 * Generation never lets private key material exist as bytes we can see.
 * Importing cannot make that promise: the file is pasted or read from disk, so
 * it passes through this page in plaintext by definition. What is on offer is
 * narrower and worth stating plainly in the UI — the plaintext window is one
 * function call wide, after which the browser holds a non-extractable handle
 * and (for a portable key) ciphertext only.
 *
 * Two caveats we do not solve, and should not imply we do:
 *
 *  - `pkcs8.fill(0)` clears the JS copy. The Go side made its own copy on the
 *    WASM heap, and that one lives until Go's collector gets to it; nothing on
 *    this side can reach in and zero it.
 *  - a key generated here has never been readable by anything. A key imported
 *    here was a file on some machine, possibly for years, possibly backed up.
 *    Non-extractable custody from now on is a real improvement and not a
 *    retroactive one.
 */

/**
 * Which imported key types can actually be used to connect.
 *
 * The SSH core parses Ed25519, RSA and ECDSA P-256 (keyparse.go) and its signer
 * can build a public key for all three (signer.go). The narrowing happens
 * further up, in lib/ssh/connect.ts, which passes `keyType: "ed25519"` for every
 * key it is given — hand it an ECDSA key and the handshake fails with a length
 * error rather than working. Storage is Ed25519-only too: hydrate() re-imports
 * every wrapped key as Ed25519, and the vault's SyncedKey carries no key type,
 * so a portable RSA key would arrive on a second device unusable and silent.
 *
 * So the honest set today is one entry. Accepting the other two would mean
 * importing keys that fail at authentication, which is the failure this file
 * exists to avoid. Widening it means, in order: a key type on StoredKey and
 * SyncedKey, an algorithm-aware makeSigner and authorizedKeysLine, and
 * connect.ts passing the key's real type.
 */
export const CONNECTABLE_KEY_TYPES: readonly SshKeyType[] = ["ed25519"]

/** Thrown when the key is encrypted, so the UI can ask for the passphrase. */
export class KeyPassphraseError extends Error {
  constructor(readonly reason: "missing" | "wrong") {
    super(
      reason === "missing"
        ? "This key is encrypted. Enter its passphrase to continue."
        : "That passphrase does not open this key.",
    )
    this.name = "KeyPassphraseError"
  }
}

/** Everything else, carrying a message meant to be shown as-is. */
export class KeyImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KeyImportError"
  }
}

/** What the review step shows before anything is stored. */
export interface KeyPreview {
  keyType: SshKeyType
  bits: number
  fingerprint: string
  /** The key's own comment, when the core reports one. Usually it does not. */
  comment?: string
}

/**
 * Obvious wrong pastes, answered before spending 6 MB of WASM on them.
 *
 * These are the three mistakes people actually make, and a specific answer to
 * each is worth more than the parser's "ssh: no key found".
 */
function precheck(text: string): void {
  if (!text) {
    throw new KeyImportError("Nothing to import — paste a private key or choose a file.")
  }
  if (/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-)\S*\s+AAAA/.test(text)) {
    throw new KeyImportError(
      "That is a public key — the one ending in .pub. Import the private half instead, " +
        "the file with the same name and no extension.",
    )
  }
  if (text.startsWith("PuTTY-User-Key-File")) {
    throw new KeyImportError(
      "PuTTY .ppk files are not PEM. In PuTTYgen, load the key and use " +
        "Conversions → Export OpenSSH key, then import that file.",
    )
  }
  if (!text.includes("-----BEGIN")) {
    throw new KeyImportError(
      "This does not look like a private key. An OpenSSH key file starts with " +
        "-----BEGIN OPENSSH PRIVATE KEY-----.",
    )
  }
}

/**
 * Turns a rejection from the Go importer into something worth reading.
 *
 * Most of keyparse.go's messages are already written for a person and are
 * passed through unchanged. The exceptions are the ones that leak Go type
 * names, and the two passphrase cases, which are a question rather than a
 * failure.
 */
function translate(error: unknown): Error {
  const message = String((error as Error)?.message ?? error)

  if (/passphrase is required/i.test(message)) return new KeyPassphraseError("missing")
  if (/wrong passphrase|password incorrect/i.test(message)) {
    return new KeyPassphraseError("wrong")
  }
  if (/not an encrypted key/i.test(message)) {
    return new KeyImportError("This key is not encrypted — leave the passphrase blank.")
  }
  // The word boundary is doing real work: "*ecdsa.PrivateKey" contains
  // "dsa.PrivateKey" as a substring, and answering an ECDSA key with advice
  // about DSA would be worse than the raw Go type name.
  if (/\bdsa\.PrivateKey/.test(message)) {
    return new KeyImportError(
      "OpenSSH DSA keys cannot be used from a browser; generate an Ed25519 key instead.",
    )
  }
  if (/unhandled key type/i.test(message)) {
    return new KeyImportError(
      "The SSH core does not handle this key type. Security-key backed keys " +
        "(sk-ssh-ed25519, sk-ecdsa-sha2-nistp256) sign on the hardware token itself, " +
        "which a web page cannot drive over the relay.",
    )
  }
  return new KeyImportError(message)
}

/** Why this parsed key still cannot be used here, or null if it can. */
function rejectionFor(keyType: SshKeyType): string | null {
  if (CONNECTABLE_KEY_TYPES.includes(keyType)) return null

  switch (keyType) {
    case "ecdsa-p256":
      return (
        "This is an ECDSA P-256 key. The SSH core can sign with one, but this build " +
        "presents every key to the handshake as Ed25519, so importing it would give " +
        "you a key that fails at authentication. Import or generate an Ed25519 key."
      )
    case "rsa":
      return (
        "This is an RSA key. This build presents every key to the handshake as Ed25519, " +
        "and WebCrypto binds an RSA key to one hash at import time, so it could not " +
        "answer a server that asks for rsa-sha2-512 rather than rsa-sha2-256. Import " +
        "or generate an Ed25519 key."
      )
    default:
      return `This build cannot connect with a ${String(keyType)} key.`
  }
}

/**
 * Parses the key, hands it to `consume`, and zeroes the plaintext on the way
 * out — including when `consume` throws, which is when it matters most.
 */
async function withParsedKey<T>(
  pem: string,
  passphrase: string,
  consume: (key: ImportedKey) => Promise<T>,
): Promise<T> {
  const text = pem.trim()
  precheck(text)

  let parsed: ImportedKey
  try {
    // OpenSSH keys must end in a newline; a paste out of a terminal often does
    // not. Adding one costs nothing and removes a baffling parse error.
    parsed = await wasmImportKey(`${text}\n`, passphrase || undefined)
  } catch (error) {
    throw translate(error)
  }

  try {
    const rejection = rejectionFor(parsed.keyType)
    if (rejection) throw new KeyImportError(rejection)
    return await consume(parsed)
  } finally {
    parsed.pkcs8.fill(0)
  }
}

/**
 * Reads a key without storing anything, so the UI can show what it found and
 * let someone check the fingerprint against `ssh-keygen -lf` before committing.
 *
 * The key is parsed once here and once again on save. That is deliberate: the
 * alternative is holding plaintext PKCS#8 in React state across a review step
 * the user might leave open indefinitely, which is exactly the thing the rest
 * of this file is arranged to avoid. The pasted text is already sitting in a
 * textarea either way, so the second parse costs milliseconds and no secrecy.
 */
export async function inspectImportedKey(pem: string, passphrase = ""): Promise<KeyPreview> {
  return withParsedKey(pem, passphrase, async (parsed) => ({
    keyType: parsed.keyType,
    bits: parsed.bits,
    fingerprint: parsed.fingerprint,
    comment: commentFrom(parsed.authorizedKey),
  }))
}

/**
 * The comment at the end of an authorized_keys line, if the line carries one.
 *
 * The core marshals the public key and nothing else, so in practice this
 * returns undefined; the check is here so that an imported key's own comment is
 * used the day the core starts emitting it, rather than being quietly dropped.
 */
function commentFrom(authorizedKey: string): string | undefined {
  const [, , ...rest] = authorizedKey.trim().split(/\s+/)
  const comment = rest.join(" ").trim()
  return comment || undefined
}

/**
 * Imports an existing private key and stores it exactly as a generated one.
 *
 * Same record shape, same custody rules, same sync behaviour — after this
 * returns there is nothing about the key that says it was imported, because
 * from the browser's point of view there is no longer any difference.
 */
export async function importKey(
  pem: string,
  opts: {
    label?: string
    mode?: KeyMode
    passphrase?: string
    vaultKey?: CryptoKey
  } = {},
): Promise<SshKey> {
  const { label = "imported", mode = "portable", passphrase = "", vaultKey } = opts

  if (mode === "portable" && !vaultKey) {
    throw new KeyImportError(
      "A portable key needs the vault unlocked so it can be wrapped. " +
        "Sign in first, or import it as a device-bound key.",
    )
  }

  return withParsedKey(pem, passphrase, async (parsed) => {
    const publicKeyRaw = Uint8Array.from(parsed.publicKeyRaw)

    const record: StoredKey = {
      id: crypto.randomUUID(),
      label,
      mode,
      publicKeyRaw: publicKeyRaw.buffer as ArrayBuffer,
      createdAt: Date.now(),
    }

    if (mode === "portable") {
      record.wrapped = await wrapWithVault(parsed.pkcs8, vaultKey!)
    }
    // Non-extractable in both modes and from the first moment we hold it: the
    // handle below is the only copy of this key that outlives the function.
    const privateKey = await importPrivate(parsed.pkcs8)
    if (mode === "device-bound") record.privateKey = privateKey

    await idbPut(STORE, record.id, record)
    return { ...record, publicKeyRaw, privateKey } as SshKey
  })
}

/* --------------------------------------------------------------- loading */

/**
 * Hydrate stored keys into usable ones. Portable keys need the vault key to
 * unwrap; without it they are listed but unusable, which is the honest state
 * to show rather than pretending they're missing.
 */
export async function listKeys(vaultKey?: CryptoKey): Promise<SshKey[]> {
  const stored = await idbGetAll<StoredKey>(STORE)
  const out: SshKey[] = []

  for (const rec of stored.sort((a, b) => a.createdAt - b.createdAt)) {
    const privateKey = await hydrate(rec, vaultKey)
    if (privateKey) {
      out.push({
        id: rec.id,
        label: rec.label,
        mode: rec.mode,
        publicKeyRaw: new Uint8Array(rec.publicKeyRaw),
        privateKey,
        createdAt: rec.createdAt,
      })
    }
  }
  return out
}

async function hydrate(rec: StoredKey, vaultKey?: CryptoKey): Promise<CryptoKey | null> {
  if (rec.mode === "device-bound") return rec.privateKey ?? null
  if (!rec.wrapped || !vaultKey) return null

  try {
    const pkcs8 = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(rec.wrapped.iv) },
        vaultKey,
        rec.wrapped.ciphertext,
      ),
    )
    const key = await importPrivate(pkcs8)
    pkcs8.fill(0)
    return key
  } catch {
    // Wrong vault key, or tampered ciphertext. Either way it is not usable.
    return null
  }
}

/** Stored keys including ones that couldn't be unwrapped, for UI listing. */
export async function listStoredKeys(): Promise<StoredKey[]> {
  const all = await idbGetAll<StoredKey>(STORE)
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Portable keys whose wrapping this vault key does not open.
 *
 * listKeys drops such a key silently — correct for the connect path, which has
 * nothing to do with a key it cannot use — but the keys page reads
 * listStoredKeys and so has been rendering them as healthy. A key that is listed
 * everywhere, has a line in authorized_keys on real servers, and quietly never
 * signs is the worst version of this failure, so the page asks this question and
 * says so.
 *
 * How a key gets into that state: it was wrapped with a vault key that a
 * password change has since retired, on a device that was offline when the
 * change ran, so the re-key never saw it. The vault sync refuses to publish such
 * a key (SyncResult.keysWithheld) precisely so this stays a one-device problem.
 */
export async function listUnwrappableKeyIds(vaultKey: CryptoKey): Promise<Set<string>> {
  const out = new Set<string>()
  for (const rec of await idbGetAll<StoredKey>(STORE)) {
    if (rec.mode !== "portable" || !rec.wrapped) continue
    if (!(await hydrate(rec, vaultKey))) out.add(rec.id)
  }
  return out
}

export async function deleteKey(id: string): Promise<void> {
  await idbDelete(STORE, id)
  await recordDeletion(id)
}

/**
 * Removes a stored key without recording a deletion. Used by vault sync to land
 * a delete another device decided — see forgetHost for why the tombstone must
 * not be re-stamped here.
 *
 * This one matters more than the others: a key deleted on one device that stays
 * on this one is a credential the user believes they have destroyed, still
 * sitting in this browser and still able to sign.
 */
export async function forgetStoredKey(id: string): Promise<void> {
  await idbDelete(STORE, id)
}

/** Used by vault sync to land a portable key pulled from another device. */
export async function putStoredKey(rec: StoredKey): Promise<void> {
  await idbPut(STORE, rec.id, rec)
}

export async function getStoredKey(id: string): Promise<StoredKey | undefined> {
  return idbGet<StoredKey>(STORE, id)
}

/* ---------------------------------------------------------------- format */

/**
 * authorized_keys line. SSH wire format is length-prefixed strings:
 * string "ssh-ed25519" ‖ string <32-byte key>.
 */
export function authorizedKeysLine(key: { publicKeyRaw: Uint8Array; label: string }): string {
  const type = new TextEncoder().encode("ssh-ed25519")
  const raw = key.publicKeyRaw

  const blob = new Uint8Array(4 + type.length + 4 + raw.length)
  const view = new DataView(blob.buffer)
  let off = 0
  view.setUint32(off, type.length)
  off += 4
  blob.set(type, off)
  off += type.length
  view.setUint32(off, raw.length)
  off += 4
  blob.set(raw, off)

  let s = ""
  for (const b of blob) s += String.fromCharCode(b)
  // Comments are interpolated into a remote shell command by installKey, and
  // the Go side rejects anything outside [A-Za-z0-9@._-].
  const comment = key.label.replace(/[^A-Za-z0-9@._-]/g, "-") || "weirdvault"
  return `ssh-ed25519 ${btoa(s)} ${comment}`
}

/** The signing callback handed to WASM: challenge in, signature out. */
export function makeSigner(key: SshKey) {
  return async (data: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, data as BufferSource))
}

/** Verifies the security claim rather than asserting it. */
export async function proveNonExtractable(key: SshKey): Promise<{ ok: boolean; detail: string }> {
  if (key.privateKey.extractable) {
    return { ok: false, detail: "privateKey.extractable is true" }
  }
  for (const fmt of ["pkcs8", "jwk"] as const) {
    try {
      await crypto.subtle.exportKey(fmt, key.privateKey)
      return { ok: false, detail: `exportKey("${fmt}") unexpectedly succeeded` }
    } catch {
      /* expected */
    }
  }
  return { ok: true, detail: "pkcs8/jwk export refused" }
}
