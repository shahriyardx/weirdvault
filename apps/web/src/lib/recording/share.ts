/**
 * Sharing one recording by link.
 *
 * The stored recording is sealed with the owner's vault key, and that key opens
 * their hosts, their SSH keys and every other recording they have. It can never
 * go in a link, so sharing is not a pointer to the blob we already hold. It is a
 * second, narrower copy:
 *
 *  1. the owner's tab decrypts the recording with the vault key,
 *  2. it generates a fresh 256-bit AES-GCM key that exists only for this share,
 *  3. it re-encrypts this one transcript under that key,
 *  4. it uploads that ciphertext as a row of its own, and
 *  5. the key goes in the URL fragment.
 *
 * A fragment is never sent in an HTTP request, so the key does not reach us: not
 * in the request line, not in a proxy log, not in a Referer header — and the
 * Referer is `no-referrer` here anyway. What we end up holding is a second blob
 * we cannot read, which is the same arrangement as the vault and costs a second
 * copy of the bytes. That is why a share counts against the account's recording
 * storage exactly as the original does.
 *
 * The token in the path and the key in the fragment are independent random
 * values, and they are minted on different machines to keep them that way: the
 * owner route generates the token, this module's `newShareKey` generates the
 * key in the tab, and neither side ever sees the other's bytes. Deriving one
 * from the other would let the server compute the key from the token it stores,
 * which would undo the entire construction.
 *
 * What sharing does NOT solve, written here because the UI has to say the same
 * thing: the link is the key. Anyone holding it can watch the recording with no
 * account and no sign-in, and forwarding the link forwards the access. An expiry
 * and an optional view limit are the only real controls, which is why an expiry
 * is required rather than offered. Revocation stops the next fetch and nothing
 * more — it cannot un-download a copy somebody already has, and the person
 * holding the link still holds a key.
 *
 * A note on layering, because it is load-bearing. This is deliberately not a
 * Client Component module: the owner route reads the ceilings and mints tokens
 * from here, and the alternative was the route keeping its own copy of numbers
 * the share dialog states — which is how a page ends up advertising a limit the
 * code does not enforce. Everything from `sealForShare` downwards touches
 * lib/vault/crypto and lib/recording/format, both of which *are* Client
 * Component modules, so those functions only ever run in a tab. The base64url
 * pair below is written out rather than built on `toB64` for the same reason:
 * token minting happens on the server, where that module is a client boundary.
 */

import { decryptVault, encryptVault, type VaultEnvelope } from "@/lib/vault/crypto";
import { decodeCast, encodeCast, type Cast } from "./format";

/* ------------------------------------------------------------------ limits */

/** AES-256-GCM. 32 bytes is 43 base64url characters, which is a short link. */
const SHARE_KEY_BYTES = 32;

/**
 * The path segment. 32 random bytes rather than a UUID's 122 bits, because the
 * token is the only thing standing between a stranger and a request for the
 * ciphertext — the key is the second lock, but the first one should not be the
 * weaker of the two by an order of magnitude for no reason.
 */
const SHARE_TOKEN_BYTES = 32;

export interface ShareExpiry {
  id: string;
  label: string;
  ms: number;
}

/**
 * How long a link may live. The longest is the ceiling the route enforces, so
 * the dialog cannot offer a window the server would refuse.
 *
 * Thirty days at the top is a judgement rather than a law, and the reasoning is:
 * a link pasted into an incident ticket should still open when somebody reads
 * the ticket a few weeks later, and a link nobody remembers making should stop
 * working inside an on-call rotation rather than outliving the job. There is
 * also a storage argument — the share is a second copy of the recording sitting
 * against the account's ceiling — and an honesty argument, which is that a
 * "never expires" option would be a control that controls nothing.
 */
export const SHARE_EXPIRIES: ShareExpiry[] = [
  { id: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
  { id: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
];

/** Derived, not retyped, so the offered windows and the enforced one agree. */
export const MAX_SHARE_TTL_MS = Math.max(...SHARE_EXPIRIES.map((e) => e.ms));

/**
 * The largest view limit that is still a limit. Past a thousand the number is
 * decoration — the link is public to whoever holds it, and somebody who needs a
 * recording watched a thousand times wants an expiry, not a counter.
 */
export const MAX_SHARE_VIEWS = 1000;

/* --------------------------------------------------------------- failures */

/**
 * Why a share could not be opened. The viewer has to distinguish these because
 * they are different situations for the person holding the link: a link that
 * arrived without its fragment is a broken paste, a key that does not decode is
 * a truncated one, a key that decodes but does not open the blob belongs to a
 * different share, and a 404 means the link is finished. One message for all
 * four would send three of those people looking for the wrong problem.
 */
export type ShareFailure =
  | "missing-key"
  | "unreadable-key"
  | "wrong-key"
  | "gone"
  | "network"
  | "unauthorized"
  | "server";

export class ShareError extends Error {
  readonly kind: ShareFailure;

  constructor(kind: ShareFailure, message: string) {
    super(message);
    this.name = "ShareError";
    this.kind = kind;
  }
}

/* -------------------------------------------------------------- base64url */

/** The base64url alphabet, unpadded. Anything else is not one of our values. */
const B64URL = /^[A-Za-z0-9_-]+$/;

export function toB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // `+/` are the two standard-base64 characters that a URL or a chat client may
  // mangle, and `=` padding is noise in a fragment that has a fixed length.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes base64url, refusing anything that is not exactly that.
 *
 * The strict alphabet check is the point. Without it a standard-base64 string
 * would decode here by accident, and so would a link somebody had half-fixed by
 * hand — both of which produce a key that is wrong in a way that then looks like
 * a decryption failure rather than a broken link.
 */
export function fromB64Url(text: string): Uint8Array {
  if (!B64URL.test(text)) throw new ShareError("unreadable-key", "not base64url");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new ShareError("unreadable-key", "not base64url");
  }
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/* ----------------------------------------------------------------- values */

/**
 * The path segment, minted on the server.
 *
 * Takes no arguments, and that is deliberate rather than incidental: a function
 * that cannot see the key cannot be quietly changed into one that derives the
 * token from it. share.test.ts asserts the arity for that reason.
 */
export function newShareToken(): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(SHARE_TOKEN_BYTES)));
}

/**
 * The share key, minted in the tab. Also argument-free, for the same reason.
 *
 * The key has to be exportable exactly once — there is no link without its
 * base64url — so it is generated extractable, exported immediately, and
 * re-imported non-extractable, and the extractable handle is dropped. That is
 * the same one-instant window lib/keys.ts opens to wrap a portable SSH key, and
 * it buys the same thing: from the caller's first sight of this key, neither our
 * code nor anything injected into the page can read the bytes back out.
 *
 * `material` is the only copy that ever exists as a string. Nothing here stores
 * it; the caller puts it in a link, shows the link once, and lets it go.
 */
export async function newShareKey(): Promise<{ key: CryptoKey; material: string }> {
  const exportable = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: SHARE_KEY_BYTES * 8 },
    true,
    ["encrypt", "decrypt"],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", exportable));
  const material = toB64Url(raw);
  const key = await importShareKey(material);
  raw.fill(0);
  return { key, material };
}

export async function importShareKey(material: string): Promise<CryptoKey> {
  const raw = fromB64Url(material);
  if (raw.length !== SHARE_KEY_BYTES) {
    throw new ShareError(
      "unreadable-key",
      `the key in this link is ${raw.length} bytes, and a share key is ${SHARE_KEY_BYTES}`,
    );
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/* ------------------------------------------------------------------ links */

/**
 * The link. `origin` is a parameter rather than read from `location` so this is
 * a pure function that a test can check and a server could call.
 */
export function buildShareLink(origin: string, token: string, material: string): string {
  return `${origin}/share/${encodeURIComponent(token)}#k=${material}`;
}

/**
 * The key out of a fragment, or null when there is not one.
 *
 * Parsed as a query string so a later build can add a second fragment parameter
 * without every existing link becoming unreadable. The base64url alphabet has
 * no character that means anything to URLSearchParams, so nothing is escaped on
 * the way in or out.
 */
export function parseShareFragment(hash: string): string | null {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (body === "") return null;
  const key = new URLSearchParams(body).get("k");
  return key === null || key === "" ? null : key;
}

/* --------------------------------------------------------------- envelope */

/**
 * The share envelope's plaintext. Deliberately the same shape the vault copy
 * uses in lib/recording/store.ts, so a reader who has understood one container
 * has understood both and the cast format only ever has one wrapper to grow.
 */
interface SharePayload {
  v: 1;
  cast: string;
}

/**
 * Re-encrypts one transcript under a share key.
 *
 * This calls `encryptVault` with a key that is not the vault key, which reads
 * oddly and is correct: that function takes a CryptoKey and produces the
 * versioned AES-GCM envelope this whole codebase stores, and the envelope shape
 * is worth keeping uniform. Writing AES-GCM out again here would be a second
 * place for an IV mistake to live. Only the key custody differs — this one is
 * born for this share and dies with the link.
 */
export async function sealForShare(key: CryptoKey, cast: Cast): Promise<string> {
  const envelope = await encryptVault(key, {
    v: 1,
    cast: encodeCast(cast),
  } satisfies SharePayload);
  return JSON.stringify(envelope);
}

export async function openShared(key: CryptoKey, blob: string): Promise<Cast> {
  let envelope: VaultEnvelope;
  try {
    envelope = JSON.parse(blob) as VaultEnvelope;
  } catch {
    // Not a key problem. Saying "wrong key" here would send somebody hunting
    // through their link for a character that is fine.
    throw new ShareError("server", "the server returned something that is not a share envelope");
  }

  let payload: SharePayload;
  try {
    payload = await decryptVault<SharePayload>(key, envelope);
  } catch {
    throw new ShareError(
      "wrong-key",
      "the key in this link does not open this recording",
    );
  }

  if (payload.v !== 1) {
    throw new ShareError("server", `unsupported share container v${String(payload.v)}`);
  }
  return decodeCast(payload.cast);
}

/* ---------------------------------------------------------------- the API */

/** One share as the owner route describes it. Never includes the token. */
export interface ShareSummary {
  id: string;
  /** Bytes of the second ciphertext, as the server counted them. */
  sizeBytes: number;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  maxViews: number | null;
  views: number;
  revokedAt: number | null;
  createdAt: number;
}

export interface CreatedShare {
  share: ShareSummary;
  /**
   * The whole link, fragment included. This is the only moment it exists: the
   * key is not stored anywhere, so nothing — here or on the server — can build
   * this string a second time.
   */
  link: string;
}

export interface SharedRecording {
  cast: Cast;
  expiresAt: number;
  /** Including the fetch that just happened. */
  views: number;
  maxViews: number | null;
}

export async function createShare(
  recordingId: string,
  cast: Cast,
  options: { ttlMs: number; maxViews: number | null },
  origin: string,
): Promise<CreatedShare> {
  const { key, material } = await newShareKey();
  const blob = await sealForShare(key, cast);

  const res = await request(`/api/recordings/${encodeURIComponent(recordingId)}/shares`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      blob,
      expiresAt: new Date(Date.now() + options.ttlMs).toISOString(),
      maxViews: options.maxViews,
    }),
  });

  const body = (await res.json()) as { share?: unknown; token?: unknown };
  const share = toSummary(body.share);
  if (!share || typeof body.token !== "string") {
    throw new ShareError("server", "The share was created but the server described it oddly.");
  }

  return { share, link: buildShareLink(origin, body.token, material) };
}

export async function listShares(recordingId: string): Promise<ShareSummary[]> {
  const res = await request(`/api/recordings/${encodeURIComponent(recordingId)}/shares`);
  const body = (await res.json()) as { shares?: unknown };
  if (!Array.isArray(body.shares)) return [];
  return body.shares.flatMap((raw) => {
    const row = toSummary(raw);
    return row ? [row] : [];
  });
}

export async function revokeShare(recordingId: string, shareId: string): Promise<void> {
  await request(
    `/api/recordings/${encodeURIComponent(recordingId)}/shares?share=${encodeURIComponent(shareId)}`,
    { method: "DELETE" },
  );
}

/**
 * Fetches a shared recording and opens it here.
 *
 * The fragment never leaves this function. The URL handed to `fetch` is built
 * from the token alone, so the key is not in the request line, and it is not in
 * any error thrown from here either — an error report that quoted the key would
 * be a way of mailing it to us.
 */
export async function fetchShared(token: string, material: string): Promise<SharedRecording> {
  // Before the fetch, so a link whose key is mangled does not spend a view on a
  // recording it could never have opened.
  const key = await importShareKey(material);

  let res: Response;
  try {
    res = await fetch(`/api/shares/${encodeURIComponent(token)}`, { cache: "no-store" });
  } catch {
    throw new ShareError("network", "The request never reached the server. You may be offline.");
  }

  if (res.status === 404) {
    throw new ShareError("gone", "This link does not open anything.");
  }
  if (!res.ok) {
    throw new ShareError("server", `The server returned ${res.status}.`);
  }

  const body = (await res.json()) as {
    blob?: unknown;
    expiresAt?: unknown;
    views?: unknown;
    maxViews?: unknown;
  };
  if (typeof body.blob !== "string") {
    throw new ShareError("server", "The server returned no recording data.");
  }

  return {
    cast: await openShared(key, body.blob),
    expiresAt: typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN,
    views: typeof body.views === "number" ? body.views : 0,
    maxViews: typeof body.maxViews === "number" ? body.maxViews : null,
  };
}

/* ------------------------------------------------------------------ plumbing */

async function request(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch {
    throw new ShareError("network", "The request never reached the server. You may be offline.");
  }
  if (res.ok) return res;

  if (res.status === 401) {
    throw new ShareError("unauthorized", "This browser is no longer signed in.");
  }
  // The routes answer with a readable `error`, and a refusal the owner could not
  // have predicted — the storage ceiling, chiefly — is worth passing through
  // verbatim rather than flattening into a status code.
  const detail = await res
    .json()
    .then((b: { error?: unknown }) => (typeof b.error === "string" ? b.error : null))
    .catch(() => null);
  throw new ShareError("server", detail ?? `The server returned ${res.status}.`);
}

function toSummary(raw: unknown): ShareSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;

  const expiresAt = typeof r.expiresAt === "string" ? Date.parse(r.expiresAt) : Number.NaN;
  const createdAt = typeof r.createdAt === "string" ? Date.parse(r.createdAt) : Number.NaN;
  if (Number.isNaN(expiresAt) || Number.isNaN(createdAt)) return null;

  return {
    id: r.id,
    sizeBytes: typeof r.sizeBytes === "number" ? r.sizeBytes : 0,
    expiresAt,
    maxViews: typeof r.maxViews === "number" ? r.maxViews : null,
    views: typeof r.views === "number" ? r.views : 0,
    revokedAt: typeof r.revokedAt === "string" ? Date.parse(r.revokedAt) : null,
    createdAt,
  };
}
