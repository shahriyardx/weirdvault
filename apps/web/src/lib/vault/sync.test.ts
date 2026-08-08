import { describe, expect, test } from "bun:test";

import { mergeVault, type VaultDocument } from "./sync";

/**
 * mergeVault is the one place in the product where user data can silently
 * disappear, so it is tested directly rather than through a sync round trip.
 */

const doc = (over: Partial<VaultDocument> = {}): VaultDocument => ({
  hosts: [],
  keys: [],
  hostKeys: [],
  tombstones: {},
  updatedAt: 0,
  ...over,
});

const host = (id: string, at: number) => ({
  id,
  label: id,
  hostname: `${id}.example`,
  port: 22,
  username: "u",
  createdAt: at,
  lastUsedAt: at,
});

const key = (id: string, at: number) =>
  ({
    id,
    label: id,
    mode: "portable" as const,
    publicKeyRaw: "AAAA",
    wrapped: { iv: "aXY=", ciphertext: "Y3Q=" },
    createdAt: at,
  });

const pin = (id: string, keyB64: string, pinnedAt: number) => ({
  id,
  key: keyB64,
  fingerprint: `SHA256:${keyB64}`,
  type: "ssh-ed25519",
  pinnedAt,
  lastSeenAt: pinnedAt,
});

describe("mergeVault", () => {
  test("unions records that exist on only one side", () => {
    const merged = mergeVault(
      doc({ hosts: [host("a", 100)] }),
      doc({ hosts: [host("b", 100)] }),
    );
    expect(merged.hosts.map((h) => h.id).sort()).toEqual(["a", "b"]);
  });

  test("keeps the newer copy when both sides have a record", () => {
    const merged = mergeVault(
      doc({ hosts: [{ ...host("a", 100), label: "local" }] }),
      doc({ hosts: [{ ...host("a", 200), label: "remote" }] }),
    );
    expect(merged.hosts).toHaveLength(1);
    expect(merged.hosts[0].label).toBe("remote");
  });

  test("a deletion beats an older edit", () => {
    const merged = mergeVault(
      doc({ tombstones: { a: 300 } }),
      doc({ hosts: [host("a", 100)] }),
    );
    expect(merged.hosts).toHaveLength(0);
  });

  test("an edit newer than the deletion survives", () => {
    // Otherwise re-creating a host on another device would be undone forever.
    const merged = mergeVault(
      doc({ hosts: [host("a", 400)] }),
      doc({ tombstones: { a: 300 } }),
    );
    expect(merged.hosts).toHaveLength(1);
  });

  test("tombstones from both sides are retained", () => {
    const merged = mergeVault(doc({ tombstones: { a: 1 } }), doc({ tombstones: { b: 2 } }));
    expect(merged.tombstones).toEqual({ a: 1, b: 2 });
  });

  test("the later tombstone wins for the same id", () => {
    const merged = mergeVault(doc({ tombstones: { a: 5 } }), doc({ tombstones: { a: 9 } }));
    expect(merged.tombstones.a).toBe(9);
  });

  test("portable keys sync — the gap this merge exists to close", () => {
    const merged = mergeVault(doc(), doc({ keys: [key("k1", 100)] }));
    expect(merged.keys).toHaveLength(1);
    expect(merged.keys[0].wrapped.ciphertext).toBe("Y3Q=");
  });

  test("host key pins sync so a new device inherits the pin", () => {
    const merged = mergeVault(doc(), doc({ hostKeys: [pin("h:22", "KEY1", 100)] }));
    expect(merged.hostKeys).toHaveLength(1);
    expect(merged.hostKeys[0].key).toBe("KEY1");
  });

  test("a re-pin after an unpin beats the stale pin", () => {
    // The server was legitimately rebuilt: one device unpinned and re-pinned
    // the new key. A device still holding the old pin must not win, or it
    // would reject the rebuilt server forever.
    const merged = mergeVault(
      doc({ hostKeys: [pin("h:22", "NEWKEY", 500)], tombstones: { "h:22": 400 } }),
      doc({ hostKeys: [pin("h:22", "OLDKEY", 100)] }),
    );
    expect(merged.hostKeys).toHaveLength(1);
    expect(merged.hostKeys[0].key).toBe("NEWKEY");
  });

  test("an unpin with no re-pin removes the pin everywhere", () => {
    const merged = mergeVault(
      doc({ tombstones: { "h:22": 400 } }),
      doc({ hostKeys: [pin("h:22", "OLDKEY", 100)] }),
    );
    expect(merged.hostKeys).toHaveLength(0);
  });

  test("merging is symmetric in what it retains", () => {
    const a = doc({ hosts: [host("a", 100)], keys: [key("k", 50)] });
    const b = doc({ hosts: [host("b", 200)], hostKeys: [pin("h:22", "K", 10)] });
    const ab = mergeVault(a, b);
    const ba = mergeVault(b, a);
    expect(ab.hosts.map((h) => h.id).sort()).toEqual(ba.hosts.map((h) => h.id).sort());
    expect(ab.keys.map((k) => k.id)).toEqual(ba.keys.map((k) => k.id));
    expect(ab.hostKeys.map((k) => k.id)).toEqual(ba.hostKeys.map((k) => k.id));
  });

  test("an empty remote never drops local data", () => {
    // The first sync from a fresh account hits this path.
    const local = doc({
      hosts: [host("a", 100)],
      keys: [key("k", 100)],
      hostKeys: [pin("h:22", "K", 100)],
    });
    const merged = mergeVault(local, doc());
    expect(merged.hosts).toHaveLength(1);
    expect(merged.keys).toHaveLength(1);
    expect(merged.hostKeys).toHaveLength(1);
  });
});
