import { NOINDEX } from "@/lib/seo"

/**
 * Share links, kept out of every index.
 *
 * This exists only to carry the metadata. The page itself is a Client
 * Component — it has to be, since the server holds a blob it cannot open — and
 * a Client Component cannot export `metadata`, so without a layout here there
 * was nowhere to say this.
 *
 * And it needs saying more than anything else on the site. The token in the
 * path *is* the credential: `/api/shares/[token]` authenticates nobody and
 * serves the ciphertext to whoever presents it. Indexed, that URL becomes a
 * working link sitting in a public search index.
 *
 * What indexing would not do is expose the transcript. The decryption key
 * travels in the URL fragment, and browsers never send a fragment to a server —
 * so a crawler fetching the page gets ciphertext it cannot open, and Google
 * could not read it any more than we can. The damage is smaller than that and
 * still real: every fetch spends a view against the limit the owner set, so a
 * crawler can exhaust a three-view link before the person it was sent to opens
 * it, and the existence and timing of a share becomes public.
 *
 * `robots.ts` disallows `/share/` as well. Both are here on purpose: robots.txt
 * asks politely and is widely ignored, while a `noindex` in the response is
 * obeyed by the crawlers that matter. Neither is a security control, and
 * neither is treated as one — what actually protects a share is 256 bits of
 * token and a key that never left the sender's browser.
 *
 * The Open Graph card is the root layout's generic one, inherited rather than
 * overridden, and that is the right outcome rather than an oversight: pasting a
 * share link into a chat shows a recognisable product card and nothing about
 * the recording. What must never happen is a card *describing* the session —
 * which cannot happen here, because this page's metadata is static and the
 * server has never been able to read the transcript to describe it.
 */
export const metadata = NOINDEX

export default function ShareLayout({ children }: LayoutProps<"/share">) {
  return children
}
