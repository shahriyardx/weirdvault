"use client"

/**
 * Vault sync.
 *
 * Pull, merge, push — with the merge happening locally on plaintext, because
 * the server holds ciphertext and could not merge if it wanted to.
 *
 * Conflict resolution is last-write-wins per record with tombstones for
 * deletes, so a delete on one device isn't undone by a stale copy on another.
 * That is weaker than a full CRDT, but it is correct for the shape of this data
 * (small, per-record, rarely concurrent) and it is honest about what it does.
 *
 * What syncs:
 *  - hosts, folders, tags
 *  - **portable keys**, as the ciphertext produced at generation time. Without
 *    these the portable key mode does its crypto and then strands the key on
 *    one device, which defeats the entire point of the mode.
 *  - **pinned host keys**, so a second device inherits the pin rather than
 *    silently trusting on first use again — a fresh TOFU on every new device
 *    is a meaningfully weaker security posture than the first device had.
 *  - **snippets**, which are plain shell text and therefore the most obviously
 *    private thing in here after the keys: they name your servers, your paths
 *    and your habits.
 */

import type { Host } from "@/lib/hosts"
import { forgetHost, listHosts, putHost } from "@/lib/hosts"
import type { PinnedHostKey } from "@/lib/hostkeys"
import { forgetPin, listPins, putPin } from "@/lib/hostkeys"
import { idbGet, idbPut } from "@/lib/idb"
import { forgetStoredKey, listStoredKeys, putStoredKey, type StoredKey } from "@/lib/keys"
import { forgetSnippet, listSnippets, putSnippet, type Snippet } from "@/lib/snippets"

import { decryptVault, encryptVault, type VaultEnvelope } from "./crypto"
import { getTombstones, setTombstones } from "./tombstones"

export { getTombstones, recordDeletion } from "./tombstones"

/** A portable key as it travels: ciphertext plus the public half. */
export interface SyncedKey {
  id: string
  label: string
  mode: "portable"
  publicKeyRaw: string // base64
  wrapped: { iv: string; ciphertext: string } // base64
  createdAt: number
}

export interface VaultDocument {
  hosts: Host[]
  keys: SyncedKey[]
  hostKeys: PinnedHostKey[]
  /**
   * Added after the first vaults were written, so every document read from the
   * server predating it arrives without this field. The pull path spreads over
   * emptyDoc() and mergeVault defends itself, which is why this can stay
   * required in the type instead of leaking an optional into every consumer.
   */
  snippets: Snippet[]
  /** id -> deletedAt, so a delete beats an older edit. Shared across kinds. */
  tombstones: Record<string, number>
  updatedAt: number
}

interface SyncState {
  version: number
  lastSyncedAt: number
}

const STATE_KEY = "sync-state"

const emptyDoc = (): VaultDocument => ({
  hosts: [],
  keys: [],
  hostKeys: [],
  snippets: [],
  tombstones: {},
  updatedAt: 0,
})

async function getState(): Promise<SyncState> {
  return (await idbGet<SyncState>("vault", STATE_KEY)) ?? { version: 0, lastSyncedAt: 0 }
}

async function setState(state: SyncState): Promise<void> {
  await idbPut("vault", STATE_KEY, state)
}

/* ------------------------------------------------------------- encoding --- */

const b64 = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ""
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s)
}

const unb64 = (s: string): ArrayBuffer => {
  const bin = atob(s)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

/**
 * Only portable keys travel. A device-bound key is a non-extractable CryptoKey
 * handle with no exportable representation — there is literally nothing to
 * send, which is the property the mode is chosen for.
 */
function toSyncedKey(rec: StoredKey): SyncedKey | null {
  if (rec.mode !== "portable" || !rec.wrapped) return null
  return {
    id: rec.id,
    label: rec.label,
    mode: "portable",
    publicKeyRaw: b64(rec.publicKeyRaw),
    wrapped: {
      iv: b64(rec.wrapped.iv),
      ciphertext: b64(rec.wrapped.ciphertext),
    },
    createdAt: rec.createdAt,
  }
}

function fromSyncedKey(k: SyncedKey): StoredKey {
  return {
    id: k.id,
    label: k.label,
    mode: "portable",
    publicKeyRaw: unb64(k.publicKeyRaw),
    wrapped: {
      iv: unb64(k.wrapped.iv),
      ciphertext: unb64(k.wrapped.ciphertext),
    },
    createdAt: k.createdAt,
  }
}

/* ---------------------------------------------------------------- merge --- */

/**
 * Last-write-wins by stamp, with the remote copy winning a tie.
 *
 * The tie-break is not arbitrary and it is not free. Remote is inserted first
 * and only a *strictly* newer stamp displaces it, so two copies of a record
 * carrying the same number resolve to the server's. That makes the merge
 * symmetric — both devices compute the same answer from the same two documents,
 * which is what stops a sync loop — but it puts the whole weight of correctness
 * on the stamp actually moving when a record is edited. A record kind whose
 * stamp does not move on edit is silently reverted here, with no error and no
 * conflict, which is exactly what happened to hosts before Host.updatedAt
 * existed. Adding a record kind to this file means answering "what moves its
 * stamp on every write" first.
 */
function mergeById<T extends { id: string }>(
  local: T[],
  remote: T[],
  stamp: (item: T) => number,
  tombstones: Record<string, number>,
): T[] {
  const byId = new Map<string, T>()
  for (const item of [...remote, ...local]) {
    const existing = byId.get(item.id)
    if (!existing || stamp(item) > stamp(existing)) byId.set(item.id, item)
  }
  return [...byId.values()].filter((item) => {
    const deletedAt = tombstones[item.id]
    return !deletedAt || stamp(item) > deletedAt
  })
}

/**
 * The stamp hosts merge on. Exported so restore.ts counts against the same
 * number the merge resolved on rather than a second, drifting copy of it.
 */
export const hostStamp = (h: Host): number => h.updatedAt ?? h.lastUsedAt ?? h.createdAt

/**
 * Pure, so it can be tested without a network or a database — which matters,
 * because this is where data gets lost if it's wrong.
 */
export function mergeVault(local: VaultDocument, remote: VaultDocument): VaultDocument {
  const tombstones = { ...remote.tombstones }
  for (const [id, at] of Object.entries(local.tombstones)) {
    tombstones[id] = Math.max(tombstones[id] ?? 0, at)
  }

  return {
    // updatedAt first: it is the only field an edit moves. lastUsedAt and
    // createdAt are the fallback for records written before that field existed,
    // and both are stable across an edit — which is why they cannot be the
    // primary stamp. See mergeById on what a stationary stamp costs.
    hosts: mergeById(local.hosts, remote.hosts, hostStamp, tombstones),
    // Keys are immutable once created, so createdAt is a stable tiebreak.
    keys: mergeById(local.keys, remote.keys, (k) => k.createdAt, tombstones),
    // A pin's lastSeenAt moves, but pinnedAt is what identifies the decision.
    // Take the most recently *pinned* record: re-pinning after a deliberate
    // unpin must win over an older copy still carrying the previous key.
    hostKeys: mergeById(local.hostKeys, remote.hostKeys, (k) => k.pinnedAt, tombstones),
    // Snippets carry updatedAt for the same reason hosts do, and saveSnippet is
    // responsible for moving it. The `?? []` is for documents written before
    // snippets existed:
    // the pull path already fills the gap, but this function is exported and
    // pure, and losing a whole record kind to an undefined is not a failure mode
    // worth leaving open.
    snippets: mergeById(
      local.snippets ?? [],
      remote.snippets ?? [],
      (s) => s.updatedAt,
      tombstones,
    ),
    tombstones,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  }
}

/* ----------------------------------------------------------- local state --- */

/**
 * Everything this device holds, as a document.
 *
 * Exported for restore.ts, which needs the same two steps against a decrypted
 * file rather than against the server. It used to keep private copies of both;
 * the file header there explains why, and the answer it gave — "exporting them
 * from sync.ts would be the better fix the day anything else needs them" — came
 * due when the prune below had to exist in both.
 */
export async function readLocalVault(): Promise<VaultDocument> {
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

/**
 * Writes a merged document over local storage: upserts what it contains, and
 * removes what it does not.
 *
 * `previous` is the local document the merge was computed from, and the removal
 * half cannot be done without it. A record it holds that `merged` does not is a
 * record a tombstone deleted — mergeById filters exactly those — and that is the
 * only way a record leaves the document.
 *
 * The removal used to be missing, and its absence made deletes one-directional
 * in a way nothing reported. The merge dropped the record, so the push was
 * right and the server was right and every other device that had never seen it
 * was right; the one device still holding it in IndexedDB simply kept it,
 * forever, because every list on screen reads IndexedDB and not the document.
 * Delete a host on your phone and it was still on your laptop, every sync
 * agreeing that it was gone. mergeVault has had a test asserting "a snippet
 * deleted on one device disappears from the other" all along — true of the
 * merge, and not true of the product, because nothing carried the answer the
 * last few inches.
 *
 * Worst of the four is a key: a portable key deleted on one device stayed in
 * this browser and stayed able to sign. Second worst is a pin, which is the
 * case tombstones were introduced for — an unpinned server stayed rejected here
 * however many times it was unpinned elsewhere.
 *
 * Bounded by construction: only ids `previous` held are considered, so a record
 * written by another tab between the read and here is never touched. Upserts
 * run first, so an interruption leaves a record too many rather than too few.
 */
export async function applyVaultLocally(
  merged: VaultDocument,
  previous: VaultDocument,
): Promise<void> {
  // putHost, not saveHost: saveHost stamps updatedAt with "now", which would
  // restamp every record the server just handed us as a local edit and make the
  // next sync fight this one.
  for (const host of merged.hosts) await putHost(host)
  for (const key of merged.keys) await putStoredKey(fromSyncedKey(key))
  for (const pin of merged.hostKeys) await putPin(pin)
  for (const snippet of merged.snippets ?? []) await putSnippet(snippet)
  await setTombstones(merged.tombstones)

  await removeDeleted(previous.hosts, merged.hosts, forgetHost)
  await removeDeleted(previous.keys, merged.keys, forgetStoredKey)
  await removeDeleted(previous.hostKeys, merged.hostKeys, forgetPin)
  await removeDeleted(previous.snippets ?? [], merged.snippets ?? [], forgetSnippet)
}

/** The ids `before` held and `after` does not, dropped one at a time. */
async function removeDeleted<T extends { id: string }>(
  before: T[],
  after: T[],
  forget: (id: string) => Promise<void>,
): Promise<void> {
  const surviving = new Set(after.map((item) => item.id))
  for (const item of before) {
    if (!surviving.has(item.id)) await forget(item.id)
  }
}

/**
 * Whether this vault key opens a portable key's wrapping.
 *
 * The plaintext exists for the length of this function and is zeroed on the way
 * out; nothing is returned but a boolean. It is asked only of keys this device
 * is about to introduce to the server for the first time — see the withholding
 * in runSync for why that distinction is the whole point.
 */
async function opensWith(key: SyncedKey, vaultKey: CryptoKey): Promise<boolean> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(key.wrapped.iv) },
      vaultKey,
      unb64(key.wrapped.ciphertext),
    )
    new Uint8Array(plaintext).fill(0)
    return true
  } catch {
    return false
  }
}

export interface SyncResult {
  /**
   * What this cycle actually did, not what it usually does:
   *
   *   synced            the merged document was pushed and became the new version
   *   up-to-date        nothing here differed from the server, so nothing was written
   *   conflict-resolved another device wrote between our pull and our push, and
   *                     this is the result of re-reading and merging on top of it
   *   offline           the server could not be reached; nothing was pushed
   */
  status: "synced" | "up-to-date" | "conflict-resolved" | "offline"
  version: number
  hosts: number
  keys: number
  hostKeys: number
  snippets: number
  /**
   * Portable keys this device holds that the current vault key cannot open, and
   * that the server has never seen, so they were kept out of the push.
   *
   * This is the residue of a password change that happened while this device was
   * offline: the key was wrapped under the old vault key and never uploaded, and
   * the re-key could only re-wrap what the server was holding. Uploading it
   * would put ciphertext nothing can open into the canonical vault and copy it
   * to every device, where it lists as a healthy key that silently never signs.
   * Withholding keeps the damage on the one device that already has it and lets
   * the keys page say so.
   */
  keysWithheld: number
}

/**
 * One full sync cycle. Safe to call repeatedly; a 409 means another device
 * wrote first, so we re-read, merge, and retry rather than overwrite.
 */
export async function syncVault(vaultKey: CryptoKey): Promise<SyncResult> {
  return runSync(vaultKey, 2, false)
}

async function runSync(
  vaultKey: CryptoKey,
  retries: number,
  afterConflict: boolean,
): Promise<SyncResult> {
  const state = await getState()

  let res: Response
  try {
    res = await fetch("/api/vault", { cache: "no-store" })
  } catch {
    return {
      status: "offline",
      version: state.version,
      hosts: 0,
      keys: 0,
      hostKeys: 0,
      snippets: 0,
      keysWithheld: 0,
    }
  }
  if (res.status === 401) throw new Error("not signed in")
  if (!res.ok) throw new Error(`vault pull failed: ${res.status}`)

  const pulled = (await res.json()) as { version: number; blob: string | null }

  const remote: VaultDocument = pulled.blob
    ? {
        ...emptyDoc(),
        ...(await decryptVault<VaultDocument>(vaultKey, JSON.parse(pulled.blob) as VaultEnvelope)),
      }
    : emptyDoc()

  const local = await readLocalVault()
  const merged = mergeVault(local, remote)
  await applyVaultLocally(merged, local)

  // A key the server already holds is pushed back unchanged even if it does not
  // open — it is the only copy of that ciphertext, and dropping it from the
  // document would delete it everywhere. Only keys this device would be
  // *introducing* are checked, because those are the ones a stale wrapping can
  // still be kept out of.
  const known = new Set(remote.keys.map((k) => k.id))
  const publishable: SyncedKey[] = []
  let keysWithheld = 0
  for (const key of merged.keys) {
    if (known.has(key.id) || (await opensWith(key, vaultKey))) publishable.push(key)
    else keysWithheld++
  }

  const outgoing: VaultDocument = { ...merged, keys: publishable }

  // Nothing to say and nothing to write. Skipped only when the server already
  // holds a document: on a brand-new account the first push is what creates one,
  // and an account with no blob at all has an export button that says there is
  // nothing to export.
  if (pulled.blob && sameRecords(outgoing, remote)) {
    await setState({ version: pulled.version, lastSyncedAt: Date.now() })
    return {
      status: "up-to-date",
      version: pulled.version,
      hosts: merged.hosts.length,
      keys: merged.keys.length,
      hostKeys: merged.hostKeys.length,
      snippets: merged.snippets.length,
      keysWithheld,
    }
  }

  const envelope = await encryptVault(vaultKey, outgoing)
  const put = await fetch("/api/vault", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blob: JSON.stringify(envelope), baseVersion: pulled.version }),
  })

  if (put.status === 409) {
    if (retries <= 0) throw new Error("vault sync kept conflicting; try again")
    // The retry carries the fact that a conflict happened, so the status
    // reports one only when one occurred rather than inferring it from the
    // version number — every vault past its first write has a non-zero version,
    // which made "conflict-resolved" the label on every ordinary sync.
    return runSync(vaultKey, retries - 1, true)
  }
  if (!put.ok) throw new Error(`vault push failed: ${put.status}`)

  const { version } = (await put.json()) as { version: number }
  await setState({ version, lastSyncedAt: Date.now() })

  return {
    status: afterConflict ? "conflict-resolved" : "synced",
    version,
    hosts: merged.hosts.length,
    keys: merged.keys.length,
    hostKeys: merged.hostKeys.length,
    snippets: merged.snippets.length,
    keysWithheld,
  }
}

/**
 * Whether a merge produced anything the server does not already hold.
 *
 * updatedAt is excluded deliberately: localDocument stamps it with Date.now() on
 * every call, so comparing it would report a difference on every sync and the
 * up-to-date state would be unreachable. The records and the tombstones are the
 * content; the order is stable because mergeById always inserts the remote side
 * first.
 */
function sameRecords(a: VaultDocument, b: VaultDocument): boolean {
  const shape = (d: VaultDocument) =>
    JSON.stringify([d.hosts, d.keys, d.hostKeys, d.snippets ?? [], d.tombstones])
  return shape(a) === shape(b)
}
