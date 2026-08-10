"use client"

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

import { idbGet, idbPut, idbDelete, idbGetAll } from "./idb"
import { recordDeletion } from "./vault/tombstones"

export interface PinnedHostKey {
  /** host:port */
  id: string
  key: string // base64 of the marshaled SSH public key
  fingerprint: string
  type: string
  pinnedAt: number
  lastSeenAt: number
}

const STORE = "hostkeys"

const idFor = (host: string, port: number) => `${host}:${port}`

/**
 * What a host key is pinned against.
 *
 * For an ordinary host that is the address, because the address is what
 * identifies the machine. For a host reached through an agent there is no
 * address — `hostname` is a label the user typed and can rename at will — so the
 * pin is keyed on the agent instead. Keying it on the label would mean renaming
 * a machine silently discarded its pinned key and re-pinned whatever answered
 * next, which is a mismatch warning that never fires: exactly the case pinning
 * exists to catch.
 *
 * This lives here, beside the store it addresses, because three callers need
 * the same answer and until now only one of them had it. connect.ts derived it
 * privately, so the hosts page looked a pin up under `label:22` while the pin
 * had been written under `agent:<id>:22` — every agent-backed host read as "not
 * pinned" no matter how many times it had connected — and the mismatch dialog
 * tried to unpin the same name that did not exist, leaving somebody with a
 * genuine key change no way to clear the old key.
 */
export function pinKeyFor(host: { hostname: string; agentId?: string }): string {
  return host.agentId ? `agent:${host.agentId}` : host.hostname
}

/** The stored id for a host's pin: the key above, plus the port. */
export function pinIdFor(host: { hostname: string; port: number; agentId?: string }): string {
  return idFor(pinKeyFor(host), host.port)
}

export async function getPin(host: string, port: number): Promise<PinnedHostKey | undefined> {
  return idbGet<PinnedHostKey>(STORE, idFor(host, port))
}

export async function listPins(): Promise<PinnedHostKey[]> {
  return idbGetAll<PinnedHostKey>(STORE)
}

export async function pin(
  host: string,
  port: number,
  info: { key: string; fingerprint: string; type: string },
): Promise<PinnedHostKey> {
  const now = Date.now()
  const record: PinnedHostKey = {
    id: idFor(host, port),
    ...info,
    pinnedAt: now,
    lastSeenAt: now,
  }
  await idbPut(STORE, record.id, record)
  return record
}

/** Used by vault sync to land a pin from another device. */
export async function putPin(record: PinnedHostKey): Promise<void> {
  await idbPut(STORE, record.id, record)
}

export async function touchPin(host: string, port: number): Promise<void> {
  const existing = await getPin(host, port)
  if (existing) {
    await idbPut(STORE, existing.id, { ...existing, lastSeenAt: Date.now() })
  }
}

/**
 * Removing a pin is how a user recovers from a legitimately rebuilt server.
 * It is intentionally a distinct, deliberate action rather than a button on
 * the mismatch warning.
 */
export async function unpin(host: string, port: number): Promise<void> {
  const id = idFor(host, port)
  await idbDelete(STORE, id)
  // Tombstone it, or the next device to sync an older copy would restore the
  // pin and keep rejecting a server the user legitimately rebuilt.
  await recordDeletion(id)
}

/**
 * Removes a pin without recording an unpin.
 *
 * Used by vault sync to land an unpin another device decided — see forgetHost
 * for why the tombstone must not be re-stamped here. This is the case the
 * tombstone was introduced for: until it ran on *this* device too, a rebuilt
 * server stayed rejected here however many times it was unpinned elsewhere.
 */
export async function forgetPin(id: string): Promise<void> {
  await idbDelete(STORE, id)
}

export class HostKeyMismatchError extends Error {
  constructor(
    /** What to call the machine on screen. A label, for an agent host. */
    readonly host: string,
    /**
     * What the pin is actually stored under, which is not `host` for a machine
     * reached through an agent.
     *
     * Carried separately because the dialog offers to clear the pin, and it
     * used to clear it by name — so on an agent host it removed nothing, the
     * stale key survived, and somebody facing a genuine key change had no way
     * out of the warning.
     */
    readonly pinKey: string,
    readonly port: number,
    readonly expected: PinnedHostKey,
    readonly presented: { fingerprint: string; type: string },
  ) {
    super(
      `Host key mismatch for ${host}:${port}. Expected ${expected.type} ` +
        `${expected.fingerprint}, got ${presented.type} ${presented.fingerprint}.`,
    )
    this.name = "HostKeyMismatchError"
  }
}
