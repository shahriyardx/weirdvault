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

/**
 * How a host authenticates.
 *
 * Only the *method* is stored, never the secret. A password host prompts on
 * every connection: writing the password into the vault would trade a real
 * credential for skipping one dialog, and the first thing webxterm does with a
 * password is install a key so it is not needed again.
 */
export type HostAuth = "key" | "password";

export interface Host {
  id: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  /** Defaults to "key" — records written before this field existed are key hosts. */
  auth?: HostAuth;
  keyId?: string;
  folder?: string;
  tags?: string[];
  createdAt: number;
  lastUsedAt?: number;
  /**
   * Bumped by every write that goes through saveHost. This is the stamp the
   * vault merge resolves on, and it exists because nothing else here moves when
   * a host is edited.
   *
   * A host is not a create-once record: renaming one, changing its port, moving
   * it to a folder or pointing it at a different key are all edits in place.
   * Before this field the merge stamped hosts with `lastUsedAt ?? createdAt`,
   * neither of which an edit touches, so an edited host and the server's stale
   * copy of it carried an identical stamp — and mergeById keeps the remote copy
   * on a tie. The edit was silently reverted by the next sync. Snippets already
   * had this field for exactly this reason; hosts were missed because they look
   * like records that are only ever created.
   *
   * Optional because every host written before this existed has no value for
   * it. The merge falls back through lastUsedAt to createdAt for those, which is
   * the old behaviour, and the first edit gives the record a real stamp.
   */
  updatedAt?: number;
}

const STORE = "hosts";

export async function listHosts(): Promise<Host[]> {
  const all = await idbGetAll<Host>(STORE);
  return all.sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));
}

/**
 * A host write made by this device, which is what makes it the newest copy.
 *
 * Always moves updatedAt. Vault sync must therefore *not* use this to land a
 * record pulled from the server — that would restamp a remote record as if this
 * device had just edited it and make every sync a fight. putHost is the verbatim
 * write for that path, exactly as putSnippet is for snippets.
 */
export async function saveHost(
  host: Omit<Host, "id" | "createdAt"> & { id?: string; createdAt?: number },
): Promise<Host> {
  const record: Host = {
    ...host,
    id: host.id ?? crypto.randomUUID(),
    createdAt: host.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  await idbPut(STORE, record.id, record);
  return record;
}

/** Lands a host from the vault exactly as it arrived, stamp included. */
export async function putHost(host: Host): Promise<void> {
  await idbPut(STORE, host.id, host);
}

/**
 * Records a connection.
 *
 * By default this only touches a host that is already saved — connecting to
 * something once should not silently add it to your list. `create` is what the
 * "Save and connect" path passes.
 */
export async function rememberHost(
  fields: Pick<Host, "hostname" | "port" | "username" | "keyId" | "auth">,
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
