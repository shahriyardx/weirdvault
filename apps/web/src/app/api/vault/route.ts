import { headers } from "next/headers"
import { and, eq } from "drizzle-orm"

import { auth } from "@/lib/auth"
import { db, schema } from "@/lib/db"

/**
 * Vault blob sync.
 *
 * This route is deliberately incapable of understanding what it stores. It
 * accepts an opaque ciphertext, checks a version for optimistic concurrency,
 * and hands it back. No filtering, no search, no server-side indexing — those
 * would all require plaintext, and the model forbids it (THREAT-MODEL.md §10).
 */

const MAX_BLOB_BYTES = 4 * 1024 * 1024

async function requireUser() {
  // Next.js 16: headers() is async-only.
  const session = await auth.api.getSession({ headers: await headers() })
  return session?.user ?? null
}

export async function GET() {
  const user = await requireUser()
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 })

  const [row] = await db
    .select()
    .from(schema.vaultBlob)
    .where(eq(schema.vaultBlob.userId, user.id))
    .limit(1)

  if (!row) return Response.json({ version: 0, blob: null })

  return Response.json({
    version: row.version,
    blob: row.ciphertext.toString("utf8"),
    updatedAt: row.updatedAt,
  })
}

export async function PUT(request: Request) {
  const user = await requireUser()
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: { blob?: unknown; baseVersion?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 })
  }

  const { blob, baseVersion } = body
  if (typeof blob !== "string" || typeof baseVersion !== "number") {
    return Response.json(
      { error: "blob (string) and baseVersion (number) required" },
      { status: 400 },
    )
  }
  if (Buffer.byteLength(blob, "utf8") > MAX_BLOB_BYTES) {
    return Response.json({ error: "vault too large" }, { status: 413 })
  }

  const ciphertext = Buffer.from(blob, "utf8")
  const version = baseVersion + 1

  /**
   * Optimistic concurrency, decided by the write rather than by a read before
   * it.
   *
   * A stale writer must be told to re-read and merge instead of silently
   * clobbering another device's changes, and that is what `baseVersion` is for.
   * It used to be checked with a SELECT and then acted on by an unconditional
   * UPDATE, which is the check-then-act shape and loses in exactly the case the
   * check exists for: two devices holding version 4 both read 4, both find it
   * matches, and both write version 5. One document survives, the other is gone,
   * and neither device is told — the losing device recorded a successful sync
   * and moved its local version on.
   *
   * So the version travels in the WHERE clause and `returning` reports whether
   * a row matched. Postgres serialises the two UPDATEs on the row lock, the
   * second re-evaluates against what the first left, and it matches nothing.
   *
   * The insert has the same shape for the same reason: `vault_blob_user_idx` is
   * unique on user_id, so two first-ever pushes race and `onConflictDoNothing`
   * makes the loser a no-op rather than a 500.
   */
  const written =
    baseVersion === 0
      ? await db
          .insert(schema.vaultBlob)
          .values({ id: crypto.randomUUID(), userId: user.id, ciphertext, version })
          .onConflictDoNothing({ target: schema.vaultBlob.userId })
          .returning({ version: schema.vaultBlob.version })
      : await db
          .update(schema.vaultBlob)
          .set({ ciphertext, version, updatedAt: new Date() })
          .where(
            and(eq(schema.vaultBlob.userId, user.id), eq(schema.vaultBlob.version, baseVersion)),
          )
          .returning({ version: schema.vaultBlob.version })

  if (written.length === 0) {
    // Nothing matched, so somebody else is ahead. The current version is read
    // here rather than guessed, because it is what the client needs in order to
    // re-pull and merge — and by now it is a fact rather than a race.
    const [current] = await db
      .select({ version: schema.vaultBlob.version })
      .from(schema.vaultBlob)
      .where(eq(schema.vaultBlob.userId, user.id))
      .limit(1)

    return Response.json(
      { error: "version conflict", currentVersion: current?.version ?? 0 },
      { status: 409 },
    )
  }

  return Response.json({ version })
}
