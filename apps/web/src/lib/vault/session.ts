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

/**
 * Whether the unlock prompt is showing.
 *
 * Anything that needs the vault — connecting with a portable key, syncing —
 * can ask for it rather than failing with "no usable key", which tells the user
 * nothing about what to do next.
 */
let unlockOpen = false;

function emit() {
  for (const fn of listeners) fn();
}

export function setVaultKey(vaultKey: CryptoKey, auditKey: CryptoKey | null = null) {
  current = { vaultKey, auditKey };
  unlockOpen = false;
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

export function requestUnlock() {
  if (current) return; // already unlocked; nothing to ask for
  unlockOpen = true;
  emit();
}

export function dismissUnlock() {
  unlockOpen = false;
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

/** Reactive: is the unlock prompt currently requested? */
export function useUnlockRequested(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => unlockOpen,
    () => false,
  );
}
