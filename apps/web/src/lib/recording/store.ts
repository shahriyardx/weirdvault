"use client";

/**
 * Reading and writing recordings.
 *
 * Everything here is one shape: the cast is serialised, encrypted under the
 * vault key, and only then handed to a route that has no way to open it. It is
 * the same treatment the host list gets and it is not an accident that this
 * module is thin — the interesting part of a zero-knowledge feature is always
 * how little the server is given, and the server is given a blob, a byte count,
 * a duration, a start time, a device id and a blinded host reference.
 *
 * What that costs, said plainly rather than discovered later: the list cannot be
 * sorted by host, searched by anything, or filtered by label, because the label
 * is inside the ciphertext. Sorting by time is what a column the server can read
 * buys you, and that is the whole of it.
 *
 * `sizeBytes` is not sent. The server measures the blob it received, which is
 * both the honest number and the only one worth having — a client-supplied size
 * would be a claim about a quota, and a quota that trusts the party it is
 * counting is not a quota.
 */

import { useEffect, useSyncExternalStore } from "react";

import { decryptVault, encryptVault, type VaultEnvelope } from "@/lib/vault/crypto";
import { decodeCast, encodeCast, type Cast } from "./format";
import { RECORDING_REQUIRES_PRO } from "./limits";

/**
 * The envelope's plaintext. Versioned separately from the cast itself so the
 * container can gain fields — a checksum, a compression flag — without touching
 * the format every stored recording is written in.
 */
interface RecordingPayload {
  v: 1;
  cast: string;
}

/** One row as the list route returns it. Never includes the ciphertext. */
export interface RecordingSummary {
  id: string;
  /** HMAC(auditKey, host|port), resolved to a name locally or not at all. */
  targetRef: string | null;
  deviceId: string | null;
  /** Bytes of ciphertext on the server, as the server counted them. */
  sizeBytes: number;
  durationMs: number;
  /** Milliseconds since the epoch. */
  startedAt: number;
  createdAt: number;
}

export interface NewRecording {
  cast: Cast;
  targetRef: string | null;
  deviceId: string | null;
}

/**
 * Why a request failed, so a caller can offer the right way out. A 401 wants a
 * sign-in link and a dead network wants a retry; one message for both serves
 * neither, and matching on the text of an error is how that promise gets broken
 * the first time somebody rewords it.
 *
 * `plan` is the 402 from a save on a Free account. It is separated from `server`
 * for the same reason and a sharper one: the transcript is still in this tab and
 * a reload destroys it, so the difference between "try again" and "this will
 * never work until you subscribe" decides whether somebody reloads the page.
 */
export type RecordingFailure = "unauthorized" | "network" | "plan" | "server";

export class RecordingRequestError extends Error {
  readonly kind: RecordingFailure;

  constructor(kind: RecordingFailure, message: string) {
    super(message);
    this.name = "RecordingRequestError";
    this.kind = kind;
  }
}

/* ------------------------------------------------------------------- count */

/**
 * The sidebar wants a badge and nothing else, so it gets a count and nothing
 * else. Cached at module scope with a listener set for the same reason snippets
 * does it: useSyncExternalStore needs a synchronous snapshot and a fetch cannot
 * give one. A stale badge after another tab records something is the accepted
 * cost; there is no push channel here to fix it with.
 */
let cachedCount: number | null = null;
const listeners = new Set<() => void>();

function publish(count: number) {
  if (cachedCount === count) return;
  cachedCount = count;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useRecordingCount(): number {
  const count = useSyncExternalStore(
    subscribe,
    () => cachedCount ?? 0,
    // Server render: the count comes from an authenticated fetch this browser
    // makes, so there is nothing to render on the server but zero.
    () => 0,
  );

  useEffect(() => {
    if (cachedCount === null) void listRecordings().catch(() => {});
  }, []);

  return count;
}

/* ------------------------------------------------------------------ fetches */

export interface RecordingPage {
  /** The most recent page of recordings, newest first. */
  recordings: RecordingSummary[];
  /**
   * How many the account has in total, which is not the same as how many came
   * back. The badge and the footer both read this rather than counting the page.
   */
  total: number;
  /**
   * Ciphertext held by the whole account, against the ceiling the route refuses
   * new saves at. Both come from the server rather than being summed over the
   * page, because the page is not the account and the ceiling is not this
   * browser's to decide. Null when a response predates them.
   */
  storedBytes: number | null;
  storageLimitBytes: number | null;
}

export async function listRecordings(): Promise<RecordingPage> {
  const res = await request("/api/recordings");
  const body = (await res.json()) as {
    recordings?: unknown;
    total?: unknown;
    storedBytes?: unknown;
    storageLimitBytes?: unknown;
  };
  const storedBytes = typeof body.storedBytes === "number" ? body.storedBytes : null;
  const storageLimitBytes =
    typeof body.storageLimitBytes === "number" ? body.storageLimitBytes : null;
  if (!Array.isArray(body.recordings)) {
    return { recordings: [], total: 0, storedBytes, storageLimitBytes };
  }

  const rows = body.recordings.flatMap((raw) => {
    const row = toSummary(raw);
    return row ? [row] : [];
  });
  const total = typeof body.total === "number" ? body.total : rows.length;
  publish(total);
  return { recordings: rows, total, storedBytes, storageLimitBytes };
}

/**
 * Fetches one recording and opens it here.
 *
 * The vault key is a parameter rather than read from the session module so that
 * a caller cannot accidentally invoke this while locked and get a confusing
 * decrypt failure instead of a locked-vault message.
 */
export async function loadCast(id: string, vaultKey: CryptoKey): Promise<Cast> {
  const res = await request(`/api/recordings/${encodeURIComponent(id)}`);
  const body = (await res.json()) as { blob?: unknown };
  if (typeof body.blob !== "string") throw new Error("The server returned no recording data.");

  let payload: RecordingPayload;
  try {
    payload = await decryptVault<RecordingPayload>(
      vaultKey,
      JSON.parse(body.blob) as VaultEnvelope,
    );
  } catch {
    // A failure here is almost always the wrong key — a recording made before a
    // password change, on a vault that was re-keyed without it. Saying "corrupt"
    // would send someone looking for a bug that is not there.
    throw new Error(
      "This recording could not be decrypted with the key this tab holds. It was encrypted under a different vault key.",
    );
  }

  if (payload.v !== 1) throw new Error(`Unsupported recording container v${String(payload.v)}.`);
  return decodeCast(payload.cast);
}

export async function saveRecording(
  vaultKey: CryptoKey,
  recording: NewRecording,
): Promise<RecordingSummary> {
  const envelope = await encryptVault(vaultKey, {
    v: 1,
    cast: encodeCast(recording.cast),
  } satisfies RecordingPayload);

  const res = await request("/api/recordings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      blob: JSON.stringify(envelope),
      durationMs: Math.round(recording.cast.header.durationMs),
      startedAt: new Date(recording.cast.header.startedAt).toISOString(),
      targetRef: recording.targetRef,
      deviceId: recording.deviceId,
    }),
  });

  const body = (await res.json()) as { recording?: unknown };
  const summary = toSummary(body.recording);
  if (!summary) throw new Error("The recording was stored but the server described it oddly.");
  publish((cachedCount ?? 0) + 1);
  return summary;
}

export async function deleteRecording(id: string): Promise<void> {
  await request(`/api/recordings/${encodeURIComponent(id)}`, { method: "DELETE" });
  publish(Math.max(0, (cachedCount ?? 1) - 1));
}

/* ------------------------------------------------------------------ plumbing */

async function request(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch {
    throw new RecordingRequestError(
      "network",
      "The request never reached the server. You may be offline.",
    );
  }
  if (res.ok) return res;

  if (res.status === 401) {
    throw new RecordingRequestError("unauthorized", "This browser is no longer signed in.");
  }
  // The routes answer with a readable `error`; passing it through is how a
  // limit the user could not see — an oversized blob, say — arrives as an
  // explanation rather than a number. The `code` is read too, so the plan
  // refusal can be told from every other 402 by something more durable than the
  // status: /api/relay-token answers 402 as well, for a different reason.
  const body = await res
    .json()
    .then((b: { error?: unknown; code?: unknown }) => b)
    .catch(() => ({}) as { error?: unknown; code?: unknown });
  const detail = typeof body.error === "string" ? body.error : null;
  const kind: RecordingFailure =
    body.code === RECORDING_REQUIRES_PRO || res.status === 402 ? "plan" : "server";
  throw new RecordingRequestError(kind, detail ?? `The server returned ${res.status}.`);
}

function toSummary(raw: unknown): RecordingSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;

  const startedAt = typeof r.startedAt === "string" ? Date.parse(r.startedAt) : Number.NaN;
  const createdAt = typeof r.createdAt === "string" ? Date.parse(r.createdAt) : Number.NaN;
  if (Number.isNaN(startedAt) || Number.isNaN(createdAt)) return null;

  return {
    id: r.id,
    targetRef: typeof r.targetRef === "string" ? r.targetRef : null,
    deviceId: typeof r.deviceId === "string" ? r.deviceId : null,
    sizeBytes: typeof r.sizeBytes === "number" ? r.sizeBytes : 0,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
    startedAt,
    createdAt,
  };
}
