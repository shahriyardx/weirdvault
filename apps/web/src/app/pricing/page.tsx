import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  CheckIcon,
  HardDrivesIcon,
  MinusIcon,
  SparkleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react/dist/ssr";

import { PageHeader, PageShell } from "@/components/shell/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Unlimited hosts, unlimited devices and zero-knowledge sync on the free tier. " +
    "Pro is $5 per user per month and Team is $12.",
};

/* ------------------------------------------------------------------ tiers */

type Tier = {
  id: string;
  name: string;
  price: string;
  unit?: string;
  icon: React.ReactNode;
  tagline: string;
  features: string[];
  cta: { label: string; href: string };
  variant: "default" | "outline";
  /** Free is the recommendation: sync is the part competitors bill for. */
  recommended?: boolean;
};

const TIERS: Tier[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    unit: "forever",
    icon: <HardDrivesIcon weight="fill" />,
    tagline:
      "The whole client, with sync. No host cap, no device cap, no trial clock.",
    features: [
      "Unlimited hosts and unlimited devices",
      "Zero-knowledge vault sync across browsers",
      "SFTP on the same SSH connection",
      "Remote files in a Monaco editor, saved back over SFTP",
      "Local and remote port forwarding",
      "Non-extractable keys, portable or device-bound",
      "Host keys pinned on first use, verified on reconnect",
    ],
    cta: { label: "Create account", href: "/sign-up" },
    variant: "default",
    recommended: true,
  },
  {
    id: "pro",
    name: "Pro",
    price: "$5",
    unit: "per user / month",
    icon: <SparkleIcon weight="fill" />,
    tagline: "For people who live in a terminal and want a record of it.",
    features: [
      "Everything in Free",
      "AI assist for commands and error output",
      "Session recording with searchable playback",
      "Share links for a live or recorded session",
      "Mosh for roaming and flaky connections",
      "Fleet dashboard across every host you own",
    ],
    cta: { label: "Start with Pro", href: "/sign-up?plan=pro" },
    variant: "outline",
  },
  {
    id: "team",
    name: "Team",
    price: "$12",
    unit: "per user / month",
    icon: <UsersThreeIcon weight="fill" />,
    tagline: "Shared access with a paper trail, still without shared secrets.",
    features: [
      "Everything in Pro",
      "Team vault, encrypted the same way as a personal one",
      "Role-based access control per host and group",
      "Audit log of sessions, transfers and grants",
      "SSO through your identity provider",
      "Credential inheritance from group to member",
    ],
    cta: { label: "Start with Team", href: "/sign-up?plan=team" },
    variant: "outline",
  },
];

/* ------------------------------------------------------------ comparison */

type Cell = boolean | string;

const COLUMNS = ["Free", "Pro", "Team"] as const;

const COMPARISON: { group: string; rows: { label: string; cells: Cell[] }[] }[] = [
  {
    group: "Connect",
    rows: [
      { label: "Hosts", cells: ["Unlimited", "Unlimited", "Unlimited"] },
      { label: "Devices", cells: ["Unlimited", "Unlimited", "Unlimited"] },
      { label: "Vault sync", cells: [true, true, true] },
      { label: "SFTP", cells: [true, true, true] },
      { label: "Port forwarding", cells: [true, true, true] },
      { label: "Remote editing", cells: [true, true, true] },
    ],
  },
  {
    group: "Work",
    rows: [
      { label: "AI assist", cells: [false, true, true] },
      { label: "Session recording", cells: [false, true, true] },
      { label: "Share links", cells: [false, true, true] },
    ],
  },
  {
    group: "Organisation",
    rows: [
      { label: "Team vault", cells: [false, false, true] },
      { label: "RBAC", cells: [false, false, true] },
      { label: "Audit log", cells: [false, false, true] },
      { label: "SSO", cells: [false, false, true] },
    ],
  },
];

/* ------------------------------------------------------------------- faq */

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "Why is sync free when everyone else charges for it?",
    a: (
      <>
        Because it costs us almost nothing to run. Your hosts, keys and snippets
        are stored as one encrypted blob that the server cannot read, so there is
        no indexing, no search and no per-host processing on our side — the cost
        does not grow with the size of your fleet. Charging for it would mean
        charging for the thing you need on the first day. We bill for the parts
        that genuinely cost us money, like inference and recording storage, and
        for the controls an organisation needs.
      </>
    ),
  },
  {
    q: "Is the free tier limited in any way I should know about?",
    a: (
      <>
        Unlimited hosts, unlimited devices, sync, SFTP and port forwarding, with
        no trial period attached. What you do not get is AI assist, session
        recording, share links and the team features — those are the paid lines,
        and none of them are needed to open a terminal and get work done.
      </>
    ),
  },
  {
    q: "What can the relay actually see?",
    a: (
      <>
        Metadata, not content. The SSH client is WebAssembly running in your tab,
        so the handshake terminates in the page and the relay only forwards
        ciphertext it has no key for. It does see which host and port you asked
        for, when, and how many bytes moved. Host keys are pinned on first use
        and verified on reconnect, so a relay that tried to sit in the middle
        would be refused rather than trusted.
      </>
    ),
  },
  {
    q: "What happens if I lose a key or forget my password?",
    a: (
      <>
        A portable key is wrapped with your vault key, so signing in on another
        device brings it back. A device-bound key never leaves the browser that
        generated it — clear that browser&apos;s storage and the key is gone for
        good; you would generate a new one and add a line to{" "}
        <code className="text-foreground">~/.ssh/authorized_keys</code>, or
        connect once with a password and let webxterm install it. Forgetting your
        login password is the unrecoverable case: the vault key is derived from
        it in your browser and never sent to us, so there is no reset that can
        decrypt the blob. We cannot recover any of this, which is the same
        property that stops anyone else from doing so.
      </>
    ),
  },
  {
    q: "Do you have SOC 2?",
    a: (
      <>
        No. No SOC 2, no ISO 27001, and no third-party audit — we would rather
        say so plainly than imply a certification we have not earned. What exists
        instead is a published threat model that states the largest residual risk
        in our own words: we serve the JavaScript, so a compromise of our
        delivery is a compromise of the client. Around that sit non-extractable
        WebCrypto keys, a vault the server cannot decrypt, and host keys pinned
        on first use and verified on every reconnect.
      </>
    ),
  },
];

/* ------------------------------------------------------------------ page */

export default function PricingPage() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="Pricing"
        title="Sync is free. Forever."
        description="Unlimited hosts, unlimited devices and encrypted sync cost nothing, because a blob we cannot read is cheap to store. The paid tiers add recording, sharing and the controls a team needs — not the basics."
        actions={
          <Button asChild>
            <Link href="/sign-up">
              Create account <ArrowRightIcon />
            </Link>
          </Button>
        }
      />

      {/* ----------------------------------------------------------- tiers */}
      <section className="py-10" aria-labelledby="tiers-heading">
        <h2 id="tiers-heading" className="sr-only">
          Plans
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          {TIERS.map((tier) => (
            <TierCard key={tier.id} tier={tier} />
          ))}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Paid plans are billed per user, monthly, and you can move between them
          at any time. Every tier runs the same client: the SSH session is
          WebAssembly in your tab whether you pay us or not.
        </p>
      </section>

      {/* ------------------------------------------------------ comparison */}
      <section className="border-t border-border py-10" aria-labelledby="compare-heading">
        <h2
          id="compare-heading"
          className="font-heading text-xl font-semibold tracking-tight"
        >
          What each tier includes
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The first six rows are the product. Everything below them is
          convenience, or governance for people who answer to someone.
        </p>

        <div className="mt-6 ring-1 ring-foreground/10">
          <Table>
            <TableCaption className="px-4 pb-4 text-left leading-relaxed">
              Each tier includes everything in the one before it. The client is
              the same in all three — the SSH session is WebAssembly in your tab
              whichever you are on.
            </TableCaption>
            <TableHeader>
              <TableRow className="bg-card">
                <TableHead className="w-[38%] min-w-40 pl-4">Feature</TableHead>
                {COLUMNS.map((col) => (
                  <TableHead key={col} className="min-w-24 text-center last:pr-4">
                    {col}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {COMPARISON.map((section) => (
                <ComparisonGroup key={section.group} section={section} />
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* ------------------------------------------------------------- faq */}
      <section className="border-t border-border py-10" aria-labelledby="faq-heading">
        <h2 id="faq-heading" className="font-heading text-xl font-semibold tracking-tight">
          Questions we get asked
        </h2>
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {FAQ.map((item) => (
            <Card key={item.q} className="h-full">
              <CardContent className="flex flex-col gap-2">
                <h3 className="font-heading text-sm font-medium text-foreground">
                  {item.q}
                </h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {item.a}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------- cta */}
      <section className="flex flex-col items-start gap-6 border-t border-border py-12 md:flex-row md:items-center">
        <div>
          <h2 className="font-heading text-xl font-semibold tracking-tight">
            Start on Free and stay there
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Generate a key, paste one line into{" "}
            <code className="text-foreground">~/.ssh/authorized_keys</code>, and
            you have a terminal, a file explorer and a remote editor. Upgrade
            only when you need a record of what happened.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 md:ml-auto">
          <Button asChild size="lg">
            <Link href="/sign-up">
              Create account <ArrowRightIcon />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/security">Read the threat model</Link>
          </Button>
        </div>
      </section>
    </PageShell>
  );
}

/* ------------------------------------------------------------- fragments */

function TierCard({ tier }: { tier: Tier }) {
  return (
    <Card
      className={cn(
        "h-full",
        tier.recommended && "ring-2 ring-primary/60",
      )}
    >
      <CardHeader>
        <div className="mb-1 flex items-center gap-2">
          <span
            className={cn(
              "grid size-7 place-items-center rounded-sm border border-border bg-secondary",
              tier.recommended ? "text-primary" : "text-muted-foreground",
            )}
            aria-hidden
          >
            {tier.icon}
          </span>
          <CardTitle className="text-base">{tier.name}</CardTitle>
          {tier.recommended && (
            <Badge className="ml-auto">Start here</Badge>
          )}
        </div>
        <div className="flex items-baseline gap-1.5 pt-2">
          <span className="font-heading text-3xl font-semibold tracking-tight">
            {tier.price}
          </span>
          {tier.unit && (
            <span className="text-xs text-muted-foreground">{tier.unit}</span>
          )}
        </div>
        <CardDescription className="pt-2">{tier.tagline}</CardDescription>
      </CardHeader>

      <CardContent className="flex-1">
        <ul className="flex flex-col gap-2">
          {tier.features.map((feature) => (
            <li key={feature} className="flex gap-2">
              <CheckIcon
                aria-hidden
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  tier.recommended ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span className="text-xs leading-relaxed text-muted-foreground">
                {feature}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>

      <CardFooter>
        <Button asChild variant={tier.variant} className="w-full">
          <Link href={tier.cta.href}>{tier.cta.label}</Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * A grouped block of comparison rows. Returns a fragment rather than a wrapper,
 * because it renders directly inside `<tbody>` and nothing may sit between the
 * body and its rows.
 */
function ComparisonGroup({
  section,
}: {
  section: { group: string; rows: { label: string; cells: Cell[] }[] };
}) {
  return (
    <>
      <TableRow className="bg-card/60 hover:bg-card/60">
        <TableCell
          colSpan={COLUMNS.length + 1}
          className="pl-4 text-xs font-medium tracking-wider text-primary uppercase"
        >
          {section.group}
        </TableCell>
      </TableRow>
      {section.rows.map((row) => (
        <TableRow key={row.label}>
          <TableCell className="pl-4 font-medium text-foreground">
            {row.label}
          </TableCell>
          {row.cells.map((cell, i) => (
            <TableCell key={COLUMNS[i]} className="text-center last:pr-4">
              <CellValue value={cell} column={COLUMNS[i]} row={row.label} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

function CellValue({
  value,
  column,
  row,
}: {
  value: Cell;
  column: string;
  row: string;
}) {
  if (typeof value === "string") {
    return <span className="text-muted-foreground">{value}</span>;
  }
  return (
    <span className="inline-flex items-center justify-center">
      {value ? (
        <CheckIcon aria-hidden className="size-4 text-success" />
      ) : (
        <MinusIcon aria-hidden className="size-4 text-muted-foreground/50" />
      )}
      <span className="sr-only">
        {row} {value ? "included in" : "not included in"} {column}
      </span>
    </span>
  );
}
