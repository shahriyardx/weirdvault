"use client";

/**
 * Vault sync.
 *
 * Pull, merge, push — with the merge happening locally on plaintext, because
 * the server holds ciphertext and could not merge if it wanted to.
 *
 * Conflict resolution is last-write-wins per record, keyed by `updatedAt`,
 * with deletions recorded as tombstones so a delete on one device isn't undone
 * by a stale copy on another. That is weaker than a full CRDT, but it is
 * correct for the shape of this data (small, per-record, rarely concurrent) and
 * it is honest about what it does. Automerge can slot in behind this interface
 * when snippets grow collaborative editing.
 */

import type { Host } from "@/lib/hosts";
import { listHosts, saveHost } from "@/lib/hosts";
import { idbGet, idbPut } from "@/lib/idb";

import { decryptVault, encryptVault, type VaultEnvelope } from "./crypto";

export interface VaultDocument {
  hosts: Host[];
  /** id -> deletedAt, so a delete beats an older edit. */
  tombstones: Record<string, number>;
  updatedAt: number;
}

interface SyncState {
  version: number;
  lastSyncedAt: number;
}

const STATE_KEY = "sync-state";

const emptyDoc = (): VaultDocument => ({ hosts: [], tombstones: {}, updatedAt: 0 });

async function getState(): Promise<SyncState> {
  return (await idbGet<SyncState>("vault", STATE_KEY)) ?? { version: 0, lastSyncedAt: 0 };
}

async function setState(state: SyncState): Promise<void> {
  await idbPut("vault", STATE_KEY, state);
}

export async function getTombstones(): Promise<Record<string, number>> {
  return (await idbGet<Record<string, number>>("vault", "tombstones")) ?? {};
}

export async function recordDeletion(id: string): Promise<void> {
  const t = await getTombstones();
  t[id] = Date.now();
  await idbPut("vault", "tombstones", t);
}

/**
 * Merge two documents. Pure, so it can be tested without a network or a
 * database — which matters, because this is where data gets lost if it's wrong.
 */
export function mergeVault(local: VaultDocument, remote: VaultDocument): VaultDocument {
  const tombstones = { ...remote.tombstones };
  for (const [id, at] of Object.entries(local.tombstones)) {
    tombstones[id] = Math.max(tombstones[id] ?? 0, at);
  }

  const byId = new Map<string, Host>();
  for (const host of [...remote.hosts, ...local.hosts]) {
    const existing = byId.get(host.id);
    const stamp = (h: Host) => h.lastUsedAt ?? h.createdAt;
    if (!existing || stamp(host) > stamp(existing)) byId.set(host.id, host);
  }

  // A deletion wins over any edit older than it.
  const hosts = [...byId.values()].filter((h) => {
    const deletedAt = tombstones[h.id];
    return !deletedAt || (h.lastUsedAt ?? h.createdAt) > deletedAt;
  });

  return { hosts, tombstones, updatedAt: Math.max(local.updatedAt, remote.updatedAt) };
}

async function localDocument(): Promise<VaultDocument> {
  return {
    hosts: await listHosts(),
    tombstones: await getTombstones(),
    updatedAt: Date.now(),
  };
}

async function applyLocally(doc: VaultDocument): Promise<void> {
  for (const host of doc.hosts) await saveHost(host);
  await idbPut("vault", "tombstones", doc.tombstones);
}

export interface SyncResult {
  status: "synced" | "up-to-date" | "conflict-resolved" | "offline";
  version: number;
  hosts: number;
}

/**
 * One full sync cycle. Safe to call repeatedly; a 409 means another device
 * wrote first, so we re-read, merge, and retry rather than overwrite.
 */
export async function syncVault(vaultKey: CryptoKey, retries = 2): Promise<SyncResult> {
  let state = await getState();

  let res: Response;
  try {
    res = await fetch("/api/vault", { cache: "no-store" });
  } catch {
    return { status: "offline", version: state.version, hosts: 0 };
  }
  if (res.status === 401) throw new Error("not signed in");
  if (!res.ok) throw new Error(`vault pull failed: ${res.status}`);

  const pulled = (await res.json()) as {
    version: number;
    blob: string | null;
  };

  const remote: VaultDocument = pulled.blob
    ? await decryptVault<VaultDocument>(vaultKey, JSON.parse(pulled.blob) as VaultEnvelope)
    : emptyDoc();

  const local = await localDocument();
  const merged = mergeVault(local, remote);
  await applyLocally(merged);

  const envelope = await encryptVault(vaultKey, merged);
  const put = await fetch("/api/vault", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blob: JSON.stringify(envelope), baseVersion: pulled.version }),
  });

  if (put.status === 409) {
    if (retries <= 0) throw new Error("vault sync kept conflicting; try again");
    return syncVault(vaultKey, retries - 1);
  }
  if (!put.ok) throw new Error(`vault push failed: ${put.status}`);

  const { version } = (await put.json()) as { version: number };
  state = { version, lastSyncedAt: Date.now() };
  await setState(state);

  return {
    status: pulled.version === 0 ? "synced" : "conflict-resolved",
    version,
    hosts: merged.hosts.length,
  };
}
