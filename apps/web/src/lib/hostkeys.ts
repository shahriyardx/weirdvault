"use client";

/**
 * Pinned SSH host keys.
 *
 * This is the control that keeps the relay honest. The relay carries every byte
 * between the browser and the server, so if nobody checks the host key it could
 * present its own and terminate the SSH session itself — making the encryption
 * end-to-relay rather than end-to-end. See docs/THREAT-MODEL.md §6.
 *
 * Policy: pin on first use, verify every time after, and refuse to connect on
 * mismatch. There is deliberately no one-click "trust anyway" — clearing a
 * pin is a separate, explicit action.
 */

import { idbGet, idbPut, idbDelete, idbGetAll } from "./idb";

export interface PinnedHostKey {
  /** host:port */
  id: string;
  key: string; // base64 of the marshaled SSH public key
  fingerprint: string;
  type: string;
  pinnedAt: number;
  lastSeenAt: number;
}

const STORE = "hostkeys";

const idFor = (host: string, port: number) => `${host}:${port}`;

export async function getPin(host: string, port: number): Promise<PinnedHostKey | undefined> {
  return idbGet<PinnedHostKey>(STORE, idFor(host, port));
}

export async function listPins(): Promise<PinnedHostKey[]> {
  return idbGetAll<PinnedHostKey>(STORE);
}

export async function pin(
  host: string,
  port: number,
  info: { key: string; fingerprint: string; type: string },
): Promise<PinnedHostKey> {
  const now = Date.now();
  const record: PinnedHostKey = {
    id: idFor(host, port),
    ...info,
    pinnedAt: now,
    lastSeenAt: now,
  };
  await idbPut(STORE, record.id, record);
  return record;
}

export async function touchPin(host: string, port: number): Promise<void> {
  const existing = await getPin(host, port);
  if (existing) {
    await idbPut(STORE, existing.id, { ...existing, lastSeenAt: Date.now() });
  }
}

/**
 * Removing a pin is how a user recovers from a legitimately rebuilt server.
 * It is intentionally a distinct, deliberate action rather than a button on
 * the mismatch warning.
 */
export async function unpin(host: string, port: number): Promise<void> {
  await idbDelete(STORE, idFor(host, port));
}

export class HostKeyMismatchError extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly expected: PinnedHostKey,
    readonly presented: { fingerprint: string; type: string },
  ) {
    super(
      `Host key mismatch for ${host}:${port}. Expected ${expected.type} ` +
        `${expected.fingerprint}, got ${presented.type} ${presented.fingerprint}.`,
    );
    this.name = "HostKeyMismatchError";
  }
}
