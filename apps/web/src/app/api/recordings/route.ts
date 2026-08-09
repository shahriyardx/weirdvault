import { and, count, desc, eq, sum } from "drizzle-orm";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { tierFor } from "@/lib/billing/subscription";
import { canRecordOnTier } from "@/lib/billing/tiers";
import { db, schema } from "@/lib/db";
import {
  MAX_ACCOUNT_RECORDING_BYTES,
  MAX_BLOB_BYTES,
  RECORDING_REQUIRES_PRO,
} from "@/lib/recording/limits";

/**
 * Session recordings: list and create.
 *
 * The route stores a blob it cannot read. Everything a person would want to
 * know about a recording — what it was called, which machine, what happened in
 * it — is inside the ciphertext, and what is left in columns is what a list has
 * to be able to sort and count by: a blinded host reference, a size, a
 * duration, a start time and a device id.
 *
 * Authorization is the part to be paranoid about. A recording is a transcript of
 * someone's work, so an id that resolves without an ownership check is not a bug
 * with a severity, it is the whole of the session handed to a stranger. Two
 * rules, applied without exception in this file and in [id]/route.ts:
 *
 *  - Every query carries `userId = session.user.id` in its WHERE clause. Not a
 *    lookup then a comparison — a comparison can be forgotten on the branch
 *    nobody reads, and a WHERE clause cannot.
 *  - Nothing the client sends is treated as evidence of anything. The device id
 *    is checked against the caller's own devices before it is stored, because a
 *    foreign key alone would happily accept another account's device and
 *    mislabel the recording's provenance forever.
 *
 * `sizeBytes` is measured here rather than accepted from the client. It is the
 * number the quota counts, and a quota that trusts the party being counted is
 * not a quota. It is also simply the more correct number: it describes the bytes
 * this route actually stored.
 *
 * Two ceilings apply on the way in, both from lib/recording/limits.ts so that
 * /pricing and the recordings page can state the same figures this route
 * refuses at. MAX_BLOB_BYTES bounds one upload. MAX_ACCOUNT_RECORDING_BYTES
 * bounds the account, and it is the one that actually stops abuse: nothing
 * prunes this table, so without a total one authenticated account could loop
 * twelve-megabyte uploads until the volume holding everyone else's vault is
 * full. The cost is a SUM over this account's rows on the write path — bounded
 * by the ceiling itself, and the cheap half of a request that just carried
 * several megabytes. `recording_user_time_idx` leads on user_id, so it reads one
 * account's rows rather than the table.
 *
 * ── The plan gate, and where it deliberately is not
 *
 * Saving a new recording is a Pro feature, and POST is the one handler that
 * checks. Nothing else in this file or in [id]/route.ts asks what anybody pays:
 * GET lists, GET [id] serves the ciphertext, DELETE removes it, and all three
 * work on any plan, forever. That is not an oversight to be tidied up later — a
 * recording is the user's own data, encrypted with their own key, and holding it
 * hostage behind a lapsed subscription would be taking something we cannot even
 * read. Downloading remains the way out of this product at all times.
 *
 * The check reads the subscription table through `tierFor`, which fails toward
 * access: if that read throws, the save is allowed and the failure is logged.
 * Refusing to store somebody's transcript because a query timed out would
 * destroy it — the recording only exists in the tab that made it until this
 * route accepts it.
 *
 * The client checks the same thing before capture starts (lib/recording/capture
 * .ts) so nobody records for ten minutes and finds out at the end. That check is
 * a courtesy and this one is the enforcement; they agree because they read the
 * same resolver, and the 402 below is written to be readable in case they ever
 * do not.
 */

/** `duration_ms` is a 32-bit integer column; 24 days of recording is not a thing. */
const MAX_DURATION_MS = 2_147_483_647;

const MAX_PAGE = 200;
const DEFAULT_PAGE = 100;

/** The columns a listing may return. Never `ciphertext`. */
const SUMMARY = {
  id: schema.recording.id,
  targetRef: schema.recording.targetRef,
  deviceId: schema.recording.deviceId,
  sizeBytes: schema.recording.sizeBytes,
  durationMs: schema.recording.durationMs,
  startedAt: schema.recording.startedAt,
  createdAt: schema.recording.createdAt,
};

async function requireUser() {
  // Next.js 16: headers() is async-only.
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
}

/**
 * A page size, clamped at both ends.
 *
 * The upper bound is obvious. The lower one is not, and was missing: `?limit=-1`
 * survived `Math.min` and reached Postgres, which rejects a negative LIMIT, so a
 * one-character query string turned a listing into an unhandled 500 and a
 * database exception in the log. Anything unreadable falls back to the default
 * rather than 400ing — a bad page size is not worth refusing a listing over.
 */
function pageSize(raw: string | null): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE;
  return Math.min(n, MAX_PAGE);
}

/**
 * How much ciphertext this account is already holding.
 *
 * `sum` comes back as a string from Postgres (it is a bigint sum over an
 * integer column) and as null for an account with no rows, so both are folded
 * into a number here rather than at the two call sites.
 */
async function storedBytesFor(userId: string): Promise<number> {
  const [row] = await db
    .select({ bytes: sum(schema.recording.sizeBytes) })
    .from(schema.recording)
    .where(eq(schema.recording.userId, userId));
  return Number(row?.bytes ?? 0);
}

export async function GET(request: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const limit = pageSize(new URL(request.url).searchParams.get("limit"));

  // Metadata only. Selecting the whole row would put every recording's
  // ciphertext — megabytes each — into a response that exists to draw a list,
  // and would be one careless spread away from serving them.
  const rows = await db
    .select(SUMMARY)
    .from(schema.recording)
    .where(eq(schema.recording.userId, user.id))
    .orderBy(desc(schema.recording.createdAt))
    .limit(limit);

  // The total is counted rather than inferred from the page, because the
  // sidebar badge reads it and a badge that stops at the page size would quietly
  // start under-reporting at exactly the point it starts mattering.
  const [totals] = await db
    .select({ total: count() })
    .from(schema.recording)
    .where(eq(schema.recording.userId, user.id));

  // The storage figure travels with the listing so the page that shows
  // recordings can show what they cost against the ceiling POST refuses at.
  // A limit the user only meets at the moment of refusal is the failure this
  // whole file is written to avoid.
  return Response.json({
    recordings: rows,
    total: totals?.total ?? rows.length,
    storedBytes: await storedBytesFor(user.id),
    storageLimitBytes: MAX_ACCOUNT_RECORDING_BYTES,
  });
}

export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Before the body is read, so a Free account is refused without a multi-
  // megabyte upload being taken off the wire first.
  if (!canRecordOnTier(await tierFor(user.id))) {
    return Response.json(
      {
        error:
          "Saving a session recording is a Pro feature, and this account is on Free. Nothing was " +
          "stored and the transcript is still in the tab that captured it — it will be lost if " +
          "that tab reloads. Recordings already saved stay listable, playable and downloadable " +
          "on any plan.",
        code: RECORDING_REQUIRES_PRO,
      },
      { status: 402 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { blob, durationMs, startedAt, targetRef, deviceId } = body;

  if (typeof blob !== "string" || blob === "") {
    return Response.json({ error: "blob (string) required" }, { status: 400 });
  }
  const sizeBytes = Buffer.byteLength(blob, "utf8");
  if (sizeBytes > MAX_BLOB_BYTES) {
    return Response.json(
      {
        error: `That recording is ${Math.round(sizeBytes / 1024 / 1024)} MB encrypted, and the limit is ${MAX_BLOB_BYTES / 1024 / 1024} MB.`,
      },
      { status: 413 },
    );
  }

  if (
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    durationMs > MAX_DURATION_MS
  ) {
    return Response.json({ error: "durationMs must be a duration in milliseconds" }, { status: 400 });
  }

  const started = typeof startedAt === "string" ? new Date(startedAt) : null;
  if (!started || Number.isNaN(started.valueOf())) {
    return Response.json({ error: "startedAt must be an ISO timestamp" }, { status: 400 });
  }

  // Opaque by contract; the shape is enforced so a hostname cannot be smuggled
  // into the one column that is indexed and readable. Same rule as the audit
  // route, and for the same reason: this column is forever.
  if (targetRef !== undefined && targetRef !== null) {
    if (typeof targetRef !== "string" || !/^[A-Za-z0-9_-]{16,32}$/.test(targetRef)) {
      return Response.json(
        { error: "targetRef must be a blinded reference, not a hostname" },
        { status: 400 },
      );
    }
  }

  // The account ceiling, checked after the cheap validations and before the
  // insert. There is a race here and it is accepted: saves landing together all
  // read the same total and can all be allowed, so the ceiling can be overshot
  // by whatever is in flight at that moment — a few blobs at most, since each is
  // capped and a browser saves one recording at a time. Closing it properly
  // means a transaction locking the account's rows on every write, which is a
  // real cost on every save to prevent a bounded overshoot that the next save
  // refuses anyway.
  const storedBytes = await storedBytesFor(user.id);
  if (storedBytes + sizeBytes > MAX_ACCOUNT_RECORDING_BYTES) {
    return Response.json(
      {
        error:
          `Your recordings already hold ${Math.round(storedBytes / 1_000_000)} MB of the ` +
          `${MAX_ACCOUNT_RECORDING_BYTES / 1_000_000_000} GB this account can store, and this one ` +
          "does not fit. Nothing was deleted to make room — delete some recordings you no longer " +
          "need and save again. The recording is still in the tab that made it.",
      },
      { status: 413 },
    );
  }

  // A device id is only stored once it is known to be one of this user's. The
  // foreign key would accept any device row in the table, which would let an
  // account attribute its recordings to a browser it does not own.
  let ownedDeviceId: string | null = null;
  if (typeof deviceId === "string" && deviceId !== "") {
    const [owned] = await db
      .select({ id: schema.device.id })
      .from(schema.device)
      .where(and(eq(schema.device.id, deviceId), eq(schema.device.userId, user.id)))
      .limit(1);
    ownedDeviceId = owned?.id ?? null;
  }

  const [row] = await db
    .insert(schema.recording)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      deviceId: ownedDeviceId,
      targetRef: (targetRef as string | undefined) ?? null,
      ciphertext: Buffer.from(blob, "utf8"),
      sizeBytes,
      durationMs: Math.round(durationMs),
      startedAt: started,
    })
    .returning(SUMMARY);

  return Response.json({ recording: row }, { status: 201 });
}
