"use client";

/**
 * Device identity.
 *
 * Each browser gets a non-extractable Ed25519 keypair and a server-side record,
 * so "where am I signed in" and "revoke that laptop" are answerable. The public
 * half is the record's stable name: it is what makes a re-registration
 * recognisable as the same browser rather than a new one, and revoking it
 * refuses that key permanently.
 *
 * What the private half does *not* do yet, stated because the UI must not imply
 * otherwise: nothing signs with it. Registration is authenticated by the session
 * cookie, and the server never asks the browser to prove it holds the key it is
 * registering. That makes the identity client-cooperative rather than
 * cryptographic — good enough to answer "which of my browsers is this", not good
 * enough to stop a stolen session from enrolling a device of its choosing.
 * Closing it means a nonce from the server, a signature from crypto.subtle.sign,
 * and a verification before the row is written.
 *
 * Revocation tombstones the record rather than deleting it, so audit rows keep
 * a resolvable reference and a revoked id can never be re-registered. Registering
 * also stamps the current session with this device id, which is what makes
 * revocation able to end that browser's sessions rather than only its future
 * registrations.
 *
 * A second keypair used to live here — an X25519 ECDH pair whose public half was
 * published so a team key could be wrapped to this browser. It is gone with the
 * rest of the team surface. Only the Ed25519 identity remains, and the two were
 * always separate on purpose: reusing a signing key for encryption is the
 * classic mistake, so removing the encryption half leaves the signing half
 * untouched rather than half-disentangled.
 *
 * Records written by an older build still carry the X25519 pair in IndexedDB.
 * Nothing here reads it and nothing deletes it: an idb write to strip a field
 * this module already ignores would risk the device id for no gain, and the
 * stale handles are non-extractable keys nothing can address.
 */

import { idbGet, idbPut } from "./idb";

const STORE = "vault";
const KEY = "device-identity";

interface DeviceIdentity {
  id: string;
  label: string;
  platform: string;
  keyPair: CryptoKeyPair;
  publicKeyRaw: ArrayBuffer;
}

function detectPlatform(): string {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac OS X/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux/.test(ua)) return "linux";
  return "other";
}

function defaultLabel(platform: string): string {
  const browser = /Firefox/.test(navigator.userAgent)
    ? "Firefox"
    : /Edg\//.test(navigator.userAgent)
      ? "Edge"
      : /Chrome/.test(navigator.userAgent)
        ? "Chrome"
        : /Safari/.test(navigator.userAgent)
          ? "Safari"
          : "Browser";
  const os =
    { macos: "Mac", windows: "Windows", linux: "Linux", ios: "iPhone", android: "Android" }[
      platform
    ] ?? "Device";
  return `${browser} on ${os}`;
}

/**
 * Creates the identity if this browser doesn't have one yet, and returns the
 * existing one otherwise.
 *
 * An existing record is returned as it stands, never regenerated: a new Ed25519
 * pair would orphan the server-side device row, its audit history and its
 * sessions, and the user would see a browser they are sitting in appear as a
 * stranger in the device list.
 */
export async function ensureDeviceIdentity(): Promise<DeviceIdentity> {
  const existing = await idbGet<DeviceIdentity>(STORE, KEY);
  if (existing) return existing;

  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const platform = detectPlatform();
  const identity: DeviceIdentity = {
    id: crypto.randomUUID(),
    label: defaultLabel(platform),
    platform,
    keyPair,
    publicKeyRaw: await crypto.subtle.exportKey("raw", keyPair.publicKey),
  };

  await idbPut(STORE, KEY, identity);
  return identity;
}

export async function getCurrentDeviceId(): Promise<string | undefined> {
  const identity = await idbGet<DeviceIdentity>(STORE, KEY);
  return identity?.id;
}

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Registers this browser with the control plane. Idempotent — the server keys
 * on (userId, signingKey), so calling it on every sign-in refreshes last-seen
 * without creating duplicates.
 */
export async function registerDevice(): Promise<{ id: string } | null> {
  try {
    const identity = await ensureDeviceIdentity();
    const res = await fetch("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: identity.id,
        label: identity.label,
        platform: identity.platform,
        signingKey: b64(identity.publicKeyRaw),
      }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { id: string };
  } catch {
    return null;
  }
}
