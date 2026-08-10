"use server"

/**
 * One question the Security tab cannot answer for itself.
 *
 * The settings page is a Client Component — it runs Argon2id, it holds form
 * state, it reads the vault session — so it cannot import lib/auth.ts, which is
 * server-only and pulls in the database. The TOTP controls need to know whether
 * this deployment can actually store an enrolment before they render, for the
 * same reason the sign-in form asks whether GitHub is configured: a control that
 * fails when pressed is worse than a control that is honestly absent.
 *
 * Colocated with the page rather than added to (auth)/actions.ts because it is
 * only ever asked from here, and because the answer is about the dashboard's
 * settings surface rather than about signing in.
 */

import { missingTwoFactorStorage, totpStorageReady } from "@/lib/auth"

export interface TotpAvailability {
  /** Whether the enrolment endpoints can complete against this schema. */
  ready: boolean
  /**
   * The columns that are missing, when it is not. Names rather than prose: the
   * only person who can act on this is writing a migration.
   */
  missing: string[]
}

/**
 * Whether TOTP enrolment can succeed here.
 *
 * A static check, computed once at module load in lib/auth.ts from the drizzle
 * schema — no database round trip, and the same answer for the life of the
 * process, which is what makes it safe to render a decision from.
 */
export async function totpAvailability(): Promise<TotpAvailability> {
  return { ready: totpStorageReady(), missing: [...missingTwoFactorStorage()] }
}
