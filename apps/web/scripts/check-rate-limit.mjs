// Drives the rate limiter against a running app and a real Postgres.
//
// The unit tests in src/lib/rate-limit.test.ts cover which subject gets counted
// and what a refusal looks like. They cannot cover the part that matters most:
// `consume` is a single SQL statement, and its correctness is the window
// arithmetic and the atomicity of that statement. A mock would assert that a
// string matches itself.
//
// So this is the check for it. It needs the app running and DATABASE_URL
// pointing at the same database the app is using:
//
//   bun run --cwd apps/web dev
//   node apps/web/scripts/check-rate-limit.mjs
//
// It creates a throwaway account, spends its own budgets, and deletes the
// account afterwards. Safe against a development database; not something to
// point at production, where it would trip the shared bucket for real callers.

import pg from "pg";

const APP = process.env.CHECK_APP_URL ?? "http://localhost:3000";
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("check-rate-limit: DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

const results = [];
function check(label, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/* ------------------------------------------------- the statement, in isolation */

// A key nothing else will touch, so the counts below are only ours.
const KEY = `check:${process.pid}:${Date.now()}`;

/** The same statement lib/rate-limit.ts runs, so this tests the real thing. */
async function consume(key, max, windowSeconds, now = Date.now()) {
  const windowMs = windowSeconds * 1000;
  const { rows } = await client.query(
    `insert into "rate_limit" ("key", "count", "window_start")
     values ($1, 1, $2)
     on conflict ("key") do update set
       "count" = case
         when $2::bigint - "rate_limit"."window_start" >= $3::bigint then 1
         else "rate_limit"."count" + 1 end,
       "window_start" = case
         when $2::bigint - "rate_limit"."window_start" >= $3::bigint then $2::bigint
         else "rate_limit"."window_start" end
     returning "count", "window_start"`,
    [key, now, windowMs],
  );
  const count = Number(rows[0].count);
  return {
    allowed: count <= max,
    count,
    retryAfter: Math.max(1, Math.ceil((Number(rows[0].window_start) + windowMs - now) / 1000)),
  };
}

{
  const decisions = [];
  for (let i = 0; i < 5; i++) decisions.push(await consume(KEY, 3, 60));

  check(
    "the first N are allowed and the rest are not",
    decisions.map((d) => d.allowed).join(",") === "true,true,true,false,false",
    decisions.map((d) => `${d.count}:${d.allowed}`).join(" "),
  );
  check(
    "a refusal says when to come back",
    decisions[4].retryAfter > 0 && decisions[4].retryAfter <= 60,
    String(decisions[4].retryAfter),
  );
}

{
  // A fixed window resets on elapse. Driven by passing a later `now` rather than
  // sleeping, so the check is instant and exact.
  const key = `${KEY}:window`;
  await consume(key, 2, 10);
  await consume(key, 2, 10);
  const blocked = await consume(key, 2, 10);
  const afterWindow = await consume(key, 2, 10, Date.now() + 11_000);
  check("blocked inside the window", !blocked.allowed);
  check(
    "allowed once the window elapses, with the count reset",
    afterWindow.allowed && afterWindow.count === 1,
    `count=${afterWindow.count}`,
  );
}

{
  // The property a fixed window has and a sliding one does not: staying under
  // the limit must never accumulate into a block. Twenty requests at 5/10s,
  // spread one every 3 seconds, is under the rate the whole way.
  const key = `${KEY}:steady`;
  let blocked = 0;
  const start = Date.now();
  for (let i = 0; i < 20; i++) {
    const d = await consume(key, 5, 10, start + i * 3000);
    if (!d.allowed) blocked += 1;
  }
  check("steady traffic under the limit is never blocked", blocked === 0, `${blocked} blocked`);
}

{
  // The reason it is one statement. Ten concurrent requests against a limit of
  // three must produce exactly three allowances — a read-then-write lets all ten
  // see the same count and pass, which is the burst a limiter exists for.
  const key = `${KEY}:race`;
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const now = Date.now();
  const windowMs = 60_000;
  const one = async () => {
    const { rows } = await pool.query(
      `insert into "rate_limit" ("key", "count", "window_start")
       values ($1, 1, $2)
       on conflict ("key") do update set
         "count" = case
           when $2::bigint - "rate_limit"."window_start" >= $3::bigint then 1
           else "rate_limit"."count" + 1 end,
         "window_start" = case
           when $2::bigint - "rate_limit"."window_start" >= $3::bigint then $2::bigint
           else "rate_limit"."window_start" end
       returning "count"`,
      [key, now, windowMs],
    );
    return Number(rows[0].count) <= 3;
  };
  const allowed = (await Promise.all(Array.from({ length: 10 }, one))).filter(Boolean).length;
  await pool.end();
  check(
    "ten concurrent requests against a limit of three allow exactly three",
    allowed === 3,
    `${allowed} allowed`,
  );
}

await client.query(`DELETE FROM "rate_limit" WHERE "key" LIKE $1`, [`${KEY}%`]);

/* ------------------------------------------------------- the routes, end to end */

let cookie = "";
async function app(path, init = {}) {
  const res = await fetch(`${APP}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      origin: APP,
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  return {
    status: res.status,
    retryAfter: res.headers.get("retry-after"),
    body: await res.json().catch(() => ({})),
  };
}

const reachable = await fetch(`${APP}/api/recordings`).then(
  () => true,
  () => false,
);
if (!reachable) {
  console.log(`\ncheck-rate-limit: ${APP} is not answering; skipping the route checks`);
} else {
  const email = `ratelimit-${Date.now()}@example.com`;
  const password = "a".repeat(43);

  const signUp = await app("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "Rate Limit" }),
  });
  check("signed up", signUp.status === 200, `status ${signUp.status}`);
  const userId = signUp.body?.user?.id;

  if (userId) {
    // Sign-in is limited to 10/minute. The eleventh must be refused, and it must
    // be refused with 429 rather than 401 — the difference between "wrong
    // password" and "stop asking" is the whole point.
    let signInStatuses = [];
    for (let i = 0; i < 12; i++) {
      const r = await app("/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email, password: "wrong-password-entirely" }),
      });
      signInStatuses.push(r.status);
    }
    check(
      "sign-in stops answering 401 and starts answering 429",
      signInStatuses.includes(429),
      signInStatuses.join(","),
    );

    // The share endpoint is 30/minute per network and takes no session.
    let shareStatuses = [];
    for (let i = 0; i < 34; i++) {
      const r = await app(`/api/shares/nonexistent-token-${i}`);
      shareStatuses.push(r.status);
    }
    const firstLimited = shareStatuses.indexOf(429);
    check(
      "public share fetches are limited after 30",
      firstLimited === 30,
      `first 429 at request ${firstLimited + 1}`,
    );
    check(
      "and a 429 there is distinguishable from a missing token",
      shareStatuses[0] === 404 && shareStatuses[33] === 429,
      `first=${shareStatuses[0]} last=${shareStatuses[33]}`,
    );

    await client.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
    await client.query(
      `DELETE FROM "rate_limit" WHERE "key" LIKE 'share:%' OR "key" LIKE '%sign-in%'`,
    );
  }
}

await client.end();

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
