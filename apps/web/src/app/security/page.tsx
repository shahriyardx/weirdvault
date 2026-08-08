import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/ssr";

import { ArchitectureDiagram } from "@/components/diagrams/architecture";
import { PageHeader, PageShell } from "@/components/shell/page-shell";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How webxterm terminates SSH inside the browser tab, what the relay and control plane can and cannot see, " +
    "and the residual risks we have not solved.",
};

/**
 * The security page.
 *
 * Deliberately prose-led, and deliberately card-free. An earlier version put
 * every paragraph in a bordered box, which made a page of claims read like a
 * dashboard and left the important parts no more prominent than the incidental
 * ones. It also said what each party can see twice — once as a pair of panels
 * and again as a pair of lists. Comparisons are tables now, everything else is
 * typography and rules, and each fact appears exactly once.
 */

const NAV = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#keys", label: "Keys and secrets" },
  { href: "#threat-model", label: "Threat model" },
  { href: "#residual-risks", label: "Residual risks" },
  { href: "#self-host", label: "Self-hosting" },
] as const;

/** Visibility matrix. One row per thing that exists, one column per observer. */
const VISIBILITY: Array<{
  what: string;
  relay: Verdict;
  control: Verdict;
}> = [
  { what: "Keystrokes, commands, output", relay: "never", control: "never" },
  { what: "Files transferred over SFTP", relay: "never", control: "never" },
  { what: "Your SSH private keys", relay: "never", control: "ciphertext" },
  { what: "Host names, usernames, ports, tags", relay: "sees", control: "ciphertext" },
  { what: "Snippets and saved settings", relay: "never", control: "ciphertext" },
  { what: "Session start, end and duration", relay: "sees", control: "sees" },
  { what: "Bytes moved, and frame timing", relay: "sees", control: "never" },
  { what: "Your browser's source address", relay: "sees", control: "sees" },
  { what: "Email address and sign-in times", relay: "never", control: "sees" },
  { what: "Login password and vault key", relay: "never", control: "never" },
];

/** What a non-extractable key does and does not stop. */
const ATTACKS: Array<{ attack: string; blocked: boolean; outcome: string }> = [
  {
    attack: "Cross-site scripting in our own app",
    blocked: true,
    outcome: "Injected code can ask the key to sign, but no API returns the private bytes to it.",
  },
  {
    attack: "A browser extension reading the page",
    blocked: true,
    outcome: "Same limit — it can observe the tab, it cannot carry the key away.",
  },
  {
    attack: "A malicious dependency in our bundle",
    blocked: true,
    outcome: "There is nothing to exfiltrate; the key material never enters JavaScript.",
  },
  {
    attack: "A subpoena served on us",
    blocked: true,
    outcome: "Our code has no privileged path to the private bytes either.",
  },
  {
    attack: "Misuse while your tab is open",
    blocked: false,
    outcome: "Anything in the page can sign, and a signature is all authentication needs.",
  },
  {
    attack: "Malware on your device",
    blocked: false,
    outcome: "It reads your session as you read it, and signs for as long as the tab lives.",
  },
  {
    attack: "A compromised server",
    blocked: false,
    outcome: "The key proves who you are to a host; it says nothing about what that host does.",
  },
];

/** Key storage modes. Rows are the questions people actually ask. */
const KEY_MODES: Array<{ question: string; portable: string; device: string }> = [
  {
    question: "Where the private key lives",
    portable: "This browser, plus a copy wrapped with your vault key",
    device: "This browser profile only",
  },
  {
    question: "What we store",
    portable: "Ciphertext we cannot open",
    device: "Nothing",
  },
  {
    question: "Appears on your other devices",
    portable: "Yes, after unlocking the vault",
    device: "No",
  },
  {
    question: "If you clear site data",
    portable: "Restored from the vault",
    device: "Gone — you re-enrol",
  },
  {
    question: "Best for",
    portable: "A key you genuinely want everywhere",
    device: "A machine you do not fully control",
  },
];

export default function SecurityPage() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="Security"
        title="What we can and cannot see"
        description="webxterm terminates SSH inside your browser tab, so our security story is an argument about where bytes are decrypted. Here is that architecture, what it actually guarantees, and — in the same detail — what it does not."
        actions={
          <Button asChild variant="outline">
            <Link href="#threat-model">Threat model</Link>
          </Button>
        }
      />

      <nav
        aria-label="On this page"
        className="flex flex-wrap gap-1 border-b border-border py-3"
      >
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-sm px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {/* ---------------------------------------------------- how it works */}
      <Section id="how-it-works" index="01" title="How a session is established">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-14">
          <div className="min-w-0">
            <P>
              A browser cannot open a raw TCP socket, so something has to sit
              between the tab and port 22. In most browser SSH products that
              something is a server which speaks SSH on your behalf: it holds
              your key, it decrypts your session, and you are trusting it with
              everything. webxterm is built the other way round — the SSH client
              is a WebAssembly module running in the page, and the thing in the
              middle is a dumb pipe.
            </P>

            <ol className="mt-6 divide-y divide-border border-y border-border">
              <Step
                n="01"
                title="The client runs in your tab"
                body="Key exchange, cipher negotiation, channel multiplexing and the terminal protocol all execute in page memory. The session keys are derived there and exist nowhere else."
              />
              <Step
                n="02"
                title="The relay bridges, it does not terminate"
                body="It accepts a WebSocket, opens a TCP connection to the host you named, and copies bytes between them. Those bytes were encrypted before they left the tab, under keys it never held."
              />
              <Step
                n="03"
                title="Your server sees ordinary SSH"
                body="Stock sshd, one line appended to authorized_keys. No agent, no daemon, no extra listening port — indistinguishable from OpenSSH on a laptop."
              />
              <Step
                n="04"
                title="The host key is pinned on first use"
                body="The fingerprint is recorded on the first connection and checked on every reconnect. A mismatch refuses the connection rather than prompting."
              />
            </ol>

            <H3 className="mt-10">Pinning is what keeps the relay honest</H3>
            <P className="mt-2">
              The relay occupies exactly the position a machine-in-the-middle
              would want. The only thing stopping it from answering with its own
              SSH server instead of yours is that the client compares the host
              key it is offered against the one it recorded the first time. A
              substituted server produces a different key, and a different key
              ends the connection. There is no &ldquo;continue anyway&rdquo;
              button. That leaves the usual trust-on-first-use window; we show
              you the fingerprint so you can close it yourself, on the server:
            </P>
            <Command>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</Command>
          </div>

          <figure className="min-w-0 lg:sticky lg:top-20">
            <ArchitectureDiagram />
            <figcaption className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Encryption begins and ends inside the tab. Everything between the
              two ends is ciphertext.
            </figcaption>
          </figure>
        </div>
      </Section>

      {/* ---------------------------------------------------------- keys */}
      <Section id="keys" index="02" title="Keys, and what non-extractable buys you">
        <P>
          SSH private keys are generated by WebCrypto with extraction disabled.
          Your tab receives a handle it can sign with; there is no API that
          returns the private bytes to JavaScript. The browser can still wrap the
          key with another key and hand back the resulting ciphertext, which is
          how syncing works — the ciphertext comes out, the plaintext never does.
        </P>

        <Table className="mt-8">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[15rem]">Key mode</TableHead>
              <TableHead>Portable</TableHead>
              <TableHead>Device-bound</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {KEY_MODES.map((row) => (
              <TableRow key={row.question}>
                <TableCell className="text-muted-foreground">{row.question}</TableCell>
                <TableCell className="text-foreground">{row.portable}</TableCell>
                <TableCell className="text-foreground">{row.device}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <H3 className="mt-12">What non-extractable stops, and what it does not</H3>
        <P className="mt-2">
          It means a key cannot be stolen for later. It does not mean it cannot
          be used now, and the difference is the whole of the honest answer.
        </P>

        <Table className="mt-5">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[18rem]">Attack</TableHead>
              <TableHead className="w-[8rem]">Key at risk</TableHead>
              <TableHead>What actually happens</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ATTACKS.map((row) => (
              <TableRow key={row.attack}>
                <TableCell className="text-foreground">{row.attack}</TableCell>
                <TableCell className={row.blocked ? "text-success" : "text-warning"}>
                  {row.blocked ? "No" : "Yes"}
                </TableCell>
                <TableCell className="text-muted-foreground">{row.outcome}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <H3 className="mt-12">Your login password never reaches the server</H3>
        <P className="mt-2">
          The password you type to sign in is stretched with Argon2id in the
          browser, and the result is split by HKDF into two independent keys. One
          is an authentication token, which is sent and only ever lets the server
          recognise you. The other is your vault key, which encrypts hosts, keys
          and snippets before anything is uploaded and is never transmitted in
          any form.
        </P>
        <P className="mt-3">
          A full dump of our database therefore yields a verifier and a blob.
          That cuts both ways, and we would rather say so: we cannot reset your
          password, we cannot recover a vault whose password is lost, and we
          cannot search your hosts server-side. The search box in the app is fast
          because the vault is already decrypted in your tab.
        </P>
      </Section>

      {/* -------------------------------------------------- threat model */}
      <Section id="threat-model" index="03" title="What each of our systems observes">
        <P>
          Encryption moves a problem, it does not delete it. Two systems of ours
          are positioned to observe you: the relay that carries your session, and
          the control plane that holds your account and your encrypted vault.
          Everything either of them has is in this table.
        </P>

        <Table className="mt-8">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[22rem]">Data</TableHead>
              <TableHead className="w-[11rem]">The relay</TableHead>
              <TableHead className="w-[11rem]">The control plane</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {VISIBILITY.map((row) => (
              <TableRow key={row.what}>
                <TableCell className="text-foreground">{row.what}</TableCell>
                <TableCell>
                  <Seen verdict={row.relay} />
                </TableCell>
                <TableCell>
                  <Seen verdict={row.control} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <P className="mt-5 text-xs">
          <strong className="font-medium text-foreground">Ciphertext</strong>{" "}
          means we store the bytes and cannot open them — the vault is encrypted
          with a key derived from your password, which we never receive. Activity
          records name their target by an HMAC of the host, so even our own audit
          log does not spell out where you connected.
        </P>
      </Section>

      {/* ------------------------------------------------ residual risks */}
      <Section id="residual-risks" index="04" title="Residual risks">
        <P>
          These are the parts we have not solved. They are listed because a
          threat model containing only the flattering half is marketing.
        </P>

        <dl className="mt-8 divide-y divide-border border-y border-border">
          <Risk severity="largest" title="We serve the JavaScript">
            Everything above depends on the code in your tab being the code we
            meant to ship. A compromised build — or a coerced one — could log
            keystrokes or drive your key while the tab is open, and
            non-extractability does not stop that. Our mitigations are real but
            partial: a strict Content-Security-Policy with no inline script and
            no third-party origins, so injected code has nowhere to send what it
            collects; integrity checks on what we do load; and a deliberately
            small dependency surface. Only self-hosting removes it.
          </Risk>
          <Risk severity="unmitigated" title="A compromised endpoint">
            If your device or browser profile is under someone else&apos;s
            control, none of this survives it. Device-bound keys keep the blast
            radius to one machine; nothing takes it to zero.
          </Risk>
          <Risk severity="partial" title="Traffic analysis">
            We do not pad frames or generate cover traffic, so the shape of your
            session is visible to the relay and to any network between you and
            it. That is enough to tell an interactive shell from a file transfer
            and to time your activity; published attacks have made statistical
            guesses about typed content from timing alone. If this is in your
            threat model, self-host the relay so the observer is you.
          </Risk>
          <Risk severity="bounded" title="Trust on first use">
            Pinning protects every connection after the first one. The first has
            nothing to compare against, so a relay that was already hostile when
            you first reached a host could pin its own key. We surface the
            fingerprint and the command to verify it, but we cannot verify it for
            you.
          </Risk>
          <Risk severity="open" title="No third-party audit">
            No outside firm has reviewed this code, and we hold no SOC 2, ISO
            27001 or comparable certification. We are not going to imply
            otherwise while that remains true, and you will not find the phrase
            &ldquo;military grade&rdquo; anywhere in this product.
          </Risk>
        </dl>
      </Section>

      {/* ------------------------------------------------------ self-host */}
      <Section id="self-host" index="05" title="Self-hosting removes us from the model">
        <P>
          The relay is a stateless Go service and the client is static files.
          Running both yourself deletes the two assumptions on this page that
          cryptography cannot: that our build is honest, and that the metadata in
          the table above goes somewhere you are comfortable with. What stays
          identical is everything else — the same WASM client, the same
          non-extractable keys, the same pinning, the same split KDF. Add
          Postgres only if you want account sync, and it still stores nothing but
          ciphertext.
        </P>

        <Command>docker compose -f compose.prod.yaml up -d</Command>

        <div className="mt-8 flex flex-wrap gap-3 border-t border-border pt-8">
          <Button asChild>
            <Link href="/docs#self-host">
              Self-hosting guide <ArrowRightIcon />
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/pricing">Pricing</Link>
          </Button>
        </div>
      </Section>
    </PageShell>
  );
}

/* -------------------------------------------------------------- primitives */

type Verdict = "sees" | "ciphertext" | "never";

const VERDICT: Record<Verdict, { label: string; className: string }> = {
  sees: { label: "Sees it", className: "text-warning" },
  ciphertext: { label: "Ciphertext", className: "text-muted-foreground" },
  never: { label: "Never has it", className: "text-success" },
};

function Seen({ verdict }: { verdict: Verdict }) {
  const v = VERDICT[verdict];
  return <span className={v.className}>{v.label}</span>;
}

function Section({
  id,
  index,
  title,
  children,
}: {
  id: string;
  index: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      /* last:border-b-0 — the footer already draws a rule under the final section. */
      className="scroll-mt-20 border-b border-border py-14 last:border-b-0"
    >
      <div className="mb-6 flex items-baseline gap-3">
        <span className="text-xs font-medium tracking-wider text-primary tabular-nums">
          {index}
        </span>
        <h2 className="font-heading text-xl font-semibold tracking-tight text-balance">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function P({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={`max-w-3xl text-sm leading-relaxed text-muted-foreground ${className ?? ""}`}>
      {children}
    </p>
  );
}

function H3({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h3 className={`font-heading text-sm font-medium ${className ?? ""}`}>{children}</h3>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <li className="flex gap-4 py-4">
      <span className="mt-0.5 text-xs text-muted-foreground tabular-nums">{n}</span>
      <div className="min-w-0">
        <H3>{title}</H3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </li>
  );
}

function Risk({
  severity,
  title,
  children,
}: {
  severity: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5 py-5 sm:grid-cols-[12rem_1fr] sm:gap-8">
      <dt className="min-w-0">
        <span className="font-heading text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{severity}</span>
      </dt>
      <dd className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{children}</dd>
    </div>
  );
}

function Command({ children }: { children: string }) {
  return (
    <pre className="mt-5 max-w-3xl overflow-x-auto rounded-sm border border-border bg-terminal px-4 py-3 text-xs leading-relaxed select-all">
      <span className="text-muted-foreground">$ </span>
      <span className="text-foreground">{children}</span>
    </pre>
  );
}
