import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  CheckIcon,
  HardDrivesIcon,
  MinusIcon,
  SparkleIcon,
  WarningCircleIcon,
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
import { AUDIT_RETENTION_LABEL } from "@/lib/audit/retention";
import {
  PRO_PRICE_LABEL,
  PRO_PRICE_UNIT,
  RELAY_ALLOWANCE_BYTES,
  SESSION_RECORDING,
} from "@/lib/billing/tiers";
import { MAX_ACCOUNT_RECORDING_BYTES, MAX_CAPTURE_BYTES } from "@/lib/recording/limits";
import { MAX_SHARE_TTL_MS } from "@/lib/recording/share";
import { formatBytes } from "@/lib/usage";
import { cn } from "@/lib/utils";

/**
 * Every enforced number here is imported, not retyped.
 *
 * A pricing page that states a different cap from the one the code refuses at
 * is the specific way this page went wrong before. These come from the modules
 * that /api/relay-token, /api/audit and /api/recordings read, so the page cannot
 * drift from the refusal — and `formatBytes` is the same decimal formatter the
 * meter in Settings uses, so "1 GB" means the same number in both places.
 *
 * One number here is not like the others and the discipline has to admit it.
 * `PRO_PRICE_LABEL` is imported from the same module, but nothing in this
 * codebase enforces a price — Stripe does, from the Price object named by
 * STRIPE_PRICE_PRO, and this app never reads its amount. tiers.ts says so at the
 * declaration. If the price in the Stripe dashboard changes, that constant has
 * to change with it; no test can catch the mismatch.
 */
const FREE_TRANSFER = formatBytes(RELAY_ALLOWANCE_BYTES.free);
const PRO_TRANSFER = formatBytes(RELAY_ALLOWANCE_BYTES.pro);
const FREE_HISTORY = AUDIT_RETENTION_LABEL.free;
const PRO_HISTORY = AUDIT_RETENTION_LABEL.pro;
const CAPTURE_CAP = formatBytes(MAX_CAPTURE_BYTES);
const RECORDING_STORAGE = formatBytes(MAX_ACCOUNT_RECORDING_BYTES);
/** The longest a share link may live, from the module the share route refuses at. */
const SHARE_TTL = `${Math.round(MAX_SHARE_TTL_MS / 86_400_000)} days`;

/**
 * Whether recording is on for each tier, read from the record the gate reads.
 *
 * A boolean rather than a sentence, so that flipping recording back to Free
 * would change this page rather than leaving it advertising a wall that is no
 * longer there. The comparison table indexes it directly.
 */
const FREE_RECORDING = SESSION_RECORDING.free;
const PRO_RECORDING = SESSION_RECORDING.pro;

export const metadata: Metadata = {
  title: "Pricing",
  description:
    `Free is the whole client, with encrypted sync, unlimited hosts and unlimited devices. ` +
    `Pro is ${PRO_PRICE_LABEL} ${PRO_PRICE_UNIT}, flat, one subscription per account: session ` +
    `recording, ${PRO_TRANSFER} of relay transfer and ${PRO_HISTORY} of activity history.`,
};

/* ------------------------------------------------------------------ tiers */

/**
 * A pricing page is the easiest place in a product to lie, and this one used to.
 * It sold session recording, share links, AI assist, RBAC, SSO, a fleet
 * dashboard and mosh — none of which exist, and one of which cannot exist here
 * at all: mosh needs UDP and a browser tab has no UDP socket (PLAN.md §2.3
 * lists it as a permanent limitation, not a backlog item).
 *
 * So the tiers below say what runs today. Nothing aspirational is in a feature
 * list, and every number is imported from the module that enforces it.
 *
 * ── What changed, and why the history is here
 *
 * There were three tiers until the team surface was withdrawn. The Team card
 * listed organizations, invitations, roles and team-key distribution, all of
 * which genuinely ran — but the shared vault they existed to protect was never
 * built, and a tier whose contents are a roster is a tier that charges for
 * nothing. The card went, along with the code behind it.
 *
 * Then Pro stopped being empty. Until Stripe was wired up this page said, twice
 * over, that no billing was configured, that the paid tier was not open and that
 * every account resolved to Free. All three sentences were true and all three
 * are now false, so they are gone rather than softened. Pro is a real
 * subscription: one price, one per account, no seats and no quantity.
 *
 * The move that needs stating plainly is session recording. It was on the Free
 * card and is now on the Pro card. That is a feature leaving a free tier, which
 * is the change a pricing page is most tempted to be quiet about, so it is said
 * in the FAQ in the same words the app uses: new recordings need Pro, and
 * recordings already saved stay listable, playable and downloadable on any plan,
 * forever, because they are the user's own data encrypted with their own key.
 *
 * The page has also had to correct itself in the other direction, twice. It once
 * said Free was limited in no way at all, which stopped being true the day the
 * relay started counting bytes. Then it said there were exactly two limits while
 * a third — capture stopping at a size cap partway through a session — was
 * already ending recordings. Understating what we enforce is the same failure as
 * overstating what we ship, so limits are listed separately from features, under
 * a heading that cannot be read as one.
 */
type Tier = {
  id: string;
  name: string;
  price: string;
  unit?: string;
  icon: React.ReactNode;
  tagline: string;
  /** Shipped and usable today. Nothing aspirational belongs in this list. */
  features: string[];
  /**
   * Enforced today, and refused or deleted when reached. Kept apart from
   * `features` and rendered under its own heading: a limit buried in a tick
   * list is a limit the reader discovers as an unexplained failure.
   */
  limits?: string[];
  /**
   * What this plan does not get, named explicitly.
   *
   * A feature that is simply absent from a list is a feature nobody notices is
   * absent until they go looking for the button, so the gap is stated here
   * rather than left to be inferred from the other card. It used to be called
   * `planned` and held things that were not built; nothing on this page is
   * unbuilt any more, and a heading that said "not built yet" over a feature
   * that runs on the tier next door would be the wrong claim entirely.
   */
  excluded?: string[];
  /** Null when there is nothing to buy and no honest action to offer. */
  cta: { label: string; href: string } | null;
  variant: "default" | "outline";
  /** Free is the recommendation, because Free is the entire product. */
  recommended?: boolean;
};

/**
 * The client, which is identical on both tiers.
 *
 * Written once and spread into both cards rather than copied, because the claim
 * being made is that they are the same list — the SSH session is WebAssembly in
 * your tab whether you pay or not, and nothing in the terminal, the file
 * explorer, the editor or the vault is switched on by a subscription. A copy per
 * card would let that stop being true by accident.
 */
const CLIENT_FEATURES = [
  "Unlimited hosts and unlimited devices",
  "Zero-knowledge vault sync across browsers",
  "Terminal with tabs, split panes and a touch keyboard bar",
  "SFTP file explorer on the same SSH connection",
  "Remote files in a Monaco editor, saved back over SFTP",
  "Non-extractable keys: generate one here or import an existing one",
  "Bulk host import from an ~/.ssh/config",
  "Host keys pinned on first use, verified on reconnect",
  "Snippets, an activity log, and device revocation",
  "Recovery codes, and an encrypted vault export that restores by merging",
];

/**
 * The limits that bite on Free.
 *
 * Two, and only two, because the other three enforced numbers in this app are
 * ceilings on session recording — which does not run on Free at all, so quoting
 * them here would describe a wall nobody on this tier can reach.
 */
const FREE_LIMITS = [
  `${FREE_TRANSFER} of relay transfer a month, counting both directions. At the ` +
    "cap, new connections through our relay are refused and sessions already " +
    "open keep running — nothing is cut mid-transfer. Run your own relay and " +
    "the limit does not apply at all.",
  `${FREE_HISTORY} of activity history. Older events are deleted, not hidden.`,
];

/**
 * The limits that bite on Pro.
 *
 * The same two with larger numbers, plus the three recording ceilings, which
 * belong on this card because this is the card recording runs on. They were
 * missing from this page for a while and it asserted there were only two limits
 * in the product; capture ending itself mid-session at a size cap is a limit
 * somebody meets in the middle of their work, and the page they read before
 * paying is where it belongs.
 */
const PRO_LIMITS = [
  `${PRO_TRANSFER} of relay transfer a month, counting both directions, on the ` +
    "same terms as Free: at the cap new relay connections are refused and open " +
    "sessions keep running. Self-hosting the relay removes it entirely.",
  `${PRO_HISTORY} of activity history. Older events are deleted, not hidden — ` +
    "and if a subscription lapses the window shortens to " +
    `${FREE_HISTORY}, which deletes what falls outside it.`,
  `${CAPTURE_CAP} of terminal output per recording. Capture stops there, the ` +
    "recording is saved with everything up to that point, and the page says " +
    `why it stopped. Any number of recordings, up to ${RECORDING_STORAGE} of ` +
    "stored ciphertext in total — past that a save is refused rather than " +
    "something older being deleted.",
  `${SHARE_TTL} is the longest a recording share link may live. There is no ` +
    "never-expires option, because once a link has been forwarded its expiry " +
    "and its view limit are the only controls left. A share is also a second " +
    "encrypted copy of the recording, so it counts against the same storage.",
];

const TIERS: Tier[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    unit: "forever",
    icon: <HardDrivesIcon weight="fill" />,
    tagline: "The whole client, with sync. No host cap, no device cap, no trial clock.",
    features: CLIENT_FEATURES,
    limits: FREE_LIMITS,
    excluded: [
      "Session recording and share links are on Pro. Recordings you have " +
        "already saved stay playable and downloadable here whatever you pay.",
    ],
    cta: { label: "Create account", href: "/sign-up" },
    variant: "default",
    recommended: true,
  },
  {
    id: "pro",
    name: "Pro",
    price: PRO_PRICE_LABEL,
    unit: PRO_PRICE_UNIT,
    icon: <SparkleIcon weight="fill" />,
    tagline:
      "Everything in Free, plus session recording, five times the relay " +
      "transfer and a year of history. One subscription per account — no seats, " +
      "no quantity, nothing to count.",
    features: [
      ...CLIENT_FEATURES,
      "Session recording, encrypted in your browser and replayable here",
      "Share a recording by link, with the decryption key in the link rather " +
        "than on our server — expiring, view-limited and revocable",
      `${PRO_TRANSFER} of relay transfer a month instead of ${FREE_TRANSFER}`,
      `${PRO_HISTORY} of activity history instead of ${FREE_HISTORY}`,
    ],
    limits: PRO_LIMITS,
    cta: { label: "Create an account to subscribe", href: "/sign-up" },
    variant: "outline",
  },
];

/* ------------------------------------------------------------ comparison */

/**
 * A cell is a tick, a dash or a value.
 *
 * There used to be a third state, `"planned"`, so the table could not round an
 * unbuilt feature up to a tick. Nothing on this page is unbuilt now — both tiers
 * ship — so the state is gone rather than kept around for a case that no longer
 * exists. If something is ever specified and not built, it comes back.
 */
type Cell = boolean | string;

const COLUMNS = ["Free", "Pro"] as const;

const COMPARISON: { group: string; rows: { label: string; cells: Cell[] }[] }[] = [
  {
    // Identical columns, and here that genuinely is the point: the SSH session
    // is WebAssembly in your tab whether you pay or not, and no part of the
    // client is switched on by a subscription.
    group: "The client",
    rows: [
      { label: "Hosts", cells: ["Unlimited", "Unlimited"] },
      { label: "Devices", cells: ["Unlimited", "Unlimited"] },
      { label: "Vault sync", cells: [true, true] },
      { label: "Terminal, tabs and split panes", cells: [true, true] },
      { label: "SFTP and remote editing", cells: [true, true] },
      { label: "Key import and ssh_config import", cells: [true, true] },
      { label: "Snippets", cells: [true, true] },
      { label: "Activity log and device revocation", cells: [true, true] },
      { label: "Recovery codes", cells: [true, true] },
      { label: "Vault export and restore", cells: [true, true] },
    ],
  },
  {
    group: "Session recording",
    rows: [
      {
        label: "Record and save a new session",
        cells: [FREE_RECORDING, PRO_RECORDING],
      },
      {
        label: "Create a recording share link",
        cells: [FREE_RECORDING, PRO_RECORDING],
      },
      {
        // The row that stops the gate reading as a hostage situation. Playing,
        // downloading and revoking are ungated in the routes and are ungated
        // here; a recording is the user's own data encrypted with their own key.
        label: "Play, download and revoke what you already saved",
        cells: [true, true],
      },
    ],
  },
  {
    group: "Limits we enforce",
    rows: [
      {
        label: "Relay transfer per month",
        cells: [FREE_TRANSFER, PRO_TRANSFER],
      },
      {
        label: "Activity history kept",
        cells: [FREE_HISTORY, PRO_HISTORY],
      },
      {
        label: "Output captured per recording",
        cells: [FREE_RECORDING ? CAPTURE_CAP : "—", CAPTURE_CAP],
      },
      {
        label: "Stored recordings",
        cells: [
          FREE_RECORDING ? `Any number, ${RECORDING_STORAGE} total` : "—",
          `Any number, ${RECORDING_STORAGE} total`,
        ],
      },
      {
        label: "Share link lifetime",
        cells: [FREE_RECORDING ? `Up to ${SHARE_TTL}` : "—", `Up to ${SHARE_TTL}`],
      },
    ],
  },
];

/* ------------------------------------------------------------------- faq */

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "Recording used to be free. What happens to my recordings?",
    a: (
      <>
        They stay exactly where they are, and they keep working. The gate is on{" "}
        <span className="text-foreground">saving a new recording</span> and on creating a new share
        link, and on nothing else: listing, playing, downloading as a cast file and revoking a link
        you already have out are ungated in the code and always will be. A recording is your own
        data, encrypted in your browser with a key we have never held — holding it behind a payment
        would mean ransoming something we cannot even read. If a subscription lapses, the Record
        button stops and every recording on the page still plays.
      </>
    ),
  },
  {
    q: `Is Pro really ${PRO_PRICE_LABEL} flat?`,
    a: (
      <>
        {PRO_PRICE_LABEL} {PRO_PRICE_UNIT}, one subscription per account, and there is no second
        number to multiply it by. Accounts here are personal: no organizations, no members, no seats
        and no invitations. A team surface was built and then withdrawn, because the shared vault it
        existed to protect was never built and charging per seat for a roster is not a product. Two
        tiers, one price, no quantity is the entire price list.
      </>
    ),
  },
  {
    q: "What happens if my card fails?",
    a: (
      <>
        You keep Pro while Stripe retries. A subscription that is{" "}
        <code className="text-foreground">past_due</code> or{" "}
        <code className="text-foreground">unpaid</code> keeps its access through the period you have
        already paid for, because cutting somebody off in the middle of a retry — over a card that
        expired at the weekend — costs them their servers for a payment that usually goes through.
        If you cancel, you keep everything until the end of the period you have paid for; nothing is
        cut off on the day you press the button. Cancelling, changing a card and every invoice live
        in Stripe&rsquo;s billing portal, which is linked from your Settings page. No card number
        ever reaches this server.
      </>
    ),
  },
  {
    q: "Why is sync free when everyone else charges for it?",
    a: (
      <>
        Because it costs us almost nothing to run. Your hosts, keys and snippets are stored as one
        encrypted blob that the server cannot read, so there is no indexing, no search and no
        per-host processing on our side — the cost does not grow with the size of your fleet.
        Charging for it would mean charging for the thing you need on the first day.
      </>
    ),
  },
  {
    q: "Is the free tier limited in any way I should know about?",
    a: (
      <>
        Two enforced limits and one feature. Our relay carries {FREE_TRANSFER} a month for you,
        counting both directions; past that we refuse to start new connections through it, and
        sessions you already have open keep running until you close them. The activity log keeps{" "}
        {FREE_HISTORY} — older events are deleted rather than hidden behind an upgrade. And session
        recording is on Pro, which is the one feature Free does not have. What the question usually
        means, the answer is still no: no host cap, no device cap, no trial period, and nothing
        about the client itself is held back — the SSH session, the file explorer, the editor and
        the encrypted sync are the same code on both plans. The transfer figure is on your Settings
        page before it bites rather than after, and running your own relay removes it entirely; it
        exists because relay bandwidth costs us money, and bandwidth you pay for already is not ours
        to ration.
      </>
    ),
  },
  {
    q: "What can the relay actually see?",
    a: (
      <>
        Metadata, not content. The SSH client is WebAssembly running in your tab, so the handshake
        terminates in the page and the relay only forwards ciphertext it has no key for. It does see
        which host and port you asked for, when, and how many bytes moved. Those byte counts are the
        one piece of that metadata we keep in a database rather than in a log: a running monthly
        total per account, which is what the transfer allowance is measured against. It records how
        much, never what or where. Host keys are pinned on first use and verified on reconnect, so a
        relay that tried to sit in the middle would be refused rather than trusted.
      </>
    ),
  },
  {
    q: "What happens if I lose a key or forget my password?",
    a: (
      <>
        A portable key is wrapped with your vault key, so signing in on another device brings it
        back. A device-bound key never leaves the browser that generated it — clear that
        browser&apos;s storage and the key is gone for good; you would generate a new one and add a
        line to <code className="text-foreground">~/.ssh/authorized_keys</code>, or connect once
        with a password and let webxterm install it. The vault key is derived from your password in
        your browser and never sent to us, so there is no reset on our side that could decrypt the
        blob — a recovery code enrolled in advance is the only way back in. It does not stand in for
        an authenticator app: if you have enrolled one, the sign-in a code attempts still stops at
        that challenge.
      </>
    ),
  },
  {
    q: "Do you have SOC 2?",
    a: (
      <>
        No. No SOC 2, no ISO 27001, and no third-party audit — we would rather say so plainly than
        imply a certification we have not earned. What exists instead is a published threat model
        that states the largest residual risk in our own words: we serve the JavaScript, so a
        compromise of our delivery is a compromise of the client. Around that sit non-extractable
        WebCrypto keys, a vault the server cannot decrypt, and host keys pinned on first use and
        verified on every reconnect.
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
        title="Two tiers, one price, no seats."
        description={`Unlimited hosts, unlimited devices and encrypted sync cost nothing, because a blob we cannot read is cheap to store. Free enforces two limits: ${FREE_TRANSFER} of relay transfer a month and ${FREE_HISTORY} of activity history. Pro is ${PRO_PRICE_LABEL} ${PRO_PRICE_UNIT}, flat, one subscription per account — session recording, ${PRO_TRANSFER} of transfer and ${PRO_HISTORY} of history. There is no seat count to multiply, because an account here is a person.`}
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
        <div className="grid gap-4 md:grid-cols-2">
          {TIERS.map((tier) => (
            <TierCard key={tier.id} tier={tier} />
          ))}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Subscribing happens inside the app, not on this page: create an account, then Settings has
          the plan card and the checkout button. Payment is handled by Stripe — card details are
          entered on their pages and never reach this server, which stores a customer id, a status
          and a renewal date and nothing else. A self-hosted install with no Stripe keys says so on
          that card and offers no button, which is the intended configuration rather than a fault.
          Both tiers run the same client: the SSH session is WebAssembly in your tab whether you pay
          us or not.
        </p>
      </section>

      {/* ------------------------------------------------------ comparison */}
      <section className="border-t border-border py-10" aria-labelledby="compare-heading">
        <h2 id="compare-heading" className="font-heading text-xl font-semibold tracking-tight">
          Line by line
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The first block is the client, and the columns are identical because it is the same code
          on both plans. The second is session recording, which is the one feature a subscription
          switches on — note the third row, which is the promise that a lapsed plan never strands a
          transcript you already saved. The third is what we actually enforce, and every number in
          it is imported from the module that does the enforcing.
        </p>

        <div className="mt-6 ring-1 ring-foreground/10">
          <Table>
            <TableCaption className="px-4 pb-4 text-left leading-relaxed">
              A tick means it runs today. A dash means it does not exist for that tier. A number is
              a limit that is enforced, not a target. Nothing on this table is unbuilt — if it is
              listed, it runs.
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

        <p className="mt-4 max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Two things that used to be advertised here are gone rather than postponed. Mosh cannot be
          built into this: it needs a UDP socket, a browser tab does not have one, and it also needs
          a <code className="text-foreground">mosh-server</code> installed on the target, which
          would break the promise that there is nothing to install on your servers. A fleet
          dashboard needs to poll hosts you are not connected to, and the client only exists while a
          tab is open.
        </p>
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
                <h3 className="font-heading text-sm font-medium text-foreground">{item.q}</h3>
                <p className="text-xs leading-relaxed text-muted-foreground">{item.a}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------- cta */}
      <section className="flex flex-col items-start gap-6 border-t border-border py-12 md:flex-row md:items-center">
        <div>
          <h2 className="font-heading text-xl font-semibold tracking-tight">
            Start on Free. Upgrade only if you hit something
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Generate a key, paste one line into{" "}
            <code className="text-foreground">~/.ssh/authorized_keys</code>, and you have a
            terminal, a file explorer and a remote editor. No card, no trial clock. The two walls on
            Free are {FREE_TRANSFER} of relay transfer a month — on your Settings page from the
            first day, and gone entirely if you run your own relay — and {FREE_HISTORY} of activity
            history. Pro is {PRO_PRICE_LABEL} {PRO_PRICE_UNIT} when one of those, or session
            recording, turns out to matter to you.
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
    <Card className={cn("h-full", tier.recommended && "ring-2 ring-primary/60")}>
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
          {tier.recommended && <Badge className="ml-auto">Start here</Badge>}
        </div>
        <div className="flex items-baseline gap-1.5 pt-2">
          <span className="font-heading text-3xl font-semibold tracking-tight">{tier.price}</span>
          {tier.unit && <span className="text-xs text-muted-foreground">{tier.unit}</span>}
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
              <span className="text-xs leading-relaxed text-muted-foreground">{feature}</span>
            </li>
          ))}
        </ul>

        {tier.limits && tier.limits.length > 0 && (
          <div className={cn(tier.features.length > 0 && "mt-4 border-t border-border pt-4")}>
            <p className="mb-2 text-xs font-medium text-warning">Limits we enforce</p>
            <ul className="flex flex-col gap-2">
              {tier.limits.map((item) => (
                <li key={item} className="flex gap-2">
                  <WarningCircleIcon
                    aria-hidden
                    className="mt-0.5 size-3.5 shrink-0 text-warning"
                  />
                  <span className="text-xs leading-relaxed text-muted-foreground">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {tier.excluded && tier.excluded.length > 0 && (
          <div
            className={cn(
              (tier.features.length > 0 || (tier.limits?.length ?? 0) > 0) &&
                "mt-4 border-t border-border pt-4",
            )}
          >
            <p className="mb-2 text-xs font-medium text-muted-foreground">Not on this plan</p>
            <ul className="flex flex-col gap-2">
              {tier.excluded.map((item) => (
                <li key={item} className="flex gap-2">
                  <MinusIcon
                    aria-hidden
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50"
                  />
                  <span className="text-xs leading-relaxed text-muted-foreground">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>

      <CardFooter>
        {tier.cta ? (
          <Button asChild variant={tier.variant} className="w-full">
            <Link href={tier.cta.href}>{tier.cta.label}</Link>
          </Button>
        ) : (
          // No button at all rather than a disabled one: a greyed-out "Start
          // with Pro" still implies a Pro exists to start.
          <p className="w-full text-center text-xs text-muted-foreground">Nothing to buy</p>
        )}
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
          <TableCell className="pl-4 font-medium text-foreground">{row.label}</TableCell>
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

function CellValue({ value, column, row }: { value: Cell; column: string; row: string }) {
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
