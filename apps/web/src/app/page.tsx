import Link from "next/link";
import {
  ArrowRightIcon,
  FileCodeIcon,
  FoldersIcon,
  KeyIcon,
  LockKeyIcon,
  PlugsConnectedIcon,
  ShieldCheckIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react/dist/ssr";

import { PageShell } from "@/components/shell/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArchitectureDiagram } from "@/components/diagrams/architecture";

export default function Home() {
  return (
    <PageShell bleed>
      {/* ------------------------------------------------------------ hero */}
      <section className="relative border-b border-border">
        {/* Faint grid, faded out toward the bottom. Arbitrary properties keep
            this in Tailwind rather than a stylesheet rule. */}
        <div
          aria-hidden
          className="absolute inset-0 [background-image:linear-gradient(to_right,color-mix(in_oklch,var(--border)_45%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklch,var(--border)_45%,transparent)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_70%_55%_at_50%_0%,#000_55%,transparent_100%)]"
        />
        <div className="relative mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <Badge variant="outline" className="mb-6 gap-1.5 font-normal">
            <ShieldCheckIcon weight="fill" className="text-primary" />
            Keys never leave your browser
          </Badge>

          <h1 className="max-w-3xl font-heading text-4xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-6xl">
            SSH from any browser.
            <span className="block text-muted-foreground">Nothing to install.</span>
          </h1>

          <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground">
            Open a tab, generate a key, add one line to your server. You get a
            real terminal, a file explorer, drag-and-drop uploads and a remote
            editor — with an SSH client that runs inside the page, not on our
            servers.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/dashboard/terminal">
                Launch workspace <ArrowRightIcon />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/security">How the encryption works</Link>
            </Button>
          </div>

          <CommandPreview />
        </div>
      </section>

      {/* -------------------------------------------------------- features */}
      <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="font-heading text-xl font-semibold tracking-tight">
          A workspace, not a web terminal
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Everything rides one SSH connection, so the file explorer costs no
          second login and the editor opens instantly.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Feature
            icon={<TerminalWindowIcon />}
            title="Real terminal"
            body="xterm.js with WebGL rendering, true colour, and full VT support. Tabs and splits for working across a fleet."
          />
          <Feature
            icon={<FoldersIcon />}
            title="File explorer"
            body="SFTP attached to every session. Drag whole folders in, stream multi-gigabyte files out without buffering."
          />
          <Feature
            icon={<FileCodeIcon />}
            title="Remote editing"
            body="Open a remote file in a real editor with syntax highlighting and save it straight back over SFTP."
          />
          <Feature
            icon={<KeyIcon />}
            title="Keys that can't leak"
            body="Generated non-extractable in WebCrypto. Our code, a browser extension and an injected script are all equally unable to read them."
          />
          <Feature
            icon={<LockKeyIcon />}
            title="Zero-knowledge sync"
            body="Hosts, snippets and keys sync as ciphertext. The server stores a blob it has no way to decrypt."
          />
          <Feature
            icon={<PlugsConnectedIcon />}
            title="Stock sshd"
            body="One line in authorized_keys. No agent, no daemon, no open port beyond the one you already have."
          />
        </div>
      </section>

      {/* --------------------------------------------------------- security */}
      <section className="border-t border-border bg-card/40">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
            <div>
              <h2 className="font-heading text-xl font-semibold tracking-tight">
                The relay cannot read your session
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                A browser can&apos;t open a TCP socket, so something has to bridge
                to your server. Ours forwards bytes that were already encrypted
                inside your tab — the SSH handshake terminates in the page, not
                in our infrastructure. Host keys are pinned on first use and
                verified on every reconnect, which is what keeps the relay
                honest.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                What the relay does see is metadata: which host, when, and how
                much. We publish that rather than gloss it, and the whole thing
                is self-hostable if you&apos;d rather it saw nothing at all.
              </p>
              <Button asChild variant="outline" className="mt-6">
                <Link href="/security">Read the threat model</Link>
              </Button>
            </div>

            <Card className="overflow-hidden">
              <CardContent className="p-5">
                <ArchitectureDiagram />
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- cta */}
      <section className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-6 px-4 py-16 sm:px-6 md:flex-row md:items-center">
          <div>
            <h2 className="font-heading text-xl font-semibold tracking-tight">
              Sync is free. Forever.
            </h2>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Unlimited hosts, unlimited devices, SFTP and port forwarding on the
              free tier. We charge for teams and audit, not for the thing you
              need on day one.
            </p>
          </div>
          <div className="flex gap-3 md:ml-auto">
            <Button asChild size="lg">
              <Link href="/sign-up">Create account</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/pricing">See pricing</Link>
            </Button>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function Feature({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <Card className="transition-colors hover:border-primary/40">
      <CardContent className="pt-6">
        <div className="mb-3 grid size-8 place-items-center rounded-sm border border-border bg-secondary text-primary">
          {icon}
        </div>
        <h3 className="font-heading text-sm font-medium">{title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
      </CardContent>
    </Card>
  );
}

/** The whole server-side setup, shown rather than described. */
function CommandPreview() {
  return (
    <div className="mt-12 max-w-2xl overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-destructive/60" />
          <span className="size-2.5 rounded-full bg-warning/60" />
          <span className="size-2.5 rounded-full bg-success/60" />
        </span>
        <span className="text-xs text-muted-foreground">your server — setup, in full</span>
      </div>
      <pre className="bg-terminal overflow-x-auto px-4 py-3 text-xs leading-relaxed">
        <span className="text-muted-foreground">$ </span>
        <span className="text-foreground">echo </span>
        <span className="text-success">&apos;ssh-ed25519 AAAAC3Nza…&apos;</span>
        <span className="text-foreground"> &gt;&gt; ~/.ssh/authorized_keys</span>
      </pre>
    </div>
  );
}
