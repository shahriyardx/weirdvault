// Non-extractable key custody.
//
// This is the piece the whole product rests on: the SSH private key is created
// inside WebCrypto with extractable=false, so neither our JS, nor our WASM, nor
// an injected script, nor a browser extension can read it. It can only be
// *used* — and the only use we ever make of it is signing an SSH auth
// challenge.

const DB_NAME = "webxterm";
const STORE = "keys";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Generate an Ed25519 keypair whose private half can never leave the browser.
 * Per the WebCrypto spec the public key stays extractable even when the pair is
 * generated non-extractable, which is exactly what we want: we need to hand the
 * public key out, and we need the private key to be unreachable.
 */
export async function generateKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ]);
  // A CryptoKey survives structured clone, so IndexedDB persists the *handle*
  // without ever materialising the key bytes.
  await idbPut("ed25519", pair);
  return pair;
}

export async function loadKey() {
  return idbGet("ed25519");
}

export async function clearKey() {
  const db = await idb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete("ed25519");
    tx.oncomplete = resolve;
  });
}

/** Raw 32-byte public key. */
export async function rawPublicKey(pair) {
  return new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
}

/**
 * Format the public key as an authorized_keys line.
 * SSH wire format is a sequence of length-prefixed strings:
 *   string "ssh-ed25519"  ‖  string <32-byte key>
 */
export async function authorizedKeysLine(pair, comment = "webxterm") {
  const raw = await rawPublicKey(pair);
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

  const b64 = btoa(String.fromCharCode(...blob));
  return `ssh-ed25519 ${b64} ${comment}`;
}

/**
 * The signing callback handed to WASM. This is the entire trust boundary: a
 * challenge goes in, a signature comes out, and the key stays put.
 */
export function makeSigner(pair) {
  return async (data /* Uint8Array */, _algorithm /* string */) => {
    const sig = await crypto.subtle.sign("Ed25519", pair.privateKey, data);
    return new Uint8Array(sig);
  };
}

/**
 * Prove the claim rather than asserting it: attempting to export the private
 * key must throw. The harness runs this and shows the result.
 */
export async function proveNonExtractable(pair) {
  if (pair.privateKey.extractable) {
    return { ok: false, detail: "privateKey.extractable is true" };
  }
  for (const fmt of ["pkcs8", "jwk", "raw"]) {
    try {
      await crypto.subtle.exportKey(fmt, pair.privateKey);
      return { ok: false, detail: `exportKey("${fmt}") unexpectedly succeeded` };
    } catch {
      /* expected */
    }
  }
  return { ok: true, detail: "extractable=false; pkcs8/jwk/raw export all refused" };
}
