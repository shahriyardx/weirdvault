import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import * as schema from "./schema"

const connectionString =
  process.env.DATABASE_URL ?? "postgres://weirdvault:weirdvault@localhost:5432/weirdvault"

// Reuse the pool across hot reloads in dev, or Next's module re-evaluation
// exhausts Postgres connections within a few edits.
const globalForDb = globalThis as unknown as { pool?: Pool }
// Assign-and-use in one step is the point: it is what makes the cache atomic
// across a hot reload, rather than a read, a branch and a write that a second
// module evaluation can interleave with.
// biome-ignore lint/suspicious/noAssignInExpressions: the atomic ??= is the point
const pool = (globalForDb.pool ??= new Pool({ connectionString }))

export const db = drizzle(pool, { schema })
export { schema }
