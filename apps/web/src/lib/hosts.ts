"use client";

/**
 * Host records.
 *
 * Stored locally in IndexedDB and, when the vault is unlocked, mirrored into
 * the encrypted vault blob that syncs across devices. The server only ever
 * holds the ciphertext, so none of this is queryable server-side by design —
 * search happens here, after decryption.
 */

import { idbDelete, idbGetAll, idbPut } from "./idb";
import { recordDeletion } from "./vault/tombstones";

export interface Host {
  id: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  keyId?: string;
  folder?: string;
  tags?: string[];
  createdAt: number;
  lastUsedAt?: number;
}

const STORE = "hosts";

export async function listHosts(): Promise<Host[]> {
  const all = await idbGetAll<Host>(STORE);
  return all.sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));
}

export async function saveHost(
  host: Omit<Host, "id" | "createdAt"> & { id?: string; createdAt?: number },
): Promise<Host> {
  const record: Host = {
    ...host,
    id: host.id ?? crypto.randomUUID(),
    createdAt: host.createdAt ?? Date.now(),
  };
  await idbPut(STORE, record.id, record);
  return record;
}

/**
 * Records a connection.
 *
 * By default this only touches a host that is already saved — connecting to
 * something once should not silently add it to your list. `create` is what the
 * "Save and connect" path passes.
 */
export async function rememberHost(
  fields: Pick<Host, "hostname" | "port" | "username" | "keyId">,
  opts: { create?: boolean } = {},
): Promise<Host | null> {
  const existing = (await listHosts()).find(
    (h) =>
      h.hostname === fields.hostname &&
      h.port === fields.port &&
      h.username === fields.username,
  );
  if (!existing && !opts.create) return null;

  return saveHost({
    ...(existing ?? {}),
    ...fields,
    label: existing?.label ?? `${fields.username}@${fields.hostname}`,
    lastUsedAt: Date.now(),
  });
}

export async function deleteHost(id: string): Promise<void> {
  await idbDelete(STORE, id);
  await recordDeletion(id);
}
