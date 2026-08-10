/**
 * Whether a machine is running what this deployment publishes.
 *
 * The rule only, with no way to read a manifest — this module is imported by
 * the machines page, which is a Client Component, and the reading half needs
 * `node:fs`. Splitting them is what keeps the rule in one place instead of
 * being written once for the server and once, differently, for the browser.
 * The reading half is `published-version.ts`.
 *
 * ## The comparison is "differs", not "newer"
 *
 * Because that is what the agent does (`apps/agent/update.go`), and the two
 * must agree or the dashboard offers an update the machine will not take.
 * These are `git describe` strings rather than an ordering, and a deployment
 * rolling its fleet back is a real thing this has to keep describing correctly.
 */

/**
 * The version a deployment publishes when nobody set one.
 *
 * `dev` never differs from `dev`, so a deployment that left AGENT_VERSION unset
 * publishes a build no agent will ever install.
 */
export const UNVERSIONED_AGENT = "dev"

/**
 * Whether a machine is running something other than what is published — the
 * question the dashboard badge asks.
 *
 * Every "no" here is deliberate:
 *
 *   - Nothing reported: the machine has not connected since versions began
 *     being reported. Unknown is not out of date.
 *   - Nothing published: no manifest, so there is no build to move to.
 *   - `dev` published: nothing will ever self-update against it, so an update
 *     prompt would be an instruction that cannot work — given to the one person
 *     who cannot fix it from where they are standing.
 *   - Equal: it is running exactly what is published.
 */
export function agentNeedsUpdate(
  reported: string | null | undefined,
  published: string | null | undefined,
): boolean {
  if (!reported || !published) return false
  if (published === UNVERSIONED_AGENT) return false
  return reported !== published
}
