"use client";

/**
 * Vault encryption.
 *
 * Everything the user cares about — hosts, folders, tags, snippets, port
 * forwards, wrapped SSH keys — is serialised, encrypted here, and shipped to
 * the server as an opaque blob. The server can count the bytes and see when
 * they changed. That is the whole extent of its knowledge.
 *
 * AES-256-GCM with a random 96-bit IV per write. The vault key is a
 * non-extractable CryptoKey derived by the split KDF; it never leaves memory.
 */

const IV_BYTES = 12;

export interface VaultEnvelope {
  /** Format version, so the wire format can change without guessing. */
  v: 1;
  iv: string; // base64
  ct: string; // base64
}

export async function encryptVault(key: CryptoKey, data: unknown): Promise<VaultEnvelope> {
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext as BufferSource,
  );
  plaintext.fill(0);
  return { v: 1, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function decryptVault<T>(key: CryptoKey, env: VaultEnvelope): Promise<T> {
  if (env.v !== 1) throw new Error(`unsupported vault format v${env.v}`);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(env.iv) as BufferSource },
    key,
    fromB64(env.ct) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export function toB64(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
