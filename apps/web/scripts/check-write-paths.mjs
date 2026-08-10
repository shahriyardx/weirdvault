// Drives the write paths whose correctness is a property of SQL, not of code.
//
//   bun run --cwd apps/web dev
//   node apps/web/scripts/check-write-paths.mjs
//
// Needs the app running and DATABASE_URL pointing at the same database it uses.
// It creates throwaway accounts and deletes them afterwards. Safe against a
// development database; not something to point at production.
//
// Three things live here rather than in src/**/*.test.ts, for the same reason
// check-rate-limit.mjs does: each one is a claim about what Postgres does, and a
// mock would assert that this file agrees with itself.
//
//   - The vault's optimistic concurrency. Whether a stale writer is refused
//     depends on the version being in the WHERE clause rather than in an `if`
//     before it, and the difference only shows under concurrency.
//   - The device primary key, which the browser proposes and two accounts in one
//     browser propose identically.
//   - The audit event's device foreign key, which accepts any row in the table
//     unless something checks the owner first.

import pg from "pg"

const APP = process.env.CHECK_APP_URL ?? "http://localhost:3000"
const url = process.env.DATABASE_URL
if (!url) {
  console.error("check-write-paths: DATABASE_URL is not set")
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: url, max: 4 })

const results = []
function check(label, ok, detail = "") {
  results.push(ok)
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
}

/** SHA256: plus 43 base64 characters, which is what the metadata validator wants. */
const FINGERPRINT = `SHA256:${"A".repeat(43)}`

/** A signed-in session of its own, so two accounts can act independently. */
function session() {
  let cookie = ""
  return async function app(path, init = {}) {
    const res = await fetch(`${APP}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        origin: APP,
        ...(cookie ? { cookie } : {}),
        ...init.headers,
      },
    })
    const set = res.headers.getSetCookie?.() ?? []
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ")
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }
}

const created = []

async function signUp(label) {
  const app = session()
  const email = `check-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`
  const r = await app("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password: "a".repeat(43), name: label }),
  })
  if (r.status !== 200) {
    throw new Error(`sign-up failed: ${r.status} ${JSON.stringify(r.body)} (rate limited?)`)
  }
  created.push(r.body.user.id)
  return { app, email, userId: r.body.user.id }
}

/* ----------------------------------------- the vault write, at SQL level --- */

// The race cannot be produced through HTTP reliably — four requests through one
// dev server did not interleave their SELECT and their UPDATE, which is luck
// rather than a property. So the two shapes are driven directly on two
// connections with the interleaving forced, and what is being demonstrated is
// the difference between them.

{
  const userId = `check-vault-${Date.now()}`
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'vault race', $2, false, now(), now())`,
    [userId, `${userId}@example.com`],
  )

  const reset = async () => {
    await pool.query(`DELETE FROM "vault_blob" WHERE user_id = $1`, [userId])
    await pool.query(
      `INSERT INTO "vault_blob" (id, user_id, ciphertext, version, updated_at)
       VALUES ($1, $2, 'v1', 1, now())`,
      [crypto.randomUUID(), userId],
    )
  }

  const survivor = async () => {
    const { rows } = await pool.query(
      `SELECT encode(ciphertext, 'escape') AS blob, version FROM "vault_blob" WHERE user_id = $1`,
      [userId],
    )
    return rows[0]
  }

  /** The shape the route used to have: read the version, then write regardless. */
  async function checkThenAct(blob, baseVersion, gapMs) {
    const c = await pool.connect()
    try {
      const { rows } = await c.query(`SELECT version FROM "vault_blob" WHERE user_id = $1`, [
        userId,
      ])
      if (rows[0] && rows[0].version !== baseVersion) return 409
      // The window. In the route this was however long the process took to get
      // back to the UPDATE; here it is explicit so the race is a fact rather
      // than a coin toss.
      await new Promise((r) => setTimeout(r, gapMs))
      await c.query(
        `UPDATE "vault_blob" SET ciphertext = $1, version = $2, updated_at = now()
         WHERE user_id = $3`,
        [blob, baseVersion + 1, userId],
      )
      return 200
    } finally {
      c.release()
    }
  }

  /** The shape it has now: the version travels in the WHERE clause. */
  async function conditional(blob, baseVersion, gapMs) {
    const c = await pool.connect()
    try {
      await new Promise((r) => setTimeout(r, gapMs))
      const { rows } = await c.query(
        `UPDATE "vault_blob" SET ciphertext = $1, version = $2, updated_at = now()
         WHERE user_id = $3 AND version = $4 RETURNING version`,
        [blob, baseVersion + 1, userId, baseVersion],
      )
      return rows.length ? 200 : 409
    } finally {
      c.release()
    }
  }

  await reset()
  const stale = await Promise.all([
    checkThenAct("device-A", 1, 60),
    checkThenAct("device-B", 1, 10),
  ])
  check(
    "check-then-act tells both writers they succeeded, and loses one vault",
    stale[0] === 200 && stale[1] === 200 && (await survivor()).version === 2,
    `statuses ${stale.join(",")}`,
  )

  await reset()
  const now = await Promise.all([conditional("device-A", 1, 60), conditional("device-B", 1, 10)])
  check(
    "the conditional update tells exactly one, so nothing is lost silently",
    now.filter((s) => s === 200).length === 1 && now.filter((s) => s === 409).length === 1,
    `statuses ${now.join(",")}`,
  )

  await pool.query(`DELETE FROM "user" WHERE id = $1`, [userId])
}

/* -------------------------------------------------- the routes, end to end --- */

const reachable = await fetch(`${APP}/api/recordings`).then(
  () => true,
  () => false,
)

if (!reachable) {
  console.log(`\ncheck-write-paths: ${APP} is not answering; skipping the route checks`)
} else {
  const a = await signUp("vault")
  const first = await a.app("/api/vault", {
    method: "PUT",
    body: JSON.stringify({ blob: "one", baseVersion: 0 }),
  })
  check(
    "the first push creates version 1",
    first.status === 200 && first.body.version === 1,
    `${first.status} v${first.body.version}`,
  )

  const repeat = await a.app("/api/vault", {
    method: "PUT",
    body: JSON.stringify({ blob: "stale", baseVersion: 0 }),
  })
  check(
    "a second push at baseVersion 0 is a conflict, not a second row",
    repeat.status === 409 && repeat.body.currentVersion === 1,
    `${repeat.status} current=${repeat.body.currentVersion}`,
  )

  const onward = await a.app("/api/vault", {
    method: "PUT",
    body: JSON.stringify({ blob: "two", baseVersion: 1 }),
  })
  check(
    "pushing on top of the current version works",
    onward.status === 200 && onward.body.version === 2,
    `${onward.status} v${onward.body.version}`,
  )

  /* ------------------------------- one browser, two accounts */

  const one = await signUp("device-one")
  const two = await signUp("device-two")

  // The same browser proposes the same id to both accounts, because the id comes
  // out of its IndexedDB and knows nothing about who is signed in.
  const deviceId = crypto.randomUUID()

  const registeredOne = await one.app("/api/devices", {
    method: "POST",
    body: JSON.stringify({ id: deviceId, label: "Chrome on Mac", signingKey: "keyOne" }),
  })
  check(
    "the first account registers the browser under the id it proposed",
    registeredOne.status === 201 && registeredOne.body.id === deviceId,
    `${registeredOne.status} ${registeredOne.body.id}`,
  )

  const registeredTwo = await two.app("/api/devices", {
    method: "POST",
    body: JSON.stringify({ id: deviceId, label: "Chrome on Mac", signingKey: "keyTwo" }),
  })
  check(
    "the second account gets a row rather than a duplicate-key 500",
    registeredTwo.status === 201,
    `${registeredTwo.status} ${JSON.stringify(registeredTwo.body)}`,
  )
  check(
    "and an id of its own, since the first account holds the proposed one",
    Boolean(registeredTwo.body.id) && registeredTwo.body.id !== deviceId,
    `${registeredTwo.body.id}`,
  )

  const listed = await two.app("/api/devices")
  check(
    "so the second account can see the browser it is sitting in",
    listed.body.devices?.length === 1 && listed.body.devices[0].id === registeredTwo.body.id,
    JSON.stringify(listed.body.devices?.map((d) => d.id)),
  )

  // The link that makes revoking a browser end its sessions rather than only its
  // future registrations.
  const bound = await pool.query(
    `SELECT count(*)::int AS n FROM "session" WHERE user_id = $1 AND device_id = $2`,
    [two.userId, registeredTwo.body.id],
  )
  check("and its session is stamped with that device", bound.rows[0].n === 1, `${bound.rows[0].n}`)

  /* ------------------------------- the audit device foreign key */

  const foreign = await two.app("/api/audit", {
    method: "POST",
    body: JSON.stringify({
      eventType: "hostkey.pinned",
      metadata: { fingerprint: FINGERPRINT, keyType: "ssh-ed25519" },
      deviceId, // the FIRST account's device
    }),
  })
  check(
    "an event naming another account's device is still recorded",
    foreign.status === 201,
    `${foreign.status} ${JSON.stringify(foreign.body)}`,
  )

  const attributed = await pool.query(
    `SELECT device_id FROM "audit_event" WHERE user_id = $1 AND event_type = 'hostkey.pinned'`,
    [two.userId],
  )
  check(
    "but with no device rather than with somebody else's",
    attributed.rows[0]?.device_id === null,
    `device_id=${attributed.rows[0]?.device_id}`,
  )

  const unknown = await two.app("/api/audit", {
    method: "POST",
    body: JSON.stringify({
      eventType: "key.installed",
      metadata: { keyId: crypto.randomUUID(), result: "installed" },
      deviceId: "no-such-device",
    }),
  })
  check(
    "a device id naming no row at all is a 201, not a foreign key 500",
    unknown.status === 201,
    `${unknown.status} ${JSON.stringify(unknown.body)}`,
  )

  const own = await two.app("/api/audit", {
    method: "POST",
    body: JSON.stringify({
      eventType: "hostkey.cleared",
      metadata: { fingerprint: FINGERPRINT },
      deviceId: registeredTwo.body.id,
    }),
  })
  const kept = await pool.query(
    `SELECT device_id FROM "audit_event" WHERE user_id = $1 AND event_type = 'hostkey.cleared'`,
    [two.userId],
  )
  check(
    "and its own device id is kept",
    own.status === 201 && kept.rows[0]?.device_id === registeredTwo.body.id,
    `${own.status} device_id=${kept.rows[0]?.device_id}`,
  )

  /* ------------------------------- the storage ceiling spans both tables */

  const storage = await signUp("storage")
  const recordingId = crypto.randomUUID()
  await pool.query(
    `INSERT INTO "recording" (id, user_id, ciphertext, size_bytes, duration_ms, started_at, created_at)
     VALUES ($1, $2, 'x', 3000000, 1000, now(), now())`,
    [recordingId, storage.userId],
  )
  await pool.query(
    `INSERT INTO "recording_share" (id, recording_id, user_id, token, ciphertext, size_bytes,
                                    expires_at, views, created_at)
     VALUES ($1, $2, $3, $4, 'x', 4000000, now() + interval '1 day', 0, now())`,
    [crypto.randomUUID(), recordingId, storage.userId, `check-${Date.now()}`],
  )

  const usage = await storage.app("/api/recordings")
  check(
    "the storage figure counts recordings and share copies together",
    usage.body.storedBytes === 7_000_000,
    `storedBytes=${usage.body.storedBytes} (3 MB recording + 4 MB share)`,
  )
}

for (const id of created) {
  await pool.query(`DELETE FROM "user" WHERE id = $1`, [id]).catch(() => {})
}
await pool.end()

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
