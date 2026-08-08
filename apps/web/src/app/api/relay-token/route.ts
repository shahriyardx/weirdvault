import { createHmac } from "node:crypto";
import { headers } from "next/headers";

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
 * Must stay byte-compatible with crates/relay/src/token.rs.
 */

const TTL_SECONDS = 60;
const MAX_PORT = 65535;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

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
    sub: session.user.id,
    host,
    port,
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  };

  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const signature = b64url(createHmac("sha256", secret).update(payload).digest());

  return Response.json({ token: `${payload}.${signature}`, expiresIn: TTL_SECONDS });
}
