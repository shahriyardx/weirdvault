"use client"

/**
 * The vault-password bootstrap: where a GitHub account gets a key.
 *
 * Signing in with GitHub produces a session and no secret. Every other route
 * into this app arrives carrying an HKDF branch of a password that was stretched
 * in the browser; this one arrives carrying proof of an identity at github.com
 * and nothing that could derive a vault key. The account is authenticated and
 * has no vault — it cannot encrypt a host, and there is no honest way to let it
 * discover that at the moment it first tries to save one.
 *
 * So the dashboard is closed until this page has been through. It is a Client
 * Component for the same reason the sign-in form is: Argon2id runs here, and
 * what leaves the tab is the auth branch only.
 *
 * It is also the landing page for *every* GitHub callback, not just the first
 * one. That is what makes it able to register the device on a browser that has
 * never typed a password here, and it means there is one place that decides
 * where an OAuth user goes rather than a redirect rule split between the server
 * and the callback URL.
 *
 * What it deliberately does not do: offer any way past. There is no "skip for
 * now", because an account with no vault password is not a working account in a
 * reduced way, it is an account that cannot store anything at all. A button
 * promising otherwise would be the lie this codebase is built not to tell.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  ArrowRightIcon,
  KeyIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/dist/ssr"

import { setVaultPasswordCredential } from "@/app/(auth)/actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { hasVaultPassword, registerDeviceAfterOAuth, useSession } from "@/lib/auth-client"
import { deriveSecrets } from "@/lib/vault/kdf"
import { setVaultKey } from "@/lib/vault/session"

/**
 * What this tab has worked out about the account it is signed into.
 *
 * "checking" covers both the session load and the accounts lookup, because to
 * the person waiting they are one pause and there is nothing useful to say
 * between them.
 */
type Gate = "checking" | "signed-out" | "needed" | "already-set"

const MIN_PASSWORD_LENGTH = 10

export default function SetVaultPasswordPage() {
  const router = useRouter()
  const { data: session, isPending } = useSession()

  /** null while the lookup is in flight; the answer once it lands. */
  const [credential, setCredential] = useState<boolean | null>(null)
  const [gateError, setGateError] = useState<string | null>(null)

  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Keyed on the user id rather than the session object: useSession hands back
  // a fresh object on every render, and depending on it would re-run the
  // lookup — and the device registration — on every keystroke in the form.
  const userId = session?.user.id

  /**
   * Ask the server which sign-in methods this account has.
   *
   * A credential row means somebody has already stretched a password for this
   * account, so this page has nothing to do and the user is sent on. Every
   * GitHub sign-in after the first lands here and leaves again through this
   * branch — which is also the moment the device gets registered, since the
   * OAuth callback is a full page navigation with none of our code in it.
   */
  useEffect(() => {
    if (isPending || !userId) return

    let cancelled = false
    void (async () => {
      try {
        const already = await hasVaultPassword()
        if (cancelled) return
        registerDeviceAfterOAuth()
        setCredential(already)
        if (already) router.replace("/dashboard")
      } catch (err) {
        if (cancelled) return
        // Not routed anywhere on failure. Sending a signed-in user to the
        // dashboard on a lookup error would be a guess in the direction that
        // breaks quietly; the layout guard would bounce them straight back and
        // the two would trade the user between them.
        setGateError(String((err as Error).message ?? err))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [isPending, userId, router])

  /**
   * Derived rather than stored, so there is one rule instead of a state machine
   * that an effect has to keep in step with what the session already says.
   */
  const gate: Gate = isPending
    ? "checking"
    : !userId
      ? "signed-out"
      : credential === null
        ? "checking"
        : credential
          ? "already-set"
          : "needed"

  const email = session?.user.email ?? ""
  const ready = password.length >= MIN_PASSWORD_LENGTH && confirm.length > 0 && password === confirm

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready || !email) return
    setBusy(true)
    setError(null)

    try {
      // The one place this account's key material comes into existence.
      // Argon2id runs in this tab; the vault and audit branches never leave it,
      // and the auth branch is the only thing the action below sends.
      const { authToken, vaultKey, auditKey } = await deriveSecrets(email, password)

      const result = await setVaultPasswordCredential(authToken)

      if (result.status === "error") {
        setError(result.message)
        return
      }

      if (result.status === "already-set") {
        // Somebody set one in another tab while this form was open. The keys
        // just derived may or may not be the ones that account uses, so they are
        // dropped rather than installed: an unlocked-looking vault holding the
        // wrong key would fail at the first decrypt, far from here.
        setError(
          "This account already has a vault password — it was set somewhere else while this page was open. " +
            "Nothing was changed here. Reload and unlock with that password.",
        )
        return
      }

      // Only now, and only in memory. lib/vault/session.ts keeps these for the
      // life of the tab and nowhere else, so a reload will ask for the password
      // again — the same as every other account.
      setVaultKey(vaultKey, auditKey)
      router.replace("/dashboard")
    } catch (err) {
      setError(String((err as Error).message ?? err))
    } finally {
      setBusy(false)
    }
  }

  /* ------------------------------------------------------------- the gate */

  if (gateError) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-base">Your account could not be checked</CardTitle>
          <CardDescription>
            We could not read which sign-in methods this account has, so this page does not know
            whether it has anything to do. Nothing was changed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <WarningCircleIcon weight="fill" />
            <AlertTitle>Lookup failed</AlertTitle>
            <AlertDescription>{gateError}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    )
  }

  if (gate === "checking" || gate === "already-set") {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <SpinnerGapIcon className="size-4 animate-spin text-primary" />
            {gate === "already-set" ? "Taking you to the dashboard" : "Checking your account"}
          </CardTitle>
          <CardDescription>
            {gate === "already-set"
              ? "This account already has a vault password, so there is nothing to set here."
              : "Working out whether this account has a vault password yet."}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (gate === "signed-out") {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-base">You are not signed in</CardTitle>
          <CardDescription>
            This page sets the vault password for an account that is already authenticated. There is
            no session in this tab, so there is nothing to set it on.
          </CardDescription>
        </CardHeader>
        <CardFooter className="text-xs text-muted-foreground">
          <p>
            <Link
              href="/sign-in"
              className="text-foreground underline underline-offset-4 hover:text-primary"
            >
              Sign in
            </Link>{" "}
            and you will be sent back here if this account still needs one.
          </p>
        </CardFooter>
      </Card>
    )
  }

  /* ------------------------------------------------------------- the form */

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyIcon className="size-4 text-primary" />
          Set your vault password
        </CardTitle>
        <CardDescription>
          GitHub has proved who you are. It has not given us anything that could decrypt your data —
          and neither has anything else, which is the point. Your hosts and keys are encrypted with
          a key derived from a password on your own device, so that key has to come from something
          we never see. This is that something.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* The two facts that decide whether somebody chooses a password they
            can reproduce. Stated before the field, not after it. */}
        <div className="space-y-2 rounded-md border border-border bg-card/40 p-3 text-xs/relaxed text-muted-foreground">
          <p>
            This is a second secret, and it is not your GitHub password. Signing in proves who you
            are; this derives the key that opens your vault. The two are separate on purpose: we
            hold a one-way branch of this one and could not open your vault with it if we were made
            to.
          </p>
          <p>
            We cannot reset it. There is no email link that would help, because there is nothing on
            our side to reset — losing it means the ciphertext stays closed for everyone, including
            us. Enrol recovery codes in Settings once you are in.
          </p>
          <p>
            Your key is tied to <span className="text-foreground">{email}</span>, the address GitHub
            gave us. Changing your primary email at GitHub later will not change it here, which is
            deliberate: the address is part of the derivation, and moving it would strand the vault.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="vault-password">Vault password</Label>
            <Input
              id="vault-password"
              name="password"
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              required
              minLength={MIN_PASSWORD_LENGTH}
              aria-describedby="vault-password-hint"
            />
            <p id="vault-password-hint" className="text-xs/relaxed text-muted-foreground">
              Ten characters or more. It is never stored anywhere, on your device or ours, so choose
              something you can reproduce exactly.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="vault-password-confirm">Confirm it</Label>
            <Input
              id="vault-password-confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
              required
            />
            {/* Confirmed here and nowhere else in the app, because this is the
                only form where a typo is unrecoverable rather than annoying:
                every other password field checks itself against a vault that
                already exists. */}
            {confirm.length > 0 && confirm !== password && (
              <p className="text-xs/relaxed text-destructive">The two do not match.</p>
            )}
          </div>

          {error && (
            <Alert variant="destructive">
              <WarningCircleIcon weight="fill" />
              <AlertTitle>The vault password was not set</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" size="lg" disabled={busy || !ready} className="w-full">
            {busy ? (
              <>
                <SpinnerGapIcon className="animate-spin" />
                Deriving keys…
              </>
            ) : (
              <>
                Set it and continue
                <ArrowRightIcon />
              </>
            )}
          </Button>

          <p className="text-xs/relaxed text-muted-foreground">
            The button pauses for a second or two — longer on a phone. That is the key derivation
            running here. The wait is the work.
          </p>
        </form>
      </CardContent>

      <CardFooter className="flex-col items-start gap-2 text-xs text-muted-foreground">
        <p>
          This password also becomes a second way in: email and password will work from now on,
          alongside GitHub.
        </p>
        <p>
          <Link href="/security" className="underline underline-offset-4 hover:text-foreground">
            How the key is derived, and what we store instead
          </Link>
        </p>
      </CardFooter>
    </Card>
  )
}
