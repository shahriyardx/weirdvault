import { headers } from "next/headers"
import { eq } from "drizzle-orm"

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

  const [existing] = await db
    .select({ version: schema.vaultBlob.version })
    .from(schema.vaultBlob)
    .where(eq(schema.vaultBlob.userId, user.id))
    .limit(1)

  // Optimistic concurrency: a stale writer is told to re-read and merge rather
  // than silently clobbering another device's changes.
  if (existing && existing.version !== baseVersion) {
    return Response.json(
      { error: "version conflict", currentVersion: existing.version },
      { status: 409 },
    )
  }

  const version = (existing?.version ?? 0) + 1

  if (existing) {
    await db
      .update(schema.vaultBlob)
      .set({ ciphertext, version, updatedAt: new Date() })
      .where(eq(schema.vaultBlob.userId, user.id))
  } else {
    await db.insert(schema.vaultBlob).values({
      id: crypto.randomUUID(),
      userId: user.id,
      ciphertext,
      version,
    })
  }

  return Response.json({ version })
}
