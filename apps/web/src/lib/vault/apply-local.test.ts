import { beforeEach, describe, expect, test } from "bun:test"

/**
 * The half of vault sync that touches this device.
 *
 * mergeVault is pure and has its own tests, and they were not enough: every one
 * of them asserts a property of the *document* ("a snippet deleted on one device
 * disappears from the other"), and the document is not what any page reads. The
 * pages read IndexedDB. Between the two sits applyVaultLocally, which for a long
 * time only ever wrote — so a record the merge dropped stayed in this browser
 * forever while every sync agreed it was gone.
 *
 * So this file drives the real lib/idb.ts, lib/hosts.ts, lib/keys.ts,
 * lib/hostkeys.ts and lib/snippets.ts against a fake IndexedDB, and asserts on
 * what a page would see afterwards rather than on the document. Testing it any
 * other way means reimplementing the thing under test.
 */

/* ------------------------------------------------------ a fake IndexedDB --- */

/**
 * Enough of IndexedDB for lib/idb.ts, and no more: open with an upgrade, a
 * transaction, and get/getAll/put/delete/clear.
 *
 * Callbacks fire in a microtask because that is the contract the real API has
 * and the code depends on — `req.onsuccess` is assigned on the line *after* the
 * request is created, so a shim that called back synchronously would call
 * nothing at all and every await here would hang.
 *
 * Values are stored by reference rather than structured-cloned. That is a
 * divergence from the real thing and it is the safe direction for this file:
 * nothing here mutates a record after storing it, and cloning would only mask a
 * bug where something did.
 */
interface FakeRequest<T> {
  result: T
  error: unknown
  onsuccess: (() => void) | null
  onerror: (() => void) | null
  onupgradeneeded?: (() => void) | null
}

function request<T>(produce: () => T): FakeRequest<T> {
  const req: FakeRequest<T> = {
    result: undefined as T,
    error: null,
    onsuccess: null,
    onerror: null,
  }
  queueMicrotask(() => {
    try {
      req.result = produce()
      req.onsuccess?.()
    } catch (e) {
      req.error = e
      req.onerror?.()
    }
  })
  return req
}

function installFakeIndexedDB() {
  const stores = new Map<string, Map<string, unknown>>()

  const objectStore = (name: string) => ({
    get: (key: string) => request(() => stores.get(name)?.get(key)),
    getAll: () => request(() => [...(stores.get(name)?.values() ?? [])]),
    put: (value: unknown, key: string) =>
      request(() => {
        stores.get(name)?.set(key, value)
        return key
      }),
    delete: (key: string) =>
      request(() => {
        stores.get(name)?.delete(key)
        return undefined
      }),
    clear: () =>
      request(() => {
        stores.get(name)?.clear()
        return undefined
      }),
  })

  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      stores.set(name, new Map())
      return objectStore(name)
    },
    transaction: (_name: string, _mode: string) => ({ objectStore }),
  }

  ;(globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const req: FakeRequest<typeof db> = {
        result: db,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      }
      queueMicrotask(() => {
        req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  }
}

// Before any import below is *called* — lib/idb.ts opens lazily, so this is in
// time, and it has to run before the first store operation rather than before
// the import itself.
installFakeIndexedDB()

import { forgetHost, listHosts, putHost, saveHost, type Host } from "@/lib/hosts"
import { listPins, pin, putPin, type PinnedHostKey } from "@/lib/hostkeys"
import { idbClear } from "@/lib/idb"
import { listStoredKeys, putStoredKey, type StoredKey } from "@/lib/keys"
import { listSnippets, saveSnippet } from "@/lib/snippets"

import { applyVaultLocally, mergeVault, readLocalVault, type VaultDocument } from "./sync"
import { recordDeletion } from "./tombstones"

/* ------------------------------------------------------------- fixtures --- */

const emptyRemote = (over: Partial<VaultDocument> = {}): VaultDocument => ({
  hosts: [],
  keys: [],
  hostKeys: [],
  snippets: [],
  tombstones: {},
  updatedAt: 0,
  ...over,
})

/** A portable key, in the shape IndexedDB holds. Contents are irrelevant here. */
const storedKey = (id: string): StoredKey => ({
  id,
  label: id,
  mode: "portable",
  publicKeyRaw: new Uint8Array([1, 2, 3, 4]).buffer,
  wrapped: {
    iv: new Uint8Array(12).buffer,
    ciphertext: new Uint8Array([9, 9, 9]).buffer,
  },
  createdAt: 1_000,
})

/**
 * One sync's worth of local work: read what this device holds, merge the
 * server's document into it, write the result back. Exactly what runSync does
 * either side of the network.
 */
async function syncAgainst(remote: VaultDocument) {
  const local = await readLocalVault()
  const merged = mergeVault(local, remote)
  await applyVaultLocally(merged, local)
  return merged
}

beforeEach(async () => {
  for (const store of ["hosts", "keys", "hostkeys", "vault"] as const) {
    await idbClear(store)
  }
})

/* ------------------------------------------------------------------ tests --- */

describe("applyVaultLocally", () => {
  test("lands records the server has and this device does not", async () => {
    const host: Host = {
      id: "h1",
      label: "web",
      hostname: "web.example",
      port: 22,
      username: "root",
      createdAt: 100,
    }

    await syncAgainst(emptyRemote({ hosts: [host] }))

    expect((await listHosts()).map((h) => h.id)).toEqual(["h1"])
  })

  test("removes a host another device deleted", async () => {
    // The regression. This device has the host; the server's document does not,
    // and carries the tombstone that says why.
    const saved = await saveHost({
      label: "old box",
      hostname: "old.example",
      port: 22,
      username: "root",
    })
    expect(await listHosts()).toHaveLength(1)

    await syncAgainst(emptyRemote({ tombstones: { [saved.id]: Date.now() + 1_000 } }))

    expect(await listHosts()).toEqual([])
  })

  test("removes a portable key another device deleted", async () => {
    // The worst of the four: until this ran, a key the user had deleted was
    // still in this browser and still able to sign.
    await putStoredKey(storedKey("k1"))
    expect(await listStoredKeys()).toHaveLength(1)

    await syncAgainst(emptyRemote({ tombstones: { k1: Date.now() + 1_000 } }))

    expect(await listStoredKeys()).toEqual([])
  })

  test("removes a host key pin another device unpinned", async () => {
    // The case tombstones were introduced for. A server legitimately rebuilt,
    // unpinned on one device: without this the stale pin survives here and goes
    // on rejecting the rebuilt server.
    await pin("rebuilt.example", 22, { key: "OLD", fingerprint: "SHA256:OLD", type: "ssh-ed25519" })
    expect(await listPins()).toHaveLength(1)

    await syncAgainst(emptyRemote({ tombstones: { "rebuilt.example:22": Date.now() + 1_000 } }))

    expect(await listPins()).toEqual([])
  })

  test("removes a snippet another device deleted", async () => {
    const snippet = await saveSnippet({ name: "cleanup", body: "docker system prune -af" })
    expect(await listSnippets()).toHaveLength(1)

    await syncAgainst(emptyRemote({ tombstones: { [snippet.id]: Date.now() + 1_000 } }))

    expect(await listSnippets()).toEqual([])
  })

  test("keeps a record the merge did not drop", async () => {
    // The other half of the property. A prune that reached one record too far
    // would be worse than the bug it replaces.
    const keep = await saveHost({
      label: "keep",
      hostname: "keep.example",
      port: 22,
      username: "root",
    })
    const drop = await saveHost({
      label: "drop",
      hostname: "drop.example",
      port: 22,
      username: "root",
    })

    await syncAgainst(emptyRemote({ tombstones: { [drop.id]: Date.now() + 1_000 } }))

    expect((await listHosts()).map((h) => h.id)).toEqual([keep.id])
  })

  test("keeps a record edited after the delete", async () => {
    // Re-creating a host on this device after deleting it on another must not be
    // undone. mergeById already decides this; the prune must not second-guess it.
    const host: Host = {
      id: "h1",
      label: "recreated",
      hostname: "web.example",
      port: 22,
      username: "root",
      createdAt: 100,
      updatedAt: 5_000,
    }
    await putHost(host)

    await syncAgainst(emptyRemote({ tombstones: { h1: 4_000 } }))

    expect((await listHosts()).map((h) => h.label)).toEqual(["recreated"])
  })

  test("a delete made here survives its own sync", async () => {
    // The originating device. deleteHost removes the row and writes the
    // tombstone; the sync that follows must not put it back from the server's
    // still-stale copy.
    const host: Host = {
      id: "h1",
      label: "gone",
      hostname: "gone.example",
      port: 22,
      username: "root",
      createdAt: 100,
      updatedAt: 100,
    }
    await putHost(host)
    await forgetHost(host.id)
    await recordDeletion(host.id)

    await syncAgainst(emptyRemote({ hosts: [host] }))

    expect(await listHosts()).toEqual([])
  })

  test("a pin from the server still lands", async () => {
    // Adjacent to the prune and easy to break with it: an id absent from
    // `previous` must be written, not skipped.
    const remote: PinnedHostKey = {
      id: "new.example:22",
      key: "NEW",
      fingerprint: "SHA256:NEW",
      type: "ssh-ed25519",
      pinnedAt: 10,
      lastSeenAt: 10,
    }
    await putPin(remote)
    await idbClear("hostkeys")

    await syncAgainst(emptyRemote({ hostKeys: [remote] }))

    expect((await listPins()).map((p) => p.key)).toEqual(["NEW"])
  })
})
