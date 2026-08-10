import { createHmac, randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { and, eq, isNull } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { dbErrorSummary } from "@/lib/db/errors";
import { relayAllowanceFor } from "@/lib/billing/subscription";
import { periodFor, periodResetsAt } from "@/lib/billing/tiers";
import { enforce } from "@/lib/rate-limit";
import { RELAY_QUOTA_EXCEEDED } from "@/lib/usage";

/**
 * Mints a short-lived relay token.
 *
 * The relay is stateless and must not query a database on the data path, so
 * authorisation travels with the request as an HMAC-signed token. Crucially the
 * token names the exact destination: without that binding, any signed-in user
 * could point the relay at anything the SSRF rules allow and use it as a
 * general TCP proxy.
 *
 * Must stay byte-compatible with apps/relay/src/token.rs.
 *
 * This is also where the monthly transfer allowance is enforced, and the choice
 * of place is the whole design. The relay counts bytes and posts them to
 * /api/relay/usage; it never learns what an allowance is. Refusing here means
 * an account over its allowance is refused a *new* connection, while sessions
 * already open keep running to their natural end — nobody's file transfer is
 * severed at a byte boundary because a counter crossed a line. It costs one
 * indexed row read per connection attempt, which is on the connection path and
 * not on the data path.
 */

const TTL_SECONDS = 60;
/** Anonymous sessions get a shorter window, since nothing binds them to a person. */
const ANON_TTL_SECONDS = 30;
const ANON_COOKIE = "webxterm.anon";
const MAX_PORT = 65535;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Identifies the caller for quota accounting.
 *
 * Signing in is not required to use webxterm — the free tier works with local
 * storage and no account, and the landing page says so. But the relay still
 * needs a subject to meter, so anonymous visitors get a random id in a cookie.
 *
 * That id is trivially rotatable, so per-subject quotas are weak for anonymous
 * users; the relay's global connection cap and the port allowlist are what
 * actually bound abuse there. Signed-in users get a stable subject, a longer
 * token TTL, and meaningful per-account limits.
 */
async function subjectFor(): Promise<{ sub: string; ttl: number; anonymous: boolean }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user) {
    return { sub: session.user.id, ttl: TTL_SECONDS, anonymous: false };
  }

  const jar = await cookies();
  let anon = jar.get(ANON_COOKIE)?.value;
  if (!anon || !/^[0-9a-f-]{36}$/i.test(anon)) {
    anon = randomUUID();
    jar.set(ANON_COOKIE, anon, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24,
    });
  }
  return { sub: `anon:${anon}`, ttl: ANON_TTL_SECONDS, anonymous: true };
}

/**
 * Whether this account has anything left this month.
 *
 * Fails open. If the usage table cannot be read, the token is minted and the
 * failure is logged: refusing every connection on the site because one query
 * timed out is a far worse outcome than a user getting some unmetered transfer
 * during an incident. It is the same direction the relay's reporter takes when
 * the control plane is unreachable, and for the same reason — under-enforcing an
 * abuse control degrades, over-enforcing it locks people out of their servers.
 *
 * `relayAllowanceFor` now resolves a subscription to decide which allowance
 * applies, and it takes the same direction independently: a subscription table
 * that cannot be read grants Pro rather than refusing it. So a database problem
 * during an incident produces the larger allowance and then, one line down, no
 * enforcement at all — both failures point the same way by construction rather
 * than by coincidence.
 */
async function allowanceCheck(userId: string): Promise<
  | { over: false }
  | { over: true; usedBytes: number; allowanceBytes: number; resetsAt: string }
> {
  const now = new Date();
  try {
    const allowanceBytes = await relayAllowanceFor(userId);
    const [row] = await db
      .select({
        bytesUp: schema.relayUsage.bytesUp,
        bytesDown: schema.relayUsage.bytesDown,
      })
      .from(schema.relayUsage)
      .where(
        and(
          eq(schema.relayUsage.userId, userId),
          eq(schema.relayUsage.period, periodFor(now)),
        ),
      )
      .limit(1);

    const usedBytes = (row?.bytesUp ?? 0) + (row?.bytesDown ?? 0);
    if (usedBytes < allowanceBytes) return { over: false };

    return {
      over: true,
      usedBytes,
      allowanceBytes,
      resetsAt: periodResetsAt(now).toISOString(),
    };
  } catch (e) {
    // Summarised rather than logged whole: a drizzle query error's message is
    // the SQL and its bound parameters, and the parameters here are a user id
    // and a billing period. See lib/db/errors.ts.
    console.warn("relay allowance check failed; minting anyway", dbErrorSummary(e));
    return { over: false };
  }
}

/**
 * Sixty tokens a minute.
 *
 * A token is minted per connection, and a person reconnecting after a dropped
 * WebSocket, opening several tabs, or using split panes will legitimately mint a
 * handful in quick succession — so this is set well above ordinary use. What it
 * bounds is a loop: each mint is an HMAC and an allowance query, and the token
 * it returns is the credential the relay accepts, so an unbounded mint endpoint
 * is an unbounded supply of relay connections.
 *
 * Keyed on the account when there is one. An anonymous caller's subject is a
 * cookie they can rotate, so for them this falls back to the network — which is
 * the honest position and is why the relay's own connection cap and port
 * allowlist, not this, are what actually bound anonymous use.
 */
const MINT_LIMIT = { max: 60, windowSeconds: 60 };

export async function POST(request: Request) {
  const { sub, ttl, anonymous } = await subjectFor();

  const limited = await enforce("relay-token", request, MINT_LIMIT, {
    userId: anonymous ? null : sub,
    message:
      "Too many connection attempts in the last minute. Sessions already open are unaffected; " +
      "wait a moment before opening another.",
  });
  if (limited) return limited;

  const secret = process.env.RELAY_SECRET;
  if (!secret) {
    // Fail closed: minting unsigned tokens would let anyone reach the relay.
    return Response.json({ error: "relay not configured" }, { status: 503 });
  }

  let body: { host?: unknown; port?: unknown; agent?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { host, port, agent } = body;

  // One destination or the other, never both. The relay refuses a token that
  // names both anyway, but a request that asks for both is a caller bug worth
  // naming here rather than letting it fail one hop later.
  if (agent !== undefined && host !== undefined) {
    return Response.json({ error: "name a host or an agent, not both" }, { status: 400 });
  }

  const wantsAgent = typeof agent === "string" && agent.length > 0;

  if (!wantsAgent && (typeof host !== "string" || !host || typeof port !== "number")) {
    return Response.json(
      { error: "host (string) and port (number), or agent (string), required" },
      { status: 400 },
    );
  }
  if (typeof port === "number" && (!Number.isInteger(port) || port < 1 || port > MAX_PORT)) {
    return Response.json({ error: "invalid port" }, { status: 400 });
  }

  // Anonymous subjects are not metered. There is no user row behind an
  // `anon:<uuid>` cookie, so /api/relay/usage discards their bytes and there is
  // nothing here to compare against — see the comment there. The relay's global
  // connection cap and the port allowlist are what bound anonymous use.
  if (!anonymous) {
    const allowance = await allowanceCheck(sub);
    if (allowance.over) {
      // 402 is the only status that means "the account is out of allowance"
      // rather than "this request was wrong" or "you are going too fast". It is
      // now literally true rather than merely the closest fit: Pro carries a
      // larger allowance, so paying is one of the ways out of this refusal. The
      // others are waiting for the reset, or running your own relay, and the
      // response carries the reset date so the caller can say which.
      return Response.json(
        {
          error: "relay transfer allowance used up",
          code: RELAY_QUOTA_EXCEEDED,
          usedBytes: allowance.usedBytes,
          allowanceBytes: allowance.allowanceBytes,
          resetsAt: allowance.resetsAt,
        },
        { status: 402 },
      );
    }
  }

  /**
   * Ownership is checked here, and only here.
   *
   * The relay cannot do it — it holds no database, which is the entire point of
   * the token — so a signed token naming `agent:<id>` *is* the statement that
   * this account may reach that machine. Every property of the agent path rests
   * on this query being right, which is why it is scoped by user id in the WHERE
   * clause and refuses a revoked row in the same breath rather than reading the
   * row and deciding afterwards.
   *
   * An anonymous subject can never own an agent, so this refuses before it
   * queries: `anon:<uuid>` has no user row for the join to find and the lookup
   * would be a slow way to reach the same answer.
   */
  if (wantsAgent) {
    if (anonymous) {
      return Response.json({ error: "sign in to reach your own machines" }, { status: 401 });
    }

    const [owned] = await db
      .select({ id: schema.agent.id })
      .from(schema.agent)
      .where(
        and(
          eq(schema.agent.id, agent as string),
          eq(schema.agent.userId, sub),
          isNull(schema.agent.revokedAt),
        ),
      )
      .limit(1);

    // 404, not 403: telling an account that an id it does not own is a real
    // agent is a fact about somebody else's machines.
    if (!owned) {
      return Response.json({ error: "no such machine" }, { status: 404 });
    }
  }

  const claims = wantsAgent
    ? {
        sub,
        agent: agent as string,
        exp: Math.floor(Date.now() / 1000) + ttl,
      }
    : {
        sub,
        host,
        port,
        exp: Math.floor(Date.now() / 1000) + ttl,
      };

  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const signature = b64url(createHmac("sha256", secret).update(payload).digest());

  return Response.json({
    token: `${payload}.${signature}`,
    expiresIn: ttl,
    anonymous,
  });
}
