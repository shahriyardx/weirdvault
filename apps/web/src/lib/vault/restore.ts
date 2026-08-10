"use client"

/**
 * Restoring an exported vault.
 *
 * An export is the ciphertext the server held at one moment, so by the time it
 * is imported it is, by definition, an old copy. Writing it over the live state
 * would therefore be a data-loss button wearing a restore label: every host
 * added, every key generated and every pin taken since the export would vanish,
 * silently, on the device that had them.
 *
 * So a restore is a merge. The file is decrypted here, turned into a
 * VaultDocument, and handed to mergeVault as the *remote* side of exactly the
 * pass sync uses — record-level last-write-wins with shared tombstones. Two
 * consequences worth stating plainly, because they are the whole point:
 *
 *  - A record that is newer on this device survives an older copy in the file.
 *  - A delete recorded on this device still wins: tombstones merge too, and
 *    mergeById drops any record whose stamp predates its tombstone. Importing
 *    a backup does not resurrect what you deliberately deleted.
 *
 * Route chosen, and why: mergeVault is exported and pure, but sync.ts keeps its
 * read-local and apply-local steps private to that module. The obvious way
 * around that — write the file's records straight into IndexedDB and let the
 * next syncVault sort it out — is simpler to type and quietly wrong: idbPut has
 * no stamp comparison, so an older host in the file would overwrite a newer one
 * locally before any merge got to see it, and the merge would then faithfully
 * propagate the damage. So the local read and the local apply below deliberately
 * mirror sync.ts, using only its public helpers (putHost, putStoredKey, putPin,
 * putSnippet, setTombstones). That is duplication, and it is the cheaper of the
 * two costs: if these mirrors ever drift from sync.ts the vault stops
 * converging, so they are kept short and adjacent in shape to make drift
 * obvious. Exporting the two steps from sync.ts would be the better fix the day
 * anything else needs them.
 *
 * After the merge lands locally, a normal syncVault pushes it, which is also
 * what carries the restored records to the account's other devices.
 */

import { listHosts, putHost } from "@/lib/hosts"
import { listPins, putPin } from "@/lib/hostkeys"
import { listStoredKeys, putStoredKey, type StoredKey } from "@/lib/keys"
import { listSnippets, putSnippet } from "@/lib/snippets"

import { decryptVault, fromB64, type VaultEnvelope } from "./crypto"
import {
  hostStamp,
  mergeVault,
  syncVault,
  type SyncedKey,
  type SyncResult,
  type VaultDocument,
} from "./sync"
import { getTombstones, setTombstones } from "./tombstones"

/**
 * A file this build has no reader for. Distinct from a decryption failure
 * because the remedy is different — update the app, rather than find the right
 * password — and telling someone their password is wrong when it is not sends
 * them looking for a problem that does not exist.
 */
export class VaultFormatError extends Error {
  constructor(version: unknown) {
    super(
      `This file declares vault format v${String(version)}, which this build cannot read. It was written by a newer version of weirdvault.`,
    )
    this.name = "VaultFormatError"
  }
}

/**
 * The interesting failure. AES-GCM authenticates, so a wrong key does not
 * produce garbage plaintext — it refuses. That refusal carries information: the
 * file is ciphertext from a different account, or from before a password
 * change. Which of the two, nothing here can tell, so the message names both
 * rather than guessing. It is its own type so the UI can promise that nothing
 * local moved, which is true: this is thrown before any local read or write.
 */
export class VaultDecryptionError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "This file did not decrypt with the vault key currently unlocked. It is an export from a different account, or from a different password.",
      options,
    )
    this.name = "VaultDecryptionError"
  }
}

/** What a restore did to one kind of record. Counts, not claims. */
export interface RestoreCount {
  /** How many records of this kind the file contained. */
  inFile: number
  /** Of those, how many did not exist on this device at all. */
  added: number
  /** How many existed here but were older than the copy in the file. */
  updated: number
  /** How many stayed deleted because a tombstone here outranked them. */
  blockedByDelete: number
}

export interface RestoreResult {
  hosts: RestoreCount
  keys: RestoreCount
  hostKeys: RestoreCount
  snippets: RestoreCount
  /**
   * Outcome of the push that follows the merge, or null if it failed. Null does
   * not mean the restore did nothing: the merge is already on this device and
   * will go up on the next successful sync.
   */
  sync: SyncResult | null
  /** Why the push failed, when it did. */
  syncError?: string
}

/* ------------------------------------------------------------- decoding --- */

/**
 * fromB64 allocates a fresh, correctly sized ArrayBuffer, so handing back its
 * `.buffer` is safe; the cast only tells TypeScript what the runtime already
 * guarantees (it is never a SharedArrayBuffer).
 */
const toBuffer = (s: string): ArrayBuffer => fromB64(s).buffer as ArrayBuffer

function toB64(b: ArrayBuffer): string {
  let s = ""
  for (const byte of new Uint8Array(b)) s += String.fromCharCode(byte)
  return btoa(s)
}

/**
 * Mirrors sync.ts's toSyncedKey. Device-bound keys return null: they are
 * non-extractable CryptoKey handles with no exportable representation, so there
 * is nothing to put in a document — which is the property that mode exists for.
 */
function toSyncedKey(rec: StoredKey): SyncedKey | null {
  if (rec.mode !== "portable" || !rec.wrapped) return null
  return {
    id: rec.id,
    label: rec.label,
    mode: "portable",
    publicKeyRaw: toB64(rec.publicKeyRaw),
    wrapped: {
      iv: toB64(rec.wrapped.iv),
      ciphertext: toB64(rec.wrapped.ciphertext),
    },
    createdAt: rec.createdAt,
  }
}

/** Mirror of sync.ts's fromSyncedKey, which is private to that module. */
function fromSyncedKey(k: SyncedKey): StoredKey {
  return {
    id: k.id,
    label: k.label,
    mode: "portable",
    publicKeyRaw: toBuffer(k.publicKeyRaw),
    wrapped: {
      iv: toBuffer(k.wrapped.iv),
      ciphertext: toBuffer(k.wrapped.ciphertext),
    },
    createdAt: k.createdAt,
  }
}

/**
 * Exports predate fields: snippets were added after the first vaults were
 * written, and nothing stops someone restoring a file from that era. Filling
 * the gaps here means mergeVault never has to reason about undefined, and a
 * missing kind cannot take the whole restore down.
 */
function normalise(doc: Partial<VaultDocument> | null | undefined): VaultDocument {
  return {
    hosts: doc?.hosts ?? [],
    keys: doc?.keys ?? [],
    hostKeys: doc?.hostKeys ?? [],
    snippets: doc?.snippets ?? [],
    tombstones: doc?.tombstones ?? {},
    updatedAt: doc?.updatedAt ?? 0,
  }
}

/* ----------------------------------------------------------- local state --- */

/** Mirrors sync.ts's localDocument. See the file header on why it is copied. */
async function localDocument(): Promise<VaultDocument> {
  const [hosts, stored, hostKeys, snippets, tombstones] = await Promise.all([
    listHosts(),
    listStoredKeys(),
    listPins(),
    listSnippets(),
    getTombstones(),
  ])

  return {
    hosts,
    keys: stored.map(toSyncedKey).filter((k): k is SyncedKey => k !== null),
    hostKeys,
    snippets,
    tombstones,
    updatedAt: Date.now(),
  }
}

/** Mirrors sync.ts's applyLocally. Upserts only; deletes are tombstone-driven. */
async function applyLocally(doc: VaultDocument): Promise<void> {
  // putHost, not saveHost: the merge already decided which copy wins, and
  // saveHost would restamp it as an edit made here and now.
  for (const host of doc.hosts) await putHost(host)
  for (const key of doc.keys) await putStoredKey(fromSyncedKey(key))
  for (const pin of doc.hostKeys) await putPin(pin)
  for (const snippet of doc.snippets) await putSnippet(snippet)
  await setTombstones(doc.tombstones)
}

/* -------------------------------------------------------------- counting --- */

function countAgainst<T extends { id: string }>(
  local: T[],
  imported: T[],
  merged: T[],
  stamp: (item: T) => number,
): RestoreCount {
  const localById = new Map(local.map((i) => [i.id, i]))
  const mergedById = new Map(merged.map((i) => [i.id, i]))

  let added = 0
  let updated = 0
  let blockedByDelete = 0

  for (const item of imported) {
    const winner = mergedById.get(item.id)
    // Absent from the merge means a tombstone newer than this record removed
    // it — the deliberate-delete-beats-old-backup case.
    if (!winner) {
      blockedByDelete++
      continue
    }
    const here = localById.get(item.id)
    if (!here) added++
    else if (stamp(winner) > stamp(here)) updated++
  }

  return { inFile: imported.length, added, updated, blockedByDelete }
}

/* --------------------------------------------------------------- restore --- */

/**
 * Decrypt an exported envelope, merge it into the live vault, and push.
 *
 * Throws VaultDecryptionError without touching local state if the key is wrong.
 * A failure of the push is reported in the result rather than thrown, because
 * by then the merge has already landed on this device and pretending otherwise
 * would be the dishonest option.
 */
export async function restoreVault(
  envelope: VaultEnvelope,
  vaultKey: CryptoKey,
): Promise<RestoreResult> {
  // Checked before the decrypt, not after: decryptVault rejects an unknown
  // version by throwing, and folding that into VaultDecryptionError would tell
  // someone their password was wrong when the real answer is that the file is
  // from a newer build. Two different problems, two different messages.
  if (envelope.v !== 1) throw new VaultFormatError((envelope as { v: unknown }).v)

  let imported: VaultDocument
  try {
    imported = normalise(await decryptVault<Partial<VaultDocument>>(vaultKey, envelope))
  } catch (cause) {
    throw new VaultDecryptionError({ cause })
  }

  const local = await localDocument()
  const merged = mergeVault(local, imported)
  await applyLocally(merged)

  // Stamps must match the ones mergeVault resolves on, or the counts would
  // describe a different merge than the one that happened.
  const result: RestoreResult = {
    hosts: countAgainst(local.hosts, imported.hosts, merged.hosts, hostStamp),
    keys: countAgainst(local.keys, imported.keys, merged.keys, (k) => k.createdAt),
    hostKeys: countAgainst(local.hostKeys, imported.hostKeys, merged.hostKeys, (k) => k.pinnedAt),
    snippets: countAgainst(local.snippets, imported.snippets, merged.snippets, (s) => s.updatedAt),
    sync: null,
  }

  try {
    result.sync = await syncVault(vaultKey)
  } catch (e) {
    result.syncError = e instanceof Error ? e.message : String(e)
  }

  return result
}
