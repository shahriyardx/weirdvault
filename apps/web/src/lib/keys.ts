"use client";

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

import { idbDelete, idbGet, idbGetAll, idbPut } from "./idb";
import { recordDeletion } from "./vault/tombstones";

export type KeyMode = "portable" | "device-bound";

export interface StoredKey {
  id: string;
  label: string;
  mode: KeyMode;
  /** Raw 32-byte Ed25519 public key. */
  publicKeyRaw: ArrayBuffer;
  /** Present only for portable keys: PKCS#8 encrypted with the vault key. */
  wrapped?: { iv: ArrayBuffer; ciphertext: ArrayBuffer };
  /** Present only for device-bound keys: the CryptoKey handle itself. */
  privateKey?: CryptoKey;
  createdAt: number;
}

export interface SshKey {
  id: string;
  label: string;
  mode: KeyMode;
  publicKeyRaw: Uint8Array;
  privateKey: CryptoKey;
  createdAt: number;
}

const STORE = "keys";

/* ------------------------------------------------------------ generation */

export async function generateKey(
  label = "webxterm",
  mode: KeyMode = "portable",
  vaultKey?: CryptoKey,
): Promise<SshKey> {
  if (mode === "portable" && !vaultKey) {
    throw new Error(
      "A portable key needs the vault unlocked so it can be wrapped. " +
        "Sign in first, or create a device-bound key.",
    );
  }

  // Portable keys must be exportable for the instant it takes to wrap them.
  const extractable = mode === "portable";
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, extractable, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const publicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );

  const record: StoredKey = {
    id: crypto.randomUUID(),
    label,
    mode,
    publicKeyRaw: publicKeyRaw.buffer as ArrayBuffer,
    createdAt: Date.now(),
  };

  let privateKey = pair.privateKey;

  if (mode === "portable") {
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      vaultKey!,
      pkcs8 as BufferSource,
    );
    record.wrapped = { iv: iv.buffer as ArrayBuffer, ciphertext };

    // Re-import non-extractable and drop the exportable handle, so from here on
    // this key behaves exactly like a device-bound one.
    privateKey = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, "Ed25519", false, [
      "sign",
    ]);
    pkcs8.fill(0);
  } else {
    record.privateKey = pair.privateKey;
  }

  await idbPut(STORE, record.id, record);
  return { ...record, publicKeyRaw, privateKey } as SshKey;
}

/* --------------------------------------------------------------- loading */

/**
 * Hydrate stored keys into usable ones. Portable keys need the vault key to
 * unwrap; without it they are listed but unusable, which is the honest state
 * to show rather than pretending they're missing.
 */
export async function listKeys(vaultKey?: CryptoKey): Promise<SshKey[]> {
  const stored = await idbGetAll<StoredKey>(STORE);
  const out: SshKey[] = [];

  for (const rec of stored.sort((a, b) => a.createdAt - b.createdAt)) {
    const privateKey = await hydrate(rec, vaultKey);
    if (privateKey) {
      out.push({
        id: rec.id,
        label: rec.label,
        mode: rec.mode,
        publicKeyRaw: new Uint8Array(rec.publicKeyRaw),
        privateKey,
        createdAt: rec.createdAt,
      });
    }
  }
  return out;
}

async function hydrate(rec: StoredKey, vaultKey?: CryptoKey): Promise<CryptoKey | null> {
  if (rec.mode === "device-bound") return rec.privateKey ?? null;
  if (!rec.wrapped || !vaultKey) return null;

  try {
    const pkcs8 = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(rec.wrapped.iv) },
        vaultKey,
        rec.wrapped.ciphertext,
      ),
    );
    const key = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, "Ed25519", false, [
      "sign",
    ]);
    pkcs8.fill(0);
    return key;
  } catch {
    // Wrong vault key, or tampered ciphertext. Either way it is not usable.
    return null;
  }
}

/** Stored keys including ones that couldn't be unwrapped, for UI listing. */
export async function listStoredKeys(): Promise<StoredKey[]> {
  const all = await idbGetAll<StoredKey>(STORE);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteKey(id: string): Promise<void> {
  await idbDelete(STORE, id);
  await recordDeletion(id);
}

/** Used by vault sync to land a portable key pulled from another device. */
export async function putStoredKey(rec: StoredKey): Promise<void> {
  await idbPut(STORE, rec.id, rec);
}

export async function getStoredKey(id: string): Promise<StoredKey | undefined> {
  return idbGet<StoredKey>(STORE, id);
}

/* ---------------------------------------------------------------- format */

/**
 * authorized_keys line. SSH wire format is length-prefixed strings:
 * string "ssh-ed25519" ‖ string <32-byte key>.
 */
export function authorizedKeysLine(key: { publicKeyRaw: Uint8Array; label: string }): string {
  const type = new TextEncoder().encode("ssh-ed25519");
  const raw = key.publicKeyRaw;

  const blob = new Uint8Array(4 + type.length + 4 + raw.length);
  const view = new DataView(blob.buffer);
  let off = 0;
  view.setUint32(off, type.length);
  off += 4;
  blob.set(type, off);
  off += type.length;
  view.setUint32(off, raw.length);
  off += 4;
  blob.set(raw, off);

  let s = "";
  for (const b of blob) s += String.fromCharCode(b);
  // Comments are interpolated into a remote shell command by installKey, and
  // the Go side rejects anything outside [A-Za-z0-9@._-].
  const comment = key.label.replace(/[^A-Za-z0-9@._-]/g, "-") || "webxterm";
  return `ssh-ed25519 ${btoa(s)} ${comment}`;
}

/** The signing callback handed to WASM: challenge in, signature out. */
export function makeSigner(key: SshKey) {
  return async (data: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(
      await crypto.subtle.sign("Ed25519", key.privateKey, data as BufferSource),
    );
}

/** Verifies the security claim rather than asserting it. */
export async function proveNonExtractable(
  key: SshKey,
): Promise<{ ok: boolean; detail: string }> {
  if (key.privateKey.extractable) {
    return { ok: false, detail: "privateKey.extractable is true" };
  }
  for (const fmt of ["pkcs8", "jwk"] as const) {
    try {
      await crypto.subtle.exportKey(fmt, key.privateKey);
      return { ok: false, detail: `exportKey("${fmt}") unexpectedly succeeded` };
    } catch {
      /* expected */
    }
  }
  return { ok: true, detail: "pkcs8/jwk export refused" };
}
