import { readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * What build of the agent this deployment publishes.
 *
 * ## Why the manifest and not the environment variable
 *
 * `AGENT_VERSION` is stamped into the binaries and into `manifest.json` in one
 * Docker stage, so at build time they agree. At runtime they can drift — the
 * variable is edited in `.env` and the container restarted without a rebuild,
 * or `AGENT_RELEASE_BASE_URL` points at a release host somebody else publishes
 * to. Reading the environment would then have the dashboard announce an update
 * that is not on the release server, which is worse than saying nothing: the
 * user follows the instructions, the agent finds the same version it already
 * has, and nothing happens twice.
 *
 * So this reads what the agents themselves read. The manifest is the contract.
 */

/** How long a manifest read is reused. */
const CACHE_MS = 60_000

let cache: { value: string | null; at: number } | null = null

/** Where the running agents look, which is the only place worth reading. */
function releaseBase(): string | null {
  return process.env.AGENT_RELEASE_BASE_URL?.replace(/\/$/, "") || null
}

function versionFrom(body: unknown): string | null {
  const version = (body as { version?: unknown } | null)?.version
  return typeof version === "string" && version ? version : null
}

async function readManifestVersion(): Promise<string | null> {
  const base = releaseBase()

  try {
    if (base) {
      // Published somewhere else. Fetched rather than guessed, with a timeout —
      // a release host that hangs must not hang the machines page with it.
      const res = await fetch(`${base}/manifest.json`, {
        signal: AbortSignal.timeout(3000),
        cache: "no-store",
      })
      if (!res.ok) return null
      return versionFrom(await res.json())
    }

    // The default: served from this app's own public directory, which is where
    // the Docker build writes it. Read from disk rather than fetched from our
    // own origin — an HTTP round trip to ourselves adds a way for this to fail
    // that has nothing to do with the question being asked.
    const raw = await readFile(join(process.cwd(), "public", "agent-bin", "manifest.json"), "utf8")
    return versionFrom(JSON.parse(raw))
  } catch {
    // Not an error worth surfacing. No manifest means agent binaries were never
    // built into this deployment, which is a real and supported state — the
    // dashboard then says nothing about versions at all.
    return null
  }
}

/**
 * The published version, cached briefly.
 *
 * Cached because the machines page reloads on every change and the answer only
 * moves on a deploy. Failures are cached for the same interval, so a release
 * host that is down is not retried once per render.
 */
export async function publishedAgentVersion(): Promise<string | null> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.value

  const value = await readManifestVersion()
  cache = { value, at: now }
  return value
}

/** Forgets the cached manifest. For tests, and for nothing else. */
export function forgetPublishedAgentVersion(): void {
  cache = null
}
