"use client";

/**
 * Device identity.
 *
 * Each browser gets a non-extractable Ed25519 keypair and a server-side record,
 * so "where am I signed in" and "revoke that laptop" are answerable. The
 * signing key is what makes the identity meaningful: without it a device id is
 * just a cookie value that any client could claim.
 *
 * Revocation tombstones the record rather than deleting it, so audit rows keep
 * a resolvable reference and a revoked id can never be re-registered.
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

/** Creates the identity if this browser doesn't have one yet. */
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
