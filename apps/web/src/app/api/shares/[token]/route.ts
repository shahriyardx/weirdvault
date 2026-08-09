import { and, eq, isNull, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

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
 * What is NOT solved here: nothing rate-limits this route, so the view counter
 * is a control against a link being passed around rather than against somebody
 * hammering the endpoint. docs/THREAT-MODEL.md already lists IP-level limits as
 * outstanding, and this route joins that list rather than pretending otherwise.
 */

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  // Next.js 16: route params are async.
  const { token } = await params;

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
      ciphertext: schema.recordingShare.ciphertext,
      views: schema.recordingShare.views,
      maxViews: schema.recordingShare.maxViews,
      expiresAt: schema.recordingShare.expiresAt,
    });

  // One answer for four situations. Splitting them would be friendlier to the
  // one person holding a link that has just expired and would also tell anyone
  // guessing tokens which of their guesses named a real share.
  if (!row) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json(
    {
      // The envelope the owner's browser wrote, byte for byte. This route has
      // never been able to open it and does not become able to by serving it.
      blob: row.ciphertext.toString("utf8"),
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
  );
}
