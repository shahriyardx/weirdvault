"use client"

/**
 * Deletion records.
 *
 * Without these, sync cannot distinguish "this device has never seen record X"
 * from "this device deleted record X" — so any delete would be resurrected by
 * the next device to sync an older copy. Deleting a host key pin is exactly the
 * case where that matters: an un-deleted pin would keep rejecting a server the
 * user legitimately rebuilt.
 *
 * Lives in its own module so hosts/keys/hostkeys can record deletions without
 * importing the sync engine, which imports them.
 */

import { idbGet, idbPut } from "@/lib/idb"

const KEY = "tombstones"

export async function getTombstones(): Promise<Record<string, number>> {
  return (await idbGet<Record<string, number>>("vault", KEY)) ?? {}
}

export async function recordDeletion(id: string): Promise<void> {
  const t = await getTombstones()
  t[id] = Date.now()
  await idbPut("vault", KEY, t)
}

export async function setTombstones(t: Record<string, number>): Promise<void> {
  await idbPut("vault", KEY, t)
}
