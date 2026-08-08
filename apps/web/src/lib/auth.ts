import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";

import { db, schema } from "@/lib/db";

/**
 * Better Auth owns accounts, sessions, organizations, roles, and invitations.
 *
 * Note what it does NOT own: the vault key. The "password" arriving here is
 * already an HKDF branch derived in the browser (see lib/vault/kdf.ts), so the
 * strongest thing an attacker gets from this database is the ability to
 * impersonate a session — never to decrypt a host list or an SSH key.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      organization: schema.organization,
      member: schema.member,
      invitation: schema.invitation,
    },
  }),

  emailAndPassword: {
    enabled: true,
    // The client already ran Argon2id; this is the server-side hash of the
    // derived auth token, not of a user-chosen password.
    minPasswordLength: 32,
    autoSignIn: true,
  },

  plugins: [
    organization({
      allowUserToCreateOrganization: true,
      organizationLimit: 5,
      creatorRole: "owner",
      membershipLimit: 100,
    }),
  ],

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },

  advanced: {
    cookiePrefix: "webxterm",
  },

  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
});

export type Session = typeof auth.$Infer.Session;
