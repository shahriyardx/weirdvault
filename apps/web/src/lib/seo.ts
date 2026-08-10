import type { Metadata } from "next"

import { configuredOrigin } from "@/lib/origin"

/**
 * What crawlers and link previews are told, in one place.
 *
 * Metadata was previously a `title` and a `description` per page and nothing
 * else: no canonical, no Open Graph, no robots directive, and no
 * `metadataBase` — which meant Next had no absolute origin to resolve anything
 * against, so even the tags that existed could not become absolute URLs.
 *
 * The gap that mattered most is the canonical. This app was reachable on two
 * hostnames for a while, because the bare company domain fell through to it on
 * a shared origin. Two hostnames serving one site is duplicate content, and a
 * crawler that finds it picks a canonical itself unless told — which is how a
 * marketing page ends up ranking under the wrong domain, or not at all.
 *
 * The second gap is the opposite instruction: several routes must never be
 * indexed, and nothing said so. `/share/[token]` is the sharp one — the token
 * *is* the credential, so an indexed share URL puts a working link into a
 * public search index. It cannot be decrypted without the key in the fragment,
 * which is never sent anywhere, but it can be fetched, and every fetch spends a
 * view against a limit the owner set.
 *
 * ── Titles
 *
 * The root layout sets a `%s · weirdvault` template, so a page passes the bare
 * page name and gets the suffix. What a page must NOT do is repeat the product
 * name in its own title, which is how titles like
 * "weirdvault Pricing · weirdvault" happen.
 */

/** The product name, in the one place both the template and the OG tags read. */
export const SITE_NAME = "weirdvault"

/**
 * The one-sentence description of the product.
 *
 * Duplicated nowhere: the root layout's description, the Open Graph card and
 * the structured data all read this, so the sentence a person sees in a search
 * result is the same sentence a link preview shows.
 */
export const SITE_DESCRIPTION =
  "A zero-install SSH client that runs in your browser tab. Generate a key, connect to any " +
  "server, and get a terminal, file explorer and remote editor — with keys we cannot read."

/**
 * Absolute base for every relative URL in metadata.
 *
 * Null on a deployment with no BETTER_AUTH_URL, and Next then simply omits the
 * tags that need one rather than emitting a relative canonical, which is worse
 * than none.
 */
export function metadataBase(): URL | undefined {
  const origin = configuredOrigin()
  return origin ? new URL(origin) : undefined
}

interface PageSeoOptions {
  /** Bare page name. The layout appends the product name. */
  title: string
  description: string
  /** Path with a leading slash. The canonical and OG URL are built from it. */
  path: string
  /** Keep it out of the index. Everything behind auth, and every share link. */
  noindex?: boolean
}

/**
 * One page's metadata, with the canonical and the social card derived from the
 * same title and description rather than written out three times.
 */
export function pageMetadata({
  title,
  description,
  path,
  noindex = false,
}: PageSeoOptions): Metadata {
  const base = metadataBase()

  return {
    title,
    description,
    ...(base ? { metadataBase: base } : {}),
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      // Written out rather than left to the template: Open Graph has no
      // template, so a bare "Pricing" would be the whole card title.
      title: `${title} · ${SITE_NAME}`,
      description,
      url: path,
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} · ${SITE_NAME}`,
      description,
    },
    ...(noindex
      ? {
          // `nofollow` as well as `noindex`: these pages link onward into the
          // application, and there is nothing there worth a crawler's time or
          // ours.
          robots: { index: false, follow: false, nocache: true },
        }
      : {}),
  }
}

/**
 * Metadata for a route that must never be indexed and has nothing to say to a
 * crawler — the application itself, and share links.
 *
 * Separate from `pageMetadata` because these want no canonical and no social
 * card. A share link with an Open Graph description would put a summary of
 * somebody's terminal session into a chat preview, which is the opposite of
 * what a link nobody else should read is for.
 */
export const NOINDEX: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  // Explicitly none, rather than inheriting the root layout's "/" — a page
  // telling a crawler both "do not index me" and "the canonical version of me
  // is the home page" is two contradictory instructions, and the second is
  // simply false.
  alternates: { canonical: null },
}
