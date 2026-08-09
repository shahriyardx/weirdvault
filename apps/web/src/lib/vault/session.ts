"use client";

import { useSyncExternalStore } from "react";

import type { DerivedSecrets } from "./kdf";

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
  recovered = null;
  emit();
}

/* --------------------------------------------------- recovered credentials */

/**
 * What a redeemed recovery code produced, held until the password change that
 * has to follow it.
 *
 * This exists because recovery had a dead end at the end of it. Redeeming a code
 * signs you in and unlocks the vault, and then the app told you to change your
 * password — which the form could not do, because changing a password needs the
 * old auth token, which is derived from the password you have just proved you do
 * not have. Both instructions on that page were unperformable, so a successful
 * recovery spent a code and changed nothing.
 *
 * The material to finish the job already exists at redemption: the envelope
 * carries the old vault key and the old auth token, and the auth token is
 * literally what Better Auth wants as `currentPassword`. Keeping it here for the
 * length of that one navigation is what makes the re-key reachable.
 *
 * The cost, stated rather than hidden: unlike the two CryptoKeys above, the auth
 * token is a string this module can read, and it is password-equivalent for as
 * long as it is held. So it is memory-only like everything else here, it is
 * dropped by lock(), and rekey clears it the moment the change lands. A reload
 * loses it, and the settings page then says the re-key cannot be done from this
 * tab rather than offering a form that would fail.
 */
let recovered: DerivedSecrets | null = null;

export function setRecoveredSecrets(secrets: DerivedSecrets) {
  recovered = secrets;
  emit();
}

export function getRecoveredSecrets(): DerivedSecrets | null {
  return recovered;
}

export function clearRecoveredSecrets() {
  if (!recovered) return;
  recovered = null;
  emit();
}

/** Reactive: can this tab still re-key without the old password? */
export function useRecoveredSecrets(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => recovered !== null,
    () => false,
  );
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
