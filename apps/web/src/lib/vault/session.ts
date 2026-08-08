"use client";

/**
 * In-memory custody of the vault key.
 *
 * Deliberately not persisted. localStorage, sessionStorage, and IndexedDB are
 * all readable by any script running on the origin, and a vault key sitting in
 * one of them would undo the split KDF entirely. The cost is that a page
 * reload requires re-entering the password — which is the correct trade, and
 * the same one every serious password manager makes.
 *
 * The key itself is a non-extractable CryptoKey, so even this module cannot
 * read its bytes; it can only hand it to encrypt/decrypt.
 */

let vaultKey: CryptoKey | null = null;

export function setVaultKey(key: CryptoKey) {
  vaultKey = key;
}

export function getVaultKey(): CryptoKey | null {
  return vaultKey;
}

export function isUnlocked(): boolean {
  return vaultKey !== null;
}

export function lock() {
  vaultKey = null;
}
