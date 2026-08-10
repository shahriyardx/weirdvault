import type { MetadataRoute } from "next"

import { configuredOrigin } from "@/lib/origin"

/**
 * Resolved per request, not at build time.
 *
 * The origin comes from BETTER_AUTH_URL, and the production image does not
 * receive that at build time — only NEXT_PUBLIC_RELAY_URL is a build arg,
 * because only that one has to be inlined into the browser bundle. Everything
 * else arrives at runtime through env_file.
 *
 * Left static, this route would therefore be baked during `docker build` with
 * no origin at all: a robots.txt naming no sitemap, and a sitemap.xml with no
 * URLs in it. Both would serve happily and say nothing, which is the kind of
 * failure nobody notices until they wonder why a site is not being indexed.
 */
export const dynamic = "force-dynamic"

/**
 * The pages worth indexing, which is a much shorter list than the pages that
 * exist.
 *
 * Only the public, static ones: everything else is behind a session, is a share
 * link whose URL is a credential, or is an API route. A sitemap listing a page
 * that answers 302 to /sign-in wastes a crawl budget and teaches Google that
 * this site is mostly redirects.
 *
 * `priority` and `changeFrequency` are included because they cost nothing and
 * are occasionally read, but they are hints and not instructions — Google has
 * said for years that it largely ignores both. The list itself is the useful
 * part: it is how a page with no inbound links gets discovered at all.
 *
 * Empty when no origin is configured. A sitemap of relative URLs is invalid,
 * and one naming localhost would be worse.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = configuredOrigin()
  if (!origin) return []

  // One timestamp for the whole build. These pages change when the app is
  // deployed and not on their own schedule, so a per-page date would be a more
  // precise-looking version of the same guess.
  const lastModified = new Date()

  return [
    { url: `${origin}/`, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${origin}/pricing`, lastModified, changeFrequency: "monthly", priority: 0.8 },
    { url: `${origin}/security`, lastModified, changeFrequency: "monthly", priority: 0.8 },
    { url: `${origin}/docs`, lastModified, changeFrequency: "monthly", priority: 0.7 },
  ]
}
