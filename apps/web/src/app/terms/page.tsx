import type { Metadata } from "next"
import Link from "next/link"

import { Bullets, H3, LegalSection, P, UnfinishedNotice } from "@/components/legal/prose"
import { PageHeader, PageShell } from "@/components/shell/page-shell"
import { PRO_PRICE_LABEL, PRO_PRICE_UNIT, RELAY_ALLOWANCE_BYTES } from "@/lib/billing/tiers"
import { CONTACT_EMAIL, LEGAL_ENTITY, LEGAL_ENTITY_DETAIL, LEGAL_UPDATED } from "@/lib/legal"
import { MAX_ACCOUNT_RECORDING_BYTES } from "@/lib/recording/limits"
import { pageMetadata } from "@/lib/seo"
import { formatBytes } from "@/lib/usage"

export const metadata: Metadata = pageMetadata({
  title: "Terms",
  description:
    "The terms for using the hosted WeirdVault service: what you may do with it, what you are " +
    "responsible for, how billing works, and what happens if you lose your password.",
  path: "/terms",
})

/**
 * Terms of service.
 *
 * Every number here is imported from the module that enforces it, on the same
 * rule the pricing page follows: terms that quote a limit the code does not
 * apply are a promise nobody is keeping, in the one document where that matters
 * most.
 *
 * Two sections carry more weight than the rest and are written plainly rather
 * than defensively:
 *
 *  - §4, the vault. There is no password reset. That is a consequence of the
 *    design and not a policy we could soften, and somebody has to read it
 *    before they lose access rather than after.
 *  - §5, authorisation. This tool connects to other people's machines. Saying
 *    "only connect to servers you are allowed to" is the single most important
 *    line in the document, and it is also what makes the acceptable-use section
 *    enforceable rather than decorative.
 *
 * Not legal advice, and the page says so. In particular the liability section
 * below is written in plain English and deliberately does not attempt to
 * exclude the things UK consumer law does not let anyone exclude — a lawyer
 * should look at it before this is relied on.
 */
export default function Terms() {
  const freeTransfer = formatBytes(RELAY_ALLOWANCE_BYTES.free)
  const proTransfer = formatBytes(RELAY_ALLOWANCE_BYTES.pro)
  const storage = `${MAX_ACCOUNT_RECORDING_BYTES / 1_000_000_000} GB`

  return (
    <PageShell>
      <PageHeader
        eyebrow="Legal"
        title="Terms"
        description={`The agreement between you and ${LEGAL_ENTITY} for the hosted service. Last updated ${LEGAL_UPDATED}.`}
      />

      <UnfinishedNotice detail={LEGAL_ENTITY_DETAIL} />

      <LegalSection id="who" index="01" title="Who these terms are with">
        <P>
          The hosted WeirdVault service is operated by {LEGAL_ENTITY}. {LEGAL_ENTITY_DETAIL}
        </P>
        <P>
          Using the service means accepting these terms. If you do not accept them, do not use it —
          the software can be run on your own hardware instead, and these terms do not govern that.
        </P>
      </LegalSection>

      <LegalSection id="service" index="02" title="What the service is">
        <P>
          WeirdVault is an SSH client that runs in your browser. It connects to servers you already
          have, using credentials you already control. We provide the client, a relay that carries
          the encrypted connection, and storage for an encrypted copy of your settings.
        </P>
        <P>
          We do not provide the servers you connect to, and we have no visibility into or
          responsibility for what is on them.
        </P>
      </LegalSection>

      <LegalSection id="account" index="03" title="Your account">
        <Bullets
          items={[
            "One account is one person. There are no seats, and account sharing is not supported.",
            "You must be old enough to enter a contract, and at least 16.",
            "You are responsible for what happens under your account, and for keeping your password and your recovery codes safe.",
            "Give us an email address that works. It is the only way we can reach you about your account.",
          ]}
        />
      </LegalSection>

      <LegalSection id="vault" index="04" title="The vault, and the thing you cannot undo">
        <P>
          Your hosts, keys and snippets are encrypted with a key derived from your password on your
          own device. We never receive that password and we hold no copy of the key.
        </P>
        <P>
          <strong className="text-foreground">
            This means there is no password reset that recovers your data.
          </strong>{" "}
          If you forget your password, the recovery codes issued when you set it up are the only way
          back in. If you lose the password and the codes, your vault cannot be decrypted by you, by
          us, or by anyone — not because we refuse, but because the key does not exist anywhere for
          us to use.
        </P>
        <P>
          Keep your recovery codes somewhere separate, and export your vault from Settings if it
          matters to you. We are not liable for data you can no longer open because of a lost
          password.
        </P>
      </LegalSection>

      <LegalSection id="use" index="05" title="What you may and may not do with it">
        <P>
          The single rule that matters:{" "}
          <strong className="text-foreground">
            only connect to machines you own or are authorised to access.
          </strong>{" "}
          This is a tool for reaching your own infrastructure, and using it to reach anybody else’s
          without permission is both a breach of these terms and, in most places, a criminal
          offence.
        </P>
        <H3>You must not</H3>
        <Bullets
          items={[
            "use the relay to scan, probe, brute-force or attack any system",
            "use the service to break the law, or to help anyone else do so",
            "route traffic through the relay for anything other than reaching a server you are entitled to reach",
            "attempt to work around transfer allowances, storage limits or rate limits, including by creating multiple accounts",
            "resell the service, or run it as the backend of something you sell, without asking us first",
            "attack the service itself, or try to access another account's data",
          ]}
        />
        <P>
          Testing the security of the service is welcome if you tell us first and do not use other
          people’s accounts to do it. Write to{" "}
          <a className="underline underline-offset-4" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          .
        </P>
      </LegalSection>

      <LegalSection id="plans" index="06" title="Plans, limits and billing">
        <P>
          Free includes the whole client, encrypted sync, unlimited hosts and unlimited devices,
          with {freeTransfer} of relay transfer a month. Pro is {PRO_PRICE_LABEL} {PRO_PRICE_UNIT},
          flat, and adds session recording, {proTransfer} of transfer and a longer activity history.
        </P>
        <Bullets
          items={[
            `Recordings are capped at ${storage} of stored ciphertext per account.`,
            "Transfer allowances are monthly. Going over stops new connections being authorised; sessions already running are not cut off mid-transfer.",
            "Subscriptions renew automatically until cancelled. Cancel any time from Settings; you keep Pro until the end of the period you have paid for.",
            "Prices may change. We will tell you before a change affects a subscription you already have.",
            "Payments are handled by Stripe. Sums are stated exclusive of any tax that applies to you.",
          ]}
        />
        <P>
          If you are a consumer in the UK or EU you have a statutory right to cancel within 14 days
          of subscribing. By subscribing you agree we may start providing the paid features
          immediately, and if you then cancel within that window we may charge for what you used.
          Nothing here removes a right you have by law.
        </P>
      </LegalSection>

      <LegalSection id="availability" index="07" title="Availability">
        <P>
          We try to keep the service up and we do not promise that it will be. There is no uptime
          guarantee, no service level agreement, and maintenance sometimes happens without notice.
        </P>
        <P>
          Because the client runs in your tab, closing the tab ends the session. That is a property
          of the design rather than a fault, and it is described on the{" "}
          <Link className="underline underline-offset-4" href="/security">
            security page
          </Link>
          .
        </P>
      </LegalSection>

      <LegalSection id="ending" index="08" title="Ending it">
        <P>
          You can delete your account at any time from Settings. It takes effect immediately, it
          cancels any subscription, and it removes your data as described in the{" "}
          <Link className="underline underline-offset-4" href="/privacy">
            privacy policy
          </Link>
          .
        </P>
        <P>
          We may suspend or close an account that breaches these terms, particularly §5. Where the
          breach is not deliberate and not harmful we will normally tell you and give you a chance
          to put it right first. Where it is an attack on somebody else, we will not.
        </P>
      </LegalSection>

      <LegalSection id="liability" index="09" title="Liability">
        <P>
          The service is provided as it is. We do not warrant that it will be uninterrupted, that it
          will suit a particular purpose, or that it will be free of faults.
        </P>
        <P>
          We are not liable for indirect or consequential loss, for lost profits or business, or for
          data you can no longer decrypt because a password or recovery code was lost. Where we are
          liable, our total liability in any twelve-month period is limited to what you paid us in
          that period.
        </P>
        <P>
          None of this limits liability for death or personal injury caused by negligence, for
          fraud, or for anything else that cannot lawfully be limited. If you are a consumer, your
          statutory rights are unaffected.
        </P>
      </LegalSection>

      <LegalSection id="misc" index="10" title="The rest">
        <Bullets
          items={[
            "We may change these terms. Material changes will be posted here with a new date before they take effect, and continuing to use the service after that means accepting them.",
            "If one part of these terms turns out to be unenforceable, the rest still stands.",
            "You may not transfer your rights under these terms to somebody else; we may transfer ours if the service changes hands.",
            "These terms are governed by the law of England and Wales, and its courts have jurisdiction — which does not remove protections you have under the law of the country you live in.",
          ]}
        />
        <P>
          Questions to{" "}
          <a className="underline underline-offset-4" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          .
        </P>
        <P className="text-xs">
          Written to be readable and accurate about what the software does. It is not legal advice
          and has not been reviewed by a solicitor.
        </P>
      </LegalSection>
    </PageShell>
  )
}
