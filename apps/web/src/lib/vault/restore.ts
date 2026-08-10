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
 * Route chosen, and why: the obvious shortcut — write the file's records
 * straight into IndexedDB and let the next syncVault sort it out — is simpler to
 * type and quietly wrong. idbPut has no stamp comparison, so an older host in
 * the file would overwrite a newer one locally before any merge got to see it,
 * and the merge would then faithfully propagate the damage. So this reads local
 * state, merges, and writes the result, using sync.ts's own readLocalVault and
 * applyVaultLocally.
 *
 * Those two used to be private to sync.ts and mirrored here, with a note saying
 * exporting them would be the better fix the day anything else needed them. That
 * day arrived: applyVaultLocally has to remove records a tombstone deleted as
 * well as upsert the ones that survived, and a second copy of that would have
 * been a second chance to leave the removal out — which is exactly the bug the
 * removal fixes.
 *
 * After the merge lands locally, a normal syncVault pushes it, which is also
 * what carries the restored records to the account's other devices.
 */

import { decryptVault, type VaultEnvelope } from "./crypto"
import {
  applyVaultLocally,
  hostStamp,
  mergeVault,
  readLocalVault,
  syncVault,
  type SyncResult,
  type VaultDocument,
} from "./sync"

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

  const local = await readLocalVault()
  const merged = mergeVault(local, imported)
  await applyVaultLocally(merged, local)

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
