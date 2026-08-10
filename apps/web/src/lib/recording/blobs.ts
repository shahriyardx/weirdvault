import {
  deleteObject,
  getObject,
  objectStore,
  putObject,
  ObjectStoreError,
} from "@/lib/storage/objects";

/**
 * The one place that knows a recording's bytes can be in two places.
 *
 * Four routes read or write a stored envelope — the recording, its shares, the
 * public share endpoint, and account deletion — and every one of them would
 * otherwise carry its own `if (row.storageKey)`. That is the shape a silent
 * divergence takes: five branches, one of which forgets that a bucket can be
 * configured after some rows already exist, and a recording from last month
 * stops playing.
 *
 * So the columns are read through `readBody`, written through `writeBody` and
 * destroyed through `destroyBody`, and none of the routes ask where the bytes
 * are.
 *
 * ── The order, which is the whole design
 *
 * There is no transaction spanning Postgres and a bucket and there cannot be
 * one, so every write is two steps and either can fail. What is chosen is which
 * way a half-failure falls:
 *
 *  - **Creating**: object first, row second. A row pointing at an object that
 *    was never written is a recording in somebody's list that cannot be played.
 *    An object with no row is invisible and costs storage. The second is
 *    recoverable — `scripts/sweep-recordings.mjs` finds it — and the first is
 *    not, so the object goes first and a failed insert takes the object back
 *    out on the way past.
 *  - **Deleting**: object first, row second, for the mirror of the same reason.
 *    And if the object cannot be deleted, the row is left alone and the caller
 *    is told, so that "delete this recording" never reports success while the
 *    ciphertext is still sitting in a bucket. Somebody deleting a transcript is
 *    the last person to lie to about it.
 *
 * ── Reading both, always
 *
 * `readBody` prefers the object and falls back to the column, and that fallback
 * is not migration scaffolding to be removed later. A deployment that runs for
 * a year on Postgres and then configures a bucket keeps every recording it
 * already had; a deployment that turns a bucket off gets its old recordings
 * back rather than a list of dead rows. The check constraint in the schema
 * guarantees a row never has both, so "prefers" never has to arbitrate.
 */

/** The two columns, on either table. */
export interface StoredBody {
  ciphertext: Buffer | null;
  storageKey: string | null;
}

/**
 * Why the bytes could not be produced. The routes turn these into statuses,
 * because a bucket that is down and an object that is gone want different
 * words and — more to the point — different advice about retrying.
 */
export type BodyFailure = "missing" | "unreachable" | "unconfigured";

export class BodyError extends Error {
  readonly kind: BodyFailure;

  constructor(kind: BodyFailure, message: string) {
    super(message);
    this.name = "BodyError";
    this.kind = kind;
  }
}

/**
 * Whether new blobs go to a bucket. Read by nothing but the two writers below
 * and the tests; every reader handles either.
 */
export function storingInBucket(): boolean {
  return objectStore() !== null;
}

/* --------------------------------------------------------------------- read */

/**
 * The envelope a row points at.
 *
 * Returns null when the row genuinely holds no bytes, which is a real state
 * rather than an error: a revoked share is exactly that, and the public route
 * never gets far enough to ask. An object that a key names and the bucket does
 * not have is a different thing and throws, because it means the two systems
 * have drifted and answering "no bytes" would file that under normal.
 */
export async function readBody(row: StoredBody): Promise<Buffer | null> {
  if (row.storageKey === null) return row.ciphertext;

  const store = objectStore();
  if (!store) {
    throw new BodyError(
      "unconfigured",
      "This recording is stored in a bucket and this server has no bucket configured. " +
        "The R2_* variables were set when it was saved and are not set now.",
    );
  }

  let object: Buffer | null;
  try {
    object = await getObject(store, row.storageKey);
  } catch (e) {
    throw new BodyError(
      "unreachable",
      e instanceof ObjectStoreError ? e.message : "the storage bucket could not be reached",
    );
  }

  if (!object) {
    throw new BodyError(
      "missing",
      "The stored recording is no longer in the bucket, so there is nothing left to play. " +
        "The row survives; the bytes do not.",
    );
  }
  return object;
}

/* -------------------------------------------------------------------- write */

/**
 * Puts an envelope wherever this deployment keeps them, and hands back the two
 * columns to insert.
 *
 * The key is passed rather than built here so that the caller owns the naming —
 * a recording and a share have different prefixes and different ids — and so
 * that this function has no opinion about which table it is serving.
 */
export async function writeBody(key: string, blob: Buffer): Promise<StoredBody> {
  const store = objectStore();
  if (!store) return { ciphertext: blob, storageKey: null };

  try {
    await putObject(store, key, blob);
  } catch (e) {
    throw new BodyError(
      "unreachable",
      e instanceof ObjectStoreError ? e.message : "the storage bucket could not be reached",
    );
  }
  return { ciphertext: null, storageKey: key };
}

/**
 * Undoes a `writeBody` whose row never landed.
 *
 * Best-effort and silent about failure on purpose: it runs on a path that is
 * already failing, the caller is about to return an error either way, and the
 * object it could not remove is an orphan the sweep will find. Throwing here
 * would replace a useful error with a less useful one.
 */
export async function discardBody(body: StoredBody): Promise<void> {
  const store = objectStore();
  if (!body.storageKey || !store) return;
  try {
    await deleteObject(store, body.storageKey);
  } catch (e) {
    console.warn(
      `orphaned object ${body.storageKey}: the row was not written and neither was the cleanup`,
      e instanceof Error ? e.message : "unknown error",
    );
  }
}

/**
 * Destroys the bytes a row points at, before the row goes.
 *
 * Throws if it cannot, and the callers let that reach the user as a refusal
 * rather than deleting the row anyway. That is the deliberate half of the
 * trade: a failed delete that leaves everything in place can be retried, and a
 * row deleted over an object that survived cannot be — nothing would be left
 * that knows the object was ever anybody's.
 */
export async function destroyBody(row: StoredBody): Promise<void> {
  if (!row.storageKey) return;

  const store = objectStore();
  if (!store) {
    throw new BodyError(
      "unconfigured",
      "This recording's bytes are in a bucket and this server has no bucket configured, so " +
        "they cannot be destroyed. Deleting the row would leave them there with nothing left " +
        "that knows whose they were.",
    );
  }

  try {
    await deleteObject(store, row.storageKey);
  } catch (e) {
    throw new BodyError(
      "unreachable",
      e instanceof ObjectStoreError ? e.message : "the storage bucket could not be reached",
    );
  }
}

/**
 * The HTTP status a `BodyError` deserves, so four routes agree.
 *
 * 410 for a missing object rather than 404: 404 says "no such recording", which
 * would send somebody looking for a row that is right there in their list. Gone
 * is exactly what happened, and it is the difference between "stop asking" and
 * "try again later" for a caller that has to decide whether to retry.
 */
export function statusForBodyError(e: BodyError): number {
  switch (e.kind) {
    case "missing":
      return 410;
    case "unconfigured":
      return 503;
    case "unreachable":
      return 502;
  }
}
