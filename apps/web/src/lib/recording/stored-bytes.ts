import { eq, sum } from "drizzle-orm"

import { db, schema } from "@/lib/db"

/**
 * How much ciphertext an account is holding, across both tables.
 *
 * There are two of them because a share link is a second full copy of the
 * transcript — re-encrypted under a key generated for that link alone, not a
 * pointer to the original — so it occupies storage the same way a recording
 * does and has to count the same way.
 *
 * This exists because the two routes did not agree. POST /api/recordings summed
 * only `recording`; POST /api/recordings/[id]/shares summed both. So the same
 * gigabyte ceiling was enforced asymmetrically: a share was refused for space
 * that a recording of the same size would have been granted, and an account
 * could sit above the limit indefinitely as long as it only ever saved
 * recordings. Each route carrying its own sum is what let them drift, so there
 * is one, and both import it — including the listing, so the figure on the
 * recordings page is the figure the refusal is computed from.
 *
 * Two statements rather than a union: they are two independent sums over two
 * tables, and Postgres returns each as a string (a bigint sum over an integer
 * column) or null for an account with no rows.
 *
 * Server-only — it opens a database connection. lib/recording/limits.ts holds
 * the constants, and stays free of this so the marketing pages can quote a
 * ceiling without dragging a connection pool behind them.
 */
export async function storedRecordingBytes(userId: string): Promise<number> {
  const [recordings] = await db
    .select({ bytes: sum(schema.recording.sizeBytes) })
    .from(schema.recording)
    .where(eq(schema.recording.userId, userId))

  const [shares] = await db
    .select({ bytes: sum(schema.recordingShare.sizeBytes) })
    .from(schema.recordingShare)
    .where(eq(schema.recordingShare.userId, userId))

  return Number(recordings?.bytes ?? 0) + Number(shares?.bytes ?? 0)
}
