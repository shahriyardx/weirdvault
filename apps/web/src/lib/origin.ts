/**
 * The URL this deployment is reached at, from the outside.
 *
 * Not `new URL(request.url).origin`, which is what three call sites used to do
 * and which is wrong behind a reverse proxy. Next builds that URL from what the
 * server itself sees, so in a container it can come out as the container's own
 * hostname and internal port — `https://2d37fdd85f21:3000`. That is a perfectly
 * good origin for a request that already arrived, and useless for anything
 * handed to somebody else to use.
 *
 * Which is exactly what these values are. They are not links within a page,
 * where a relative path would do; they are absolute URLs that leave the
 * request entirely:
 *
 *   - the installer's APP_URL and release base, pasted into a root shell on a
 *     machine that has never heard of your container;
 *   - the release URL written into an agent's config, which it fetches from
 *     unattended for as long as it runs;
 *   - Stripe's success and cancel URLs, which a browser is redirected to after
 *     a payment on somebody else's site.
 *
 * Each failed the same way and none of them failed at the point of the mistake.
 *
 * So the answer comes from configuration, because the public URL is a fact only
 * the operator knows — no header proves it, and `Host` is written by the caller
 * unless a proxy overwrote it. `BETTER_AUTH_URL` already carries it, is already
 * required for sign-in to work at all, and is already the value the deployment
 * docs make you set. Using a second variable for the same fact would be a
 * second thing to get wrong.
 *
 * The request is the fallback rather than the source, for local development,
 * where there is no proxy and the two agree.
 */
export function publicOrigin(request: Request): string {
  return configuredOrigin() ?? new URL(request.url).origin
}

/**
 * The same answer, for callers that have no request to fall back to.
 *
 * `generateMetadata` and the robots and sitemap routes are the ones that need
 * it: they run without a Request, and what they emit — canonical URLs, Open
 * Graph URLs, sitemap entries — is not a link within a page but an absolute URL
 * handed to a crawler and remembered.
 *
 * Getting it wrong here is expensive in a way the other callers are not. This
 * app was, for a while, reachable on two hostnames: the bare company domain
 * fell through to it because nothing else claimed that name on the origin. Two
 * hostnames serving one site is duplicate content, and left to itself Google
 * picks a canonical of its own — quite possibly the wrong one. A canonical tag
 * naming the configured origin is what settles it, and it can only do that if
 * every page emits the same origin regardless of which hostname the request
 * arrived on. So this deliberately does NOT fall back to the request.
 *
 * Null when unset, so the caller decides. On a development machine there is no
 * canonical origin to speak of and inventing localhost would be worse than
 * emitting nothing.
 */
export function configuredOrigin(): string | null {
  const configured = process.env.BETTER_AUTH_URL
  if (!configured) return null
  try {
    return new URL(configured).origin
  } catch {
    // A malformed BETTER_AUTH_URL is an operator error worth saying out loud:
    // sign-in is already broken, and silently falling through would make this
    // look like a different bug.
    console.warn(
      `BETTER_AUTH_URL is not a usable URL (${configured}); falling back to the request origin, ` +
        "which is wrong behind a proxy",
    )
    return null
  }
}
