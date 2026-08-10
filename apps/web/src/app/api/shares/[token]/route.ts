import { and, eq, isNull, sql } from "drizzle-orm"

import { db, schema } from "@/lib/db"
import { enforce } from "@/lib/rate-limit"
import { BodyError, readBody, statusForBodyError } from "@/lib/recording/blobs"

/**
 * The public end of a share link. No session, by design.
 *
 * This is the only route in the app that authorizes nobody. It does not read a
 * cookie, it does not know who is asking, and it must not learn: a share link
 * is meant to work for a colleague who has no account, from a phone, at three
 * in the morning. What stands in for authorization is the token in the path,
 * and what stands in for confidentiality is a key this route has never held —
 * the blob it serves was encrypted in the owner's browser under a key that
 * lives in the link's fragment and is therefore never sent to us.
 *
 * The token is not an ownership check and is not treated as one. It selects a
 * row that was created specifically to be handed out, and that row contains one
 * transcript. There is no path from here to the owner's other recordings, to
 * their vault, or to anything encrypted under their vault key, because the
 * ciphertext in this table was sealed with a different key entirely.
 *
 * Two properties this handler exists to get right.
 *
 * First, the count and the check are one statement. A read-then-write would let
 * two viewers arriving together both read `views = 0`, both pass a limit of one,
 * and both be served — which is not a rounding error, it is the limit failing in
 * exactly the case somebody set it for. The conditional UPDATE ... RETURNING
 * below increments and tests in a single statement, so Postgres serialises the
 * two: under READ COMMITTED the second waits on the row lock, re-evaluates the
 * WHERE clause against the row the first one left, and matches nothing.
 *
 * Second, every refusal is the same refusal. Expired, revoked, over its view
 * limit and never existed all answer 404 with an identical body, so this
 * endpoint cannot be used to discover which tokens are real or to watch a link
 * being used up. The person holding a working link learns everything from the
 * fact that it worked; nobody else learns anything at all.
 *
 * Third, it is rate-limited, and the limit is doing a different job from the
 * view counter. The counter bounds a link being passed around; the limit bounds
 * somebody working through tokens, and bounds the cost of serving a multi-
 * megabyte transcript from a bucket to whoever asks. Neither is what makes the
 * token unguessable — 256 bits does that — which is why tripping the limit and
 * presenting a real token produce different statuses without that leaking
 * anything: a 429 says the *caller* is going too fast and says nothing at all
 * about whether the token was real.
 *
 * The limit is per network, and without a trusted proxy in front there is no
 * network to key on and everybody shares one bucket. That is stated in
 * lib/rate-limit.ts and it is the reason the ceiling below is generous rather
 * than tight: on the default configuration, a low limit here would be one
 * stranger away from switching off everybody's share links.
 */

/** Thirty views a minute. A person opening a link does it once. */
const VIEW_LIMIT = { max: 30, windowSeconds: 60 }

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  // Before the statement below, which increments a counter and can serve
  // megabytes. There is no session here to key on, by design, so this is the
  // caller's network or the shared bucket.
  const limited = await enforce("share", request, VIEW_LIMIT, {
    message:
      "Too many requests for shared recordings from this network. This is a rate limit rather " +
      "than anything about the link you have — wait a moment and try it again.",
  })
  if (limited) return limited

  // Next.js 16: route params are async.
  const { token } = await params

  const [row] = await db
    .update(schema.recordingShare)
    .set({ views: sql`${schema.recordingShare.views} + 1` })
    .where(
      and(
        eq(schema.recordingShare.token, token),
        isNull(schema.recordingShare.revokedAt),
        // The database's clock, evaluated inside the same statement as the
        // increment, rather than a timestamp this process computed earlier.
        //
        // This is the one timestamp comparison in the codebase that happens in
        // SQL, and it only means what it says because `expires_at` is
        // `timestamptz` — see the note on the table in lib/db/schema.ts. As a
        // naive `timestamp` it would be promoted through the server's TimeZone
        // here, so a Postgres running on local time would keep serving a link
        // for hours after the owner's screen called it expired.
        sql`${schema.recordingShare.expiresAt} > now()`,
        // Null max_views means unlimited. The comparison is against the value
        // before the increment, which is what makes a limit of one serve once.
        sql`(${schema.recordingShare.maxViews} is null or ${schema.recordingShare.views} < ${schema.recordingShare.maxViews})`,
      ),
    )
    .returning({
      id: schema.recordingShare.id,
      ciphertext: schema.recordingShare.ciphertext,
      storageKey: schema.recordingShare.storageKey,
      views: schema.recordingShare.views,
      maxViews: schema.recordingShare.maxViews,
      expiresAt: schema.recordingShare.expiresAt,
    })

  // One answer for four situations. Splitting them would be friendlier to the
  // one person holding a link that has just expired and would also tell anyone
  // guessing tokens which of their guesses named a real share.
  if (!row) return Response.json({ error: "not found" }, { status: 404 })

  /**
   * The bytes, which may be in the row above or in a bucket.
   *
   * A bucket is the one thing that can fail after the view has already been
   * spent, because the count and the check have to be a single statement and
   * the fetch cannot be part of it. So a failure refunds the view: the caller
   * is getting nothing, and a link limited to three views should not be worth
   * two after a bucket had a bad minute. The refund is its own atomic UPDATE,
   * so it cannot lose a concurrent increment; what it cannot survive is this
   * process dying between the two statements, which spends one view and is the
   * smallest failure available here.
   *
   * Never presigned, and this route is the reason the whole app proxies. What
   * stands between a revoked link and the transcript is the WHERE clause above,
   * evaluated when the request arrives. A signed URL is evaluated by a bucket
   * that has never heard of `revoked_at`, so handing one out would mean revoke
   * stops meaning revoked for as long as the signature lives.
   */
  let blob: Buffer | null
  try {
    blob = await readBody(row)
  } catch (e) {
    if (!(e instanceof BodyError)) throw e
    await db
      .update(schema.recordingShare)
      .set({ views: sql`greatest(${schema.recordingShare.views} - 1, 0)` })
      .where(eq(schema.recordingShare.id, row.id))
    return Response.json({ error: e.message }, { status: statusForBodyError(e) })
  }

  // A live share with no bytes. The revoke path nulls both columns and stamps
  // `revoked_at`, which the WHERE clause above already excluded, so reaching
  // here means the two got out of step — 404 rather than a crash on a null.
  if (!blob) return Response.json({ error: "not found" }, { status: 404 })

  return Response.json(
    {
      // The envelope the owner's browser wrote, byte for byte. This route has
      // never been able to open it and does not become able to by serving it.
      blob: blob.toString("utf8"),
      // The count including this fetch, so the viewer can say how many views
      // are left rather than implying the link is inexhaustible.
      views: row.views,
      maxViews: row.maxViews,
      expiresAt: row.expiresAt,
    },
    {
      headers: {
        // Every fetch spends a view, so a cached copy would be a view served
        // without being counted — and on a shared cache, served to somebody the
        // link was never sent to.
        "Cache-Control": "no-store, private",
      },
    },
  )
}
