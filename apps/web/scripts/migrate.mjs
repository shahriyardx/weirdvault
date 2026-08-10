// Applies the generated SQL migrations, then gets out of the way.
//
// Runs at container start rather than image build: a Docker build has no
// database — no compose network, no depends_on, no DATABASE_URL — so there is
// nothing to migrate at that point. `depends_on: condition: service_healthy` is
// what actually guarantees Postgres is up, and that only holds at start.
//
// Deliberately uses `pg` and nothing else. The runtime image is Next's
// standalone output, which traces only what the app imports; drizzle-kit is a
// build-time tool and is not in there. `pg` is, because the app itself needs it.
//
//   node apps/web/scripts/migrate.mjs

import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = join(HERE, "..", "drizzle")

const url = process.env.DATABASE_URL
if (!url) {
  console.error("migrate: DATABASE_URL is not set")
  process.exit(1)
}

/** Migration tags in journal order, so a rename or a re-sort cannot reorder them. */
function pending() {
  const journal = JSON.parse(readFileSync(join(DIR, "meta", "_journal.json"), "utf8"))
  return journal.entries
    .sort((a, b) => a.idx - b.idx)
    .map((e) => e.tag)
    .filter((tag) => readdirSync(DIR).includes(`${tag}.sql`))
}

const client = new pg.Client({ connectionString: url })
await client.connect()

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "__migrations" (
      tag         text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `)

  const done = new Set(
    (await client.query('SELECT tag FROM "__migrations"')).rows.map((r) => r.tag),
  )

  let applied = 0
  for (const tag of pending()) {
    if (done.has(tag)) continue

    // One transaction per migration: a failure half way through leaves the
    // database on the last good version rather than in an invented one.
    const sql = readFileSync(join(DIR, `${tag}.sql`), "utf8")
    await client.query("BEGIN")
    try {
      for (const stmt of sql.split("--> statement-breakpoint")) {
        if (stmt.trim()) await client.query(stmt)
      }
      await client.query('INSERT INTO "__migrations" (tag) VALUES ($1)', [tag])
      await client.query("COMMIT")
    } catch (e) {
      await client.query("ROLLBACK")
      throw new Error(`migration ${tag} failed: ${e.message}`, { cause: e })
    }
    console.log(`migrate: applied ${tag}`)
    applied += 1
  }

  console.log(applied === 0 ? "migrate: already up to date" : `migrate: ${applied} applied`)
} finally {
  await client.end()
}
