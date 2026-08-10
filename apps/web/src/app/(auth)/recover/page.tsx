"use client"

/**
 * Signing in with a recovery code.
 *
 * A Client Component for the same reason the sign-in form is one: the code is
 * turned into a key here, in the browser, and the envelope is opened here. What
 * goes over the wire is an email and the hash of a code, and what comes back is
 * ciphertext. The server takes no part in the unwrapping and could not help if
 * it wanted to.
 *
 * The page ends by sending the user to change their password, and that is not a
 * suggestion dressed as a redirect. Until the password changes, the account is
 * still protected by a password nobody knows, the remaining codes are the only
 * way in, and each use spends one. The settings page is opened with ?rekey=1 so
 * it can say exactly that at the top of the form.
 *
 * For that redirect to lead anywhere, the secrets the envelope produced are put
 * into the in-memory vault session (setRecoveredSecrets) and not only the two
 * CryptoKeys. A password change needs the *old* auth token, which normally comes
 * from the old password — the one thing this user does not have. Carrying it
 * across the navigation is what turns the instruction on the settings page from
 * a dead end into a form that works. It is memory-only and dies with the tab.
 */

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ArrowRightIcon,
  LifebuoyIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/dist/ssr"

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
import { signInWithRecoveredToken } from "@/lib/auth-client"
import {
  formatRecoveryCode,
  isPlausibleRecoveryCode,
  normaliseRecoveryCode,
  redeemRecoveryCode,
  RecoveryCodeError,
} from "@/lib/vault/recovery"
import { setRecoveredSecrets, setVaultKey } from "@/lib/vault/session"



/**
 * Which step failed, because the two mean opposite things to the user.
 *
 * "code" is the expected miss: nothing opened, no code was spent, try another.
 * "after" is a failure that happened *after* the envelope decrypted — and an
 * envelope only decrypts if the code was genuine, which means the server already
 * consumed it (api/recovery/route.ts consumes on hand-out, deliberately). Under
 * the wrong heading that reads as "wrong code", so the user tries the next one
 * from their card and burns a second code for a problem that was never the
 * code's fault.
 */
type Failure = { step: "code" | "after"; message: string }

export default function RecoverPage() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)

  const ready = email.trim().length > 0 && isPlausibleRecoveryCode(code)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setFailure(null)

    // Order matters. The envelope is opened first, so a failure here happens
    // before any session exists — there is no state to unwind, and the code is
    // spent on the server either way.
    let secrets: Awaited<ReturnType<typeof redeemRecoveryCode>>
    try {
      secrets = await redeemRecoveryCode(email, code)
    } catch (err) {
      // RecoveryCodeError is the deliberate single answer to "wrong code",
      // "unknown account" and "already used". Anything else here is the server
      // or the network, and it is not the user's typing either — but in both
      // cases no envelope came back open, so nothing was spent by us.
      setFailure({
        step: "code",
        message:
          err instanceof RecoveryCodeError ? err.message : String((err as Error).message ?? err),
      })
      setBusy(false)
      return
    }

    try {
      await signInWithRecoveredToken(email.trim().toLowerCase(), secrets.authToken)
      setVaultKey(secrets.vaultKey, secrets.auditKey)
      setRecoveredSecrets(secrets)
      router.push("/dashboard/settings?tab=security&rekey=1")
    } catch (err) {
      setFailure({ step: "after", message: String((err as Error).message ?? err) })
      setBusy(false)
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LifebuoyIcon className="size-4 text-primary" />
          Use a recovery code
        </CardTitle>
        <CardDescription>
          A recovery code carries a sealed copy of your keys. It is opened in this tab, which both
          signs you in and unlocks the vault. The code itself is never sent to us — only a one-way
          hash of it, so we can find the right sealed copy and retire it.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="recover-email">Email</Label>
            <Input
              id="recover-email"
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
            <Label htmlFor="recover-code">Recovery code</Label>
            <Input
              id="recover-code"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              className="font-mono tracking-wider"
              value={code}
              // Re-grouped as it is typed, so a pasted code with different
              // spacing and a hand-typed one look identical. Dashes, spaces and
              // case carry no information; the confusable letters are folded
              // onto their digits, so O and 0 both work.
              onChange={(e) => setCode(formatRecoveryCode(normaliseRecoveryCode(e.target.value)))}
              disabled={busy}
              required
            />
            <p className="text-xs/relaxed text-muted-foreground">
              Twenty-four characters. Each code works once; your others stay valid until you change
              your password.
            </p>
          </div>

          {failure && (
            <Alert variant="destructive">
              <WarningCircleIcon weight="fill" />
              <AlertTitle>
                {failure.step === "code"
                  ? "That did not open anything"
                  : "Your code opened, but signing in failed"}
              </AlertTitle>
              <AlertDescription>
                {failure.step === "code" ? (
                  failure.message
                ) : (
                  <span>
                    {failure.message} That code has been spent — it was a real code, and codes are
                    retired the moment the sealed copy is handed out, so re-entering it will not
                    work. Try again with a different code from your set.
                  </span>
                )}
              </AlertDescription>
            </Alert>
          )}

          <Button type="submit" size="lg" disabled={busy || !ready} className="w-full">
            {busy ? (
              <>
                <SpinnerGapIcon className="animate-spin" />
                Opening the sealed copy…
              </>
            ) : (
              <>
                Recover my account
                <ArrowRightIcon />
              </>
            )}
          </Button>

          <p className="text-xs/relaxed text-muted-foreground">
            The pause is a key derivation running on this device, the same one that makes signing in
            take a second.
          </p>
        </form>
      </CardContent>

      <CardFooter className="flex-col items-start gap-2 text-xs text-muted-foreground">
        <p>
          Remembered it after all?{" "}
          <Link
            href="/sign-in"
            className="text-foreground underline underline-offset-4 hover:text-primary"
          >
            Sign in normally
          </Link>
        </p>
        <p>
          Without a code there is no way back in. We never held anything that could open your vault,
          so there is nothing for us to reset.{" "}
          <Link href="/security" className="underline underline-offset-4 hover:text-foreground">
            Why
          </Link>
        </p>
      </CardFooter>
    </Card>
  )
}
