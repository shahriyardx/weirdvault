"use client";

import { useSyncExternalStore } from "react";
import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/plugins/two-factor";
import { passkeyClient } from "@better-auth/passkey/client";

import { registerDevice } from "@/lib/device";
import { deriveSecrets } from "@/lib/vault/kdf";

/**
 * Two plugins, both of which authenticate the ACCOUNT and neither of which
 * touches the vault.
 *
 * The organization client used to be here and is deliberately gone — an account
 * is a person now, and a client plugin whose server half is absent only produces
 * calls that 404 at runtime. These two have their server halves registered in
 * lib/auth.ts, unconditionally, so every method below reaches something.
 *
 * `twoFactorClient` is given no options on purpose. Its only options are two
 * ways to redirect the browser when a sign-in comes back needing a second
 * factor, and both of them navigate away from the tab that has just derived the
 * vault key — which would throw that key away and force the password to be typed
 * again immediately after it was typed. The challenge is handled in place
 * instead; see signInWithVaultAndSecondFactor below.
 */
export const authClient = createAuthClient({
  plugins: [twoFactorClient(), passkeyClient()],
});

export const { useSession, signOut } = authClient;

/* --------------------------------------------- how this tab got its session */

/**
 * The last sign-in this tab performed, when it was one that derives no vault key.
 *
 * There are two ways into this app that authenticate without a password —
 * GitHub and, now, a passkey — and both land on a dashboard that is signed in
 * and locked. A user who is not told why reads an empty host list as data loss.
 * The explanation lives in components/vault-unlock.tsx, once, for both; this is
 * the flag that tells it which sentence to use.
 *
 * Memory-only and not persisted, which is not a security property here but a
 * correctness one: after a reload the honest reason the vault is locked is the
 * reload, not the sign-in that happened before it. lib/vault/session.ts already
 * says so about the key itself, and this has to age out at the same rate.
 */
export type PasswordlessSignIn = "passkey" | "github";

let lastPasswordlessSignIn: PasswordlessSignIn | null = null;
const signInListeners = new Set<() => void>();

/**
 * Records how this tab got its session, including "with a password", which
 * clears the flag.
 *
 * Clearing matters as much as setting: a tab can sign out and back in without a
 * page load, and a stale "you signed in with a passkey" attached to a session
 * that was opened with a password would be an explanation of something that did
 * not happen — a small lie, but the kind this codebase does not ship.
 */
function noteSignInMethod(method: PasswordlessSignIn | null) {
  lastPasswordlessSignIn = method;
  for (const fn of signInListeners) fn();
}

const subscribeSignInMethod = (fn: () => void) => {
  signInListeners.add(fn);
  return () => {
    signInListeners.delete(fn);
  };
};

/** Reactive: which passwordless route, if any, produced this tab's session. */
export function usePasswordlessSignIn(): PasswordlessSignIn | null {
  return useSyncExternalStore(
    subscribeSignInMethod,
    () => lastPasswordlessSignIn,
    // Server render: nothing has signed in here, and the dialog this drives is
    // only ever rendered in the browser.
    () => null,
  );
}

/**
 * Sign-up and sign-in both go through the split KDF, so the raw password never
 * touches the network. Callers get the vault key back and must keep it in
 * memory only — persisting it anywhere would undo the point.
 */
export async function signUpWithVault(email: string, password: string, name: string) {
  const { authToken, vaultKey, auditKey } = await deriveSecrets(email, password);
  const res = await authClient.signUp.email({
    email,
    password: authToken,
    name,
  });
  if (res.error) throw new Error(res.error.message ?? "sign up failed");
  // Best-effort: a device that fails to register can still work, it just
  // won't appear in "where am I signed in".
  void registerDevice();
  return { vaultKey, auditKey, user: res.data?.user };
}

export async function signInWithVault(email: string, password: string) {
  // Delegates rather than duplicates. The three lines this used to contain are
  // the security-critical path and now exist exactly once, in the function
  // below; what stays here is this function's shape, which callers depend on.
  // A sign-in that stops at a second-factor challenge has no user yet, which is
  // exactly what `user: undefined` already meant.
  const outcome = await signInWithVaultAndSecondFactor(email, password);
  return {
    vaultKey: outcome.vaultKey,
    auditKey: outcome.auditKey,
    user: outcome.status === "signed-in" ? outcome.user : undefined,
  };
}

/**
 * What a password sign-in can end in now that a second factor exists.
 *
 * Note that the vault key is present in both branches, and note why: it is
 * derived in the browser from the password, before the network is touched at
 * all, and a second factor has nothing to do with it. Holding it across the
 * challenge is what stops the user typing the password twice — once for the
 * sign-in and once for the unlock dialog thirty seconds later — and it is not a
 * weakening, because the key it holds is the one the person who typed the
 * password already had.
 *
 * It is also the sharp edge of requirement two: 2FA gates the SESSION. Somebody
 * who has the password has the vault key whether or not this challenge is ever
 * answered. That is a property of deriving the key on the device and cannot be
 * fixed by adding factors — only stated.
 */
export type SignInOutcome =
  | {
      status: "signed-in";
      vaultKey: CryptoKey;
      auditKey: CryptoKey;
      user:
        | NonNullable<Awaited<ReturnType<typeof authClient.signIn.email>>["data"]>["user"]
        | undefined;
    }
  | {
      status: "two-factor-required";
      vaultKey: CryptoKey;
      auditKey: CryptoKey;
      /** Which factors the server will accept, e.g. ["totp"]. */
      methods: string[];
    };

/**
 * A shape Better Auth's client does not type.
 *
 * The two-factor plugin answers a sign-in that needs a challenge from an `after`
 * hook, replacing the response body — so the value on the wire has
 * `twoFactorRedirect` where the endpoint's declared type has a session. The
 * client's inference follows the endpoint, not the hook, so this is narrowed by
 * hand. Checked rather than cast: a body that does not have the flag is treated
 * as a completed sign-in, which is what it is.
 */
function twoFactorChallenge(data: unknown): { methods: string[] } | null {
  if (typeof data !== "object" || data === null) return null;
  const body = data as { twoFactorRedirect?: unknown; twoFactorMethods?: unknown };
  if (body.twoFactorRedirect !== true) return null;
  const methods = Array.isArray(body.twoFactorMethods)
    ? body.twoFactorMethods.filter((m): m is string => typeof m === "string")
    : [];
  return { methods };
}

export async function signInWithVaultAndSecondFactor(
  email: string,
  password: string,
): Promise<SignInOutcome> {
  const { authToken, vaultKey, auditKey } = await deriveSecrets(email, password);
  const res = await authClient.signIn.email({ email, password: authToken });
  if (res.error) throw new Error(res.error.message ?? "sign in failed");

  const challenge = twoFactorChallenge(res.data);
  if (challenge) {
    // No device registration yet: there is no session to attach it to, and the
    // challenge may never be answered. It happens on the way through
    // completeTwoFactorSignIn instead.
    return { status: "two-factor-required", vaultKey, auditKey, methods: challenge.methods };
  }

  // A password was typed, so whatever this tab last recorded about a
  // passwordless route is no longer the reason for anything.
  noteSignInMethod(null);
  void registerDevice();
  return { status: "signed-in", vaultKey, auditKey, user: res.data?.user };
}

/**
 * Answer a pending second-factor challenge.
 *
 * The challenge is held in a short-lived signed cookie the server set when it
 * refused the sign-in, so nothing has to be carried across from the call above
 * except the fact that a challenge is outstanding. A backup code and an
 * authenticator code go to different endpoints; the caller says which it has,
 * because the two cannot be told apart by looking at them and guessing would
 * spend a backup code on a typo.
 */
export async function completeTwoFactorSignIn(
  code: string,
  factor: "totp" | "backup-code",
): Promise<void> {
  const res =
    factor === "totp"
      ? await authClient.twoFactor.verifyTotp({ code: code.trim() })
      : await authClient.twoFactor.verifyBackupCode({ code: code.trim() });
  if (res.error) throw new Error(res.error.message ?? "that code was not accepted");
  // Reached only from a password sign-in, so the same clearing applies.
  noteSignInMethod(null);
  void registerDevice();
}

/* ------------------------------------------------------------------ GitHub */

/**
 * Where a GitHub callback lands, for both a first sign-up and a return visit.
 *
 * Deliberately not /dashboard. The bootstrap page is the only place that can
 * tell the two apart in the browser — it asks which accounts are linked, sends a
 * finished account straight on, and shows the password form to one that has no
 * vault key yet. Sending returning users through it costs an interstitial and
 * buys two things: the device gets registered on a browser that has never typed
 * a password here (nothing else on the OAuth path would do it), and there is one
 * landing page to reason about instead of two.
 */
const OAUTH_LANDING = "/set-vault-password";

/**
 * Start the GitHub redirect.
 *
 * Note what this function does not return: any key material, and in the normal
 * case any control at all — the browser leaves for github.com inside the call.
 * A GitHub sign-in cannot produce a vaultKey and must never look as though it
 * might; there is no password in this flow, and the vault key is Argon2id of a
 * password or it is nothing. Whoever comes back is authenticated and locked.
 *
 * Only callable when the server registered the provider. The caller checks that
 * first (see githubConfigured in lib/auth.ts) and does not render the button
 * otherwise, so this is not a control that fails when pressed.
 */
export async function signInWithGithub() {
  const res = await authClient.signIn.social({
    provider: "github",
    callbackURL: OAUTH_LANDING,
    // Failures come back to the sign-in page carrying ?error=<code>, which
    // AuthForm turns into a sentence. Without this they land on Better Auth's
    // own /error page, which is a route this app does not have.
    errorCallbackURL: "/sign-in",
  });
  if (res.error) {
    throw new Error(res.error.message ?? "GitHub sign-in could not be started");
  }
}

/**
 * Does this account have a password credential — and therefore a vault key
 * somebody can derive?
 *
 * Reads the same fact the server gates the dashboard on, from the browser, so
 * the bootstrap page can decide what to render without a server action round
 * trip of its own. `listAccounts` needs the session cookie and returns only
 * provider ids and timestamps; there is no secret in the answer.
 */
export async function hasVaultPassword(): Promise<boolean> {
  const res = await authClient.listAccounts();
  if (res.error) {
    throw new Error(res.error.message ?? "could not read the linked sign-in methods");
  }
  return (res.data ?? []).some((a) => a.providerId === "credential");
}

/**
 * Register this browser after a GitHub sign-in.
 *
 * The three password paths above do this for themselves; an OAuth callback is a
 * full page navigation with no client code of ours in the middle, so the landing
 * page has to do it instead. Best-effort for the same reason it is there: a
 * device that fails to register still works, it just will not appear in "where
 * am I signed in".
 */
export function registerDeviceAfterOAuth() {
  void registerDevice();
  // Also the moment this tab learns it got its session without a password, which
  // is what the unlock dialog needs in order to explain itself. This is the only
  // client code that runs on the OAuth return path, so it is the only place the
  // fact is available.
  noteSignInMethod("github");
}

/* ---------------------------------------------------------------- passkeys */

/**
 * Passkeys, and what they are for.
 *
 * They replace typing an email and a password AT SIGN-IN. They do not replace
 * the password, and the UI must never imply that they do — the vault key is
 * Argon2id over the password and nothing else, it lives in tab memory only, and
 * it dies on every reload. So the password is typed several times a day and a
 * sign-in happens once a month; a passkey removes the rarer of the two.
 *
 * The WebAuthn PRF extension could change that and is deliberately not used.
 * See the note at the top of the second-factor section in lib/auth.ts: one
 * derivation, one sentence, one answer to what a password change does.
 */

/** The browser prompt was dismissed, or no credential matched. Not an error. */
export class PasskeyCancelledError extends Error {
  constructor() {
    super("The passkey prompt was closed before a credential was chosen.");
    this.name = "PasskeyCancelledError";
  }
}

const CANCELLATION_CODES = new Set(["AUTH_CANCELLED", "REGISTRATION_CANCELLED"]);

function throwPasskeyError(error: { code?: string; message?: string }, fallback: string): never {
  if (error.code && CANCELLATION_CODES.has(error.code)) throw new PasskeyCancelledError();
  throw new Error(error.message ?? fallback);
}

/**
 * Sign in with a passkey.
 *
 * Returns no key material and cannot: no password is typed, so nothing is
 * stretched and there is no vault key to hand back. Whoever arrives is
 * authenticated and locked, and `notePasswordlessSignIn` is what lets the unlock
 * dialog say so in those words instead of appearing without explanation.
 */
export async function signInWithPasskey(): Promise<void> {
  const res = await authClient.signIn.passkey();
  if (res.error) throwPasskeyError(res.error, "passkey sign-in failed");
  noteSignInMethod("passkey");
  void registerDevice();
}

/** One registered credential, as the settings list shows it. */
export type PasskeySummary = NonNullable<
  Awaited<ReturnType<typeof authClient.passkey.listUserPasskeys>>["data"]
>[number];

export async function listPasskeys(): Promise<PasskeySummary[]> {
  const res = await authClient.passkey.listUserPasskeys();
  if (res.error) throw new Error(res.error.message ?? "could not read your passkeys");
  return res.data ?? [];
}

/**
 * Register a passkey against the current session.
 *
 * The server requires the session to be fresh — created within the last day —
 * because this adds a way into the account. A stale session comes back as
 * SESSION_NOT_FRESH and the caller turns that into "sign in again first" rather
 * than a raw code.
 */
export async function addPasskey(name: string): Promise<void> {
  const trimmed = name.trim();
  const res = await authClient.passkey.addPasskey(trimmed ? { name: trimmed } : {});
  if (res?.error) throwPasskeyError(res.error, "the passkey was not registered");
}

export async function renamePasskey(id: string, name: string): Promise<void> {
  const res = await authClient.passkey.updatePasskey({ id, name: name.trim() });
  if (res.error) throw new Error(res.error.message ?? "the passkey was not renamed");
}

/**
 * Remove a passkey. Authenticated by the session, which is Better Auth's own
 * ownership check on the row — a passkey belonging to somebody else answers
 * UNAUTHORIZED rather than being silently ignored.
 */
export async function removePasskey(id: string): Promise<void> {
  const res = await authClient.passkey.deletePasskey({ id });
  if (res.error) throw new Error(res.error.message ?? "the passkey was not removed");
}

/* -------------------------------------------------------------------- TOTP */

/**
 * TOTP enrolment, in two steps because one step would be a lie.
 *
 * `beginTotpEnrolment` produces the secret and the backup codes and enables
 * nothing. `confirmTotpEnrolment` sends a code the authenticator generated, and
 * only that turns the factor on. Between the two, an abandoned enrolment leaves
 * an account exactly as it was — which matters more here than in most apps,
 * because there is no support route into an account whose vault we cannot open.
 *
 * Every one of these sends the derived auth token as `password`. That is the
 * same HKDF branch a sign-in sends and the only credential this server has ever
 * held, so "confirm your password" is a real re-authentication rather than a
 * form field: the browser has to run Argon2id over the typed password to produce
 * a token the server will accept.
 */
export interface TotpEnrolment {
  /** The otpauth:// URI, for the QR code. */
  totpURI: string;
  /** The shared secret on its own, for anyone who cannot scan. */
  secret: string;
  /** Shown once. Nothing can show them again. */
  backupCodes: string[];
}

/**
 * The secret, pulled out of the URI the server built.
 *
 * Read from the URI rather than requested separately because they are the same
 * secret and asking twice would be two chances for them to disagree — somebody
 * scanning the code and somebody typing the string must end up with the same
 * factor.
 */
function secretFromTotpUri(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

export async function beginTotpEnrolment(email: string, password: string): Promise<TotpEnrolment> {
  const { authToken } = await deriveSecrets(email, password);
  const res = await authClient.twoFactor.enable({ password: authToken });
  if (res.error) throw new Error(res.error.message ?? "two-factor could not be set up");
  const totpURI = res.data?.totpURI ?? "";
  const secret = secretFromTotpUri(totpURI);
  if (!totpURI || !secret) {
    // Neither half of the enrolment is usable without both, and a card showing a
    // QR code with no fallback secret is a control that fails for anyone who
    // cannot scan. Refusing is the honest answer.
    throw new Error("The server did not return a usable enrolment secret, so nothing was set up.");
  }
  return { totpURI, secret, backupCodes: res.data?.backupCodes ?? [] };
}

/** Turns the factor on, and only if the authenticator is genuinely in step. */
export async function confirmTotpEnrolment(code: string): Promise<void> {
  const res = await authClient.twoFactor.verifyTotp({ code: code.trim() });
  if (res.error) throw new Error(res.error.message ?? "that code was not accepted");
}

/**
 * Turn the factor off. Requires the password, and Better Auth additionally reads
 * the session authoritatively rather than from the cookie cache for this one —
 * it is treated as a sensitive operation, which it is.
 */
export async function disableTotp(email: string, password: string): Promise<void> {
  const { authToken } = await deriveSecrets(email, password);
  const res = await authClient.twoFactor.disable({ password: authToken });
  if (res.error) throw new Error(res.error.message ?? "two-factor was not turned off");
}

/**
 * Replace the backup codes. Every code from the previous set stops working, which
 * is the point: it is the only way back if the old list leaked or was lost.
 */
export async function reissueBackupCodes(email: string, password: string): Promise<string[]> {
  const { authToken } = await deriveSecrets(email, password);
  const res = await authClient.twoFactor.generateBackupCodes({ password: authToken });
  if (res.error) throw new Error(res.error.message ?? "the backup codes were not replaced");
  const codes = res.data?.backupCodes ?? [];
  if (codes.length === 0) {
    throw new Error("The server reported success but returned no codes. Nothing was shown.");
  }
  return codes;
}

/**
 * Sign in with an auth token recovered from a recovery code.
 *
 * The password is not involved and cannot be: the whole point of a recovery
 * code is that the password is gone. Redeeming the code yields the same three
 * secrets `deriveSecrets` would have produced, and this hands the auth branch
 * to Better Auth exactly as `signInWithVault` does — the server sees an
 * indistinguishable sign-in, because it is the same token.
 *
 * Deliberately takes the token rather than the code. Only lib/vault/recovery.ts
 * ever holds a code, and keeping it that way means a future caller cannot
 * accidentally send one to the server.
 */
export async function signInWithRecoveredToken(email: string, authToken: string) {
  const res = await authClient.signIn.email({ email, password: authToken });
  if (res.error) throw new Error(res.error.message ?? "sign in failed");

  /**
   * A recovery code does not bypass the second factor, and the recovery page
   * cannot ask for one.
   *
   * Better Auth challenges every /sign-in/email, and a redeemed code signs in
   * through exactly that endpoint with exactly that token — which is the whole
   * design of recovery here and is why it works at all. So an account with an
   * authenticator enrolled gets the challenge on this path too, and this page has
   * no field for it.
   *
   * Refusing loudly is the only honest option available from this file. The
   * alternative is what happened before this check: the call succeeds with no
   * session, the page installs the recovered keys and navigates to Settings, and
   * the layout bounces the user to /sign-in having spent a code for nothing. The
   * code IS spent either way — the server consumes it when it hands the envelope
   * over — so the message says so rather than inviting another attempt.
   *
   * Fixing it properly means a second-factor step on /recover, which is not this
   * file's to add. See the note on the two-factor card in Settings, which warns
   * about this before somebody enrols rather than after they need it.
   */
  if (twoFactorChallenge(res.data)) {
    throw new Error(
      "This account has an authenticator app enabled, and a recovery code does not replace it — " +
        "the sign-in stopped at the second factor, which this page cannot ask for. The code you " +
        "just used has been spent. Sign in at /sign-in with your password and your authenticator " +
        "code, or turn two-factor off from Settings first.",
    );
  }

  void registerDevice();
  return { user: res.data?.user };
}

/**
 * Delete the account, verified with the derived auth token.
 *
 * Better Auth's deleteUser wants the credential it stores, and what it stores
 * is the HKDF auth branch — not the password. So the password is re-derived
 * here and never sent, the same as every other authenticated action.
 *
 * Verification matters more here than anywhere else in the app: this is the one
 * call that destroys the vault blob, and a vault we cannot decrypt is a vault
 * we cannot restore from a backup either.
 */
export async function deleteAccountWithVault(email: string, password: string) {
  const { authToken } = await deriveSecrets(email, password);
  const res = await authClient.deleteUser({ password: authToken });
  if (res.error) throw new Error(res.error.message ?? "account deletion failed");
}
