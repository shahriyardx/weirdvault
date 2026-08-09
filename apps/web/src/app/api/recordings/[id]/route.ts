import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";

/**
 * One recording: fetch the blob, or delete it.
 *
 * This is the route where getting authorization wrong costs the most, so it is
 * written to make getting it wrong awkward. Both handlers put the owner in the
 * WHERE clause — `id = ? AND user_id = ?` — rather than reading the row and
 * then comparing, because a comparison is a line that can be deleted during a
 * refactor and still leave code that runs, while a missing WHERE clause returns
 * the wrong number of rows immediately.
 *
 * A row belonging to someone else answers 404, not 403. The two are the same
 * outcome for the caller and different information: 403 confirms that the id
 * names a real recording, which is a fact about another account's data and not
 * one to hand out for free.
 *
 * The id being a UUID is not part of the argument. Unguessable is not
 * authorized, and treating it as such is how these bugs get written.
 *
 * There is no share-token path in this file, and that — rather than any claim
 * about the app as a whole — is the property to hold onto. Public sharing is
 * built, and it is deliberately two other routes: /api/recordings/[id]/shares is
 * the owner's side and authenticates exactly the way this file does, and
 * /api/shares/[token] is the public side and authenticates nobody at all.
 * Neither authenticates through the other's identifier — a session never selects
 * a row by token here, and a token never reaches an owner-scoped query there.
 * Bolting an "or a valid token" branch onto the handlers below is what all three
 * files are arranged to prevent, because that is how an authorization check ends
 * up with a way around it.
 *
 * So a reviewer auditing who can read a recording's transcript has two surfaces
 * to read, not one: this file, and /api/shares/[token]/route.ts, which serves a
 * separately encrypted second copy to whoever holds the token. This header says
 * so rather than implying the audit ends here.
 */

async function requireUser() {
  // Next.js 16: headers() is async-only.
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Next.js 16: route params are async.
  const { id } = await params;

  const [row] = await db
    .select({
      id: schema.recording.id,
      ciphertext: schema.recording.ciphertext,
      startedAt: schema.recording.startedAt,
      durationMs: schema.recording.durationMs,
      sizeBytes: schema.recording.sizeBytes,
      targetRef: schema.recording.targetRef,
    })
    .from(schema.recording)
    .where(and(eq(schema.recording.id, id), eq(schema.recording.userId, user.id)))
    .limit(1);

  if (!row) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json({
    id: row.id,
    // The same envelope the browser wrote, byte for byte. This route has never
    // been able to read it and does not become able to by serving it.
    blob: row.ciphertext.toString("utf8"),
    startedAt: row.startedAt,
    durationMs: row.durationMs,
    sizeBytes: row.sizeBytes,
    targetRef: row.targetRef,
  });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  // `returning` is what distinguishes "deleted" from "there was nothing of
  // yours by that id". Without it the route would report success for a delete
  // that matched nothing, which is the wrong answer to give someone who has
  // just asked for a transcript to be destroyed.
  const deleted = await db
    .delete(schema.recording)
    .where(and(eq(schema.recording.id, id), eq(schema.recording.userId, user.id)))
    .returning({ id: schema.recording.id });

  if (deleted.length === 0) return Response.json({ error: "not found" }, { status: 404 });

  // `recording_share` references this row with onDelete: cascade, and that is a
  // live effect of this handler rather than a dormant property of the schema:
  // every share made from this recording goes with it, including links that
  // have not expired and are in somebody's hands right now, and including the
  // revoked rows that were the only record a link ever existed. The confirmation
  // dialog on /dashboard/recordings says so before this is called, because a
  // delete that quietly breaks a circulated link is not a delete the user
  // consented to.
  return Response.json({ ok: true });
}
