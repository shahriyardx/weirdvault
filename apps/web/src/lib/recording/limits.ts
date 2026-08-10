/**
 * Every number that bounds a recording, in one module both halves of the app
 * can read.
 *
 * They are here rather than next to the code that enforces them for one
 * practical reason: lib/recording/capture.ts is a Client Component module and
 * /pricing is server-rendered, so the page that has to state these limits cannot
 * import them from the file that applies them. The alternative was retyping the
 * numbers on the marketing page, which is precisely how a page ends up
 * advertising a cap the code does not enforce — and understating what we enforce
 * is the same failure as overstating what we ship. This module imports nothing,
 * so a route, a browser and a static page can all read the same constant.
 *
 * All three limits below are the same on every tier, and that stayed true when
 * Pro became a real subscription. Recording is switched on rather than sized:
 * `SESSION_RECORDING` in lib/billing/tiers.ts decides whether an account may
 * save a new recording at all, and once it may, it gets the same capture cap and
 * the same storage ceiling as anybody else. Two dimensions to explain rather
 * than one, when the second buys nothing — the ceiling exists to stop one
 * account filling the volume everybody else's vault is on, and a paying account
 * filling it is the same problem.
 *
 * What is NOT here, deliberately: the gate itself. This module imports nothing
 * and is read by a Client Component, a route handler and a static page, so it
 * cannot resolve a subscription. It exports only the name of the refusal, so
 * that the route that refuses and the browser that explains the refusal are
 * matching on a constant rather than on a sentence somebody might reword.
 */

/**
 * The `code` on the 402 from POST /api/recordings when the account is on Free.
 *
 * A code rather than a status alone, because 402 is also what /api/relay-token
 * answers when the monthly transfer allowance is used up, and a browser holding
 * an unsaved transcript needs to tell those two apart to say anything useful.
 */
export const RECORDING_REQUIRES_PRO = "recording_requires_pro"

/**
 * Where capture stops. Four mebibytes of raw output is a long working session —
 * tens of thousands of lines — and it lands somewhere near six megabytes once
 * base64 and the envelope have had their share, which is a blob a browser can
 * encrypt and a route can accept without either of them thinking about it.
 *
 * This is the limit a person actually meets: capture ends itself here, the
 * recording is finalised with everything up to that point, and the reason is on
 * screen. It is stated on /pricing for that reason.
 */
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024

/** Where the UI starts warning. Three quarters leaves time to wrap up. */
export const WARN_CAPTURE_BYTES = Math.floor(MAX_CAPTURE_BYTES * 0.75)

/**
 * The largest blob POST /api/recordings will accept, measured server-side.
 *
 * The backstop rather than the limit anyone should meet: capture has already
 * stopped at MAX_CAPTURE_BYTES, and this leaves room for the envelope, base64
 * and a format that grows a field later. It is generous on purpose — a recording
 * rejected at the end of a long session is an hour of someone's work thrown away
 * by a number they never saw.
 */
export const MAX_BLOB_BYTES = 12 * 1024 * 1024

/**
 * The most stored ciphertext one account may hold, across all its recordings.
 *
 * A per-blob cap bounds one upload and nothing else, and nothing prunes this
 * table — a recording stays until its owner deletes it, deliberately. Without a
 * total, one authenticated account looping twelve-megabyte uploads fills the
 * volume that also holds every other account's vault, and the first symptom is
 * everybody's writes failing. So there is a ceiling, and the route refuses over
 * it with the same readable 413 the blob cap uses.
 *
 * A decimal gigabyte, which is what `formatBytes` renders as "1 GB" and roughly
 * a hundred and sixty full-length recordings. The figure is on the recordings
 * page next to what is stored, and on /pricing, because a storage limit nobody
 * can see is a failed save at the end of an hour-long session.
 *
 * What is NOT solved: this bounds one account, not the deployment. A thousand
 * accounts are still a terabyte, and nothing here rate-limits sign-ups or the
 * route itself — see docs/THREAT-MODEL.md, which lists bandwidth and IP-level
 * limits as still to add.
 */
export const MAX_ACCOUNT_RECORDING_BYTES = 1_000_000_000
