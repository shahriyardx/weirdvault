"use client";

/**
 * In-memory custody of the derived key material.
 *
 * Deliberately not persisted. localStorage, sessionStorage, and IndexedDB are
 * all readable by any script running on the origin, and a vault key sitting in
 * one of them would undo the split KDF entirely. The cost is that a page
 * reload requires re-entering the password — which is the correct trade, and
 * the same one every serious password manager makes.
 *
 * Both keys are non-extractable CryptoKeys, so even this module cannot read
 * their bytes; it can only hand them to encrypt/decrypt/sign.
 */

interface VaultSession {
  vaultKey: CryptoKey;
  /** Blinds hostnames before they reach the audit log. */
  auditKey: CryptoKey | null;
}

let current: VaultSession | null = null;

export function setVaultKey(vaultKey: CryptoKey, auditKey: CryptoKey | null = null) {
  current = { vaultKey, auditKey };
}

export function getVaultKey(): CryptoKey | null {
  return current?.vaultKey ?? null;
}

export function getAuditKey(): CryptoKey | null {
  return current?.auditKey ?? null;
}

export function isUnlocked(): boolean {
  return current !== null;
}

export function lock() {
  current = null;
}
