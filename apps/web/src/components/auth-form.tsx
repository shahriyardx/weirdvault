"use client";

// Client Component: this form owns local field state and — more importantly —
// runs the Argon2id derivation in the browser. Neither can happen on the server
// without defeating the point of the split KDF.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  FingerprintSimpleIcon,
  GithubLogoIcon,
  LockKeyIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/dist/ssr";

import { githubSignInAvailable } from "@/app/(auth)/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  completeTwoFactorSignIn,
  PasskeyCancelledError,
  signInWithGithub,
  signInWithPasskey,
  signInWithVaultAndSecondFactor,
  signUpWithVault,
  type SignInOutcome,
} from "@/lib/auth-client";
import { setVaultKey } from "@/lib/vault/session";

export type AuthMode = "sign-in" | "sign-up";

/**
 * What a failed OAuth callback comes back as, in words.
 *
 * Better Auth redirects to the error URL with a machine code in `?error=`. The
 * codes are accurate and unreadable, and the first of them is the one this
 * deployment's linking policy makes routine, so it gets a full explanation
 * rather than a shrug — see the accountLinking comment in lib/auth.ts for why
 * that refusal is deliberate.
 *
 * Unknown codes are shown as themselves. Inventing a friendly sentence for a
 * code nobody has read would be a guess presented as an explanation, and the
 * raw code is at least searchable.
 */
/**
 * The query string never changes under us — a callback error arrives with the
 * document — so there is nothing to subscribe to. useSyncExternalStore is here
 * for its server snapshot, not for its subscription.
 */
const subscribeToNothing = () => () => {};

function readOAuthError(): string | null {
  return new URLSearchParams(window.location.search).get("error");
}

function oauthErrorMessage(code: string): string {
  switch (code) {
    case "account_not_linked":
      return (
        "That GitHub account's email address already belongs to an account here that was " +
        "created with a password, and we do not merge the two automatically. Sign in with " +
        "your email and password instead — it opens the same vault, which signing in with " +
        "GitHub could not have done anyway."
      );
    case "email_not_found":
      return (
        "GitHub did not give us an email address for that account. We derive your vault key " +
        "from your address, so there is nothing we can do without one — add a primary email " +
        "at GitHub, or create an account with a password here."
      );
    case "unable_to_get_user_info":
      return "GitHub accepted the sign-in but we could not read the profile behind it. Nothing was created.";
    case "state_not_found":
    case "state_mismatch":
      return (
        "The sign-in could not be matched to the request that started it, so it was refused. " +
        "That usually means it was left too long or started in another tab. Try again."
      );
    default:
      return `GitHub sign-in failed: ${code.replace(/_/g, " ")}.`;
  }
}

/**
 * One form, two modes, so sign-in and sign-up cannot drift apart — the vault
 * handling below is the security-critical path and should exist exactly once.
 */
export function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Whether this deployment has a GitHub OAuth app.
   *
   * Starts null — unknown — and the button is not rendered until the server has
   * said yes. Null and false render identically, so the wrong answer is never on
   * screen; the honest cost is that the button appears a beat after the form on
   * a deployment that has one.
   *
   * Asked through a Server Action because the credentials are server-side
   * environment variables read at process start, and this component is in the
   * browser bundle. A NEXT_PUBLIC_ mirror of the client id would be baked in at
   * build time, which is exactly the fallback-shaped thing that lets a button
   * outlive the configuration it describes.
   */
  const [githubAvailable, setGithubAvailable] = useState<boolean | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);

  /**
   * Whether this browser can do WebAuthn at all.
   *
   * Unlike GitHub this is not a deployment question — the server always
   * registers the plugin — so the only gate is the browser. Read through the
   * same external-store form as the OAuth error above, for the same reason:
   * `window` does not exist during the server render, the answer never changes
   * afterwards, and there is nothing to subscribe to. The server snapshot is
   * false, so an old browser sees nothing rather than a control that throws when
   * pressed.
   */
  const passkeySupported = useSyncExternalStore(
    subscribeToNothing,
    () => typeof window.PublicKeyCredential !== "undefined",
    () => false,
  );
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void githubSignInAvailable()
      .then((available) => {
        if (!cancelled) setGithubAvailable(available);
      })
      // A failed lookup means the same thing on screen as "not configured":
      // nothing is rendered. Guessing true here would put up a button whose
      // callback might 404.
      .catch(() => {
        if (!cancelled) setGithubAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The error code a failed OAuth callback comes back with.
   *
   * Read straight off the URL rather than through useSearchParams, which would
   * oblige every page rendering this form to wrap it in a Suspense boundary to
   * stay prerenderable — and those pages are not this component's to edit. The
   * external-store form is what keeps it out of an effect: the server snapshot
   * is null, the browser reads the query string once, and there is no state to
   * set and no cascading render.
   *
   * Once the user does something themselves the message is stale, so
   * `dismissedOAuthError` retires it — an explanation of a redirect that
   * happened two attempts ago is worse than none.
   */
  const oauthErrorCode = useSyncExternalStore(subscribeToNothing, readOAuthError, () => null);
  const [dismissedOAuthError, setDismissedOAuthError] = useState(false);
  const shownError =
    error ??
    (oauthErrorCode && !dismissedOAuthError ? oauthErrorMessage(oauthErrorCode) : null);

  /**
   * A sign-in that stopped at a second factor, and the keys it already derived.
   *
   * The vault key is produced by Argon2id in this tab before the network is
   * touched, so it exists whether or not the challenge is answered. Holding it
   * here is what stops the user typing the same password again into the unlock
   * dialog thirty seconds later. It is state in a component that is about to
   * unmount either way — it is never persisted, and abandoning the page drops it
   * like everything else.
   */
  const [challenge, setChallenge] = useState<
    Extract<SignInOutcome, { status: "two-factor-required" }> | null
  >(null);
  const [code, setCode] = useState("");
  const [factor, setFactor] = useState<"totp" | "backup-code">("totp");

  async function startGithub() {
    setGithubBusy(true);
    setError(null);
    setDismissedOAuthError(true);
    try {
      // On success the browser leaves for github.com and nothing below runs.
      await signInWithGithub();
    } catch (err) {
      setError(String((err as Error).message ?? err));
      setGithubBusy(false);
    }
  }

  /**
   * Sign in with a passkey.
   *
   * Nothing is derived and nothing is unlocked: no password is typed here, so
   * there is no vault key to set, and the dashboard this lands on is
   * authenticated and shut. That is stated under the button before it is pressed
   * and again by the unlock dialog afterwards.
   */
  async function startPasskey() {
    setPasskeyBusy(true);
    setError(null);
    setDismissedOAuthError(true);
    try {
      await signInWithPasskey();
      router.push("/dashboard");
    } catch (err) {
      // Closing the prompt is a decision, not a failure, and an alert about it
      // would be noise.
      if (!(err instanceof PasskeyCancelledError)) {
        setError(String((err as Error).message ?? err));
      }
      setPasskeyBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDismissedOAuthError(true);
    try {
      // Argon2id runs here, in the browser. What goes over the wire is an HKDF
      // branch — the server never sees anything that can open the vault.
      if (mode === "sign-up") {
        const { vaultKey, auditKey } = await signUpWithVault(email, password, name);
        // The audit key has to travel with the vault key: without it the
        // activity log cannot blind a hostname on write, or resolve one on read.
        setVaultKey(vaultKey, auditKey);
        router.push("/dashboard");
        return;
      }

      const outcome = await signInWithVaultAndSecondFactor(email, password);
      if (outcome.status === "two-factor-required") {
        setChallenge(outcome);
        setCode("");
        setFactor("totp");
        return;
      }

      setVaultKey(outcome.vaultKey, outcome.auditKey);
      router.push("/dashboard");
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }

  /** Answer the outstanding challenge, then install the keys already derived. */
  async function verifyChallenge(e: React.FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await completeTwoFactorSignIn(code, factor);
      setVaultKey(challenge.vaultKey, challenge.auditKey);
      router.push("/dashboard");
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }

  const signUp = mode === "sign-up";

  if (challenge) {
    return (
      <TwoFactorChallenge
        busy={busy}
        code={code}
        error={error}
        factor={factor}
        methods={challenge.methods}
        onCodeChange={setCode}
        onFactorChange={(next) => {
          setFactor(next);
          setCode("");
          setError(null);
        }}
        onSubmit={verifyChallenge}
      />
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-base">
          {signUp ? "Create your account" : "Sign in"}
        </CardTitle>
        <CardDescription>
          {signUp
            ? "Your email and password derive the vault key on this device. Only a separate, one-way branch of it is sent to us."
            : "Your password is stretched on this device and never sent. What reaches the server cannot open the vault."}
        </CardDescription>
      </CardHeader>

      <CardContent>
        {/* The two routes in that type no password. Each is rendered only when
            it can actually work — GitHub when the server says it registered the
            provider, a passkey when the browser has WebAuthn — because a
            greyed-out button for a provider nobody configured is not a feature
            this install is waiting on. Passkeys are offered on sign-in only:
            there is no account to attach one to before sign-up. */}
        {(githubAvailable === true || (!signUp && passkeySupported)) && (
          <div className="mb-6 space-y-3">
            {githubAvailable === true && (
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="w-full"
                disabled={busy || githubBusy || passkeyBusy}
                onClick={startGithub}
              >
                {githubBusy ? (
                  <>
                    <SpinnerGapIcon className="animate-spin" />
                    Redirecting to GitHub…
                  </>
                ) : (
                  <>
                    <GithubLogoIcon weight="fill" />
                    Continue with GitHub
                  </>
                )}
              </Button>
            )}

            {!signUp && passkeySupported && (
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="w-full"
                disabled={busy || githubBusy || passkeyBusy}
                onClick={startPasskey}
              >
                {passkeyBusy ? (
                  <>
                    <SpinnerGapIcon className="animate-spin" />
                    Waiting for your passkey…
                  </>
                ) : (
                  <>
                    <FingerprintSimpleIcon weight="fill" />
                    Sign in with a passkey
                  </>
                )}
              </Button>
            )}

            {/* The consequence, said before it happens rather than after.
                Neither of these involves a password, so neither derives a key:
                the account is authenticated and the vault is shut until one is
                typed. Users who are not told this read the password prompt that
                follows as a bug.

                The second sentence branches on sign-up rather than on GitHub,
                which is the distinction that decides what actually happens next.
                Only a first-ever sign-up sets a vault password; anybody arriving
                on /sign-in already has one, because a passkey can only be
                registered from inside the dashboard and
                (auth)/set-vault-password sends an account that already has a
                credential straight through. Telling a returning user they are
                about to "set a vault password" would be describing a page they
                will never see.

                The sentence is deliberately unflattering about what these
                buttons save you. They replace a sign-in, which happens rarely;
                the password is still typed after every reload, because the key
                only ever lives in this tab's memory. Implying otherwise would be
                a promise the product does not keep. */}
            <p className="text-xs/relaxed text-muted-foreground">
              {githubAvailable === true && !signUp && passkeySupported
                ? "Neither of these can open your vault — no password is typed, so no key is derived. "
                : githubAvailable === true
                  ? "GitHub proves who you are. It cannot open your vault — no password is typed, so no key is derived. "
                  : "A passkey proves who you are. It cannot open your vault — no password is typed, so no key is derived. "}
              {signUp
                ? "You will set a vault password straight afterwards, and enter it again after each reload."
                : githubAvailable === true
                  ? "You will be asked for your vault password on arrival — set there if this is a new account — and again after each reload: this saves you the sign-in, not the password."
                  : "You will be asked for your vault password on arrival, and again after each reload: a passkey saves you the sign-in, not the password."}
            </p>

            <div className="flex items-center gap-3 pt-1" aria-hidden>
              <span className="h-px flex-1 bg-border" />
              <span className="text-[0.7rem] tracking-wide text-muted-foreground uppercase">
                or
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          {signUp && (
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                autoComplete="name"
                placeholder="Ada Lovelace"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                required
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={signUp ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              required
              minLength={10}
              aria-describedby={signUp ? "password-hint" : undefined}
            />
            {signUp && (
              <p id="password-hint" className="text-xs/relaxed text-muted-foreground">
                Ten characters or more. It is never stored anywhere, on your
                device or ours, so choose something you can reproduce exactly.
              </p>
            )}
          </div>

          {shownError && (
            <Alert variant="destructive">
              <WarningCircleIcon weight="fill" />
              <AlertTitle>
                {signUp ? "Could not create the account" : "Could not sign in"}
              </AlertTitle>
              <AlertDescription>{shownError}</AlertDescription>
            </Alert>
          )}

          <Button
            type="submit"
            size="lg"
            disabled={busy || githubBusy || passkeyBusy}
            className="w-full"
          >
            {busy ? (
              <>
                <SpinnerGapIcon className="animate-spin" />
                Deriving keys…
              </>
            ) : signUp ? (
              "Create account"
            ) : (
              "Sign in"
            )}
          </Button>

          {/* The pause is long enough to read as a bug, so it gets one line.
              The panel beside the form explains why it costs what it costs. */}
          <p className="text-xs/relaxed text-muted-foreground">
            The button pauses for a second or two — longer on a phone. That is
            the key derivation running here. The wait is the work.
          </p>
        </form>
      </CardContent>

      <CardFooter className="text-xs text-muted-foreground">
        {signUp ? (
          <p>
            Already have an account?{" "}
            <Link
              href="/sign-in"
              className="text-foreground underline underline-offset-4 hover:text-primary"
            >
              Sign in
            </Link>
          </p>
        ) : (
          <div className="space-y-1">
            <p>
              No account yet?{" "}
              <Link
                href="/sign-up"
                className="text-foreground underline underline-offset-4 hover:text-primary"
              >
                Create one
              </Link>
            </p>
            {/* Only offered on sign-in, and worded as what it is. There is no
                password reset to link to instead: a recovery code is the only
                construction that gets someone back into a vault we cannot
                open, and it only exists if they enrolled one in advance. */}
            <p>
              Forgotten your password?{" "}
              <Link
                href="/recover"
                className="text-foreground underline underline-offset-4 hover:text-primary"
              >
                Use a recovery code
              </Link>
            </p>
          </div>
        )}
      </CardFooter>
    </Card>
  );
}

/**
 * The second-factor step of a password sign-in.
 *
 * A separate card rather than a section of the form, because at this point the
 * email and password fields are answered and re-rendering them invites somebody
 * to edit one and press the wrong button. The password has already done its work
 * — including, importantly, deriving the vault key, which the parent is holding.
 *
 * The note at the bottom is the one that matters and it is not decoration. Users
 * read a second factor as protecting everything. Here it protects the session
 * and nothing else: whoever has the password has the key, because the key is
 * Argon2id of the password and is computed on the device before this challenge
 * is even reached. Saying so is the difference between a security feature and
 * the appearance of one.
 */
function TwoFactorChallenge({
  busy,
  code,
  error,
  factor,
  methods,
  onCodeChange,
  onFactorChange,
  onSubmit,
}: {
  busy: boolean;
  code: string;
  error: string | null;
  factor: "totp" | "backup-code";
  /** What the server said it will accept. Empty means it did not say. */
  methods: string[];
  onCodeChange: (value: string) => void;
  onFactorChange: (value: "totp" | "backup-code") => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const backup = factor === "backup-code";

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LockKeyIcon className="size-4 text-primary" />
          Enter your second factor
        </CardTitle>
        <CardDescription>
          Your password was accepted. This account also asks for a code from an
          authenticator app before a session is created.
          {methods.length > 0 && !methods.includes("totp") && (
            <>
              {" "}
              The server offered: {methods.join(", ")}.
            </>
          )}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="two-factor-code">
              {backup ? "Backup code" : "Six-digit code"}
            </Label>
            <Input
              id="two-factor-code"
              name="code"
              // One-time-code lets a phone offer the code from the notification
              // it just received. It is the wrong hint for a backup code, which
              // is read off paper.
              autoComplete={backup ? "off" : "one-time-code"}
              inputMode={backup ? "text" : "numeric"}
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              value={code}
              onChange={(e) => onCodeChange(e.target.value)}
              disabled={busy}
              required
            />
            <p className="text-xs/relaxed text-muted-foreground">
              {backup
                ? "Each backup code works once. Using one here spends it."
                : "The code changes every thirty seconds. If it is refused twice, check the clock on the device generating it."}
            </p>
          </div>

          {error && (
            <Alert variant="destructive">
              <WarningCircleIcon weight="fill" />
              <AlertTitle>That code was not accepted</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" size="lg" disabled={busy || !code} className="w-full">
            {busy ? (
              <>
                <SpinnerGapIcon className="animate-spin" />
                Checking…
              </>
            ) : (
              "Verify and sign in"
            )}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={busy}
            onClick={() => onFactorChange(backup ? "totp" : "backup-code")}
          >
            {backup ? "Use a code from my authenticator" : "Use a backup code instead"}
          </Button>
        </form>
      </CardContent>

      <CardFooter className="text-xs/relaxed text-muted-foreground">
        <p>
          This step protects the session, not the vault. Your vault key was
          derived from the password you have just typed and never leaves this
          device, so two-factor authentication does not change who could decrypt
          a stolen copy of your data — only who can sign in.
        </p>
      </CardFooter>
    </Card>
  );
}
