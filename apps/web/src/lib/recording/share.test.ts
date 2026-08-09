import { describe, expect, test } from "bun:test";

import {
  MAX_SHARE_TTL_MS,
  SHARE_EXPIRIES,
  ShareError,
  buildShareLink,
  fromB64Url,
  importShareKey,
  newShareKey,
  newShareToken,
  openShared,
  parseShareFragment,
  sealForShare,
  toB64Url,
} from "./share";
import type { Cast } from "./format";

/**
 * The parts of sharing that can be checked without a server or a tab.
 *
 * Three of these are not really unit tests, they are tripwires. The link
 * carries a decryption key in its fragment, and the properties that make that
 * safe — the key survives the trip verbatim, the token cannot be computed from
 * the key, the key is never in the part of the URL a browser sends — are all
 * properties of code that would keep working after they were broken. A key
 * mangled by a lax base64 decoder still decodes to *something*; a token derived
 * from the key still opens the share. So they are asserted directly.
 */

function cast(): Cast {
  return {
    header: {
      v: 1,
      cols: 80,
      rows: 24,
      startedAt: 1_700_000_000_000,
      durationMs: 1_500,
      label: "an incident",
      host: "web@example.com:22",
    },
    events: [
      { at: 0, kind: "output", bytes: new Uint8Array([0x68, 0x69, 0x0a, 0xff]) },
      { at: 900, kind: "resize", cols: 132, rows: 40 },
    ],
  };
}

/* ---------------------------------------------------------------- base64url */

describe("base64url", () => {
  test("round trips every byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(Array.from(fromB64Url(toB64Url(all)))).toEqual(Array.from(all));
  });

  test("emits nothing that a URL, a shell or a chat client would mangle", () => {
    // 96 bytes so every one of the 64 output characters gets a chance to appear.
    for (let attempt = 0; attempt < 64; attempt++) {
      const encoded = toB64Url(crypto.getRandomValues(new Uint8Array(96)));
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("refuses standard base64 rather than decoding it by accident", () => {
    // `+` and `/` are valid base64 and not valid base64url. Accepting them
    // would mean a key that arrived through some other encoding decodes to the
    // wrong bytes and then presents as a decryption failure.
    expect(() => fromB64Url("ab+d")).toThrow(ShareError);
    expect(() => fromB64Url("ab/d")).toThrow(ShareError);
    expect(() => fromB64Url("abcd=")).toThrow(ShareError);
    expect(() => fromB64Url("not a key")).toThrow(ShareError);
  });
});

/* --------------------------------------------------------------- the key */

describe("the share key", () => {
  test("encodes to a fragment value and imports back to the same key", async () => {
    const { key, material } = await newShareKey();

    // 32 bytes, unpadded, is exactly 43 characters. Asserted because a link
    // that got truncated in transit is the failure this length check catches.
    expect(material).toHaveLength(43);
    expect(fromB64Url(material)).toHaveLength(32);

    const reimported = await importShareKey(material);
    const blob = await sealForShare(key, cast());
    const opened = await openShared(reimported, blob);

    expect(opened.header.label).toBe("an incident");
    expect(opened.header.cols).toBe(80);
    // The 0xff proves the transcript survived as bytes rather than as text.
    expect(Array.from((opened.events[0] as { bytes: Uint8Array }).bytes)).toEqual([
      0x68, 0x69, 0x0a, 0xff,
    ]);
  });

  test("is not extractable once it has been handed back", async () => {
    const { key } = await newShareKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  test("a different key does not open the ciphertext", async () => {
    const mine = await newShareKey();
    const theirs = await newShareKey();
    const blob = await sealForShare(mine.key, cast());

    await expect(openShared(theirs.key, blob)).rejects.toMatchObject({ kind: "wrong-key" });
  });

  test("a key of the wrong length is refused as unreadable, not as wrong", async () => {
    // What a link truncated by a chat client actually looks like. It is a
    // different situation from a key that belongs to another share, and the
    // viewer says so, which it can only do if this stays distinguishable.
    const { material } = await newShareKey();
    await expect(importShareKey(material.slice(0, 20))).rejects.toMatchObject({
      kind: "unreadable-key",
    });
  });
});

/* ----------------------------------------------------- token independence */

describe("the token and the key", () => {
  test("are minted by generators that cannot see each other's input", () => {
    // The real property is that the server cannot compute the key from the
    // token it stores. Randomness cannot be asserted, but this can: neither
    // generator takes an argument, so neither can be derived from the other
    // without a signature change that fails here first.
    expect(newShareToken).toHaveLength(0);
    expect(newShareKey).toHaveLength(0);
  });

  test("never collide and never repeat", async () => {
    const tokens = new Set<string>();
    const keys = new Set<string>();
    for (let i = 0; i < 128; i++) {
      tokens.add(newShareToken());
      keys.add((await newShareKey()).material);
    }
    expect(tokens.size).toBe(128);
    expect(keys.size).toBe(128);
    // Belt and braces: no token is ever equal to a key.
    for (const token of tokens) expect(keys.has(token)).toBe(false);
  });
});

/* --------------------------------------------------------------- the link */

describe("the link", () => {
  test("puts the key after the hash and nowhere else", () => {
    const link = buildShareLink("https://webxterm.test", "TOKEN", "KEYMATERIAL");
    const url = new URL(link);

    expect(url.pathname).toBe("/share/TOKEN");
    expect(url.search).toBe("");
    expect(url.hash).toBe("#k=KEYMATERIAL");
    // The whole construction rests on this: everything a browser sends is the
    // part before the hash, and the key must not appear in it.
    expect(link.slice(0, link.indexOf("#"))).not.toContain("KEYMATERIAL");
  });

  test("round trips a real key through building and parsing", async () => {
    const { material } = await newShareKey();
    const link = buildShareLink("https://webxterm.test", newShareToken(), material);
    expect(parseShareFragment(new URL(link).hash)).toBe(material);
  });

  test("reports a missing fragment as missing rather than as an empty key", () => {
    expect(parseShareFragment("")).toBeNull();
    expect(parseShareFragment("#")).toBeNull();
    expect(parseShareFragment("#k=")).toBeNull();
    // Something else entirely in the fragment is still a link without its key.
    expect(parseShareFragment("#section-two")).toBeNull();
  });

  test("survives a fragment that grows a second parameter", () => {
    expect(parseShareFragment("#k=abc&t=12")).toBe("abc");
    expect(parseShareFragment("#t=12&k=abc")).toBe("abc");
  });
});

/* ------------------------------------------------------------- the ceiling */

describe("the expiry ceiling", () => {
  test("is the longest window the dialog offers", () => {
    // Derived rather than retyped, so the dialog cannot offer a window the
    // route refuses. This asserts the derivation is still a derivation.
    expect(MAX_SHARE_TTL_MS).toBe(Math.max(...SHARE_EXPIRIES.map((e) => e.ms)));
    expect(SHARE_EXPIRIES.every((e) => e.ms > 0)).toBe(true);
  });
});
