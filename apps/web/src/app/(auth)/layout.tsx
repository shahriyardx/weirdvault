import Link from "next/link"
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/ssr"

import { Brand } from "@/components/shell/brand"
import { NOINDEX } from "@/lib/seo"

/**
 * Auth runs outside the site shell.
 *
 * Form on the right, where the eye lands and the cursor already is. The left
 * panel says what the app is, in a few lines. It used to carry the split-KDF
 * diagram and a walkthrough of the derivation, which is the wrong thing to
 * read while creating an account — /security carries all of that.
 */
/**
 * None of the four routes in this group belongs in a search index.
 *
 * /sign-in and /sign-up are thin duplicates of the landing page wrapped around
 * a form, and an indexed one competes with the page that actually explains the
 * product. /recover and /set-vault-password are worse than useless indexed: a
 * password form reachable from a search result, with no context for how anyone
 * arrived at it, is a phishing target wearing our own branding.
 *
 * Declared on the layout rather than per page because two of the four are
 * Client Components, which cannot export metadata at all. The two that do
 * export their own — for a title and a description — restate noindex there, and
 * page metadata wins over a layout's, so it has to be said in both places or
 * not at all.
 */
export const metadata = NOINDEX

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-svh w-full lg:grid-cols-2">
      {/* --------------------------------------------------------- explainer */}
      <aside className="relative hidden border-r border-border bg-card/40 lg:flex lg:flex-col lg:justify-center">
        <div
          aria-hidden
          className="absolute inset-0 [background-image:linear-gradient(to_right,color-mix(in_oklch,var(--border)_45%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklch,var(--border)_45%,transparent)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_70%_55%_at_50%_0%,#000_55%,transparent_100%)]"
        />

        <div className="relative mx-auto w-full max-w-md px-10 py-14">
          <h2 className="font-heading text-xl leading-snug font-semibold tracking-tight text-balance">
            SSH from any browser tab.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            A terminal, a file browser and an editor for your servers, with nothing to install — on
            your machine or theirs.
          </p>

          <ul className="mt-8 space-y-3 border-t border-border pt-6 text-sm text-muted-foreground">
            <li>Full terminal, SFTP and remote editing on one connection.</li>
            <li>Keys are generated in your browser and encrypted before they sync.</li>
            <li>Your laptop, a borrowed machine, or a phone — same account.</li>
          </ul>

          <p className="mt-8 text-xs/relaxed text-muted-foreground">
            <Link href="/security" className="underline underline-offset-4 hover:text-foreground">
              How it keeps your keys and hosts private
            </Link>
          </p>
        </div>
      </aside>

      {/* ------------------------------------------------------------- form */}
      <div className="flex min-w-0 flex-col lg:order-last">
        <header className="flex items-center justify-between gap-4 px-4 py-5 sm:px-8">
          <Brand />
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3.5" />
            Back to site
          </Link>
        </header>

        <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8">
          <div className="w-full max-w-sm">{children}</div>
        </main>

        {/* Spacer, so the form sits optically centred rather than pushed up by
            the header alone. */}
        <div aria-hidden className="py-5" />
      </div>
    </div>
  )
}
