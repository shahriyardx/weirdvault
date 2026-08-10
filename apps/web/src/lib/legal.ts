/**
 * The facts a privacy policy and a set of terms have to state, in one place so
 * the two pages cannot disagree about them.
 *
 * The company details below are taken from the Companies House register and
 * match it exactly — registered name, number, and the registered office as
 * filed. A privacy policy under UK GDPR has to identify the controller, and
 * terms have to say who the contract is with; both are worth being right rather
 * than approximately right, because the register is public and a mismatch is
 * checkable by anyone.
 *
 * ── Still outstanding
 *
 * The two mailboxes must actually receive mail before these pages are relied
 * on. A privacy contact that bounces is not a contact, and a data subject who
 * cannot reach you takes their complaint to the ICO instead of to you.
 */

/** The registered name, in the case a person reads rather than shouts. */
export const LEGAL_ENTITY = "Weirdsoft Ltd"

/**
 * The rest of the registration, as one sentence that stands on its own — both
 * pages drop it in after naming the company, so it has to read as a sentence
 * rather than a fragment.
 *
 * Registered as WEIRDSOFT LTD; "Weirdsoft Ltd" above is the same name and the
 * register is not case-sensitive about how it is written down elsewhere.
 */
export const LEGAL_ENTITY_DETAIL =
  "It is a company registered in England and Wales under number 14288956, with its registered " +
  "office at 2 Frederick Street, Kings Cross, London, WC1X 0ND."

/** Where privacy requests and data-protection questions go. Must exist. */
export const PRIVACY_EMAIL = "privacy@weirdsoft.co.uk"

/** General contact for the terms. Must exist. */
export const CONTACT_EMAIL = "hello@weirdsoft.co.uk"

/**
 * When these documents last changed.
 *
 * Bump it whenever either page changes in substance. A policy with a stale date
 * is one nobody can tell has been revised, and "we will tell you about material
 * changes" is only checkable against this.
 */
export const LEGAL_UPDATED = "10 August 2026"

/** Where a UK data subject complains if we get it wrong. */
export const SUPERVISORY_AUTHORITY = {
  name: "Information Commissioner's Office",
  url: "https://ico.org.uk/make-a-complaint/",
}
