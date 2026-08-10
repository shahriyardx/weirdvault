"use client"

/**
 * Minimal IndexedDB wrapper.
 *
 * IndexedDB is the only browser store that can persist a non-extractable
 * CryptoKey handle, which is why everything local goes through it rather than
 * localStorage.
 */

const DB_NAME = "weirdvault"
const DB_VERSION = 2
const STORES = ["keys", "hosts", "hostkeys", "vault"] as const

export type StoreName = (typeof STORES)[number]

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const req = fn(tx.objectStore(store))
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
  })
}

export const idbGet = <T>(store: StoreName, key: string) =>
  run<T | undefined>(store, "readonly", (s) => s.get(key))

export const idbGetAll = <T>(store: StoreName) => run<T[]>(store, "readonly", (s) => s.getAll())

export const idbPut = <T>(store: StoreName, key: string, value: T) =>
  run<IDBValidKey>(store, "readwrite", (s) => s.put(value, key))

export const idbDelete = (store: StoreName, key: string) =>
  run<undefined>(store, "readwrite", (s) => s.delete(key))

export const idbClear = (store: StoreName) => run<undefined>(store, "readwrite", (s) => s.clear())
