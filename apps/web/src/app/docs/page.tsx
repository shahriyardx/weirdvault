import type { Metadata } from "next";
import Link from "next/link";
import {
  ArchiveIcon,
  ArrowRightIcon,
  CloudArrowUpIcon,
  DeviceMobileIcon,
  FileCodeIcon,
  FingerprintIcon,
  FoldersIcon,
  KeyIcon,
  LifebuoyIcon,
  PlugsConnectedIcon,
  ProhibitIcon,
  RocketLaunchIcon,
  TerminalWindowIcon,
  WarningIcon,
} from "@phosphor-icons/react/dist/ssr";

import { PageHeader, PageShell } from "@/components/shell/page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RELAY_ALLOWANCE_BYTES } from "@/lib/billing/tiers";
import { formatBytes } from "@/lib/usage";
import { cn } from "@/lib/utils";

/**
 * Imported so the troubleshooting entry cannot name a cap the code does not use.
 *
 * Both tiers, because the allowance genuinely differs and this page is where
 * somebody lands after being refused. A Pro subscriber reading the Free figure
 * as their own would conclude the server had cut them off at a fifth of what
 * they pay for.
 */
const FREE_TRANSFER = formatBytes(RELAY_ALLOWANCE_BYTES.free);
const PRO_TRANSFER = formatBytes(RELAY_ALLOWANCE_BYTES.pro);

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Getting started with webxterm: authorise a key on stock sshd, understand portable and " +
    "device-bound keys, move files over SFTP, and read the errors when a connection fails.",
};

const SECTIONS = [
  { id: "quickstart", label: "Quickstart" },
  { id: "server", label: "Server setup" },
  { id: "keys", label: "Keys" },
  { id: "files", label: "Files and editing" },
  { id: "hosts", label: "Hosts and sync" },
  { id: "troubleshooting", label: "Troubleshooting" },
] as const;

const PUBLIC_KEY_LINE =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHk2mQ1r7ZC9tRfV0oXqK3nB8sJyLwDpE6uNaG4vTcXi webxterm@laptop";

export default function Docs() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="Documentation"
        title="Getting started"
        description="From an empty tab to a live shell. Everything below is the whole setup — there is no agent to install on the server and no client to install on the machine you are sitting at."
        actions={
          <Button asChild size="sm">
            <Link href="/dashboard/terminal">
              Open the dashboard <ArrowRightIcon />
            </Link>
          </Button>
        }
      />

      <div className="flex flex-col gap-10 py-10 lg:flex-row-reverse lg:items-start lg:gap-12">
        <TableOfContents />

        <article className="min-w-0 flex-1 space-y-16">
          {/* ---------------------------------------------------- quickstart */}
          <Section id="quickstart" icon={<RocketLaunchIcon />} title="Quickstart">
            <P>
              Six steps, and the only one that touches the server is step three.
              If you already have an Ed25519 key authorised somewhere you can
              import it instead of generating a new one, with a caveat worth
              reading before you do: <A href="#keys">what import can and cannot
              promise</A>.
            </P>

            <ol className="mt-6 space-y-5">
              <Step n={1} title="Open the dashboard">
                Go to <Code>/dashboard</Code>. The SSH client is WebAssembly and
                loads with the page. You can connect without an account; create
                one when you want hosts and keys to follow you to another device.
              </Step>
              <Step n={2} title="Generate a key">
                Choose <em>New key</em> and pick Ed25519. The private key is
                created inside WebCrypto and is never handed back to the page as
                bytes. Decide now whether it is portable or device-bound — see{" "}
                <A href="#keys">Keys</A>.
              </Step>
              <Step n={3} title="Authorise the key on the server">
                Copy the public key and append it to{" "}
                <Code>~/.ssh/authorized_keys</Code> on the host. If you would
                rather not leave the browser, connect once with a password and
                let webxterm write the line for you. Both routes are in{" "}
                <A href="#server">Server setup</A>.
              </Step>
              <Step n={4} title="Add the host">
                Give it a label, hostname or IP, port, and the login user, then
                attach the key you just made. The entry is encrypted in the
                browser before it is stored or synced.
              </Step>
              <Step n={5} title="Verify the host key fingerprint">
                The first connection shows the server&apos;s host key fingerprint
                and asks you to accept it. Compare it against the server console
                if you can. Accepting pins it, and every reconnect after that is
                checked against the pin.
              </Step>
              <Step n={6} title="You have a shell">
                The terminal is a real VT emulator with true colour, splits and
                tabs. The file explorer and the editor ride the same connection,
                so opening them costs no second login.
              </Step>
            </ol>
          </Section>

          {/* -------------------------------------------------------- server */}
          <Section id="server" icon={<PlugsConnectedIcon />} title="Server setup">
            <P>
              webxterm speaks to stock <Code>sshd</Code>. There is no package to
              install, no daemon to run, and no port to open beyond the one you
              already use for SSH. The entire server-side change is one line.
            </P>

            <CodeBlock label="on your server — the whole setup" className="mt-6">
              <span className="text-muted-foreground">$ </span>
              <span className="text-foreground">echo </span>
              <span className="text-success">&apos;{PUBLIC_KEY_LINE}&apos;</span>
              <span className="text-foreground"> &gt;&gt; ~/.ssh/authorized_keys</span>
            </CodeBlock>
            <p className="mt-2 text-xs text-muted-foreground">
              Click the block to select it. The dashboard shows your real public
              key with the command already built around it.
            </p>

            <P className="mt-6">
              If <Code>~/.ssh</Code> does not exist yet, create it with the modes{" "}
              <Code>sshd</Code> insists on. It refuses keys from a directory or
              file that other users can write to, and it does so quietly.
            </P>

            <CodeBlock label="first time on a fresh account" className="mt-4">
              <span className="text-muted-foreground">$ </span>
              <span className="text-foreground">mkdir -p ~/.ssh &amp;&amp; chmod 700 ~/.ssh</span>
              {"\n"}
              <span className="text-muted-foreground">$ </span>
              <span className="text-foreground">touch ~/.ssh/authorized_keys &amp;&amp; chmod 600 ~/.ssh/authorized_keys</span>
            </CodeBlock>

            <H3 className="mt-10">Prerequisites</H3>
            <ul className="mt-4 space-y-3">
              <Bullet title="sshd is reachable on the port you configure">
                Default 22. The relay opens the TCP connection, so the host has
                to be routable from the relay, not from your laptop.
              </Bullet>
              <Bullet title="PubkeyAuthentication yes">
                On by default, but hardening scripts and some managed images turn
                it off. Confirm with <Code>sudo sshd -T | grep -i pubkeyauth</Code>{" "}
                rather than by reading the config file, which does not account for
                includes and matches.
              </Bullet>
              <Bullet title="AllowUsers / AllowGroups permit your account">
                If either directive is set, the user you connect as must appear in
                it. <Code>DenyUsers</Code> and <Code>DenyGroups</Code> win over
                both.
              </Bullet>
              <Bullet title="Permissions are 700 on ~/.ssh and 600 on authorized_keys">
                Both owned by the login user. On SELinux systems a manually
                created directory may also need{" "}
                <Code>restorecon -R -v ~/.ssh</Code>.
              </Bullet>
            </ul>

            <Callout tone="warning" icon={<ProhibitIcon />} title="Firewalls and NAT: the honest version">
              <p>
                The relay dials your server from the public internet. If the host
                sits behind NAT with no forwarded port, or behind a firewall that
                only allows a specific office range, the relay cannot reach it —
                and webxterm has nothing on the server to open a tunnel back out,
                because there is deliberately nothing on the server.
              </p>
              <p className="mt-2">
                The answer is to run the relay where an SSH client would already
                have a route: inside the VPC, on the bastion, behind the VPN.
                Self-hosting is supported for exactly this reason.
              </p>
            </Callout>

            <H3 className="mt-10">Password first, key after</H3>
            <P className="mt-3">
              If the server already accepts passwords, you can skip the copying
              entirely. Choose <em>Password</em> for the first connection, and once
              you are authenticated webxterm appends the public key to{" "}
              <Code>authorized_keys</Code> itself, creating <Code>~/.ssh</Code>{" "}
              with the right modes if it has to. The password is used for that one
              connection; every connection after it is key-based.
            </P>
          </Section>

          {/* ---------------------------------------------------------- keys */}
          <Section id="keys" icon={<KeyIcon />} title="Keys">
            <P>
              A private key is generated in the tab and stays there. Two modes,
              chosen when you create the key, decide whether it can reach your
              other devices.
            </P>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <Card>
                <CardContent className="px-4">
                  <div className="mb-3 flex items-center gap-2">
                    <CloudArrowUpIcon className="size-4 text-primary" />
                    <h4 className="font-heading text-sm font-medium">Portable</h4>
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Wrapped with your vault key before it is stored, then synced
                    as ciphertext. The wrap happens inside WebCrypto, so what
                    comes back is an encrypted blob rather than a private key the
                    page could read. Sign in on a new laptop and the key is there.
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="px-4">
                  <div className="mb-3 flex items-center gap-2">
                    <DeviceMobileIcon className="size-4 text-primary" />
                    <h4 className="font-heading text-sm font-medium">Device-bound</h4>
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Created non-extractable and never wrapped, so it cannot be
                    copied anywhere — including to your own other browsers. The
                    stronger option, at the cost of authorising a separate key per
                    device.
                  </p>
                </CardContent>
              </Card>
            </div>

            <H3 className="mt-10">What &ldquo;non-extractable&rdquo; actually means</H3>
            <P className="mt-3">
              The key is created with the browser&apos;s{" "}
              <Code>extractable</Code> flag set to false. After that there is no
              API that returns its bytes — not to our code, not to a browser
              extension, not to a script that manages to get itself injected into
              the page. Code can ask the browser to sign with the key and get a
              signature back. It cannot ask for the key.
            </P>
            <P className="mt-3">
              This is a real boundary, not a policy we promise to honour, and it
              is why webxterm has no &ldquo;export private key&rdquo; button. It
              also means the largest residual risk is not key theft but the
              JavaScript we serve you — the{" "}
              <A href="/security">threat model</A> says so plainly.
            </P>

            <H3 className="mt-10">Importing a key you already have</H3>
            <P className="mt-3">
              Paste an OpenSSH or PKCS#8 private key, or choose the file, and it
              is parsed by the same WebAssembly core that runs the SSH session.
              Encrypted keys are supported: you are asked for the passphrase, and
              it is used once and not stored. From the moment the key is parsed
              it is held exactly like a generated one — non-extractable, and
              wrapped with your vault key if you chose portable.
            </P>
            <P className="mt-3">
              What import cannot promise is the part before that. A generated key
              has never existed as bytes any code could read. An imported key was
              a file on some machine, possibly for years and possibly in a
              backup, and it passes through the page in plaintext for the length
              of one function call — that is what importing means, and no amount
              of care on our side makes it retroactive. If the key protects
              something you care about, generating a new one here and adding a
              second line to <Code>authorized_keys</Code> is the stronger move.
            </P>
            <P className="mt-3">
              One practical limit: only Ed25519 keys are accepted. The core can
              parse RSA and ECDSA, but the connect path signs as Ed25519 only, so
              importing the others would give you a key that stores cleanly and
              then fails at authentication. Refusing them up front is the honest
              version.
            </P>

            <Callout tone="destructive" icon={<WarningIcon />} title="A device-bound key dies with the browser profile">
              <p>
                Clearing site data, using &ldquo;delete cookies and site
                data&rdquo; on exit, resetting the profile, or wiping the machine
                destroys a device-bound key permanently. There is no copy on our
                servers to restore, because the whole point is that there never
                was one.
              </p>
              <p className="mt-2">
                If a key is your only way into a host, make it portable, or
                authorise a second key from another device first. Keeping a
                console or recovery route into any server you care about is
                sensible regardless of which SSH client you use.
              </p>
            </Callout>
          </Section>

          {/* --------------------------------------------------------- files */}
          <Section id="files" icon={<FoldersIcon />} title="Files and editing">
            <P>
              SFTP runs over the SSH connection you are already using. Opening the
              explorer does not authenticate again, does not open a second socket,
              and does not care whether the server has anything installed beyond
              its SFTP subsystem.
            </P>

            <div className="mt-6 space-y-4">
              <Row icon={<FoldersIcon />} title="Drag and drop, folders included">
                Drop files onto the explorer to upload them to the directory you
                are looking at. Whole folders work: the tree is walked in the
                browser and recreated on the remote side, so dragging a project
                directory in does what you would expect.
              </Row>
              <Row icon={<CloudArrowUpIcon />} title="Streaming, in both directions">
                Uploads and downloads stream. Nothing is read into memory first,
                so a multi-gigabyte image moves through a tab that never grows,
                and a download starts writing before the transfer has finished.
              </Row>
              <Row icon={<ArchiveIcon />} title="A tar fast path for many small files">
                Thousands of tiny files are dominated by per-file round trips, not
                by bytes. When it detects that shape — a{" "}
                <Code>node_modules</Code>, a source tree — webxterm streams the
                set as a single tar over the same connection and unpacks on the
                far side.
              </Row>
              <Row icon={<FileCodeIcon />} title="Edit remote files in place">
                Open a file and it loads into a Monaco editor with syntax
                highlighting, search and multiple cursors. Save writes it back
                over SFTP. No scp round trip, no local copy left behind to get out
                of sync.
              </Row>
            </div>
          </Section>

          {/* --------------------------------------------------------- hosts */}
          <Section id="hosts" icon={<FingerprintIcon />} title="Hosts and sync">
            <P>
              A saved host is a label, a hostname, a port, a user and a key.
              Together with your snippets they make up the vault, and the vault is
              encrypted in the browser before anything leaves it.
            </P>

            <H3 className="mt-8">Host key pinning</H3>
            <P className="mt-3">
              The first time you connect, webxterm shows the server&apos;s host key
              fingerprint and pins it once you accept. Every reconnect compares the
              key the server presents against that pin, and a mismatch refuses the
              connection outright — the session does not open and you are told
              which fingerprint was expected. Replacing a pin is a deliberate act
              in the host&apos;s settings, not a prompt you can click through while
              you are busy.
            </P>
            <P className="mt-3">
              This is what keeps the relay honest. The relay forwards ciphertext it
              cannot read, and pinning is the check that proves the SSH handshake
              really terminated at your server rather than somewhere in the middle.
            </P>

            <H3 className="mt-8">Bulk import from ~/.ssh/config</H3>
            <P className="mt-3">
              Adding hosts one at a time is fine for three and tedious for thirty,
              so an existing <Code>~/.ssh/config</Code> can be pasted or uploaded
              whole. It is parsed by the same WebAssembly core the terminal uses,
              and what comes back is a review list rather than an import: every
              entry is shown with what was understood, what was ignored, and which
              ones are already saved, and you tick the ones you want.
            </P>
            <P className="mt-3">
              Directives with no equivalent here are reported instead of being
              silently dropped — the import screen names them per host. The one
              worth knowing about in advance is <Code>ProxyJump</Code>, which is
              not implemented at all: a host that depends on it will import and
              then fail to connect, so it is flagged rather than accepted quietly.
            </P>

            <H3 className="mt-8">Zero-knowledge sync</H3>
            <P className="mt-3">
              Your login password never reaches us. Argon2id runs in the browser
              and HKDF splits the result into three: an auth token, which is sent;
              a vault key, which is not; and an audit key, which blinds hostnames
              in the activity log and is also never sent. The vault syncs as a
              single encrypted blob, so the server holds your hosts, keys and
              snippets without being able to read any of them.
            </P>
            <P className="mt-3">
              The honest consequence: because the server cannot read the blob, it
              cannot search it either. Search, filtering and sorting all happen in
              the tab, over data decrypted locally. Everything works, it just works
              in a different place than you might assume.
            </P>
            <P className="mt-3">
              The other consequence is that a forgotten password is not something
              we can help with — there is no reset that could open the blob. Two
              things in <A href="/dashboard/settings">Settings</A> exist because of
              that. Recovery codes are sealed copies of your keys, each encrypted
              under 120 random bits shown once in your browser; one of them signs
              you in and unlocks the vault, which makes a code as valuable as the
              password itself. And an export writes the encrypted blob to a file
              you keep, which restores by merging into whatever is on the device
              rather than overwriting it — an export is by definition older than
              the vault it came from, and a restore that discarded newer work
              would be a delete button with the wrong label.
            </P>
            <Button asChild variant="outline" size="sm" className="mt-5">
              <Link href="/security">Read the threat model</Link>
            </Button>
          </Section>

          {/* ----------------------------------------------- troubleshooting */}
          <Section id="troubleshooting" icon={<LifebuoyIcon />} title="Troubleshooting">
            <P>
              Four failures cover almost everything. The error text is the
              server&apos;s, so the fixes are the ordinary SSH ones.
            </P>

            <div className="mt-6 space-y-4">
              <Problem code="Permission denied (publickey)" summary="The server saw your key and did not accept it.">
                <p>
                  Work through it in this order: the key is in{" "}
                  <Code>authorized_keys</Code> for the user you are connecting as
                  and not for <Code>root</Code> by accident; the line was appended
                  whole, on one line, without a wrapped or truncated base64 body;{" "}
                  <Code>~/.ssh</Code> is 700 and <Code>authorized_keys</Code> is
                  600, both owned by that user; <Code>PubkeyAuthentication</Code>{" "}
                  is enabled; <Code>AllowUsers</Code> does not exclude you.
                </p>
                <p className="mt-2">
                  The server log says which one it is, and is far faster than
                  guessing:
                </p>
                <CodeBlock className="mt-3">
                  <span className="text-muted-foreground">$ </span>
                  <span className="text-foreground">sudo journalctl -u ssh -n 50 --no-pager</span>
                  {"\n"}
                  <span className="text-muted-foreground"># or, on systems without journald</span>
                  {"\n"}
                  <span className="text-muted-foreground">$ </span>
                  <span className="text-foreground">sudo tail -n 50 /var/log/auth.log</span>
                </CodeBlock>
              </Problem>

              <Problem
                code="Host key verification failed"
                summary="The key the server presented is not the one pinned on first use."
              >
                <p>
                  There are two explanations and they are very different. The
                  ordinary one: the machine was rebuilt, reimaged, restored from a
                  snapshot, or its host keys were regenerated — the IP now answers
                  for a different server. It also happens when a load balancer or
                  round-robin DNS fronts several hosts that were never given
                  matching host keys.
                </p>
                <p className="mt-2">
                  The other one is that something is sitting between you and the
                  server. webxterm cannot tell these apart, which is exactly why it
                  refuses instead of asking. Verify the fingerprint out of band —
                  on the console, through your provider&apos;s dashboard, from a
                  machine you trust:
                </p>
                <CodeBlock className="mt-3">
                  <span className="text-muted-foreground">$ </span>
                  <span className="text-foreground">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span>
                </CodeBlock>
                <p className="mt-2">
                  Only when that matches what webxterm reports should you clear the
                  pin on the host and reconnect.
                </p>
              </Problem>

              <Problem code="Connection refused / connection timed out" summary="The relay never got as far as the SSH handshake.">
                <p>
                  The two are worth telling apart. <em>Refused</em> means something
                  answered and said no: <Code>sshd</Code> is not running, it is
                  listening on a different port, or it is bound to{" "}
                  <Code>127.0.0.1</Code> rather than a reachable address. Check
                  with <Code>sudo ss -tlnp | grep sshd</Code>.
                </p>
                <p className="mt-2">
                  <em>Timed out</em> means the packets went nowhere: a security
                  group, a firewall rule, or NAT with no port forward. Remember the
                  relay connects from the internet, not from your laptop — a host
                  you can reach over a VPN or from inside a VPC is not necessarily
                  a host the hosted relay can reach. See the{" "}
                  <A href="#server">firewall caveat</A>.
                </p>
              </Problem>

              <Problem
                code="You have used this month's relay transfer allowance"
                summary="Not a fault. We stopped starting new connections through our relay."
              >
                <p>
                  Our relay carries {FREE_TRANSFER} a month per account on Free
                  and {PRO_TRANSFER} on Pro, counting both directions in each
                  case. Past that we refuse to mint the token a new
                  connection needs. Sessions you already have open are untouched
                  and run until you close them — nothing is cut at a byte
                  boundary — and the counter resets at midnight UTC on the first
                  of the month.
                </p>
                <p className="mt-2">
                  The exact figure is on your{" "}
                  <A href="/dashboard/settings">Settings page</A> from the first
                  day rather than only once it bites, and it warns before it
                  refuses. The relay reports its counts about once a minute, so
                  a session you are in right now may not be in the total yet;
                  when a report cannot be delivered it is dropped rather than
                  queued, which means the figure normally reads low rather than
                  high. The one exception is the month boundary: a batch flushed
                  just after midnight UTC on the first is counted in the month it
                  arrived in, so on the first of the month the total can carry up
                  to a minute of the previous month&rsquo;s traffic.
                </p>
                <p className="mt-2">
                  The limit is on <em>our</em> relay, not on webxterm. It exists
                  because that bandwidth costs us money. Point{" "}
                  <Code>NEXT_PUBLIC_RELAY_URL</Code> at a relay you run and
                  nothing counts anything — see{" "}
                  <A href="/security#self-host">self-hosting</A>.
                </p>
              </Problem>

              <Problem code="Closing the tab ends the session" summary="A limitation of running the client in the page, not a bug.">
                <p>
                  The SSH client is in your tab. When the tab closes the client
                  goes with it and the connection drops, because there is no
                  server-side process of ours holding it open — that is the same
                  property that stops us from reading your session. A reload
                  reconnects; it does not resume.
                </p>
                <p className="mt-2">
                  Keep long-running work in a multiplexer on the server, then
                  reattaching is all a reconnect costs you:
                </p>
                <CodeBlock className="mt-3">
                  <span className="text-muted-foreground">$ </span>
                  <span className="text-foreground">tmux new -A -s main</span>
                  {"\n"}
                  <span className="text-muted-foreground"># the same command reattaches later</span>
                </CodeBlock>
                <p className="mt-2">
                  For a single unattended job, <Code>systemd-run --user</Code> or{" "}
                  <Code>nohup … &amp;</Code> is enough. There is no roaming
                  session on any tier and there is not going to be one: mosh
                  needs UDP, and a browser tab has no UDP socket. That is a
                  permanent limitation of running the client in the page rather
                  than an item on a roadmap.
                </p>
              </Problem>

              <Problem
                code="There is no port forwarding"
                summary="Also permanent, and for the same kind of reason."
              >
                <p>
                  <Code>ssh -L 5432:localhost:5432</Code> works by opening a
                  listening socket <em>on your own machine</em>, so that
                  something local — <Code>psql</Code>, a browser, a GUI client —
                  can connect to it. A browser tab cannot open a listening
                  socket. There is no API for it, and the one that exists is
                  restricted to a kind of installed app this is not, so it is not
                  a matter of waiting for browsers to catch up.
                </p>
                <p className="mt-2">
                  It could be delivered by asking you to install a small daemon
                  on your laptop. That is exactly the thing webxterm promises you
                  never have to do, and the promise is worth more than the
                  feature, so this is a decision rather than a gap.
                </p>
                <p className="mt-2">
                  What works instead is to run the client on the machine that can
                  already reach the service, in the terminal you already have —{" "}
                  <Code>psql</Code>, <Code>redis-cli</Code>, <Code>curl</Code>{" "}
                  against <Code>localhost</Code> — which needs no tunnel at all,
                  because you are already on the far end of one.
                </p>
              </Problem>
            </div>
          </Section>

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-8">
            <p className="text-sm text-muted-foreground">
              That is the whole of it. The next step is a terminal.
            </p>
            <Button asChild size="sm" className="sm:ml-auto">
              <Link href="/dashboard/terminal">
                Open the dashboard <ArrowRightIcon />
              </Link>
            </Button>
          </div>
        </article>
      </div>
    </PageShell>
  );
}

/* ------------------------------------------------------------------ layout */

/**
 * Plain anchor links, so the contents work with JavaScript disabled and before
 * hydration. Sticky only from lg up; on narrow screens it is a short index that
 * scrolls away with the rest of the page.
 */
function TableOfContents() {
  return (
    <aside className="lg:sticky lg:top-20 lg:w-52 lg:shrink-0 lg:self-start">
      <nav aria-label="On this page" className="border border-border p-4 lg:border-0 lg:p-0">
        <p className="mb-3 text-xs font-medium tracking-wider text-muted-foreground uppercase">
          On this page
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-2 lg:block lg:space-y-1">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}

function Section({
  id,
  icon,
  title,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <div className="mb-4 flex items-center gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-sm border border-border bg-secondary text-primary">
          {icon}
        </span>
        <h2 className="font-heading text-xl font-semibold tracking-tight">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function H3({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <h3 className={cn("font-heading text-sm font-medium", className)}>{children}</h3>
  );
}

function P({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <p className={cn("max-w-2xl text-sm leading-relaxed text-muted-foreground", className)}>
      {children}
    </p>
  );
}

function A({ href, children }: { href: string; children: React.ReactNode }) {
  const className =
    "text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-primary";
  return href.startsWith("#") ? (
    <a href={href} className={className}>
      {children}
    </a>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-sm bg-secondary px-1 py-0.5 text-[0.85em] text-foreground">
      {children}
    </code>
  );
}

/* ------------------------------------------------------------- primitives */

/**
 * `select-all` makes a single click select the whole block, so copying needs no
 * button and therefore no client component on this page.
 */
function CodeBlock({
  label,
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("max-w-2xl overflow-hidden rounded-md border border-border", className)}>
      {label && (
        <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          <TerminalWindowIcon className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </div>
      )}
      <pre className="bg-terminal overflow-x-auto px-4 py-3 text-xs leading-relaxed select-all">
        {children}
      </pre>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span
        aria-hidden
        className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-sm border border-border bg-secondary text-xs font-medium text-primary"
      >
        {n}
      </span>
      <div className="min-w-0">
        <h3 className="font-heading text-sm font-medium">{title}</h3>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {children}
        </p>
      </div>
    </li>
  );
}

function Bullet({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li className="max-w-2xl border-l-2 border-border pl-4">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{children}</p>
    </li>
  );
}

function Row({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex max-w-2xl gap-3.5">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-sm border border-border bg-secondary text-primary">
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="font-heading text-sm font-medium">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

function Callout({
  tone,
  icon,
  title,
  children,
}: {
  tone: "warning" | "destructive";
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "mt-8 max-w-2xl rounded-md border border-l-2 bg-card p-4",
        tone === "warning" ? "border-border border-l-warning" : "border-border border-l-destructive",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className={cn("shrink-0", tone === "warning" ? "text-warning" : "text-destructive")}>
          {icon}
        </span>
        <h3 className="font-heading text-sm font-medium">{title}</h3>
      </div>
      <div className="text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}

function Problem({
  code,
  summary,
  children,
}: {
  code: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-2xl border border-border p-4">
      {/* Wraps rather than truncates: these strings are long and are the thing
          people are matching against their own error output. */}
      <code className="inline-block rounded-sm bg-secondary px-1.5 py-0.5 text-xs break-words text-warning">
        {code}
      </code>
      <p className="mt-2.5 text-sm font-medium text-foreground">{summary}</p>
      <div className="mt-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}
