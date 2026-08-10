import type { Metadata } from "next"
import Link from "next/link"

import { Bullets, DataTable, H3, LegalSection, P, UnfinishedNotice } from "@/components/legal/prose"
import { PageHeader, PageShell } from "@/components/shell/page-shell"
import { AUDIT_RETENTION_LABEL } from "@/lib/audit/retention"
import {
  CONTACT_EMAIL,
  LEGAL_ENTITY,
  LEGAL_ENTITY_DETAIL,
  LEGAL_UPDATED,
  PRIVACY_EMAIL,
  SUPERVISORY_AUTHORITY,
} from "@/lib/legal"
import { pageMetadata } from "@/lib/seo"

export const metadata: Metadata = pageMetadata({
  title: "Privacy",
  description:
    "What WeirdVault stores, what it cannot read, who processes it, and how long each thing is " +
    "kept — written from the database schema rather than from a template.",
  path: "/privacy",
})

/**
 * The privacy policy.
 *
 * Written from `lib/db/schema.ts` table by table, which is the only way to make
 * it true. A policy assembled from a template describes a generic SaaS and
 * quietly misses the things that are unusual here — an encrypted blob the
 * server cannot open, a byte counter, a truncated network prefix — and, worse,
 * asserts things that are not done at all.
 *
 * Two claims in here were checked against the running system rather than
 * assumed, because both are the kind a policy usually gets wrong in the
 * flattering direction:
 *
 *  - Session rows carry a **full** IP address and a full user-agent string.
 *    Better Auth writes them and every session row has them. The audit log's
 *    truncated /24 is a different thing on a different table, and saying "we
 *    only keep truncated prefixes" would have been false.
 *  - The vault blob really is opaque to the server. That is not a promise about
 *    intent, it is what the code can do: the key is Argon2id over a password
 *    that never leaves the browser, and there is no code path that decrypts it
 *    server-side because there is no key there to do it with.
 *
 * Not legal advice, and it says so on the page. What this file can be
 * responsible for is that every factual statement matches the schema.
 */
export default function Privacy() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="Legal"
        title="Privacy"
        description={`How ${LEGAL_ENTITY} handles your data in WeirdVault. Last updated ${LEGAL_UPDATED}.`}
      />

      <UnfinishedNotice detail={LEGAL_ENTITY_DETAIL} />

      <LegalSection id="summary" index="01" title="The short version">
        <P>
          WeirdVault is an SSH client that runs inside your browser tab. The parts of it that would
          be most sensitive — your private keys, the list of servers you connect to, your saved
          commands, and everything you type in a terminal — are either encrypted before they reach
          us or never reach us at all.
        </P>
        <P>
          What we do hold is the account around that: an email address, a record of which browsers
          have signed in, a log of security-relevant events, a count of bytes moved, and billing
          identifiers if you subscribe. Each is listed below with why it exists and how long it
          stays.
        </P>
        <P>
          We do not sell anything to anyone, we run no advertising, and there are no third-party
          analytics or tracking scripts on this site.
        </P>
      </LegalSection>

      <LegalSection id="controller" index="02" title="Who is responsible">
        <P>
          {LEGAL_ENTITY} is the data controller for the hosted service at this domain.{" "}
          {LEGAL_ENTITY_DETAIL}
        </P>
        <P>
          For anything in this policy, including a request to exercise your rights, write to{" "}
          <a className="underline underline-offset-4" href={`mailto:${PRIVACY_EMAIL}`}>
            {PRIVACY_EMAIL}
          </a>
          .
        </P>
        <P>
          If you run WeirdVault on your own hardware, none of this applies to us: you are the
          controller of everything your installation stores, and we receive nothing.
        </P>
      </LegalSection>

      <LegalSection id="what" index="03" title="What we store">
        <P>
          The table below is the whole of it, taken from the database schema. Where something is
          described as ciphertext, it means the server holds bytes it has no key for.
        </P>

        <H3>Your account</H3>
        <DataTable
          rows={[
            {
              what: "Name and email address",
              why: "To identify the account, sign you in, and contact you about the service",
              kept: "Until you delete the account",
            },
            {
              what: "A hash of a derived authentication token",
              why: "Your password is stretched with Argon2id in your browser and never sent. What reaches us is a one-way derivation, and we store a hash of that",
              kept: "Until you delete the account",
            },
            {
              what: "GitHub account id, and the name, email and avatar URL GitHub returns",
              why: "Only if you use “Continue with GitHub”, to link that identity to an account",
              kept: "Until you delete the account or unlink GitHub",
            },
            {
              what: "TOTP secret and backup codes; passkey credential ids and public keys",
              why: "Only if you turn on two-factor authentication or register a passkey",
              kept: "Until you remove the factor or delete the account",
            },
          ]}
        />

        <H3>Sessions and devices</H3>
        <P>
          This is the part most policies describe too generously, so plainly: a session row carries
          your <strong className="text-foreground">full IP address</strong> and full browser
          user-agent string. That is how “where am I signed in” can show you anything useful, and
          how you can end a session on a laptop you no longer have.
        </P>
        <DataTable
          rows={[
            {
              what: "Session token, full IP address, user-agent string",
              why: "To keep you signed in and to let you see and revoke your own sessions",
              kept: "Until the session expires or is revoked; 30 days at most",
            },
            {
              what: "Device record: a label derived from your browser and OS, a platform name, a public key generated in that browser, and a truncated network prefix",
              why: "So “where am I signed in” lists browsers rather than opaque ids, and so revoking one can end its sessions",
              kept: "Until you delete the account. Revoking a device keeps the row so its history stays readable",
            },
          ]}
        />
        <P>
          The truncated prefix is a /24 for IPv4 and a /48 for IPv6 — enough to answer “was that
          me?” and not enough to locate anybody.
        </P>

        <H3>Your vault</H3>
        <DataTable
          rows={[
            {
              what: "One encrypted blob containing your hosts, your portable SSH keys, your pinned host keys and your saved snippets",
              why: "So the same data appears on every browser you sign in from",
              kept: "Until you delete the account",
            },
            {
              what: "Recovery envelopes",
              why: "Encrypted under codes we have never seen, so a lost password is recoverable by you and not by us",
              kept: "Until you regenerate or disable them, or delete the account",
            },
          ]}
        />
        <P>
          We cannot read any of it. The key is derived from your password on your device, and the
          server has no copy of the password and no copy of the key. This is also the trade: if you
          forget your password and have no recovery code left, nobody — including us — can open the
          vault again.
        </P>

        <H3>Activity and usage</H3>
        <DataTable
          rows={[
            {
              what: "Audit events: what happened, when, a truncated network prefix, and a small fixed set of details per event type",
              why: "So you can see security-relevant activity on your own account — devices registered, keys installed, host keys pinned, recovery codes used",
              kept: `${AUDIT_RETENTION_LABEL.free} on Free, ${AUDIT_RETENTION_LABEL.pro} on Pro, then deleted`,
            },
            {
              what: "A blinded reference to the host an event concerns",
              why: "So events about the same server group together. It is an HMAC computed in your browser under a key we do not hold, so it is not a hostname and cannot be turned back into one by us",
              kept: "With the event",
            },
            {
              what: "Bytes moved through the relay, per account, per calendar month",
              why: "To enforce the monthly transfer allowance",
              kept: "Kept as monthly totals; not deleted on a schedule",
            },
          ]}
        />

        <H3>Recordings, if you use them</H3>
        <DataTable
          rows={[
            {
              what: "An encrypted recording, its size, its duration, when it started, and which of your devices made it",
              why: "So you can play back a session you chose to record",
              kept: "Until you delete it, or delete the account",
            },
            {
              what: "Share links: a token, a second encrypted copy, an expiry, and a view count",
              why: "So a link you create works for the person you send it to, expires, and can be cut off",
              kept: "Until the link is revoked or you delete the recording; revoking destroys the copy immediately",
            },
          ]}
        />

        <H3>Billing, if you subscribe</H3>
        <DataTable
          rows={[
            {
              what: "Stripe customer and subscription identifiers, the subscription status and its period end",
              why: "To know which plan an account is on",
              kept: "Until you delete the account",
            },
          ]}
        />
        <P>
          We never see or store your card details. Payment happens on Stripe’s own checkout pages
          and what comes back to us is an identifier and a status.
        </P>

        <H3>Machines, if you enrol one</H3>
        <DataTable
          rows={[
            {
              what: "A label, the hostname the machine reports about itself, its operating system, CPU architecture, agent version, public key and last-seen time",
              why: "So you can identify a machine in your list and revoke it",
              kept: "Until you remove it, or delete the account",
            },
          ]}
        />

        <H3>Abuse controls</H3>
        <DataTable
          rows={[
            {
              what: "Rate-limit counters keyed on an account id or a truncated network prefix",
              why: "To bound sign-in attempts, recovery attempts and expensive writes",
              kept: "Cleared automatically once the window is long past",
            },
          ]}
        />
      </LegalSection>

      <LegalSection id="cannot" index="04" title="What we deliberately do not have">
        <Bullets
          items={[
            <>
              <strong className="text-foreground">Your password.</strong> It is stretched in your
              browser and never transmitted. We hold a hash of a one-way derivation of it.
            </>,
            <>
              <strong className="text-foreground">Your private SSH keys, in readable form.</strong>{" "}
              A portable key syncs as ciphertext sealed with your vault key. A device-bound key
              never leaves the browser that made it at all.
            </>,
            <>
              <strong className="text-foreground">
                What you type, or what your servers reply.
              </strong>{" "}
              The SSH session is encrypted end to end between your tab and your server. Our relay
              forwards bytes it cannot read.
            </>,
            <>
              <strong className="text-foreground">The names of the servers you connect to</strong>,
              in the audit log. Only a blinded reference is stored, computed under a key we do not
              hold.
            </>,
            <>
              <strong className="text-foreground">Analytics.</strong> No third-party analytics, no
              advertising, no tracking pixels, no behavioural profiling.
            </>,
          ]}
        />
        <P>
          One thing our relay does necessarily observe while a session is open: that an account
          connected to a particular address, at a particular time, and roughly how much moved. It
          has to, in order to route the connection at all. This is stated in more detail on the{" "}
          <Link className="underline underline-offset-4" href="/security">
            security page
          </Link>
          , and it is the main reason self-hosting is offered.
        </P>
      </LegalSection>

      <LegalSection id="why" index="05" title="Our lawful bases">
        <Bullets
          items={[
            <>
              <strong className="text-foreground">Performance of a contract</strong> — your account,
              your vault, your sessions and your recordings. Without these there is no service to
              provide.
            </>,
            <>
              <strong className="text-foreground">Legitimate interests</strong> — the audit log,
              rate-limit counters and transfer accounting. The interest is keeping the service
              working and secure for the people using it, and each is the minimum that achieves it:
              truncated addresses rather than full ones, counts rather than contents.
            </>,
            <>
              <strong className="text-foreground">Legal obligation</strong> — retaining billing
              records for as long as tax law requires.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection id="processors" index="06" title="Who else touches it">
        <P>
          We use a small number of processors. We do not share your data with anyone else, and we do
          not sell it.
        </P>
        <Bullets
          items={[
            <>
              <strong className="text-foreground">Cloudflare</strong> — DNS, TLS and protection in
              front of the site, and object storage for encrypted recordings. Cloudflare sees the
              traffic to this domain, including your IP address, and stores recordings as
              ciphertext.
            </>,
            <>
              <strong className="text-foreground">Stripe</strong> — payments. If you subscribe, you
              give Stripe your card details directly and they become a controller of that data under
              their own policy.
            </>,
            <>
              <strong className="text-foreground">GitHub</strong> — only if you choose “Continue
              with GitHub”, and only to authenticate you.
            </>,
            <>
              <strong className="text-foreground">Our hosting provider</strong> — the servers this
              runs on, which hold the database.
            </>,
          ]}
        />
        <P>
          Some of these operate outside the UK. Where they do, transfers rely on the safeguards
          those providers offer, such as standard contractual clauses.
        </P>
      </LegalSection>

      <LegalSection id="cookies" index="07" title="Cookies">
        <P>
          There are no advertising or analytics cookies. There are two, and both are strictly
          necessary:
        </P>
        <Bullets
          items={[
            <>
              A <strong className="text-foreground">session cookie</strong>, set when you sign in,
              which is what keeps you signed in.
            </>,
            <>
              A <strong className="text-foreground">short-lived identifier</strong> for signed-out
              visitors who open a connection, used only to meter relay use. It is a random value
              tied to nothing else and expires within a day.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection id="rights" index="08" title="Your rights">
        <P>
          Under UK GDPR you can ask us to give you a copy of your data, correct it, delete it,
          restrict what we do with it, or object to processing based on legitimate interests. You
          can also ask for it in a portable form.
        </P>
        <P>
          Two of these you can exercise yourself, immediately, without asking us. Settings has an
          export that gives you your whole vault, and a delete that removes the account. For
          anything else, write to{" "}
          <a className="underline underline-offset-4" href={`mailto:${PRIVACY_EMAIL}`}>
            {PRIVACY_EMAIL}
          </a>{" "}
          and we will answer within one month.
        </P>
        <P>
          If you think we have handled your data badly, you can complain to the{" "}
          <a
            className="underline underline-offset-4"
            href={SUPERVISORY_AUTHORITY.url}
            rel="noreferrer"
            target="_blank"
          >
            {SUPERVISORY_AUTHORITY.name}
          </a>
          . We would rather you told us first, but you are not obliged to.
        </P>
      </LegalSection>

      <LegalSection id="deletion" index="09" title="What deleting your account does">
        <P>Deleting the account is immediate and is not reversible. In one operation it:</P>
        <Bullets
          items={[
            "removes your account, sessions, devices, passkeys and two-factor enrolment",
            "removes your encrypted vault, your recovery envelopes, your recordings and every share link you created — including the stored copies in object storage",
            "removes your audit history, your enrolled machines and your usage counters",
            "cancels any active subscription, so you are not billed again",
          ]}
        />
        <P>
          What survives is what we are required to keep: billing records held by Stripe for tax
          purposes. Backups are retained on a short rolling cycle and are overwritten in the normal
          course; we do not mine them and they are not used to restore a deleted account.
        </P>
      </LegalSection>

      <LegalSection id="children" index="10" title="Children">
        <P>
          This is a tool for administering servers and is not directed at children. We do not
          knowingly create accounts for anyone under 16.
        </P>
      </LegalSection>

      <LegalSection id="changes" index="11" title="Changes">
        <P>
          If we change this policy in a way that matters, we will say so on this page and update the
          date at the top before the change takes effect. Questions to{" "}
          <a className="underline underline-offset-4" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          .
        </P>
        <P className="text-xs">
          This page describes what the software does. It is written to be accurate rather than to be
          comprehensive legal drafting, and it is not legal advice.
        </P>
      </LegalSection>
    </PageShell>
  )
}
