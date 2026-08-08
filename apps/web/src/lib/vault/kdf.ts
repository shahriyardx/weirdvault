/**
 * The split key derivation.
 *
 * The obvious design — send the password to Better Auth and also use it to
 * unlock the vault — quietly destroys zero-knowledge: the server sees the
 * password at every sign-in, and therefore could derive the vault key.
 *
 * So the password is stretched once in the browser and then split into two
 * independent branches:
 *
 *     master     = Argon2id(password, salt)
 *     authToken  = HKDF(master, "webxterm/auth/v1")   → sent to the server
 *     vaultKey   = HKDF(master, "webxterm/vault/v1")  → NEVER leaves the device
 *
 * HKDF is one-way and the branches are domain-separated, so possession of
 * authToken says nothing about vaultKey. The server stores only a hash of
 * authToken. One password for the user; nothing decryptable for us.
 *
 * This must be settled before any auth code ships: changing it later means
 * re-deriving and re-encrypting every user's vault.
 */

import { argon2id } from "hash-wasm";

/** OWASP-recommended Argon2id parameters, tuned to stay tolerable on mobile. */
export const ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65536, // 64 MiB
  hashLength: 32,
} as const;

const AUTH_INFO = "webxterm/auth/v1";
const VAULT_INFO = "webxterm/vault/v1";

const enc = new TextEncoder();

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
  const material = enc.encode(`webxterm/salt/v1:${email.trim().toLowerCase()}`);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", material));
}

async function hkdf(
  master: Uint8Array,
  info: string,
  bytes = 32,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", master as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32), // master is already high-entropy
      info: enc.encode(info),
    },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

export interface DerivedSecrets {
  /** Sent to the server in place of a password. Useless for decryption. */
  authToken: string;
  /** Stays on the device. Unwraps everything in the vault. */
  vaultKey: CryptoKey;
}

export async function deriveSecrets(
  email: string,
  password: string,
): Promise<DerivedSecrets> {
  const salt = await saltFor(email);

  const master = await argon2id({
    password,
    salt,
    ...ARGON2_PARAMS,
    outputType: "binary",
  });

  const [authBytes, vaultBytes] = await Promise.all([
    hkdf(master, AUTH_INFO),
    hkdf(master, VAULT_INFO),
  ]);

  // Non-extractable: once derived, the vault key cannot be read back out,
  // only used. Same principle as the SSH keys.
  const vaultKey = await crypto.subtle.importKey(
    "raw",
    vaultBytes as BufferSource,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );

  // Wipe what we can. JS gives no guarantees here, but leaving copies around
  // deliberately would be worse.
  master.fill(0);
  vaultBytes.fill(0);

  return { authToken: b64(authBytes), vaultKey };
}

function b64(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}
