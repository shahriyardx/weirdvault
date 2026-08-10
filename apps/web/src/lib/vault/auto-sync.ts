"use client"

import * as React from "react"

import { getVaultKey, useVaultUnlocked } from "./session"
import { syncVault, type SyncResult } from "./sync"

/**
 * When the vault syncs, as opposed to how.
 *
 * sync.ts has always known how to reconcile two devices. What was missing is
 * anything that decided to run it: `syncVault` was called from four places, and
 * every one of them was on the far side of a *write* — importing an ssh_config,
 * generating a key, saving a snippet, finishing an SSH connection. There was no
 * caller anywhere that ran on the way in.
 *
 * A push-only schedule is not a slow sync, it is not a sync. Add a host on your
 * desktop and it is pushed; open the app on your laptop and nothing pulls it, so
 * the host is not there — not late, absent — and it stays absent until that
 * laptop happens to perform a write of its own, which merges the server's copy
 * in as a side effect of pushing its own. Two devices could therefore each hold
 * a full vault, each be perfectly in sync with the server by their own
 * reckoning, and show completely different lists. That is what this module
 * exists to end.
 *
 * ── When
 *
 * On unlock, first and most importantly. The vault key lives in tab memory and
 * dies on every reload, so unlocking is what every session begins with and it is
 * the moment the app first *can* read the server's copy. "Sign in and everything
 * is there" is that one trigger.
 *
 * On focus and on coming back online, because a tab left open for a day is the
 * other half of the same expectation — you changed something on your phone and
 * came back to the laptop that was already sitting there.
 *
 * On a slow timer, as the backstop for a tab that is open and never focused,
 * which is the ordinary state of a terminal you are working in.
 *
 * And after every local write, which is what the existing callers were doing and
 * remains right — a change should leave for the other devices immediately, not
 * in five minutes.
 *
 * ── Coalescing, and why it is not optional
 *
 * All four triggers can land together: unlocking a vault in a tab that has just
 * regained focus while a save is in flight. Concurrent syncs are not merely
 * wasteful — each pushes with the `baseVersion` it pulled, so the second gets a
 * 409, re-reads, merges and retries, and two devices doing this at once can
 * spend several round trips converging on the answer one sync would have
 * reached. So there is at most one in flight, and callers arriving mid-sync
 * receive the running one.
 *
 * That does mean a caller can be handed a sync that started fractionally before
 * its own write landed. `pushLocalChange` is the entry point for that case: it
 * always ends with a sync that began after the caller's write.
 *
 * ── Quiet by default
 *
 * A background sync reports nothing. It runs on a timer and on window focus, and
 * a toast on either would be the app interrupting to say it did the thing it
 * exists to do. Failures are logged, not shown: being offline is a normal state
 * for this product and the next trigger retries. The explicit paths — import,
 * key generation — keep their own messages, because there a person pressed a
 * button and is owed an answer.
 */

/** The backstop for a tab that is open and never focused. */
const IDLE_INTERVAL_MS = 5 * 60 * 1000

/* ------------------------------------------------------------ subscribers --- */

/**
 * Bumped after every sync that landed anything locally.
 *
 * Pages read hosts, keys and snippets out of IndexedDB into React state, so a
 * sync that writes to IndexedDB is invisible to them until they read again.
 * Without this, pulling a host on unlock would put it in the store and leave the
 * page showing the list it rendered a moment earlier — the data would be there
 * and the screen would still be wrong, which is a worse failure than not
 * syncing, because nothing about it suggests where to look.
 */
let revision = 0
const listeners = new Set<() => void>()

function bump() {
  revision += 1
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * A number that changes when the vault has landed something new locally.
 *
 * Depend on it from an effect that re-reads the store. It is a counter rather
 * than the data itself because the three pages read three different shapes, and
 * a module that held all of them would be a second cache to keep honest.
 */
export function useVaultRevision(): number {
  return React.useSyncExternalStore(
    subscribe,
    () => revision,
    // Server render: nothing has synced, and nothing that reads this is
    // rendered on the server anyway.
    () => 0,
  )
}

/* ------------------------------------------------------------------ syncing --- */

let inFlight: Promise<SyncResult | null> | null = null

/**
 * Sync now, or join the sync already running.
 *
 * Returns null when the vault is locked, which is not a failure: the key is what
 * decrypts the server's copy, and there is nothing useful to do without it. The
 * unlock itself is a trigger, so a caller that finds the vault shut can simply
 * return.
 */
export function syncNow(): Promise<SyncResult | null> {
  if (inFlight) return inFlight

  const vaultKey = getVaultKey()
  if (!vaultKey) return Promise.resolve(null)

  inFlight = syncVault(vaultKey)
    .then((result) => {
      // "up-to-date" means the merge matched what the server already held, so
      // nothing was written here either and nothing needs re-reading.
      if (result.status !== "up-to-date") bump()
      return result
    })
    .catch((e: unknown) => {
      // Offline is reported as a status rather than a throw, so reaching here
      // means something else: a 409 that would not settle, a blob this build
      // cannot read, a wrong key. Worth a line in the console and not worth a
      // dialog over — the next trigger tries again.
      console.warn("vault sync failed", e instanceof Error ? e.message : e)
      return null
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

/**
 * Push a change this device just made.
 *
 * Differs from `syncNow` in one way that matters: it will not hand back a sync
 * that started before the write it is being called for. A save and a focus event
 * arriving together would otherwise let the save join a sync that had already
 * read local state, and the change would sit here until some later trigger — the
 * exact "it is on my desktop and not on my laptop" this module exists to stop.
 */
export async function pushLocalChange(): Promise<SyncResult | null> {
  if (inFlight) await inFlight.catch(() => null)
  return syncNow()
}

/* ---------------------------------------------------------------- the driver --- */

/**
 * Runs the schedule. Mounted once, in the dashboard layout.
 *
 * Renders nothing: it is a lifecycle, not a control. Putting it in the layout
 * rather than in each page means a page added next month inherits it, and means
 * the timer is not reset by navigating between Hosts and Keys.
 */
export function VaultSync(): null {
  const unlocked = useVaultUnlocked()

  React.useEffect(() => {
    if (!unlocked) return

    // The one that answers "sign in and everything is there". Unlocking is the
    // first moment the server's copy can be read at all.
    void syncNow()

    const onFocus = () => {
      void syncNow()
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncNow()
    }

    window.addEventListener("focus", onFocus)
    window.addEventListener("online", onFocus)
    document.addEventListener("visibilitychange", onVisible)
    const timer = window.setInterval(() => void syncNow(), IDLE_INTERVAL_MS)

    return () => {
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("online", onFocus)
      document.removeEventListener("visibilitychange", onVisible)
      window.clearInterval(timer)
    }
  }, [unlocked])

  return null
}
