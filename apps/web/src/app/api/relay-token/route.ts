import { createHmac, randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";

import { auth } from "@/lib/auth";

/**
 * Mints a short-lived relay token.
 *
 * The relay is stateless and must not query a database on the data path, so
 * authorisation travels with the request as an HMAC-signed token. Crucially the
 * token names the exact destination: without that binding, any signed-in user
 * could point the relay at anything the SSRF rules allow and use it as a
 * general TCP proxy.
 *
 * Must stay byte-compatible with core/relay/src/token.rs.
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

export async function POST(request: Request) {
  const { sub, ttl, anonymous } = await subjectFor();

  const secret = process.env.RELAY_SECRET;
  if (!secret) {
    // Fail closed: minting unsigned tokens would let anyone reach the relay.
    return Response.json({ error: "relay not configured" }, { status: 503 });
  }

  let body: { host?: unknown; port?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { host, port } = body;
  if (typeof host !== "string" || !host || typeof port !== "number") {
    return Response.json({ error: "host (string) and port (number) required" }, { status: 400 });
  }
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    return Response.json({ error: "invalid port" }, { status: 400 });
  }

  const claims = {
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
