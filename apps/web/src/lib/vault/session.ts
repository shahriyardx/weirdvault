"use client";

import { useSyncExternalStore } from "react";

/**
 * In-memory custody of the derived key material.
 *
 * Deliberately not persisted. localStorage, sessionStorage, and IndexedDB are
 * all readable by any script running on the origin, and a vault key sitting in
 * one of them would undo the split KDF entirely. The cost is real and visible:
 * a full page load leaves you signed in but locked, and you have to re-enter
 * the password to unlock. That is the correct trade, and the same one every
 * serious password manager makes — but it means the UI must offer a way back
 * in, which is what useVaultLocked drives.
 *
 * Both keys are non-extractable CryptoKeys, so even this module cannot read
 * their bytes; it can only hand them to encrypt/decrypt/sign.
 */

interface VaultSession {
  vaultKey: CryptoKey;
  auditKey: CryptoKey | null;
}

let current: VaultSession | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function setVaultKey(vaultKey: CryptoKey, auditKey: CryptoKey | null = null) {
  current = { vaultKey, auditKey };
  emit();
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
  emit();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Reactive unlock state. Components need to re-render when the vault unlocks,
 * which a plain module variable cannot drive.
 */
export function useVaultUnlocked(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => current !== null,
    // Server render: always locked, since the key only exists in the browser.
    () => false,
  );
}
