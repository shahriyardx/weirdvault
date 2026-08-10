import { sql } from "drizzle-orm";

import { clientAddress, proxyConfigured } from "@/lib/audit/address";
import { ipPrefix } from "@/lib/audit/events";
import { db, schema } from "@/lib/db";
import { dbErrorSummary } from "@/lib/db/errors";

/**
 * One limiter, for every route that has one.
 *
 * ── What this is for, and what it is not
 *
 * It bounds cost and noise. It is not what makes anything secure: a share token
 * is 256 bits, a recovery code is 120, and a session is a session. If this table
 * were truncated every minute, nothing would become guessable. What would happen
 * is that one script could create ten thousand accounts, each entitled to a
 * gigabyte of recording storage in a bucket somebody pays for, and could sit on
 * the sign-in endpoint until the log was useless.
 *
 * Saying that plainly matters, because it decides the failure direction. A
 * limiter that refuses requests when the database is unreachable would turn a
 * slow query into an outage of the whole product. So a failure here **allows**
 * the request and logs; see `consume`.
 *
 * ── Who is being counted
 *
 * In descending order of how much the key can be trusted:
 *
 *  1. A user id, when there is a session. Stable, unforgeable, and the only one
 *     of the three that is really a *subject*.
 *  2. A truncated network, when `TRUSTED_PROXY_HOPS` says which entry in
 *     X-Forwarded-For your own proxy wrote. /24 for v4 and /48 for v6, so one
 *     caller cannot spend a whole network's budget and a whole network cannot be
 *     used to multiply one caller's.
 *  3. One bucket shared by everybody, when neither is available.
 *
 * The third is uncomfortable and it is deliberate. Without a trusted proxy there
 * is no address a Route Handler can believe — X-Forwarded-For is written by the
 * caller, so keying on it hands every caller a private budget and the limit
 * stops existing. A shared bucket is trippable by a stranger, which is a real
 * denial of service against the endpoint; a client-chosen key is a limiter that
 * stops nobody at all. lib/audit/address.ts argues this at length and this
 * module simply obeys it. The fix on a real deployment is one variable, and
 * DEPLOY.md says so.
 *
 * ── The window
 *
 * Fixed, anchored at the first request in it. `window_start` moves only when a
 * window has elapsed, so a caller running steadily under the limit is never
 * pushed over it by their own traffic — which is what happens with a window that
 * slides forward on every allowed request, and is why Better Auth's built-in
 * database storage is replaced rather than configured. See `authRateLimitStorage`.
 *
 * The count is incremented even while blocked, and that is not an accident: it
 * makes `count` a usable measure of how hard something is being hit. What is
 * *not* extended while blocked is `window_start`, so a caller who trips a limit
 * is let back in when the window ends rather than being held out for as long as
 * they keep knocking.
 */

/** A limit: how many, over how long. */
export interface Rule {
  max: number;
  windowSeconds: number;
}

export interface Decision {
  allowed: boolean;
  /** Seconds until the window opens again. Zero when allowed. */
  retryAfter: number;
}

const ALLOWED: Decision = { allowed: true, retryAfter: 0 };

/**
 * Records one request against `key` and says whether it may proceed.
 *
 * A single statement, because the check and the increment have to be one
 * operation. Read-then-write lets N concurrent requests all see the same count,
 * all decide they are under the limit, and all be allowed — which is precisely
 * the burst a limiter exists for, so the non-atomic version fails in exactly the
 * case it was written for. Postgres serialises the conflicting upserts on the
 * primary key.
 */
export async function consume(key: string, rule: Rule): Promise<Decision> {
  const now = Date.now();
  const windowMs = rule.windowSeconds * 1000;

  try {
    const rows = await db.execute<{ count: number; window_start: string }>(sql`
      insert into ${schema.rateLimit} ("key", "count", "window_start")
      values (${key}, 1, ${now})
      on conflict ("key") do update set
        "count" = case
          when ${now} - "rate_limit"."window_start" >= ${windowMs} then 1
          else "rate_limit"."count" + 1
        end,
        "window_start" = case
          when ${now} - "rate_limit"."window_start" >= ${windowMs} then ${now}
          else "rate_limit"."window_start"
        end
      returning "count", "window_start"
    `);

    const row = rows.rows[0];
    if (!row) return ALLOWED;

    const count = Number(row.count);
    if (count <= rule.max) return ALLOWED;

    // `window_start` comes back as a string: node-postgres hands bigint out as
    // text rather than silently rounding it through a double.
    const endsAt = Number(row.window_start) + windowMs;
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((endsAt - now) / 1000)) };
  } catch (e) {
    // Fails open, and loudly. The alternative is that an unreachable database
    // stops sign-in, playback and everything else in the app — trading a bounded
    // abuse problem for a total outage. Summarised rather than logged whole,
    // because a drizzle error's message carries the SQL and its bound
    // parameters, and one of those parameters is a user id. See lib/db/errors.ts.
    console.warn("rate limit check failed; allowing the request", dbErrorSummary(e));
    return ALLOWED;
  }
}

/* ------------------------------------------------------------------ subjects */

/** The bucket everything shares when no subject can be established. */
const UNRESOLVED = "unresolved";

/**
 * Who to count this request against.
 *
 * `userId` is passed rather than resolved here so that a caller which has
 * already loaded the session does not load it twice, and so that this module
 * never imports lib/auth.ts — which would drag the whole auth stack into any
 * route that wants a limit.
 */
export function subjectFor(headers: Headers, userId?: string | null): string {
  if (userId) return `u:${userId}`;
  if (!proxyConfigured) return UNRESOLVED;
  const address = clientAddress(headers);
  const prefix = address ? ipPrefix(address) : null;
  return prefix ? `n:${prefix}` : UNRESOLVED;
}

/** `<bucket>:<subject>`, so two routes cannot share a budget by accident. */
export function keyFor(bucket: string, subject: string): string {
  return `${bucket}:${subject}`;
}

/**
 * The whole thing in one call, for a route that just wants a limit.
 *
 * Returns null when the request may proceed, and a 429 when it may not, so the
 * call site reads `const limited = await enforce(...); if (limited) return limited;`
 * and cannot forget to act on the answer — which a boolean invites.
 */
export async function enforce(
  bucket: string,
  request: Request,
  rule: Rule,
  options: { userId?: string | null; message?: string } = {},
): Promise<Response | null> {
  const decision = await consume(
    keyFor(bucket, subjectFor(request.headers, options.userId)),
    rule,
  );
  if (decision.allowed) return null;
  return tooManyRequests(decision, options.message);
}

/**
 * A 429 with the header that tells a client when to come back.
 *
 * `Retry-After` in seconds is the standard spelling and the one a fetch wrapper
 * or a proxy will already understand. The body says the same thing in words,
 * because the app's own error handling surfaces `error` to the user.
 */
export function tooManyRequests(decision: Decision, message?: string): Response {
  const seconds = Math.max(1, decision.retryAfter);
  return Response.json(
    {
      error:
        message ??
        `That is more requests than this endpoint accepts. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`,
      retryAfter: seconds,
    },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  );
}

/* --------------------------------------------------------------- better auth */

/**
 * The same limiter, handed to Better Auth.
 *
 * Better Auth ships its own storage backends and this replaces them, for two
 * reasons rather than taste. Its `memory` backend is per process, so it is the
 * thing this module exists to stop being. Its `database` backend is durable but
 * slides the window forward on every allowed request, so a caller drip-feeding
 * *below* the limit still accumulates count until they are blocked — which is
 * defensible and is not what the fixed window everything else here uses does.
 * Two algorithms differing in a way nobody would predict from reading the config
 * is worse than one algorithm.
 *
 * `consume` is the atomic path and the only one Better Auth calls when it is
 * present. `get` and `set` are the legacy non-atomic fallback; they are
 * implemented rather than thrown from so that a future version which reaches for
 * them degrades instead of erroring, and they share the table so the counts stay
 * the same counts.
 */
export const authRateLimitStorage = {
  async get(key: string) {
    const rows = await db.execute<{ count: number; window_start: string }>(sql`
      select "count", "window_start" from ${schema.rateLimit} where "key" = ${key}
    `);
    const row = rows.rows[0];
    if (!row) return null;
    return { key, count: Number(row.count), lastRequest: Number(row.window_start) };
  },

  async set(key: string, value: { count: number; lastRequest: number }) {
    await db.execute(sql`
      insert into ${schema.rateLimit} ("key", "count", "window_start")
      values (${key}, ${value.count}, ${value.lastRequest})
      on conflict ("key") do update set
        "count" = ${value.count}, "window_start" = ${value.lastRequest}
    `);
  },

  async consume(key: string, rule: { window: number; max: number }) {
    // Better Auth counts its window in seconds and calls it `window`; the shape
    // is otherwise identical.
    const decision = await consume(key, { max: rule.max, windowSeconds: rule.window });
    return {
      allowed: decision.allowed,
      retryAfter: decision.allowed ? null : decision.retryAfter,
    };
  },
};
