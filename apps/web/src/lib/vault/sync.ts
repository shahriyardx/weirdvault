"use client";

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
 */

import type { Host } from "@/lib/hosts";
import { listHosts, saveHost } from "@/lib/hosts";
import type { PinnedHostKey } from "@/lib/hostkeys";
import { listPins, putPin } from "@/lib/hostkeys";
import { idbGet, idbPut } from "@/lib/idb";
import { listStoredKeys, putStoredKey, type StoredKey } from "@/lib/keys";

import { decryptVault, encryptVault, type VaultEnvelope } from "./crypto";
import { getTombstones, setTombstones } from "./tombstones";

export { getTombstones, recordDeletion } from "./tombstones";

/** A portable key as it travels: ciphertext plus the public half. */
export interface SyncedKey {
  id: string;
  label: string;
  mode: "portable";
  publicKeyRaw: string; // base64
  wrapped: { iv: string; ciphertext: string }; // base64
  createdAt: number;
}

export interface VaultDocument {
  hosts: Host[];
  keys: SyncedKey[];
  hostKeys: PinnedHostKey[];
  /** id -> deletedAt, so a delete beats an older edit. Shared across kinds. */
  tombstones: Record<string, number>;
  updatedAt: number;
}

interface SyncState {
  version: number;
  lastSyncedAt: number;
}

const STATE_KEY = "sync-state";

const emptyDoc = (): VaultDocument => ({
  hosts: [],
  keys: [],
  hostKeys: [],
  tombstones: {},
  updatedAt: 0,
});

async function getState(): Promise<SyncState> {
  return (await idbGet<SyncState>("vault", STATE_KEY)) ?? { version: 0, lastSyncedAt: 0 };
}

async function setState(state: SyncState): Promise<void> {
  await idbPut("vault", STATE_KEY, state);
}

/* ------------------------------------------------------------- encoding --- */

const b64 = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
};

const unb64 = (s: string): ArrayBuffer => {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

/**
 * Only portable keys travel. A device-bound key is a non-extractable CryptoKey
 * handle with no exportable representation — there is literally nothing to
 * send, which is the property the mode is chosen for.
 */
function toSyncedKey(rec: StoredKey): SyncedKey | null {
  if (rec.mode !== "portable" || !rec.wrapped) return null;
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
  };
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
  };
}

/* ---------------------------------------------------------------- merge --- */

function mergeById<T extends { id: string }>(
  local: T[],
  remote: T[],
  stamp: (item: T) => number,
  tombstones: Record<string, number>,
): T[] {
  const byId = new Map<string, T>();
  for (const item of [...remote, ...local]) {
    const existing = byId.get(item.id);
    if (!existing || stamp(item) > stamp(existing)) byId.set(item.id, item);
  }
  return [...byId.values()].filter((item) => {
    const deletedAt = tombstones[item.id];
    return !deletedAt || stamp(item) > deletedAt;
  });
}

/**
 * Pure, so it can be tested without a network or a database — which matters,
 * because this is where data gets lost if it's wrong.
 */
export function mergeVault(local: VaultDocument, remote: VaultDocument): VaultDocument {
  const tombstones = { ...remote.tombstones };
  for (const [id, at] of Object.entries(local.tombstones)) {
    tombstones[id] = Math.max(tombstones[id] ?? 0, at);
  }

  return {
    hosts: mergeById(local.hosts, remote.hosts, (h) => h.lastUsedAt ?? h.createdAt, tombstones),
    // Keys are immutable once created, so createdAt is a stable tiebreak.
    keys: mergeById(local.keys, remote.keys, (k) => k.createdAt, tombstones),
    // A pin's lastSeenAt moves, but pinnedAt is what identifies the decision.
    // Take the most recently *pinned* record: re-pinning after a deliberate
    // unpin must win over an older copy still carrying the previous key.
    hostKeys: mergeById(local.hostKeys, remote.hostKeys, (k) => k.pinnedAt, tombstones),
    tombstones,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}

/* ----------------------------------------------------------- local state --- */

async function localDocument(): Promise<VaultDocument> {
  const [hosts, stored, hostKeys, tombstones] = await Promise.all([
    listHosts(),
    listStoredKeys(),
    listPins(),
    getTombstones(),
  ]);

  return {
    hosts,
    keys: stored.map(toSyncedKey).filter((k): k is SyncedKey => k !== null),
    hostKeys,
    tombstones,
    updatedAt: Date.now(),
  };
}

async function applyLocally(doc: VaultDocument): Promise<void> {
  for (const host of doc.hosts) await saveHost(host);
  for (const key of doc.keys) await putStoredKey(fromSyncedKey(key));
  for (const pin of doc.hostKeys) await putPin(pin);
  await setTombstones(doc.tombstones);
}

export interface SyncResult {
  status: "synced" | "up-to-date" | "conflict-resolved" | "offline";
  version: number;
  hosts: number;
  keys: number;
  hostKeys: number;
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
    return { status: "offline", version: state.version, hosts: 0, keys: 0, hostKeys: 0 };
  }
  if (res.status === 401) throw new Error("not signed in");
  if (!res.ok) throw new Error(`vault pull failed: ${res.status}`);

  const pulled = (await res.json()) as { version: number; blob: string | null };

  const remote: VaultDocument = pulled.blob
    ? {
        ...emptyDoc(),
        ...(await decryptVault<VaultDocument>(vaultKey, JSON.parse(pulled.blob) as VaultEnvelope)),
      }
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
    keys: merged.keys.length,
    hostKeys: merged.hostKeys.length,
  };
}
