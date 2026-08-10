import Link from "next/link"
import { ArrowRightIcon, BroadcastIcon, ShieldCheckIcon } from "@phosphor-icons/react/dist/ssr"

import { ArchitectureDiagram } from "@/components/diagrams/architecture"
import { FeatureBento } from "@/components/marketing/bento"
import { HeroTerminal } from "@/components/marketing/hero-terminal"
import { Reveal, ScrollScene, TiltCard } from "@/components/marketing/motion"
import { PageShell } from "@/components/shell/page-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { AUDIT_RETENTION_LABEL } from "@/lib/audit/retention"
import { RELAY_ALLOWANCE_BYTES } from "@/lib/billing/tiers"
import { formatBytes } from "@/lib/usage"

/**
 * Imported rather than written out, for the same reason the pricing page does
 * it: a landing page that names a different cap from the one /api/relay-token
 * refuses at is a landing page that lies the first time either changes.
 */
const FREE_TRANSFER = formatBytes(RELAY_ALLOWANCE_BYTES.free)
const FREE_HISTORY = AUDIT_RETENTION_LABEL.free

/**
 * The landing page.
 *
 * The design brief was 3D, minimal, enterprise. The reading of it here is that
 * depth should come from real perspective on real content — the product tilted
 * in space, straightening as you scroll into it — rather than from decorative
 * geometry that has nothing to do with what is being sold. Everything that
 * moves is either the product or the diagram of the product.
 *
 * Motion is scroll-linked through one CSS custom property (see
 * components/marketing/motion.tsx) so the transforms stay on the compositor,
 * and every animation is off under prefers-reduced-motion. A page whose pitch
 * is "this is lighter than the thing you are using" cannot be the page that
 * drops frames on a laptop.
 *
 * The copy rules are the same as everywhere else in this codebase: nothing is
 * claimed that is not shipped, the one enforced limit is stated on the page
 * rather than discovered later, and every number is imported from the module
 * that enforces it.
 */
export default function Home() {
  return (
    <PageShell bleed>
      {/* ------------------------------------------------------------ hero */}
      <section className="relative overflow-hidden border-b border-border">
        <HeroBackdrop />

        <div className="relative mx-auto w-full max-w-6xl px-4 pt-20 pb-16 sm:px-6 sm:pt-28 sm:pb-24">
          <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16">
            {/* ------------------------------------------------ hero copy */}
            <div className="animate-fade">
              <Badge variant="outline" className="mb-6 gap-1.5 font-normal">
                <ShieldCheckIcon weight="fill" className="text-primary" />
                Keys never leave your browser
              </Badge>

              <h1 className="font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
                SSH from any browser.
                <span className="mt-1 block bg-gradient-to-br from-foreground via-foreground to-muted-foreground bg-clip-text text-transparent">
                  Nothing to install.
                </span>
              </h1>

              <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground">
                Open a tab, generate a key, add one line to your server. You get a real terminal, a
                file explorer, drag-and-drop uploads and a remote editor — with an SSH client that
                runs inside the page, not on our servers.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <Button asChild size="lg">
                  <Link href="/dashboard/terminal">
                    Launch the dashboard <ArrowRightIcon />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link href="/security">How the encryption works</Link>
                </Button>
              </div>

              <CommandPreview />
            </div>

            {/* --------------------------------------------- hero visual */}
            {/* Tilted in space and straightening as it is scrolled into. The
                perspective sits on the wrapper so the shadow tilts with the
                surface rather than staying flat under it. */}
            <ScrollScene className="relative [perspective:1600px]">
              <div className="[transform:rotateX(calc((1_-_var(--p))_*_16deg))_rotateY(calc((1_-_var(--p))_*_-9deg))_scale(calc(0.94_+_var(--p)_*_0.06))] [transform-style:preserve-3d] will-change-transform">
                <div className="absolute -inset-8 -z-10 bg-[radial-gradient(ellipse_at_center,color-mix(in_oklch,var(--primary)_16%,transparent),transparent_70%)] blur-2xl" />
                <HeroTerminal />
              </div>
            </ScrollScene>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ stat strip */}
      <section className="border-b border-border bg-card/30">
        {/* Worded, not numbered.
            These read left to right before anyone reaches the caption, and two
            of them used to be a bare "0" — which in the strip position where a
            visitor expects customers, uptime or years in business scans as "no
            traction" for exactly as long as it takes to read the small text
            underneath. The claims are identical; only the first glance changes.
            Faking a customer count instead would be the other way to fix this,
            and it is not available. */}
        <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-px px-4 sm:px-6 lg:grid-cols-4">
          <Stat value="No agent" label="to install on your server, ever" />
          <Stat value="One line" label="pasted into ~/.ssh/authorized_keys" />
          <Stat value="Never" label="do we hold a key that opens your data" />
          <Stat value={FREE_TRANSFER} label="of relay transfer a month, free" />
        </div>
      </section>

      {/* -------------------------------------------------------- features */}
      <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        {/* Centred, unlike the rest of the page's left-aligned headings: the
            bento below is a symmetrical block, and a left-aligned title over a
            centred grid reads as a mistake rather than a choice. */}
        <Reveal className="mx-auto max-w-2xl text-center">
          <h2 className="font-heading text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            A dashboard, not a web terminal
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground text-pretty">
            Everything rides one SSH connection, so the file explorer costs no second login and the
            editor opens instantly.
          </p>
        </Reveal>

        <Reveal delay={80} className="mt-10">
          <FeatureBento />
        </Reveal>
      </section>

      {/* --------------------------------------------------------- security */}
      <section className="relative border-y border-border bg-card/40">
        <div
          aria-hidden
          className="absolute inset-0 [background-image:linear-gradient(to_right,color-mix(in_oklch,var(--border)_35%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklch,var(--border)_35%,transparent)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_60%_60%_at_50%_50%,#000_30%,transparent_100%)]"
        />
        <div className="relative mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
            <Reveal>
              <Badge variant="outline" className="mb-5 gap-1.5 font-normal">
                <BroadcastIcon weight="fill" className="text-primary" />
                End to end, not end to us
              </Badge>
              <h2 className="font-heading text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
                The relay cannot read your session
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                A browser can&apos;t open a TCP socket, so something has to bridge to your server.
                Ours forwards bytes that were already encrypted inside your tab — the SSH handshake
                terminates in the page, not in our infrastructure. Host keys are pinned on first use
                and verified on every reconnect, which is what keeps the relay honest.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                What the relay does see is metadata: which host, when, and how much. We publish that
                rather than gloss it, and the whole thing is self-hostable if you&apos;d rather it
                saw nothing at all.
              </p>
              <Button asChild variant="outline" className="mt-6">
                <Link href="/security">Read the threat model</Link>
              </Button>
            </Reveal>

            <Reveal delay={90}>
              <TiltCard>
                <Card className="overflow-hidden shadow-xl shadow-black/30">
                  <CardContent className="p-5">
                    <ArchitectureDiagram />
                  </CardContent>
                </Card>
              </TiltCard>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- cta */}
      <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <Reveal className="flex flex-col items-start gap-8 md:flex-row md:items-center">
          <div>
            <h2 className="font-heading text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
              Sync is free. Forever.
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Unlimited hosts, unlimited devices, SFTP, snippets, recordings and encrypted sync —
              all of it free, because there is no paid tier holding anything back. Two limits, and
              neither is a paywall: our relay carries {FREE_TRANSFER} a month for you, and activity
              history keeps {FREE_HISTORY}. A relay you host yourself carries as much as you like.
              The pricing page says which parts are unfinished rather than leaving you to find out.
            </p>
          </div>
          <div className="flex gap-3 md:ml-auto md:shrink-0">
            <Button asChild size="lg">
              <Link href="/sign-up">Create account</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/pricing">See pricing</Link>
            </Button>
          </div>
        </Reveal>
      </section>
    </PageShell>
  )
}

/* --------------------------------------------------------------- pieces */

/**
 * The hero's backdrop: a grid that drifts up as the page scrolls, plus a soft
 * bloom behind the headline. Both are aria-hidden decoration.
 */
function HeroBackdrop() {
  return (
    <ScrollScene decorative className="pointer-events-none absolute inset-0">
      <div className="absolute inset-0 [background-image:linear-gradient(to_right,color-mix(in_oklch,var(--border)_45%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklch,var(--border)_45%,transparent)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_75%_60%_at_50%_0%,#000_45%,transparent_100%)] [transform:translate3d(0,calc(var(--p)*-3rem),0)] will-change-transform" />
      <div className="absolute -top-24 left-1/2 size-[38rem] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--primary)_11%,transparent),transparent_65%)] blur-3xl" />
    </ScrollScene>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="border-border px-2 py-8 not-last:border-r sm:px-4">
      {/* One size down from the old digits, and no tabular-nums: these are
          words now, and figure-width spacing on a word looks like a bug. */}
      <p className="font-heading text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
        {value}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-pretty text-muted-foreground">{label}</p>
    </div>
  )
}

/** The whole server-side setup, shown rather than described. */
function CommandPreview() {
  return (
    <div className="mt-10 max-w-xl overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-destructive/60" />
          <span className="size-2.5 rounded-full bg-warning/60" />
          <span className="size-2.5 rounded-full bg-success/60" />
        </span>
        <span className="text-xs text-muted-foreground">your server — setup, in full</span>
      </div>
      <pre className="overflow-x-auto bg-terminal px-4 py-3 text-xs leading-relaxed">
        <span className="text-muted-foreground">$ </span>
        <span className="text-foreground">echo </span>
        <span className="text-success">&apos;ssh-ed25519 AAAAC3Nza…&apos;</span>
        <span className="text-foreground"> &gt;&gt; ~/.ssh/authorized_keys</span>
      </pre>
    </div>
  )
}
