import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://webxterm:webxterm@localhost:5432/webxterm";

// Reuse the pool across hot reloads in dev, or Next's module re-evaluation
// exhausts Postgres connections within a few edits.
const globalForDb = globalThis as unknown as { pool?: Pool };
const pool = (globalForDb.pool ??= new Pool({ connectionString }));

export const db = drizzle(pool, { schema });
export { schema };
