"use client"

/**
 * Snippet records.
 *
 * A snippet is a named piece of shell text — one command, or a short script —
 * that you keep because you would otherwise retype it from memory into every
 * new session. Like hosts, snippets live in IndexedDB and are mirrored into the
 * encrypted vault blob, so the server holds them as ciphertext and cannot
 * search, suggest or lint them. Everything the UI does with a snippet happens
 * after decryption, in this tab.
 *
 * A note on where they are stored. Hosts and keys each own an IndexedDB object
 * store; snippets share the "vault" store under a single key holding an id-keyed
 * map. Adding a fifth object store means bumping DB_VERSION in src/lib/idb.ts,
 * which is shared with the rest of the local persistence layer, and a version
 * bump is not something this feature should be making on everyone else's
 * behalf. The map is read and written whole, which is fine at the scale
 * snippets exist at — the entire vault is already serialised as one blob on
 * every sync — but it does mean two tabs writing different snippets in the same
 * instant can lose one of the two writes. Moving to a real store later is a
 * drop-in change to the four helpers below.
 */

import { useEffect, useSyncExternalStore } from "react"

import { idbGet, idbPut } from "./idb"
import { recordDeletion } from "./vault/tombstones"

export interface Snippet {
  id: string
  /** What you call it in the list. Not unique; nothing keys off it. */
  name: string
  /** The text sent to the shell, verbatim. Newlines in here are real newlines. */
  body: string
  description?: string
  tags?: string[]
  createdAt: number
  /** Bumped on every edit. This is the stamp vault merge resolves on. */
  updatedAt: number
}

const STORE = "vault"
const KEY = "snippets"

type SnippetMap = Record<string, Snippet>

/* --------------------------------------------------------------- observers --- */

/**
 * The sidebar shows a snippet count and has no other reason to load snippets,
 * so it needs to hear about writes that happen on the snippets page. A cached
 * count plus a listener set is the smallest thing that works: useSyncExternalStore
 * demands a synchronous snapshot, and IndexedDB cannot give one.
 */
let cachedCount: number | null = null
const listeners = new Set<() => void>()

function publish(count: number) {
  if (cachedCount === count) return
  cachedCount = count
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Reactive snippet count, or 0 until the first read completes. It is a count and
 * not a list on purpose: nothing outside the snippets page needs the bodies, and
 * holding decrypted snippet text in a component that renders on every route
 * would spread the plaintext further than it needs to go.
 */
export function useSnippetCount(): number {
  const count = useSyncExternalStore(
    subscribe,
    () => cachedCount ?? 0,
    // Server render: IndexedDB does not exist there, and neither does the count.
    () => 0,
  )

  useEffect(() => {
    if (cachedCount === null) void listSnippets().catch(() => {})
  }, [])

  return count
}

/* ------------------------------------------------------------------ store --- */

async function readMap(): Promise<SnippetMap> {
  return (await idbGet<SnippetMap>(STORE, KEY)) ?? {}
}

async function writeMap(map: SnippetMap): Promise<void> {
  await idbPut(STORE, KEY, map)
  publish(Object.keys(map).length)
}

export async function listSnippets(): Promise<Snippet[]> {
  const map = await readMap()
  const all = Object.values(map)
  publish(all.length)
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Creates or replaces a snippet.
 *
 * `updatedAt` is set here rather than by the caller because it is what vault
 * merge compares: a device that edits a snippet without moving the stamp would
 * quietly lose the edit to an older copy on the next sync.
 */
export async function saveSnippet(
  snippet: Omit<Snippet, "id" | "createdAt" | "updatedAt"> & {
    id?: string
    createdAt?: number
  },
): Promise<Snippet> {
  const now = Date.now()
  const record: Snippet = {
    ...snippet,
    id: snippet.id ?? crypto.randomUUID(),
    createdAt: snippet.createdAt ?? now,
    updatedAt: now,
  }
  const map = await readMap()
  map[record.id] = record
  await writeMap(map)
  return record
}

/**
 * Writes a snippet exactly as given, stamp included. Used by vault sync when a
 * record arrives from another device — re-stamping it would make every pull look
 * like a local edit and start a stamp war between two devices.
 */
export async function putSnippet(record: Snippet): Promise<void> {
  const map = await readMap()
  map[record.id] = record
  await writeMap(map)
}

export async function deleteSnippet(id: string): Promise<void> {
  const map = await readMap()
  delete map[id]
  await writeMap(map)
  await recordDeletion(id)
}

/**
 * Removes a snippet without recording a deletion. Used by vault sync to land a
 * delete another device decided — see forgetHost in lib/hosts.ts for why the
 * tombstone must not be re-stamped here.
 */
export async function forgetSnippet(id: string): Promise<void> {
  const map = await readMap()
  if (!(id in map)) return
  delete map[id]
  await writeMap(map)
}
