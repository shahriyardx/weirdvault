"use client";

/**
 * SSH key custody.
 *
 * Keys are generated inside WebCrypto with extractable=false, so the private
 * half cannot be read by our code, an injected script, or a browser extension.
 * It can only be *used* — and the only use is signing an SSH auth challenge.
 *
 * Portability is a deliberate per-key choice (PLAN.md §3.6). This module
 * implements the device-bound mode; the portable mode wraps an extractable key
 * with the vault key at creation and is added alongside it in Phase 3.
 */

const DB_NAME = "webxterm";
const DB_VERSION = 1;
const KEY_STORE = "keys";
const HOST_STORE = "hosts";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
      if (!db.objectStoreNames.contains(HOST_STORE)) db.createObjectStore(HOST_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface SshKey {
  id: string;
  label: string;
  pair: CryptoKeyPair;
  createdAt: number;
}

export async function generateKey(label = "webxterm"): Promise<SshKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const key: SshKey = { id: crypto.randomUUID(), label, pair, createdAt: Date.now() };
  // A CryptoKey survives structured clone, so this persists the *handle*
  // without the key bytes ever existing outside WebCrypto.
  await tx(KEY_STORE, "readwrite", (s) => s.put(key, key.id));
  return key;
}

export async function listKeys(): Promise<SshKey[]> {
  const all = await tx<SshKey[]>(KEY_STORE, "readonly", (s) => s.getAll());
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteKey(id: string): Promise<void> {
  await tx(KEY_STORE, "readwrite", (s) => s.delete(id));
}

export async function rawPublicKey(key: SshKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key.pair.publicKey));
}

/**
 * Format as an authorized_keys line. SSH wire format is length-prefixed
 * strings: string "ssh-ed25519" ‖ string <32-byte key>.
 */
export async function authorizedKeysLine(key: SshKey): Promise<string> {
  const raw = await rawPublicKey(key);
  const type = new TextEncoder().encode("ssh-ed25519");

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
  return `ssh-ed25519 ${btoa(s)} ${key.label}`;
}

/** The signing callback handed to WASM: challenge in, signature out. */
export function makeSigner(key: SshKey) {
  return async (data: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.sign("Ed25519", key.pair.privateKey, data as BufferSource));
}

/** Verifies the security claim rather than asserting it. */
export async function proveNonExtractable(
  key: SshKey,
): Promise<{ ok: boolean; detail: string }> {
  if (key.pair.privateKey.extractable) {
    return { ok: false, detail: "privateKey.extractable is true" };
  }
  for (const fmt of ["pkcs8", "jwk", "raw"] as const) {
    try {
      await crypto.subtle.exportKey(fmt, key.pair.privateKey);
      return { ok: false, detail: `exportKey("${fmt}") unexpectedly succeeded` };
    } catch {
      /* expected */
    }
  }
  return { ok: true, detail: "pkcs8/jwk/raw export all refused" };
}

/* --------------------------------------------------------------- hosts --- */

export interface Host {
  id: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  keyId?: string;
  createdAt: number;
}

// Phase 1 keeps hosts local. Phase 3 encrypts this same shape into the vault
// blob and syncs it; the server never sees it in either case.
export async function listHosts(): Promise<Host[]> {
  const all = await tx<Host[]>(HOST_STORE, "readonly", (s) => s.getAll());
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveHost(host: Omit<Host, "id" | "createdAt"> & { id?: string }) {
  const record: Host = {
    id: host.id ?? crypto.randomUUID(),
    createdAt: Date.now(),
    ...host,
  } as Host;
  await tx(HOST_STORE, "readwrite", (s) => s.put(record, record.id));
  return record;
}

export async function deleteHost(id: string): Promise<void> {
  await tx(HOST_STORE, "readwrite", (s) => s.delete(id));
}
