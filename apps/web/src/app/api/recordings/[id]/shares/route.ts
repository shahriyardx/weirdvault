import { and, desc, eq, sql, sum } from "drizzle-orm";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { tierFor } from "@/lib/billing/subscription";
import { canRecordOnTier } from "@/lib/billing/tiers";
import { db, schema } from "@/lib/db";
import {
  BodyError,
  destroyBody,
  discardBody,
  statusForBodyError,
  writeBody,
  type StoredBody,
} from "@/lib/recording/blobs";
import {
  MAX_ACCOUNT_RECORDING_BYTES,
  MAX_BLOB_BYTES,
  RECORDING_REQUIRES_PRO,
} from "@/lib/recording/limits";
import { MAX_SHARE_TTL_MS, MAX_SHARE_VIEWS, newShareToken } from "@/lib/recording/share";
import { shareKey } from "@/lib/storage/objects";

/**
 * The owner's side of sharing: make a link, list the links, cut one off.
 *
 * The public side is /api/shares/[token] and it is a separate file on purpose.
 * ../route.ts says at length why a share token must never become a second way
 * into the owner path, and the converse holds here: nothing in this file
 * authenticates anybody with a token, and nothing in the public file
 * authenticates anybody at all. Two handlers with two authorization stories,
 * neither of which has a branch that reaches the other's data.
 *
 * What is being stored is not the recording. It is a second ciphertext the
 * owner's tab produced by decrypting the recording with the vault key and
 * re-encrypting it under a key generated for this share alone — see
 * lib/recording/share.ts. The vault key never appears in a link because it
 * opens the whole account; this key opens one transcript. The server holds the
 * blob and the token and cannot derive the key from either.
 *
 * The token is minted here rather than sent by the browser, and that is the
 * cheapest possible guarantee that the token and the key are independent: they
 * are generated on different machines, and neither side sees the other's random
 * bytes. A token the client chose would still be fine for the client, but this
 * way the independence is structural rather than a promise about somebody
 * else's code.
 *
 * Authorization follows ../route.ts exactly: the owner is in the WHERE clause,
 * never in a comparison after a read, and a row belonging to someone else
 * answers 404 rather than 403. Every statement here is scoped by both
 * `user_id` and `recording_id`, so a share id from another recording — or
 * another account — matches nothing.
 *
 * The storage ceiling. A share is a second copy of the bytes, so it counts
 * against MAX_ACCOUNT_RECORDING_BYTES the same as the original, and the sum
 * here spans both tables. The same race POST /api/recordings documents applies
 * and is accepted for the same reason: concurrent creates all read the same
 * total and can all be allowed, overshooting by what is in flight, and closing
 * it means locking the account's rows on every write.
 *
 * What is NOT solved: POST /api/recordings sums only the `recording` table, so
 * share copies are invisible to the ceiling on the save path. Until that sum
 * includes this table the ceiling is enforced asymmetrically — a share is
 * refused for space a recording would have been granted. Stated rather than
 * quietly worked around, because the fix belongs in that route.
 *
 * ── The plan gate
 *
 * POST is Pro-only, on the same rule POST /api/recordings applies: a share is a
 * *new* encrypted copy stored on our disk, which is the thing being sold. GET
 * and DELETE are not gated and must not be. Listing a share is how an owner
 * discovers a link they have out; revoking one is how they stop it working, and
 * requiring a subscription to cut off a live link to somebody's terminal session
 * would be indefensible on any reading. A lapsed account can still see and
 * revoke every link it ever made.
 *
 * The recording underneath stays downloadable on any plan, so refusing a new
 * share strands nothing — the transcript can still be exported and sent by hand.
 */

/**
 * Slack on the expiry ceiling, for clock skew between the browser that computed
 * `expiresAt` and the server that checks it. A browser five minutes fast should
 * not have its 30-day link refused for being 30 days and thirty seconds.
 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The columns a listing may return. Never `ciphertext`, and never `token`. */
const SUMMARY = {
  id: schema.recordingShare.id,
  sizeBytes: schema.recordingShare.sizeBytes,
  expiresAt: schema.recordingShare.expiresAt,
  maxViews: schema.recordingShare.maxViews,
  views: schema.recordingShare.views,
  revokedAt: schema.recordingShare.revokedAt,
  createdAt: schema.recordingShare.createdAt,
};

async function requireUser() {
  // Next.js 16: headers() is async-only.
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
}

/** Whether this recording is this user's. Owner in the WHERE clause, as ever. */
async function ownsRecording(userId: string, recordingId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.recording.id })
    .from(schema.recording)
    .where(and(eq(schema.recording.id, recordingId), eq(schema.recording.userId, userId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Ciphertext this account holds across both copies.
 *
 * Two statements rather than a union, because they are two independent sums
 * over two tables and Postgres returns each as a string (a bigint sum over an
 * integer column) or null for an account with no rows.
 */
async function storedBytesFor(userId: string): Promise<number> {
  const [recordings] = await db
    .select({ bytes: sum(schema.recording.sizeBytes) })
    .from(schema.recording)
    .where(eq(schema.recording.userId, userId));
  const [shares] = await db
    .select({ bytes: sum(schema.recordingShare.sizeBytes) })
    .from(schema.recordingShare)
    .where(eq(schema.recordingShare.userId, userId));
  return Number(recordings?.bytes ?? 0) + Number(shares?.bytes ?? 0);
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Next.js 16: route params are async.
  const { id } = await params;

  // The recording is checked first so that a recording belonging to somebody
  // else answers 404 rather than an empty list, which would be a quiet way of
  // saying "that id exists and has no shares".
  if (!(await ownsRecording(user.id, id))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const rows = await db
    .select(SUMMARY)
    .from(schema.recordingShare)
    .where(
      and(
        eq(schema.recordingShare.recordingId, id),
        eq(schema.recordingShare.userId, user.id),
      ),
    )
    .orderBy(desc(schema.recordingShare.createdAt));

  // The token is not in SUMMARY and its absence is the point. Returning it
  // would let this page render most of a link, and most of a link is a thing
  // somebody would try to send — while the half that matters, the key, was
  // dropped the moment the dialog that created it closed. A share is listed so
  // it can be counted and revoked, not so it can be handed out again.
  return Response.json({ shares: rows });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Before the body, so a refusal does not require a re-encrypted copy of the
  // whole transcript to be uploaded first. `tierFor` fails toward access.
  if (!canRecordOnTier(await tierFor(user.id))) {
    return Response.json(
      {
        error:
          "Share links are part of session recording, which is a Pro feature, and this account " +
          "is on Free. Nothing was stored. Links you have already created are unaffected and can " +
          "still be listed and revoked, and the recording itself can still be played and " +
          "downloaded — a downloaded cast can be sent to anyone.",
        code: RECORDING_REQUIRES_PRO,
      },
      { status: 402 },
    );
  }

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { blob, expiresAt, maxViews } = body;

  if (typeof blob !== "string" || blob === "") {
    return Response.json({ error: "blob (string) required" }, { status: 400 });
  }
  const sizeBytes = Buffer.byteLength(blob, "utf8");
  if (sizeBytes > MAX_BLOB_BYTES) {
    return Response.json(
      {
        error: `That share is ${Math.round(sizeBytes / 1024 / 1024)} MB encrypted, and the limit is ${MAX_BLOB_BYTES / 1024 / 1024} MB.`,
      },
      { status: 413 },
    );
  }

  const expires = typeof expiresAt === "string" ? new Date(expiresAt) : null;
  if (!expires || Number.isNaN(expires.valueOf())) {
    return Response.json({ error: "expiresAt must be an ISO timestamp" }, { status: 400 });
  }
  const ttl = expires.valueOf() - Date.now();
  if (ttl <= 0) {
    return Response.json(
      { error: "A link that has already expired is not worth creating." },
      { status: 400 },
    );
  }
  if (ttl > MAX_SHARE_TTL_MS + CLOCK_SKEW_MS) {
    return Response.json(
      {
        error:
          `A share link can live at most ${MAX_SHARE_TTL_MS / 86_400_000} days. The link is the ` +
          "key, so an expiry is the only control that keeps working after the link has been " +
          "forwarded somewhere you cannot see.",
      },
      { status: 400 },
    );
  }

  // Null means unlimited, which is a real answer and not a missing one. Anything
  // that is neither null nor a usable count is a bug in the caller rather than a
  // preference to interpret.
  let views: number | null = null;
  if (maxViews !== undefined && maxViews !== null) {
    if (
      typeof maxViews !== "number" ||
      !Number.isInteger(maxViews) ||
      maxViews < 1 ||
      maxViews > MAX_SHARE_VIEWS
    ) {
      return Response.json(
        { error: `maxViews must be a whole number between 1 and ${MAX_SHARE_VIEWS}, or null` },
        { status: 400 },
      );
    }
    views = maxViews;
  }

  if (!(await ownsRecording(user.id, id))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const storedBytes = await storedBytesFor(user.id);
  if (storedBytes + sizeBytes > MAX_ACCOUNT_RECORDING_BYTES) {
    return Response.json(
      {
        error:
          `Your recordings and share links already hold ${Math.round(storedBytes / 1_000_000)} MB ` +
          `of the ${MAX_ACCOUNT_RECORDING_BYTES / 1_000_000_000} GB this account can store, and a ` +
          "share is a second encrypted copy of the recording rather than a pointer to the first. " +
          "Nothing was deleted to make room — revoke a share you no longer need, or delete a " +
          "recording, and try again.",
      },
      { status: 413 },
    );
  }

  const token = newShareToken();
  // Minted here rather than by the insert, because the object key is built from
  // it and the object is written first. Same ordering as POST /api/recordings,
  // for the reasons in lib/recording/blobs.ts.
  const shareId = crypto.randomUUID();

  let stored: StoredBody;
  try {
    stored = await writeBody(shareKey(user.id, shareId), Buffer.from(blob, "utf8"));
  } catch (e) {
    if (!(e instanceof BodyError)) throw e;
    return Response.json(
      {
        error:
          "The share copy could not be stored, so no link was created: " +
          e.message +
          " The recording itself is untouched.",
      },
      { status: statusForBodyError(e) },
    );
  }

  let row;
  try {
    [row] = await db
      .insert(schema.recordingShare)
      .values({
        id: shareId,
        recordingId: id,
        userId: user.id,
        token,
        ...stored,
        sizeBytes,
        expiresAt: expires,
        maxViews: views,
      })
      .returning(SUMMARY);
  } catch (e) {
    await discardBody(stored);
    throw e;
  }

  // The token travels back exactly once, because it is one half of a link the
  // caller is about to build and then cannot rebuild: the other half is a key
  // that only ever existed in that tab. The listing above never returns it.
  return Response.json({ share: row, token }, { status: 201 });
}

/**
 * Revoking a share.
 *
 * This is a DELETE on the owner's collection rather than a POST to
 * /api/shares/[token]/revoke, and the reason is the shape of the authorization
 * rather than taste. Revoking is an owner action: it needs a session and it
 * needs the row scoped to that session's user. The /api/shares/[token] path
 * exists to serve a stranger who holds a link and has no session at all, and
 * putting an authenticated, destructive handler on that path would mean the one
 * route in the codebase whose whole design is "no session required" also
 * contains a branch that requires one. That is the arrangement ../route.ts
 * warns about, viewed from the other end. It would also make the token — which
 * we deliberately never return to the owner after creation — the identifier for
 * an owner action, which it cannot be.
 *
 * The share id arrives as a query parameter because the collection is already
 * addressed by the recording and, through the session, by the owner; the id
 * only has to pick a member of it.
 *
 * What revocation does, precisely: it stamps `revoked_at` and destroys the
 * second ciphertext. The public route stops serving it, and the bytes go back
 * to the account's storage — a revoked share that still occupied a share of the
 * ceiling would be a penalty for doing the safe thing. What it does not do is
 * recall anything. A viewer who already fetched the transcript has it, and
 * anyone holding the link still holds a working key; there is simply nothing
 * left for it to open. The row itself survives, revoked and empty, so the owner
 * can still see that a link existed and when it was cut off.
 *
 * "Destroys the ciphertext" is one statement about two storage backends, and
 * the second one is why this handler reads before it writes. When the copy is
 * an object, the key has to be known before it can be deleted, and the delete
 * has to succeed before the row stops pointing at it — otherwise revoking would
 * report success over a share copy still sitting in a bucket, and the row that
 * named it would be the last thing that could have found it again.
 *
 * This is also the one place where a presigned URL would have quietly broken a
 * promise. Revocation is enforced when a request arrives at /api/shares/[token];
 * a signed URL minted before it keeps working until it expires, because a bucket
 * has never heard of `revoked_at`. Shares proxy for that reason and not as a
 * preference — see lib/storage/objects.ts.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const shareId = new URL(request.url).searchParams.get("share");
  if (!shareId) {
    return Response.json({ error: "share (query parameter) required" }, { status: 400 });
  }

  // Scoped by share, recording and owner — the same three the UPDATE below
  // carries, so this read grants nothing the write would not have.
  const [existing] = await db
    .select({
      ciphertext: schema.recordingShare.ciphertext,
      storageKey: schema.recordingShare.storageKey,
    })
    .from(schema.recordingShare)
    .where(
      and(
        eq(schema.recordingShare.id, shareId),
        eq(schema.recordingShare.recordingId, id),
        eq(schema.recordingShare.userId, user.id),
      ),
    )
    .limit(1);

  if (!existing) return Response.json({ error: "not found" }, { status: 404 });

  try {
    await destroyBody(existing);
  } catch (e) {
    if (!(e instanceof BodyError)) throw e;
    return Response.json(
      {
        error:
          "The shared copy could not be destroyed, so the link was left working: " +
          e.message +
          " Nothing was changed. Try again — a link reported as revoked while its bytes are " +
          "still fetchable would be worse than this refusal.",
      },
      { status: statusForBodyError(e) },
    );
  }

  // Idempotent: revoking an already-revoked share keeps the original timestamp
  // and succeeds, because the caller's intent — this link must not work — is
  // already true and answering 404 would suggest otherwise. Two revokes racing
  // both delete the object, which S3 treats as idempotent too, and both land
  // here where `coalesce` keeps the first timestamp.
  const revoked = await db
    .update(schema.recordingShare)
    .set({
      revokedAt: sql`coalesce(${schema.recordingShare.revokedAt}, now())`,
      // Null rather than an empty buffer, so that "there are no bytes" has one
      // spelling across both backends and the check constraint holds.
      ciphertext: null,
      storageKey: null,
      sizeBytes: 0,
    })
    .where(
      and(
        eq(schema.recordingShare.id, shareId),
        eq(schema.recordingShare.recordingId, id),
        eq(schema.recordingShare.userId, user.id),
      ),
    )
    .returning(SUMMARY);

  // `returning` is what tells "revoked" apart from "there was nothing of yours
  // by that id". Reporting success for an update that matched nothing is the
  // wrong answer to give somebody who has just asked for a link to stop working.
  if (revoked.length === 0) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json({ share: revoked[0] });
}
