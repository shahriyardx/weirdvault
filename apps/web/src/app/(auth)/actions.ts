"use server"

/**
 * The two things the auth screens need from the server and cannot work out for
 * themselves.
 *
 * Both are Server Actions rather than Route Handlers because both are called
 * from Client Components — the sign-in form and the vault-password bootstrap —
 * and neither has a body worth designing a JSON contract for. Being actions,
 * they are POST endpoints reachable by anyone who can read the bundle, so both
 * are written on that assumption: one returns a fact the page renders anyway,
 * the other refuses without a session because the Better Auth endpoint under it
 * does.
 *
 * `setVaultPasswordCredential` exists at all because Better Auth's setPassword
 * is a server-only endpoint: it is deliberately absent from the HTTP router, so
 * the browser cannot call it however it is asked. That is the right decision on
 * their part — setting a first password is the one credential write that needs
 * no proof of a previous one — and it means the derived auth token has to make
 * one hop through our server. It is the same token sign-up sends, and it is not
 * the password: what crosses the wire here is an HKDF branch that cannot derive
 * the vault key. See lib/vault/kdf.ts.
 */

import { headers } from "next/headers"
import { APIError } from "better-auth/api"

import { auth, githubConfigured, hasVaultCredential } from "@/lib/auth"
import { dbErrorSummary } from "@/lib/db/errors"

/**
 * Whether this deployment registered the GitHub provider.
 *
 * The sign-in form renders the button only on true. False is not a disabled
 * button with an explanation, because an unconfigured provider is not a feature
 * this deployment has and is waiting on — it is a feature it does not have, and
 * the operator is the only person who could change that.
 */
export async function githubSignInAvailable(): Promise<boolean> {
  return githubConfigured()
}

/**
 * What the bootstrap can report back. Three outcomes, three sentences on screen.
 *
 * `already-set` is kept out of `error` because it means something different and
 * the page has to act differently: the account has a vault key already, so the
 * keys this tab just derived are probably not that account's keys and must not
 * be installed. "Try again" is the wrong instruction; "unlock with the password
 * that was set" is the right one.
 */
export type SetVaultPasswordResult =
  | { status: "ok" }
  | { status: "already-set" }
  | { status: "error"; message: string }

/**
 * Store the derived auth token as this account's password credential.
 *
 * `authToken` is the base64 HKDF auth branch that lib/vault/kdf.ts produces
 * alongside the vault key — the identical value `signUpWithVault` sends. Storing
 * it here is what makes the bootstrap produce an ordinary password account:
 *
 *  - A wrong password at unlock fails the way it already fails for everyone
 *    else. The vault-unlock dialog re-derives and the vault refuses to decrypt;
 *    there is no second verification path to write, test and get subtly wrong.
 *  - The account gains email-and-password sign-in as well as GitHub, which
 *    matters because account linking is off (see lib/auth.ts): without this the
 *    only route in would be GitHub, and losing that GitHub account would lose
 *    the vault with it.
 *  - The re-key, recovery-code enrolment and account-deletion paths all take a
 *    password and derive this same token. They keep working unchanged, because
 *    from here on there is nothing special about this account.
 *
 * The server never sees the password and cannot derive the vault key from what
 * it stores. It hashes the token again on the way in, as it does for every other
 * account.
 *
 * Better Auth refuses when a credential already exists rather than overwriting
 * one, which is the behaviour we want: this endpoint sets a first password, and
 * changing an existing one has to go through lib/vault/rekey.ts, where the old
 * vault is re-encrypted under the new key. A silent overwrite here would leave a
 * signed-in account whose ciphertext no longer matches its password.
 */
export async function setVaultPasswordCredential(
  authToken: string,
): Promise<SetVaultPasswordResult> {
  const requestHeaders = await headers()

  try {
    // Checked before the write so the "you already have one" case is a plain
    // answer rather than a parsed error string. The race between this and the
    // write is real and harmless: setPassword refuses a second credential
    // itself, and the catch below reports it.
    if (await hasVaultCredential(requestHeaders)) return { status: "already-set" }

    await auth.api.setPassword({
      body: { newPassword: authToken },
      headers: requestHeaders,
    })
    return { status: "ok" }
  } catch (e) {
    // Two kinds of failure, and only one of them is safe to repeat.
    //
    // An APIError is Better Auth refusing on purpose — no session, password
    // already set, token shorter than minPasswordLength — and its message is
    // written to be read by a person. Anything else is almost certainly the
    // database, whose message is the SQL and its bound parameters (see
    // lib/db/errors.ts), so it is summarised for the log and replaced on the
    // way out.
    //
    // Neither branch logs the body. The body is the auth token, and a log line
    // carrying it would hand a log reader the ability to sign in as this
    // account.
    if (e instanceof APIError) {
      const message = typeof e.body?.message === "string" ? e.body.message : e.message
      console.error("vault password bootstrap refused:", message)
      return { status: "error", message }
    }
    console.error("vault password bootstrap failed:", dbErrorSummary(e))
    return {
      status: "error",
      message:
        "The password could not be stored, so nothing was set. Nothing else changed — try again.",
    }
  }
}
