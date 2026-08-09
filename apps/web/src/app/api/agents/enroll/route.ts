import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import {
  agentRelayUrl,
  agentReleaseUrl,
  hashEnrollmentToken,
  looksLikeEnrollmentToken,
} from "@/lib/agents/enrollment";
import { fingerprintFor } from "@/lib/agents/verify";

/**
 * Where a machine becomes an agent.
 *
 * This is the only unauthenticated write in the agent feature, and the token is
 * the whole of its authorisation — there is no session here, because the caller
 * is a daemon on a box that may not have a browser at all.
 *
 * Two properties make that safe enough to be worth doing:
 *
 * 1. The token is spent atomically. The UPDATE carries `used_at IS NULL` and
 *    `expires_at > now()` in its WHERE clause and reports how many rows it
 *    touched, so two daemons racing the same token produce one agent and one
 *    refusal. A read-then-write here would produce two agents and one confused
 *    user.
 * 2. Enrolling grants nothing but the ability to *offer* a connection. The agent
 *    holds no SSH credentials and cannot read the ciphertext it carries, so the
 *    worst a stolen token buys is attaching a machine the thief controls to
 *    somebody's account — which is why the waiting page shows a fingerprint and
 *    asks the user to confirm it before the machine is adopted.
 *
 * A refusal says only that the token was refused. Distinguishing expired from
 * spent from never-existed would tell whoever is guessing which half of the
 * space to search.
 */

const MAX_FIELD = 200;

function cleanString(value: unknown, max = MAX_FIELD): string | null {
  if (typeof value !== "string") return null;
  // Control characters stripped, not escaped. This is self-reported by the
  // machine and lands in a dashboard beside a fingerprint the user is being
  // asked to read carefully — a hostname carrying a newline or an ANSI escape
  // is either a bug or an attempt to make that comparison harder to do.
  const trimmed = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function isBase64Key(value: unknown): value is string {
  return (
    typeof value === "string" &&
    // 32 raw bytes is 44 base64 characters with padding.
    value.length === 44 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
    Buffer.from(value, "base64").length === 32
  );
}

export async function POST(request: Request) {
  const releaseUrl = agentReleaseUrl(new URL(request.url).origin);
  const relayUrl = agentRelayUrl();
  if (!relayUrl) {
    return Response.json(
      { error: "this deployment has no relay configured" },
      { status: 503 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!looksLikeEnrollmentToken(body.token)) {
    return Response.json({ error: "enrollment refused" }, { status: 401 });
  }
  if (!isBase64Key(body.publicKey)) {
    return Response.json(
      { error: "publicKey must be a base64 Ed25519 public key" },
      { status: 400 },
    );
  }

  const hostname = cleanString(body.hostname) ?? "unknown";
  const os = cleanString(body.os, 32);
  const arch = cleanString(body.arch, 32);
  const agentVersion = cleanString(body.version, 32);
  const publicKey = body.publicKey;

  const now = new Date();
  const agentId = randomUUID();

  /**
   * Claim, insert, link — all three or none.
   *
   * A transaction rather than three statements with compensating writes, and
   * the ordering inside it is not free choice: `agent_enrollment.agent_id`
   * references `agent.id`, so setting it in the claiming UPDATE points a
   * foreign key at a row that does not exist yet. That is not a race, it fails
   * every single time, and it did.
   *
   * The claim is still atomic. The UPDATE carries `used_at IS NULL` and takes a
   * row lock, so a second daemon presenting the same token blocks, then sees
   * the row already spent and matches nothing. And because a failed insert
   * rolls the claim back, there is no longer a window where a token is spent
   * and no agent exists — which previously needed a hand-written "release the
   * token" write that was itself a thing that could fail.
   */
  let outcome: { ok: true } | { ok: false; status: number; error: string };
  try {
    outcome = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(schema.agentEnrollment)
        .set({ usedAt: now })
        .where(
          and(
            eq(schema.agentEnrollment.tokenHash, hashEnrollmentToken(body.token as string)),
            isNull(schema.agentEnrollment.usedAt),
            gt(schema.agentEnrollment.expiresAt, now),
          ),
        )
        .returning({ userId: schema.agentEnrollment.userId, id: schema.agentEnrollment.id });

      if (claimed.length === 0) {
        // Returned rather than thrown: there is nothing to roll back, and a
        // throw here would be indistinguishable from a database failure one
        // catch block later.
        return { ok: false as const, status: 401, error: "enrollment refused" };
      }

      const { userId, id: enrollmentId } = claimed[0];

      await tx.insert(schema.agent).values({
        id: agentId,
        userId,
        label: hostname,
        publicKey,
        fingerprint: fingerprintFor(publicKey),
        hostname,
        os,
        arch,
        agentVersion,
      });

      await tx
        .update(schema.agentEnrollment)
        .set({ agentId })
        .where(eq(schema.agentEnrollment.id, enrollmentId));

      return { ok: true as const };
    });
  } catch (e) {
    // The insert is what fails here, and almost always on the unique index over
    // public_key: a machine re-enrolling with a config it still has, or a cloned
    // disk image carrying somebody else's key into a second VM. The token is
    // untouched — the rollback saw to that — so the same command can be retried.
    console.warn("agent enrollment failed", e);
    return Response.json(
      {
        error:
          "That key is already enrolled. If you are re-enrolling this machine, revoke the " +
          "old agent in the dashboard first, or delete /etc/webxterm-agent/agent.json.",
      },
      { status: 409 },
    );
  }

  if (!outcome.ok) {
    return Response.json({ error: outcome.error }, { status: outcome.status });
  }

  return Response.json({ agentId, relayUrl, releaseUrl });
}

/** Not a browser endpoint; a GET here is a misconfiguration worth naming. */
export function GET() {
  return Response.json(
    { error: "POST an enrollment token here; this is the agent's endpoint" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
