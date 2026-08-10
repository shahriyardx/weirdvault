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
 * What a crawler may fetch.
 *
 * There was no robots.txt at all, which means every route was fair game — and
 * three groups of them should never be crawled:
 *
 * **`/share/`** is the sharp one. The token in the path *is* the credential for
 * a shared recording. Indexed, it becomes a working link in a public search
 * index. It still cannot be decrypted — the key lives in the URL fragment and
 * fragments are never sent to a server, let alone crawled — but it can be
 * fetched, and every fetch spends a view against the limit the owner set. A
 * crawler could exhaust a three-view link before the person it was sent to
 * opened it.
 *
 * **`/api/` and `/dashboard/`** are the application. The dashboard redirects a
 * signed-out visitor to /sign-in, so a crawler would index the sign-in page
 * under a dozen dashboard URLs — duplicate content standing in for pages that
 * do not exist to the public.
 *
 * **`/install.sh` and `/agent-bin/`** are a shell script and unsigned
 * executables. Nothing about them belongs in a search index, and a domain
 * serving crawlable binaries is a signal to exactly the classifiers that put a
 * "Dangerous site" interstitial in front of this app once already.
 *
 * Disallow is not an access control and is not treated as one: none of these
 * paths rely on it for their security. `/share/` is protected by 256 bits of
 * token and a key that never leaves the sender's browser; the dashboard by a
 * session. This is about what gets indexed, and nothing more.
 */
export default function robots(): MetadataRoute.Robots {
  const origin = configuredOrigin()

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/dashboard/", "/share/", "/install.sh", "/agent-bin/"],
    },
    // Omitted rather than guessed when the origin is unset: a sitemap URL
    // pointing at the wrong host is worse than none, and a development machine
    // has no canonical host to name.
    ...(origin ? { sitemap: `${origin}/sitemap.xml`, host: origin } : {}),
  }
}
