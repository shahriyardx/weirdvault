import { SplitKdfDiagram } from "@/components/diagrams/flows";
import Link from "next/link";
import {
  ArrowLeftIcon,
  KeyIcon,
  LockKeyIcon,
  TimerIcon,
} from "@phosphor-icons/react/dist/ssr";

import { Brand } from "@/components/shell/brand";

/**
 * Auth runs outside the site shell.
 *
 * No header nav and no footer links: the only two things worth doing on this
 * screen are filling in the form and understanding what happens to the password
 * when you do. The right-hand panel carries the second job on wide viewports;
 * on narrow ones the form itself says the same thing in fewer words.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-svh w-full lg:grid-cols-2">
      {/* ------------------------------------------------------------- form */}
      <div className="flex min-w-0 flex-col">
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

        <footer className="px-4 py-5 text-xs/relaxed text-muted-foreground sm:px-8">
          Lose the password and the vault stays shut — we hold no copy of the
          key and no way to rebuild it.{" "}
          <Link
            href="/security"
            className="underline underline-offset-4 hover:text-foreground"
          >
            How that works
          </Link>
        </footer>
      </div>

      {/* --------------------------------------------------------- explainer */}
      <aside className="relative hidden border-l border-border bg-card/40 lg:flex lg:flex-col lg:justify-center">
        <div
          aria-hidden
          className="absolute inset-0 [background-image:linear-gradient(to_right,color-mix(in_oklch,var(--border)_45%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklch,var(--border)_45%,transparent)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_70%_55%_at_50%_0%,#000_55%,transparent_100%)]"
        />

        <div className="relative mx-auto w-full max-w-md px-10 py-14">
          <p className="mb-3 text-xs font-medium tracking-wider text-primary uppercase">
            What happens when you submit
          </p>
          <h2 className="font-heading text-xl leading-snug font-semibold tracking-tight text-balance">
            The password is stretched here, then split in two.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            Sending a password to a server means the server can derive whatever
            that password protects. So this one stays in the tab. Argon2id
            stretches it against a salt derived from your email, and HKDF splits
            the result into two domain-separated branches. One is sent, one is
            not, and the sent one is one-way — holding it says nothing about the
            other.
          </p>

          <SplitKdfDiagram />

          <dl className="mt-8 space-y-5">
            <Point
              icon={<KeyIcon />}
              term="The vault key is not stored"
              detail="It lives in memory for the length of the tab and is never written to localStorage or IndexedDB. Reloading asks for the password again, which is the correct trade."
            />
            <Point
              icon={<LockKeyIcon />}
              term="Sync is a blob we cannot read"
              detail="Hosts, SSH keys and snippets are encrypted under that key before upload. The server cannot decrypt them, and so cannot search them either."
            />
            <Point
              icon={<TimerIcon />}
              term="The delay is deliberate"
              detail="Argon2id costs memory and time on purpose, so an attacker holding a stolen hash pays the same price per guess that you pay once."
            />
          </dl>

          <p className="mt-9 border-t border-border pt-5 text-xs/relaxed text-muted-foreground">
            No audit badge, no compliance seal — we have neither. The largest
            residual risk is that we serve you the JavaScript that does all of
            this, and the{" "}
            <Link
              href="/security"
              className="underline underline-offset-4 hover:text-foreground"
            >
              threat model
            </Link>{" "}
            says so plainly.
          </p>
        </div>
      </aside>
    </div>
  );
}

function Point({
  icon,
  term,
  detail,
}: {
  icon: React.ReactNode;
  term: string;
  detail: string;
}) {
  return (
    <div className="flex gap-3">
      <div
        aria-hidden
        className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-sm border border-border bg-secondary text-primary"
      >
        {icon}
      </div>
      <div className="min-w-0">
        <dt className="font-heading text-xs font-medium">{term}</dt>
        <dd className="mt-1 text-xs/relaxed text-muted-foreground">{detail}</dd>
      </div>
    </div>
  );
}
