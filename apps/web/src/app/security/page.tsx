import { ArchitectureDiagram, VisibilityDiagram } from "@/components/diagrams/architecture";
import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  BroadcastIcon,
  BrowserIcon,
  CpuIcon,
  DatabaseIcon,
  DeviceMobileIcon,
  EyeIcon,
  FingerprintIcon,
  HardDrivesIcon,
  KeyIcon,
  LockKeyIcon,
  PackageIcon,
  ProhibitIcon,
  ShieldWarningIcon,
} from "@phosphor-icons/react/dist/ssr";

import { PageHeader, PageShell } from "@/components/shell/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How webxterm terminates SSH inside the browser tab, what the relay and control plane can and cannot see, " +
    "and the residual risks we have not solved.",
};

const NAV = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#keys", label: "Keys and secrets" },
  { href: "#threat-model", label: "Threat model" },
  { href: "#self-host", label: "Self-hosting" },
] as const;

export default function SecurityPage() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="Security"
        title="What we can and cannot see"
        description="webxterm terminates SSH inside your browser tab, so most of our security story is an argument about where bytes are decrypted. This page describes that architecture, the guarantees it actually provides, and — in the same detail — the ones it does not."
        actions={
          <Button asChild variant="outline">
            <Link href="#threat-model">Jump to threat model</Link>
          </Button>
        }
      />

      {/* Anchor rail. Wraps rather than scrolls so narrow viewports stay clean. */}
      <nav
        aria-label="On this page"
        className="flex flex-wrap gap-x-1 gap-y-1 border-b border-border py-3"
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
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          A browser cannot open a raw TCP socket, so something has to sit between
          the tab and port 22. In most browser SSH products that something is a
          server that speaks SSH on your behalf: it holds your key, it decrypts
          your session, and you are trusting it with everything. webxterm is
          built the other way round. The SSH client is a WebAssembly module
          running in the page, and the thing in the middle is a dumb pipe.
        </p>

        <div className="mt-8 grid gap-4 lg:grid-cols-[1.05fr_1fr] lg:items-start">
          <ol className="grid gap-3">
            <Step
              n={1}
              icon={<CpuIcon />}
              title="The client runs in your tab"
              body="Key exchange, cipher and MAC negotiation, channel multiplexing and the terminal protocol all execute in page memory. The session keys are derived there and exist nowhere else."
            />
            <Step
              n={2}
              icon={<BroadcastIcon />}
              title="The relay bridges, it does not terminate"
              body="It accepts a WebSocket, opens a TCP connection to the host and port you named, and copies bytes between them. Those bytes were encrypted before they left the tab under keys the relay never held."
            />
            <Step
              n={3}
              icon={<HardDrivesIcon />}
              title="Your server sees ordinary SSH"
              body="Stock sshd, one line appended to ~/.ssh/authorized_keys. No agent, no daemon, no additional listening port. From the server side this is indistinguishable from OpenSSH on a laptop."
            />
            <Step
              n={4}
              icon={<FingerprintIcon />}
              title="The host key is pinned on first use"
              body="The server's host key fingerprint is recorded on the first connection and checked on every reconnect. A mismatch refuses the connection rather than prompting."
            />
          </ol>

          <Card className="min-w-0 overflow-hidden">
            <CardContent className="p-0">
              <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
                trust boundary
              </div>
              <ArchitectureDiagram className="max-w-md" />
            </CardContent>
          </Card>
        </div>

        <Card className="mt-4">
          <CardContent className="pt-6">
            <div className="flex flex-wrap items-center gap-2">
              <FingerprintIcon className="size-4 text-primary" />
              <h3 className="font-heading text-sm font-medium">
                Pinning is what keeps the relay honest
              </h3>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              The relay occupies exactly the position a machine-in-the-middle
              would want. The only thing stopping it from answering with its own
              SSH server instead of yours is that the client compares the host
              key it is offered against the fingerprint it recorded the first
              time. A substituted server produces a different key, a different
              key is a mismatch, and a mismatch ends the connection. There is no
              &ldquo;continue anyway&rdquo; button — re-pinning is a deliberate
              action you take after checking the new fingerprint yourself.
            </p>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              That leaves the usual trust-on-first-use window: the very first
              connection to a host has nothing to compare against. We show you
              the fingerprint at that moment so you can close the window
              yourself, on the server:
            </p>
            <pre className="bg-terminal mt-3 overflow-x-auto rounded-sm border border-border px-4 py-3 text-xs leading-relaxed">
              <span className="text-muted-foreground">$ </span>
              <span className="text-foreground">
                ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
              </span>
            </pre>
          </CardContent>
        </Card>
      </Section>

      {/* ---------------------------------------------------------- keys */}
      <Section
        id="keys"
        index="02"
        title="Keys, and what non-extractable actually buys you"
      >
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          SSH private keys are generated by WebCrypto with extraction disabled.
          Your tab receives a handle it can sign with; there is no API that
          returns the private bytes to JavaScript. The browser can still wrap the
          key with another key and hand back the resulting ciphertext, which is
          how syncing works — the ciphertext comes out, the plaintext never does.
        </p>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Card>
            <CardContent className="pt-6">
              <div className="mb-3 flex items-center gap-2">
                <div className="grid size-8 place-items-center rounded-sm border border-border bg-secondary text-primary">
                  <PackageIcon />
                </div>
                <Badge variant="outline" className="font-normal">
                  portable
                </Badge>
              </div>
              <h3 className="font-heading text-sm font-medium">
                Wrapped, so it follows you
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                The key is wrapped with your vault key inside the tab and stored
                as ciphertext, so it appears on your laptop and your phone. We
                hold the wrapped blob and never the wrapping key. Use this for a
                key you actually want on every device.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="mb-3 flex items-center gap-2">
                <div className="grid size-8 place-items-center rounded-sm border border-border bg-secondary text-primary">
                  <DeviceMobileIcon />
                </div>
                <Badge variant="outline" className="font-normal">
                  device-bound
                </Badge>
              </div>
              <h3 className="font-heading text-sm font-medium">
                Never wrapped, never uploaded
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                The key exists only in this browser profile and cannot be
                exported, synced or recovered. Clearing site data destroys it and
                you re-enrol. Use this on a machine you do not fully control, or
                when you want revocation to mean walking away.
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <ClaimList
            tone="success"
            icon={<LockKeyIcon />}
            title="What this defeats"
            items={[
              "A cross-site scripting bug in our own application. Injected code can ask the key to sign, but cannot read it or carry it anywhere.",
              "A browser extension with access to the page. Same limit: it can observe the tab, it cannot take the key with it.",
              "A compromised dependency inside our bundle attempting to exfiltrate key material.",
              "Us. Our code has no privileged path to the private bytes either, so we could not hand them over if we were asked to.",
            ]}
          />
          <ClaimList
            tone="warning"
            icon={<ShieldWarningIcon />}
            title="What it does not defeat"
            items={[
              "Use of the key while your tab is open. Anything running in the page can sign with it, and a signature is all authentication needs. Non-extractable means it cannot be stolen for later, not that it cannot be misused now.",
              "A compromised device. Malware in your operating system, or a browser started with a debugger attached, reads your session as you read it.",
              "A compromised server. The key proves who you are to a host; it says nothing about what that host does afterwards.",
              "Anyone already sitting at your unlocked machine with your browser profile.",
            ]}
          />
        </div>

        <Separator className="my-10" />

        <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr] lg:items-start">
          <div className="min-w-0">
            <div className="mb-3 flex items-center gap-2">
              <KeyIcon className="size-4 text-primary" />
              <h3 className="font-heading text-sm font-medium">
                Your login password never reaches the server
              </h3>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              The password you type to sign in is stretched with Argon2id in the
              browser, and the result is split by HKDF into two independent keys.
              One is an authentication token, which is sent and only ever lets
              the server recognise you. The other is your vault key, which
              encrypts hosts, keys and snippets before anything is uploaded and
              is never transmitted in any form.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              A full dump of our database therefore yields a verifier and a blob.
              That cuts both ways, and we would rather say so: we cannot reset
              your password, we cannot recover a vault whose password is lost,
              and we cannot run server-side search over your hosts. The search
              box in the app is fast because the vault is already decrypted in
              your tab.
            </p>
          </div>

          <div className="min-w-0">
            <VisibilityDiagram />
          </div>
        </div>
      </Section>

      {/* -------------------------------------------------- threat model */}
      <Section
        id="threat-model"
        index="03"
        title="What we can see"
        lede="Encryption moves a problem, it does not delete it. Two of our systems observe you: the relay that carries your session, and the control plane that holds your account. Here is each of them, in both directions."
      >
        <Visibility
          icon={<BroadcastIcon />}
          name="The relay"
          role="Stateless bridge between your tab and port 22. It copies bytes and forgets them."
          can={[
            "The destination host and port you asked it to reach, and the source address of your browser.",
            "When a session opens, how long it stays open, and when it ends.",
            "The byte volume in each direction, plus the size and arrival time of every frame.",
            "Traffic-analysis signals that follow from the above: interactive typing looks like small packets with human-shaped gaps, an upload looks like a sustained one-way flow. Published research has recovered information about typed content from timing alone.",
          ]}
          cannot={[
            "Any plaintext byte of the session. It never holds a session key.",
            "Your private keys, wrapped or otherwise. They are not part of this path.",
            "The commands you run or the output they produce.",
            "File names, paths, or contents transferred over SFTP.",
            "Your server password, when you authenticate that way — it travels inside the encrypted channel like everything else.",
          ]}
        />

        <Visibility
          className="mt-4"
          icon={<DatabaseIcon />}
          name="The control plane"
          role="Accounts, billing, devices, and the encrypted vault blob in Postgres."
          can={[
            "Your email address, and billing details if you are on a paid plan.",
            "Sign-in times, source addresses, and which devices are enrolled on the account.",
            "The size of your encrypted vault blob and when it last changed.",
            "Team membership and role assignments, on Team plans.",
          ]}
          cannot={[
            "Host names, addresses, usernames, ports or tags — all of it lives inside the blob.",
            "Keys, snippets, or any other vault content.",
            "Your login password, or anything derived from it beyond the auth token you send.",
            "Consequently: it cannot search, index, or de-duplicate your hosts, and it cannot restore a vault whose password you have lost.",
          ]}
        />

        {/* ------------------------------------------------ residual risks */}
        <h3
          id="residual-risks"
          className="mt-12 scroll-mt-20 font-heading text-lg font-semibold tracking-tight"
        >
          Residual risks
        </h3>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          These are the parts we have not solved. They are listed because a
          threat model that only contains the flattering half is marketing.
        </p>

        <div className="mt-6 grid gap-3">
          <Risk
            icon={<BrowserIcon />}
            severity="largest"
            title="We serve the JavaScript"
            body="Everything above depends on the code in your tab being the code we meant to ship. A compromised build — or a coerced one — could log keystrokes or drive your key while the tab is open, and non-extractability does not stop that, because using a key is not the same as stealing it. Our mitigations are real but partial: a strict Content-Security-Policy with no inline script and no third-party origins, so injected code has nowhere to send what it collects; integrity checks on what we do load; and a deliberately small dependency surface. They raise the cost of an attack. Only self-hosting removes it."
          />
          <Risk
            icon={<DeviceMobileIcon />}
            severity="unmitigated"
            title="A compromised endpoint"
            body="If your device or browser profile is under someone else's control, none of this survives it. They read the terminal as you read it and sign with your key for as long as the tab is open. Device-bound keys keep the blast radius to one machine; nothing takes it to zero."
          />
          <Risk
            icon={<EyeIcon />}
            severity="partial"
            title="Traffic analysis"
            body="We do not pad frames or generate cover traffic, so the shape of your session is visible to the relay and to any network between you and it. That is enough to tell an interactive shell from a file transfer, to time your activity, and in some published attacks to make statistical guesses about what was typed. If this is in your threat model, self-host the relay so the observer is you."
          />
          <Risk
            icon={<ProhibitIcon />}
            severity="open"
            title="No third-party audit"
            body="No outside firm has reviewed this code, and we hold no SOC 2, ISO 27001 or comparable certification. We are not going to imply otherwise while that remains true, and you will not find the phrase 'military grade' anywhere in this product. Read the client build yourself; it is the same code we ship."
          />
          <Risk
            icon={<FingerprintIcon />}
            severity="bounded"
            title="Trust on first use"
            body="Pinning protects every connection after the first one. The first one has nothing to compare against, so if the relay were already hostile when you first connected to a host, it could pin its own key. We surface the fingerprint and the command to verify it, but we cannot verify it for you."
          />
        </div>
      </Section>

      {/* ------------------------------------------------------ self-host */}
      <Section
        id="self-host"
        index="04"
        title="Self-hosting removes us from the model"
        lede="The relay is a stateless Go service and the client is static files. Running both yourself deletes the two trust assumptions on this page that cryptography cannot: that our build is honest, and that the metadata above goes somewhere you are comfortable with."
      >
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardContent className="pt-6">
              <h3 className="font-heading text-sm font-medium text-success">
                What it removes
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                We no longer serve your JavaScript, so a compromise of our
                infrastructure cannot reach your sessions. The relay metadata —
                hosts, ports, timings, volumes — lands on your own logs instead
                of ours.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <h3 className="font-heading text-sm font-medium">
                What stays identical
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                The same WASM client, the same non-extractable keys, the same
                host key pinning, the same split KDF. Self-hosting changes who
                operates the pipe, not how the cryptography works.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <h3 className="font-heading text-sm font-medium">
                What it needs
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                A host that can terminate TLS and reach your servers. The relay
                holds no keys and no state, so it scales horizontally behind
                anything. Add Postgres only if you want account sync, and it
                still stores nothing but ciphertext.
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="mt-8 flex flex-col gap-4 border-t border-border pt-8 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <h3 className="font-heading text-sm font-medium">
              Read it before you trust it
            </h3>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
              The setup guide covers deployment, and the same document explains
              key enrolment and server configuration in full.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 sm:ml-auto">
            <Button asChild>
              <Link href="/docs#self-host">
                Self-hosting guide <ArrowRightIcon />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/pricing">Pricing</Link>
            </Button>
          </div>
        </div>
      </Section>
    </PageShell>
  );
}

/* -------------------------------------------------------------- primitives */

function Section({
  id,
  index,
  title,
  lede,
  children,
}: {
  id: string;
  index: string;
  title: string;
  lede?: string;
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
      {lede && (
        <p className="mb-8 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {lede}
        </p>
      )}
      {children}
    </section>
  );
}

function Step({
  n,
  icon,
  title,
  body,
}: {
  n: number;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <li className="flex gap-3 rounded-sm border border-border bg-card p-4">
      <div className="grid size-8 shrink-0 place-items-center rounded-sm border border-border bg-secondary text-primary">
        {icon}
      </div>
      <div className="min-w-0">
        <h3 className="font-heading text-sm font-medium">
          <span className="mr-2 text-muted-foreground tabular-nums">
            {String(n).padStart(2, "0")}
          </span>
          {title}
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </li>
  );
}

function ClaimList({
  tone,
  icon,
  title,
  items,
}: {
  tone: "success" | "warning";
  icon: React.ReactNode;
  title: string;
  items: string[];
}) {
  return (
    <Card className="min-w-0">
      <CardContent className="pt-6">
        <div className="flex items-center gap-2">
          <span className={tone === "success" ? "text-success" : "text-warning"}>
            {icon}
          </span>
          <h3 className="font-heading text-sm font-medium">{title}</h3>
        </div>
        <ul className="mt-4 grid gap-3">
          {items.map((item) => (
            <li key={item} className="flex gap-2.5">
              <span
                aria-hidden
                className={`mt-2 size-1 shrink-0 rounded-full ${
                  tone === "success" ? "bg-success" : "bg-warning"
                }`}
              />
              <span className="text-sm leading-relaxed text-muted-foreground">
                {item}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function Visibility({
  icon,
  name,
  role,
  can,
  cannot,
  className,
}: {
  icon: React.ReactNode;
  name: string;
  role: string;
  can: string[];
  cannot: string[];
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardContent className="pt-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-primary">{icon}</span>
          <h3 className="font-heading text-sm font-medium">{name}</h3>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{role}</p>

        <div className="mt-6 grid gap-6 md:grid-cols-2 md:gap-8">
          <Column
            tone="warning"
            icon={<EyeIcon />}
            heading="Can see"
            items={can}
          />
          <Column
            tone="success"
            icon={<ProhibitIcon />}
            heading="Cannot see"
            items={cannot}
            /* The divider only makes sense once the columns sit side by side. */
            className="md:border-l md:border-border md:pl-8"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Column({
  tone,
  icon,
  heading,
  items,
  className,
}: {
  tone: "success" | "warning";
  icon: React.ReactNode;
  heading: string;
  items: string[];
  className?: string;
}) {
  const accent = tone === "success" ? "text-success" : "text-warning";
  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      <div className={`flex items-center gap-2 ${accent}`}>
        {icon}
        <h4 className="text-xs font-medium tracking-wider uppercase">{heading}</h4>
      </div>
      <ul className="mt-3 grid gap-2.5">
        {items.map((item) => (
          <li
            key={item}
            className="border-l border-border pl-3 text-sm leading-relaxed text-muted-foreground"
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Risk({
  icon,
  severity,
  title,
  body,
}: {
  icon: React.ReactNode;
  severity: string;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-4 rounded-sm border border-border bg-card p-5">
      <div className="grid size-8 shrink-0 place-items-center rounded-sm border border-border bg-secondary text-warning">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="font-heading text-sm font-medium">{title}</h4>
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {severity}
          </Badge>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
