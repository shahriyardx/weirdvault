"use client"

/**
 * Account settings.
 *
 * A Client Component: it reads the session through a hook, owns the state of
 * three forms, and does file work (export, import) that only exists in a
 * browser.
 *
 * Honesty rule for this page: a control is either wired to something real or it
 * is visibly marked as not implemented and disabled. Nothing here reports
 * success it did not achieve.
 *
 *   Wired:      sign out, sign out everywhere, change the password (which
 *               re-encrypts the vault — see lib/vault/rekey.ts), recovery codes,
 *               passkeys (register, rename, remove), export the encrypted vault,
 *               restore an exported vault by merging it, delete the account, the
 *               relay transfer meter, which reads the same row /api/relay-token
 *               consults before it refuses to mint, and the billing card, which
 *               reads the same subscription row every gate in the app reads and
 *               hands the user to Stripe for anything that touches a card.
 *   Gated off:  TOTP enrolment, when the deployment's `two_factor` table is
 *               missing columns the installed Better Auth writes. The card says
 *               which ones and why there is no button, rather than offering one
 *               that answers 500 — see TwoFactorSection.
 *   Not wired:  editing the display name, which is cosmetic and says so.
 *
 * The security tab is grouped by what each control protects — the account, or
 * the vault — because the most common and most damaging misreading in this whole
 * product is that a second factor guards the data. It does not, and the grouping
 * is the first thing that says so.
 *
 * The controls that can destroy an account all state their consequences before
 * the button rather than in a toast afterwards.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  ArrowsDownUpIcon,
  ArrowsMergeIcon,
  CheckCircleIcon,
  CreditCardIcon,
  ClockCounterClockwiseIcon,
  CloudCheckIcon,
  CopyIcon,
  DatabaseIcon,
  DeviceMobileIcon,
  DownloadSimpleIcon,
  FingerprintSimpleIcon,
  IdentificationCardIcon,
  InfoIcon,
  KeyIcon,
  LifebuoyIcon,
  LockKeyIcon,
  PasswordIcon,
  PencilSimpleIcon,
  PlusIcon,
  ShieldCheckIcon,
  SignOutIcon,
  SparkleIcon,
  SpinnerGapIcon,
  TrashIcon,
  UploadSimpleIcon,
  UserIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { PageHeader } from "@/components/shell/page-shell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { totpAvailability, type TotpAvailability } from "@/app/dashboard/settings/actions"
import {
  addPasskey,
  authClient,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  deleteAccountWithVault,
  disableTotp,
  listPasskeys,
  PasskeyCancelledError,
  reissueBackupCodes,
  removePasskey,
  renamePasskey,
  signOut,
  useSession,
  type PasskeySummary,
  type TotpEnrolment,
} from "@/lib/auth-client"
import { encodeQr } from "@/lib/qr"
import {
  BillingActionError,
  loadBilling,
  openPortal,
  startCheckout,
  useBilling,
} from "@/lib/billing/client"
import { idbClear } from "@/lib/idb"
import { MAX_ACCOUNT_RECORDING_BYTES } from "@/lib/recording/limits"
import {
  bytesRemaining,
  fetchRelayUsage,
  formatBytes,
  usagePercent,
  usageState,
  type RelayUsage,
} from "@/lib/usage"
import type { VaultEnvelope } from "@/lib/vault/crypto"
import {
  disableRecoveryCodes,
  enrolRecoveryCodes,
  formatRecoveryCode,
  getRecoveryStatus,
  RECOVERY_CODE_COUNT,
  RecoveryLockedError,
  type EnrolmentProgress,
  type RecoveryStatus,
} from "@/lib/vault/recovery"
import {
  changePasswordAndRekey,
  rekeyAfterRecovery,
  RekeyStrandedError,
  type RekeyProgress,
  type RekeyResult,
  type RekeyStage,
} from "@/lib/vault/rekey"
import {
  restoreVault,
  VaultDecryptionError,
  VaultFormatError,
  type RestoreCount,
  type RestoreResult,
} from "@/lib/vault/restore"
import {
  getRecoveredSecrets,
  getVaultKey,
  lock,
  requestUnlock,
  useRecoveredSecrets,
  useVaultUnlocked,
} from "@/lib/vault/session"

export default function SettingsPage() {
  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Your account, your vault password, and your data."
      />

      {/* The tabs read the query string, which makes them dynamic: the recovery
          flow lands on ?tab=security&rekey=1 and the right tab has to be open on
          the first paint, not after an effect. useSearchParams pushes the client
          tree up to the nearest boundary into client rendering, so the boundary
          is put here rather than around the whole route — the header above stays
          prerendered. */}
      <Suspense fallback={<Skeleton className="mt-6 h-[32rem] w-full" />}>
        <SettingsTabs />
      </Suspense>
    </div>
  )
}

function SettingsTabs() {
  const { data: session, isPending } = useSession()
  const user = session?.user

  const params = useSearchParams()
  const requested = params.get("tab")
  const [tab, setTab] = useState(
    requested === "security" || requested === "data" ? requested : "account",
  )
  const afterRecovery = params.get("rekey") === "1"

  // A password change deletes the recovery envelopes server-side, so the count
  // rendered by the sibling section below becomes a false statement the moment
  // the change lands. Bumping this makes it re-read rather than keep claiming
  // codes that no longer exist.
  const [rekeyedAt, setRekeyedAt] = useState(0)

  return (
    <Tabs value={tab} onValueChange={setTab} className="mt-6 gap-6">
      <TabsList className="w-full sm:w-auto">
        <TabsTrigger value="account">
          <UserIcon data-icon="inline-start" />
          Account
        </TabsTrigger>
        <TabsTrigger value="security">
          <LockKeyIcon data-icon="inline-start" />
          Security
        </TabsTrigger>
        <TabsTrigger value="data">
          <DatabaseIcon data-icon="inline-start" />
          Data
        </TabsTrigger>
      </TabsList>

      <TabsContent value="account" className="space-y-6">
        <AccountSection
          name={user?.name ?? null}
          email={user?.email ?? null}
          createdAt={user?.createdAt ?? null}
          loading={isPending}
        />
        <BillingSection />
        <RelayTransferSection />
      </TabsContent>

      {/*
          Grouped by what each control protects, because that grouping is the
          clearest way to state the thing users most often get wrong: a second
          factor guards the account and the session, and does nothing whatever
          for the ciphertext. Putting "sign in with a passkey" in the same list
          as "change the password that derives your vault key" invites exactly
          the wrong inference, and a paragraph further down the page would not
          undo it.
        */}
      <TabsContent value="security" className="space-y-6">
        <SecurityGroup
          title="Your account"
          summary="Who can sign in as you. None of these encrypt anything."
        />
        <TwoFactorSection email={user?.email ?? null} enabled={user?.twoFactorEnabled ?? false} />
        <PasskeysSection />
        <SessionsSection />

        <SecurityGroup
          title="Your vault"
          summary="What can decrypt your hosts, keys and snippets. Irreversible."
        />
        <ChangePasswordSection
          email={user?.email ?? null}
          afterRecovery={afterRecovery}
          onRekeyed={() => setRekeyedAt(Date.now())}
        />
        <RecoveryCodesSection email={user?.email ?? null} reloadOn={rekeyedAt} />
      </TabsContent>

      <TabsContent value="data" className="space-y-6">
        <ExportSection />
        <ImportSection />
        <DeleteAccountSection email={user?.email ?? null} />
      </TabsContent>
    </Tabs>
  )
}

/* -------------------------------------------------------------- account tab */

function AccountSection({
  name,
  email,
  createdAt,
  loading,
}: {
  name: string | null
  email: string | null
  createdAt: Date | string | null
  loading: boolean
}) {
  const display = name?.trim() || email || "No session"

  return (
    <>
      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle className="flex items-center gap-2">
            <IdentificationCardIcon className="size-4 text-primary" />
            Profile
          </CardTitle>
          <CardDescription>Your name and email.</CardDescription>
        </CardHeader>

        <CardContent>
          {loading ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-10 w-48" />
              <Skeleton className="h-3 w-64" />
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="flex items-center gap-3">
                <Avatar className="size-10 rounded-sm">
                  <AvatarFallback className="rounded-sm bg-secondary text-xs">
                    {initials(display)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="truncate font-heading text-sm font-medium">{display}</p>
                  <p className="truncate text-muted-foreground">
                    {email ?? "No session on this device"}
                  </p>
                </div>
              </div>

              <dl className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
                <Field label="Display name" value={name?.trim() || "Not set"} />
                <Field label="Email address" value={email ?? "unknown"} />
                <Field
                  label="Account created"
                  value={createdAt ? formatDate(createdAt) : "unknown"}
                />
                {/* The plan used to be a fourth field here, reading "Free (no
                    billing configured)" because that was true of everybody. It
                    is a card of its own now: a plan has a status, a renewal date
                    and two buttons behind it, and none of that fits in a
                    definition list. One place states it, so there is nothing to
                    keep in step. */}
              </dl>
            </div>
          )}
        </CardContent>

        <CardFooter>
          <NotImplemented>Editing the display name is not wired up yet.</NotImplemented>
        </CardFooter>
      </Card>

      {/* Kept, unlike the rest of the prose that used to surround it. It is not
          a description of a control — it is the answer to "why can I not change
          my email", which is otherwise unguessable. */}
      <Alert>
        <InfoIcon className="text-primary" />
        <AlertTitle>Your email cannot be changed</AlertTitle>
        <AlertDescription>
          <span>
            It is the salt your vault key is derived from. Changing it would mean re-encrypting the
            whole vault.
          </span>
        </AlertDescription>
      </Alert>
    </>
  )
}

/* -------------------------------------------------------------- billing */

/**
 * The plan, and the two buttons that hand the user to Stripe.
 *
 * Real, and this card is the reason the honesty rule is written down. Nothing
 * here is decided in the browser: the tier, the status, the renewal date and
 * whether this deployment can sell anything at all come from
 * /api/billing/subscription, which reads the same subscription row that every
 * gate in the app reads. A card that resolved a plan locally would sooner or
 * later show a window or an allowance the server does not enforce, and the
 * person reading it would have no way to tell.
 *
 * Four states, and each gets different words rather than one paragraph hedged to
 * cover all of them:
 *
 *  - Not configured on this deployment. No Stripe key or no price, so nothing
 *    can be bought here and no upgrade button is offered. That is a self-hosted
 *    install working as intended, not a fault, and the copy says so. The portal
 *    button is not part of that branch: it needs a customer, not a price, and an
 *    existing subscriber must never lose the route to cancelling because an
 *    operator cleared a variable that only checkout reads.
 *  - Free. What Pro would add, and a button that starts a checkout.
 *  - Pro. What renews and when, and a link to Stripe's portal for anything that
 *    touches a card.
 *  - Could not be read. The tier shown is the fail-toward-access assumption
 *    rather than a fact, and the card says which — "we could not check, so we
 *    are assuming Pro" is a different statement from "you are on Pro" and only
 *    one of them should be made without evidence.
 *
 * Neither button changes anything on its own. Both ask the server for a URL and
 * navigate; the subscription changes when Stripe says so, through the webhook.
 * That is why returning from either one shows a note about the mirror possibly
 * not having caught up rather than a congratulations or a confirmation — a
 * query string is not evidence of anything, and both returns get the same note
 * so the lag is not disclosed only when it happens to flatter us.
 */
function BillingSection() {
  const { billing, loading, error } = useBilling()
  const params = useSearchParams()
  const justCheckedOut = params.get("checkout") === "complete"
  const justReturnedFromPortal = params.get("portal") === "returned"
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null)

  // Returning from Stripe lands on this page with the same module cache the tab
  // left with, which would show the old plan. A forced re-read is the least this
  // can do; the webhook may still be in flight, which the notes below say.
  //
  // Both directions get the note, and that symmetry is the point. Returning from
  // a checkout that has not been mirrored yet shows Free to somebody who has
  // paid; returning from a cancellation that has not been mirrored yet shows
  // "Renews" to somebody who has cancelled. Warning about the first and not the
  // second would mean disclosing the lag only when it flatters us.
  useEffect(() => {
    if (justCheckedOut || justReturnedFromPortal) void loadBilling(true)
  }, [justCheckedOut, justReturnedFromPortal])

  async function go(action: "checkout" | "portal") {
    setBusy(action)
    try {
      const url = action === "checkout" ? await startCheckout() : await openPortal()
      // A full navigation rather than a router push: the destination is
      // stripe.com, which the Next router cannot route to.
      window.location.assign(url)
    } catch (e) {
      const kind = e instanceof BillingActionError ? e.kind : "failed"
      toast.error(
        kind === "not-configured"
          ? "Billing is not configured on this deployment"
          : action === "checkout"
            ? "Checkout did not start"
            : "The billing portal did not open",
        { description: message(e) },
      )
      setBusy(null)
    }
  }

  const pro = billing?.tier === "pro"

  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <CreditCardIcon className="size-4 text-primary" />
          Plan and billing
        </CardTitle>
        <CardDescription>Cards, invoices and cancellation are handled by Stripe.</CardDescription>
        <CardAction className="flex items-center gap-2">
          {billing ? (
            <Badge variant="outline" className={pro ? "text-success" : undefined}>
              {billing.label}
            </Badge>
          ) : error ? null : (
            <Skeleton className="h-5 w-14" />
          )}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void loadBilling(true)}
            disabled={loading}
          >
            <ArrowsClockwiseIcon
              data-icon="inline-start"
              className={loading ? "animate-spin" : undefined}
            />
            Refresh
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && !billing ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>Could not read your plan</AlertTitle>
            <AlertDescription>
              <span>{error} Your subscription is unaffected; only this read failed.</span>
            </AlertDescription>
          </Alert>
        ) : !billing ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-3 w-64" />
            <Skeleton className="h-8 w-40" />
          </div>
        ) : (
          <>
            {billing.degraded && (
              <Alert variant="destructive">
                <WarningCircleIcon />
                <AlertTitle>This is an assumption, not a lookup</AlertTitle>
                <AlertDescription>
                  <span>
                    Your plan could not be read, so Pro was granted rather than refused. It will
                    correct itself shortly.
                  </span>
                </AlertDescription>
              </Alert>
            )}

            {justCheckedOut && !pro && !billing.degraded && (
              <Alert>
                <InfoIcon className="text-primary" />
                <AlertTitle>
                  You came back from checkout; this account still shows {billing.label}
                </AlertTitle>
                <AlertDescription>
                  <span>
                    Stripe confirms payments to us separately, usually within seconds. Refresh above
                    in a moment.
                  </span>
                </AlertDescription>
              </Alert>
            )}

            {justReturnedFromPortal && (
              <Alert>
                <InfoIcon className="text-primary" />
                <AlertTitle>Changes may take a moment to appear</AlertTitle>
                <AlertDescription>
                  <span>Refresh above if the details below still look stale.</span>
                </AlertDescription>
              </Alert>
            )}

            <dl className="grid gap-3 sm:grid-cols-3">
              <Field label="Plan" value={billing.label} />
              <Field label="Subscription" value={statusWords(billing.status)} />
              <Field
                label={billing.cancelAtPeriodEnd ? "Access ends" : "Renews"}
                value={
                  billing.currentPeriodEnd
                    ? formatDate(billing.currentPeriodEnd)
                    : pro
                      ? "not stated"
                      : "—"
                }
              />
            </dl>

            <p className="flex items-start gap-2 text-muted-foreground">
              <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <span className="min-w-0">
                {formatBytes(billing.limits.relayAllowanceBytes)} relay transfer a month ·{" "}
                {billing.limits.auditRetentionLabel} of activity history · session recording{" "}
                {billing.limits.sessionRecording ? "on" : "off"} ·{" "}
                <Link href="/pricing" className="underline underline-offset-2">
                  compare plans
                </Link>
              </span>
            </p>

            {billing.cancelAtPeriodEnd && billing.currentPeriodEnd && (
              <Alert>
                <WarningCircleIcon className="text-warning" />
                <AlertTitle>This subscription is set to end</AlertTitle>
                <AlertDescription>
                  <span>
                    Pro stops on {formatDate(billing.currentPeriodEnd)}. New recordings stop and
                    activity history shortens to the Free window, deleting older events; recordings
                    you already have stay. Undo it in the billing portal.
                  </span>
                </AlertDescription>
              </Alert>
            )}

            {!billing.billingConfigured && (
              <Alert>
                <InfoIcon className="text-primary" />
                <AlertTitle>Nothing can be bought on this deployment</AlertTitle>
                <AlertDescription>
                  {/* Operator-facing, so it keeps its variable names — this is
                      the one audience that cannot guess what to do next. */}
                  <span>
                    No payment provider is configured. The operator sets{" "}
                    <code className="font-mono">STRIPE_SECRET_KEY</code> and{" "}
                    <code className="font-mono">STRIPE_PRICE_PRO</code>; see apps/web/README.md.
                  </span>
                </AlertDescription>
              </Alert>
            )}

            {/*
              Two conditions, deliberately not one. Selling needs a key and a
              price; the portal needs only a customer, and the route that opens
              it reads neither the price nor the webhook secret. Nesting the
              portal button inside the "configured" branch meant that clearing
              STRIPE_PRICE_PRO — an ordinary step while repricing — took the
              cancellation path away from every existing subscriber while
              telling them there was no payment provider at all.
            */}
            {(billing.billingConfigured || billing.hasCustomer) && (
              <div className="flex flex-wrap items-center gap-2">
                {billing.billingConfigured && !pro && (
                  <Button onClick={() => void go("checkout")} disabled={busy !== null}>
                    {busy === "checkout" ? (
                      <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <SparkleIcon data-icon="inline-start" weight="fill" />
                    )}
                    Upgrade to Pro — {billing.price.label} {billing.price.unit}
                  </Button>
                )}
                {billing.hasCustomer && (
                  <Button
                    variant="outline"
                    onClick={() => void go("portal")}
                    disabled={busy !== null}
                  >
                    {busy === "portal" ? (
                      <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <ArrowSquareOutIcon data-icon="inline-start" />
                    )}
                    Manage billing at Stripe
                  </Button>
                )}
                <span className="text-muted-foreground">
                  {pro
                    ? "Invoices, payment method and cancellation are all in the portal."
                    : "Card details are entered on Stripe, never here."}
                </span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Stripe's status string in words.
 *
 * Translated rather than shown raw because `past_due` is a state somebody has to
 * act on and "past_due" is not a sentence. Every phrase says what is true of
 * access, not just of the payment, because that is the question being asked. An
 * unrecognised status is passed through as-is: a made-up phrase for a state this
 * build has never seen would be worse than an unfamiliar word.
 */
function statusWords(status: string | null): string {
  switch (status) {
    case null:
      return "None"
    case "none":
      return "None"
    case "active":
      return "Active"
    case "trialing":
      return "Trial"
    case "past_due":
      return "Payment failed, retrying"
    case "unpaid":
      return "Unpaid, retrying"
    case "canceled":
      return "Cancelled"
    case "incomplete":
      return "Checkout not finished"
    case "incomplete_expired":
      return "Checkout expired"
    case "paused":
      return "Paused"
    default:
      return status
  }
}

/**
 * The transfer meter.
 *
 * Real: it reads relay_usage, which is the table the relay reports into and the
 * table /api/relay-token reads before it decides whether to mint. There is no
 * second number and no estimate — what this shows is what the refusal will be
 * based on.
 *
 * It is on the Account tab because it is a property of the account rather than
 * of the data or of the vault's security, and because the plan it derives from
 * is stated three lines above it.
 *
 * A failure to read shows the failure. Rendering zero when the request did not
 * come back would be reassurance invented on no evidence, and this is precisely
 * the number somebody checks when connections have started being refused.
 *
 * Nothing polls. The card reads once and then says when it read, with a button
 * to read again — it used to fetch on mount and never again, which meant a tab
 * left open all afternoon presented a morning's figure under a sentence
 * promising a lag of about a minute. Two timestamps are on screen for that
 * reason and they are not the same fact: "last reported" is the relay's, "read"
 * is this page's, and a stale card is a different problem from a silent relay.
 * An interval was the alternative and was not worth it — this number moves over
 * a month, and a request every thirty seconds from every open dashboard is a
 * cost paid on every account to save one click on a few.
 */
function RelayTransferSection() {
  const [usage, setUsage] = useState<RelayUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [readAt, setReadAt] = useState<number | null>(null)
  const [reading, setReading] = useState(false)

  const load = useCallback(async () => {
    setReading(true)
    try {
      const next = await fetchRelayUsage()
      setUsage(next)
      setError(null)
    } catch (e) {
      setError(message(e))
    } finally {
      setReadAt(Date.now())
      setReading(false)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      await load()
    })()
  }, [load])

  const state = usage ? usageState(usage) : "ok"

  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <ArrowsDownUpIcon className="size-4 text-primary" />
          Relay transfer this month
        </CardTitle>
        <CardDescription>
          Everything the relay carries for you, in both directions. Recordings have a separate{" "}
          {formatBytes(MAX_ACCOUNT_RECORDING_BYTES)} ceiling, shown on the{" "}
          <Link href="/dashboard/recordings" className="underline underline-offset-2">
            Recordings page
          </Link>
          .
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          {usage ? (
            <Badge variant="outline">{usage.tier}</Badge>
          ) : error ? null : (
            <Skeleton className="h-5 w-14" />
          )}
          <Button variant="ghost" size="xs" onClick={() => void load()} disabled={reading}>
            <ArrowsClockwiseIcon
              data-icon="inline-start"
              className={reading ? "animate-spin" : undefined}
            />
            Refresh
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>Could not read your transfer usage</AlertTitle>
            <AlertDescription>
              {/* No zero on failure: a meter reading empty because a request
                  failed is worse than no meter at all. */}
              <span>{error} Your allowance is unaffected.</span>
              <Button
                variant="outline"
                size="sm"
                className="mt-1"
                onClick={() => void load()}
                disabled={reading}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : !usage ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-3 w-72" />
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-heading text-sm font-medium tabular-nums">
                  {formatBytes(usage.bytesTotal)} of {formatBytes(usage.allowanceBytes)}
                </p>
                <p
                  className={
                    state === "over"
                      ? "text-destructive"
                      : state === "approaching"
                        ? "text-warning"
                        : "text-muted-foreground"
                  }
                >
                  {state === "over"
                    ? "Allowance used up"
                    : `${formatBytes(bytesRemaining(usage))} left`}
                </p>
              </div>
              <Progress value={usagePercent(usage)} />
              <dl className="grid gap-3 pt-1 sm:grid-cols-3">
                <Field label="Sent" value={formatBytes(usage.bytesUp)} />
                <Field label="Received" value={formatBytes(usage.bytesDown)} />
                <Field label="Resets" value={`${formatUtcDate(usage.resetsAt)}, 00:00 UTC`} />
              </dl>
            </div>

            {state === "over" && (
              <Alert variant="destructive">
                <WarningCircleIcon />
                <AlertTitle>New connections through the relay are refused</AlertTitle>
                <AlertDescription>
                  <span>
                    Open sessions keep running. New ones fail until {formatUtcDate(usage.resetsAt)}.
                    Running your own relay removes the limit.
                  </span>
                </AlertDescription>
              </Alert>
            )}

            {state === "approaching" && (
              <Alert>
                <WarningCircleIcon className="text-warning" />
                <AlertTitle>
                  {usagePercent(usage)}% of this month&apos;s allowance is gone
                </AlertTitle>
                <AlertDescription>
                  <span>
                    At the limit, new connections are refused until {formatUtcDate(usage.resetsAt)}.
                  </span>
                </AlertDescription>
              </Alert>
            )}

            {!usage.reportingConfigured ? (
              <Alert variant="destructive">
                <WarningCircleIcon />
                <AlertTitle>Nothing is counting on this deployment</AlertTitle>
                <AlertDescription>
                  {/* Operator-facing. The figures above are structurally zero
                      rather than genuinely small, and that difference has to be
                      visible or the meter lies quietly. */}
                  <span>
                    Usage reporting is not configured, so the figures above are always zero. Set{" "}
                    <code className="font-mono">RELAY_USAGE_SECRET</code> and{" "}
                    <code className="font-mono">RELAY_USAGE_URL</code>; see apps/relay/README.md.
                  </span>
                </AlertDescription>
              </Alert>
            ) : (
              <p className="flex items-start gap-2 text-muted-foreground">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span className="min-w-0">
                  {usage.updatedAt
                    ? `Last reported ${formatDateTime(usage.updatedAt)}, `
                    : "No relay has reported traffic for this account this month, "}
                  {readAt === null ? "read just now. " : `read at ${formatClock(readAt)}. `}
                  Counts arrive about once a minute, so a session in progress may not be included
                  yet.
                </span>
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-foreground">{value}</dd>
    </div>
  )
}

/* ------------------------------------------------------------- security tab */

/**
 * A heading that says what the cards under it protect.
 *
 * The whole reason this tab is grouped rather than listed. It is not a visual
 * device: users assume a second factor covers everything, and the only place
 * that assumption can be corrected before it does harm is at the point where
 * they are choosing between controls.
 */
function SecurityGroup({ title, summary }: { title: string; summary: string }) {
  return (
    <div className="space-y-1 pt-2 first:pt-0">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <p className="max-w-prose text-muted-foreground">{summary}</p>
    </div>
  )
}

/** Matches sign-up. The server's own minimum is on the derived token, not this. */
const MIN_PASSWORD_LENGTH = 10

/**
 * TOTP, and the sentence that has to be on this card.
 *
 * Real, in the sense the honesty rule means it: the enrolment goes through
 * Better Auth's two-factor endpoints, nothing is switched on until a code the
 * authenticator generated has been checked by the server, and turning it off
 * re-derives and sends the auth token, so it is a genuine re-authentication.
 *
 * It is also gated. The `two_factor` table this deployment migrated is missing
 * three columns the installed plugin writes (see totpStorageReady in
 * lib/auth.ts), and on a deployment where that is true the enrolment endpoint
 * answers 500. So the card renders disabled and says which columns are missing,
 * rather than offering a button whose failure would look like a bug in the
 * authenticator app.
 *
 * The scope note is not decoration and is not moveable to a comment. Two-factor
 * authentication is the single most over-read control in any product: people
 * believe it protects their data. Here it demonstrably does not — the vault key
 * is Argon2id over the password, computed in the browser, and anybody holding
 * the password can decrypt a stolen vault blob offline with no server, no
 * session and no second factor anywhere in the picture.
 */
function TwoFactorSection({ email, enabled }: { email: string | null; enabled: boolean }) {
  const [availability, setAvailability] = useState<TotpAvailability | null>(null)
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<"begin" | "confirm" | "disable" | "reissue" | null>(null)

  useEffect(() => {
    let cancelled = false
    void totpAvailability()
      .then((a) => {
        if (!cancelled) setAvailability(a)
      })
      // A lookup that failed is not a lookup that said yes. Leaving this null
      // keeps the controls hidden, which is the safe direction.
      .catch(() => {
        if (!cancelled) setAvailability({ ready: false, missing: [] })
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function begin(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) return
    setBusy("begin")
    try {
      setEnrolment(await beginTotpEnrolment(email, password))
      setPassword("")
      setCode("")
    } catch (err) {
      toast.error("Two-factor was not set up", { description: message(err) })
    } finally {
      setBusy(null)
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault()
    if (!enrolment || !code) return
    setBusy("confirm")
    try {
      await confirmTotpEnrolment(code)
      // Only now are the backup codes worth showing: before this the enrolment
      // could still have been abandoned, and a saved list for a factor that was
      // never enabled is a list somebody will trust later for nothing.
      setCodes(enrolment.backupCodes)
      setEnrolment(null)
      setCode("")
      toast.success("Authenticator app enabled", {
        description: "It will be asked for the next time you sign in with your password.",
      })
    } catch (err) {
      toast.error("That code was not accepted", { description: message(err) })
    } finally {
      setBusy(null)
    }
  }

  async function turnOff() {
    if (!email || !password) return
    setBusy("disable")
    try {
      await disableTotp(email, password)
      setPassword("")
      setCodes(null)
      toast.success("Authenticator app removed", {
        description: "Your password alone signs you in again, and the backup codes are gone.",
      })
    } catch (err) {
      toast.error("Two-factor was not turned off", { description: message(err) })
    } finally {
      setBusy(null)
    }
  }

  async function reissue(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) return
    setBusy("reissue")
    try {
      setCodes(await reissueBackupCodes(email, password))
      setPassword("")
    } catch (err) {
      toast.error("The backup codes were not replaced", { description: message(err) })
    } finally {
      setBusy(null)
    }
  }

  const blocked = availability !== null && !availability.ready

  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <DeviceMobileIcon className="size-4 text-primary" />
          Authenticator app
        </CardTitle>
        <CardDescription>
          A six-digit code from your phone, asked for after your password.
        </CardDescription>
        <CardAction>
          {availability === null ? (
            <Skeleton className="h-5 w-16" />
          ) : enabled ? (
            <Badge variant="outline" className="text-success">
              On
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              Off
            </Badge>
          )}
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* The "protects your account, not your data" alert that used to sit
            here is now one line in the group heading above. What survives is
            only what a user cannot find out any other way, and would otherwise
            discover at the worst possible moment. */}
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>Two things it does not cover</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              <li>Passkey and GitHub sign-ins are never asked for a code.</li>
              <li>
                Recovery codes stop working while this is on. Keep the backup codes below somewhere
                safe.
              </li>
            </ul>
          </AlertDescription>
        </Alert>

        {blocked ? (
          <NotImplemented>
            Enrolment is turned off on this deployment. The <code>two_factor</code> table is missing{" "}
            {availability.missing.length > 0
              ? `the ${availability.missing.join(", ")} ${availability.missing.length === 1 ? "column" : "columns"}`
              : "columns"}{" "}
            that the installed version of Better Auth writes. This needs a migration from whoever
            runs the database.
          </NotImplemented>
        ) : codes ? (
          <GeneratedCodes
            codes={codes}
            format={(c) => c}
            filename={`webxterm-backup-codes-${new Date().toISOString().slice(0, 10)}.txt`}
            fileTitle="webxterm two-factor backup codes"
            fileNote="Each code works once, in place of a code from your authenticator app. Anyone holding one can complete a sign-in that has already got past your password."
            warning="Shown once. Save them before you leave this page."
            onAcknowledge={() => setCodes(null)}
          />
        ) : enrolment ? (
          <TotpEnrolmentPanel
            busy={busy === "confirm"}
            code={code}
            enrolment={enrolment}
            onCancel={() => {
              setEnrolment(null)
              setCode("")
            }}
            onCodeChange={setCode}
            onSubmit={confirm}
          />
        ) : availability === null ? (
          <Skeleton className="h-24 w-full max-w-sm" />
        ) : enabled ? (
          <form className="grid max-w-sm gap-3" onSubmit={(e) => void reissue(e)}>
            <div className="space-y-1.5">
              <Label htmlFor="totp-password">Confirm your password</Label>
              <Input
                id="totp-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy !== null || !email}
              />
              <p className="text-muted-foreground">Needed for both buttons below.</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="outline" disabled={busy !== null || !password}>
                {busy === "reissue" ? (
                  <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <ArrowsClockwiseIcon data-icon="inline-start" />
                )}
                Replace backup codes
              </Button>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" disabled={busy !== null || !password}>
                    {busy === "disable" ? (
                      <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <TrashIcon data-icon="inline-start" />
                    )}
                    Turn off
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Turn off the authenticator app?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Your password alone will sign you in again. Backup codes are deleted and
                      setting this up again means scanning a new code.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep it on</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={(e) => {
                        e.preventDefault()
                        void turnOff()
                      }}
                    >
                      Turn it off
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </form>
        ) : (
          <form className="grid max-w-sm gap-3" onSubmit={(e) => void begin(e)}>
            <div className="space-y-1.5">
              <Label htmlFor="totp-password">Confirm your password</Label>
              <Input
                id="totp-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy !== null || !email}
              />
              <p className="text-muted-foreground">
                Nothing is switched on until you have entered a code from your app.
              </p>
            </div>

            <Button type="submit" className="w-fit" disabled={busy !== null || !email || !password}>
              {busy === "begin" ? (
                <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
              ) : (
                <ShieldCheckIcon data-icon="inline-start" />
              )}
              Set up an authenticator app
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * The enrolment step: a code to scan, the same secret as text, and the
 * verification that is the only thing that turns the factor on.
 *
 * The manual secret is not a fallback for a broken QR code, it is the primary
 * route for anyone whose authenticator lives on the machine they are reading
 * this on — and it is the same string the QR encodes, pulled out of the URI
 * rather than fetched separately, so the two cannot disagree.
 */
function TotpEnrolmentPanel({
  busy,
  code,
  enrolment,
  onCancel,
  onCodeChange,
  onSubmit,
}: {
  busy: boolean
  code: string
  enrolment: TotpEnrolment
  onCancel: () => void
  onCodeChange: (value: string) => void
  onSubmit: (e: React.FormEvent) => void
}) {
  return (
    <div className="space-y-4 border border-border bg-card p-3">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <TotpQrCode value={enrolment.totpURI} />

        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-muted-foreground">
            Scan this with your authenticator app, or type the secret in by hand if the app is on
            this machine.
          </p>
          <div>
            <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              Secret
            </p>
            <p className="bg-terminal mt-1 border border-border px-3 py-2 font-mono text-[11px] break-all text-foreground select-all">
              {enrolment.secret}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard
                .writeText(enrolment.secret)
                .then(() => toast.success("Secret copied to the clipboard"))
                .catch(() =>
                  toast.error("The clipboard was refused", {
                    description: "Select the secret and copy it by hand.",
                  }),
                )
            }}
          >
            <CopyIcon data-icon="inline-start" />
            Copy the secret
          </Button>
        </div>
      </div>

      <form className="grid max-w-sm gap-3" onSubmit={onSubmit}>
        <div className="space-y-1.5">
          <Label htmlFor="totp-verify">Code from the app</Label>
          <Input
            id="totp-verify"
            autoComplete="one-time-code"
            inputMode="numeric"
            autoCapitalize="none"
            spellCheck={false}
            value={code}
            onChange={(e) => onCodeChange(e.target.value)}
            disabled={busy}
          />
          <p className="text-muted-foreground">
            Nothing is enabled until this is accepted. If it is refused twice, check that the clock
            on the device generating the code is right — that is the usual cause, and enabling on a
            wrong clock would lock you out of an account nobody can let you back into.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy || !code}>
            {busy ? (
              <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
            ) : (
              <ShieldCheckIcon data-icon="inline-start" />
            )}
            Verify and turn it on
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}

/**
 * The QR code, rendered as an SVG from a matrix built in lib/qr.ts.
 *
 * No image service and no dependency: the URI contains the TOTP secret, and
 * handing that to a third party to draw would undo more than it saved. The four
 * modules of light margin are not optional — the standard requires them and a
 * scanner will refuse a code without them — so they are part of the viewBox
 * rather than something a caller has to remember.
 *
 * If the encoder refuses the URI, the code is not drawn and says so. The secret
 * above it still works, which is why this is a degraded card and not a failure.
 */
function TotpQrCode({ value }: { value: string }) {
  const code = (() => {
    try {
      return encodeQr(value)
    } catch {
      return null
    }
  })()

  if (!code) {
    return (
      <div className="w-full max-w-[200px] shrink-0 border border-warning/40 p-3">
        <p className="text-warning">
          The QR code could not be generated for this enrolment. Type the secret in by hand instead
          — it is the same factor.
        </p>
      </div>
    )
  }

  const quiet = 4
  const span = code.size + quiet * 2

  return (
    <svg
      viewBox={`0 0 ${span} ${span}`}
      role="img"
      aria-label="QR code for the authenticator secret"
      className="size-[200px] shrink-0 bg-white p-0"
      shapeRendering="crispEdges"
    >
      <rect width={span} height={span} fill="#fff" />
      {code.modules.map((row, r) =>
        row.map((dark, c) =>
          dark ? (
            <rect key={`${r}-${c}`} x={c + quiet} y={r + quiet} width={1} height={1} fill="#000" />
          ) : null,
        ),
      )}
    </svg>
  )
}

/**
 * Passkeys: register, rename, remove.
 *
 * Real. Each control calls the corresponding Better Auth endpoint and the list
 * is re-read from the server afterwards rather than patched locally, so what is
 * on screen is what is stored.
 *
 * What each row has to show is decided by the question "could I remove the right
 * one from this?". A name, when it was added, and whether it syncs — because
 * "this one only exists on that laptop" and "this one is in my iCloud Keychain"
 * are materially different things to delete, and the second is the one that
 * still works after the laptop is gone.
 */
function PasskeysSection() {
  const [passkeys, setPasskeys] = useState<PasskeySummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      setPasskeys(await listPasskeys())
      setLoadError(null)
    } catch (e) {
      // An unreadable list is not an empty list. Saying "none registered" here
      // would be a claim about who can sign in to this account, made on nothing.
      setLoadError(message(e))
    }
  }, [])

  useEffect(() => {
    void (async () => {
      await refresh()
    })()
  }, [refresh])

  async function register(e: React.FormEvent) {
    e.preventDefault()
    setBusy("add")
    try {
      await addPasskey(name)
      setName("")
      await refresh()
      toast.success("Passkey registered", {
        description:
          "It signs you in. It does not unlock your vault — your password still does that.",
      })
    } catch (err) {
      // Closing the browser prompt is a decision, not a failure.
      if (!(err instanceof PasskeyCancelledError)) {
        toast.error("The passkey was not registered", { description: message(err) })
      }
    } finally {
      setBusy(null)
    }
  }

  async function remove(id: string) {
    setBusy(id)
    try {
      await removePasskey(id)
      await refresh()
      toast.success("Passkey removed", {
        description:
          "It will no longer sign you in. Whatever is stored on the device itself is the device's to delete.",
      })
    } catch (err) {
      toast.error("The passkey was not removed", { description: message(err) })
    } finally {
      setBusy(null)
    }
  }

  async function rename(e: React.FormEvent) {
    e.preventDefault()
    if (!renaming) return
    setBusy(renaming.id)
    try {
      await renamePasskey(renaming.id, renaming.name)
      setRenaming(null)
      await refresh()
    } catch (err) {
      toast.error("The passkey was not renamed", { description: message(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <FingerprintSimpleIcon className="size-4 text-primary" />
          Passkeys
        </CardTitle>
        <CardDescription>
          A key held by your device or password manager, used instead of typing your email and
          password at sign-in. It never leaves the authenticator that holds it, and we only ever
          store its public half.
        </CardDescription>
        <CardAction>
          {passkeys === null ? (
            <Skeleton className="h-5 w-20" />
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              {passkeys.length} registered
            </Badge>
          )}
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* One line where there were two alerts. Both facts still matter — a
            passkey does not replace the vault password, and it skips the
            two-factor challenge — but they are facts, not essays. */}
        <p className="text-muted-foreground">
          A passkey signs you in. You still enter your vault password afterwards, and a passkey
          sign-in is not asked for a two-factor code.
        </p>

        {loadError ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>Could not read your passkeys</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        ) : passkeys === null ? (
          <Skeleton className="h-16 w-full" />
        ) : passkeys.length === 0 ? (
          <p className="text-muted-foreground">No passkeys registered.</p>
        ) : (
          <ul className="divide-y divide-border border border-border">
            {passkeys.map((p) => {
              // Narrowed once, here, so the draft name is a value rather than a
              // property of state that may have changed by the time a handler runs.
              const editing = renaming?.id === p.id ? renaming : null
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    {editing ? (
                      <form className="flex flex-wrap gap-2" onSubmit={(e) => void rename(e)}>
                        <Input
                          aria-label="Passkey name"
                          className="h-8 max-w-56"
                          autoFocus
                          value={editing.name}
                          onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                          disabled={busy === p.id}
                        />
                        <Button
                          type="submit"
                          size="sm"
                          disabled={busy === p.id || !editing.name.trim()}
                        >
                          Save
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy === p.id}
                          onClick={() => setRenaming(null)}
                        >
                          Cancel
                        </Button>
                      </form>
                    ) : (
                      <>
                        <p className="truncate text-foreground">
                          {p.name?.trim() || "Unnamed passkey"}
                        </p>
                        <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                          <span>Added {formatDate(p.createdAt)}</span>
                          <span aria-hidden>·</span>
                          {p.backedUp ? (
                            <span className="inline-flex items-center gap-1">
                              <CloudCheckIcon className="size-3.5 text-primary" />
                              Synced
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <DeviceMobileIcon className="size-3.5" />
                              This device only
                            </span>
                          )}
                        </p>
                      </>
                    )}
                  </div>

                  {!editing && (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => setRenaming({ id: p.id, name: p.name ?? "" })}
                      >
                        <PencilSimpleIcon data-icon="inline-start" />
                        Rename
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm" disabled={busy !== null}>
                            {busy === p.id ? (
                              <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
                            ) : (
                              <TrashIcon data-icon="inline-start" />
                            )}
                            Remove
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              Remove “{p.name?.trim() || "Unnamed passkey"}”?
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              It stops signing you in immediately. Your email and password still
                              work.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Keep it</AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              onClick={(e) => {
                                e.preventDefault()
                                void remove(p.id)
                              }}
                            >
                              Remove it
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => void register(e)}>
          <div className="space-y-1.5">
            <Label htmlFor="passkey-name">Name for this passkey</Label>
            <Input
              id="passkey-name"
              className="max-w-56"
              placeholder="Work laptop"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy !== null}
            />
          </div>
          <Button type="submit" disabled={busy !== null}>
            {busy === "add" ? (
              <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
            ) : (
              <PlusIcon data-icon="inline-start" />
            )}
            Register a passkey
          </Button>
        </form>

        {/* Said before it happens, because SESSION_NOT_FRESH reads like a bug
            and is not one. */}
        <p className="text-muted-foreground">
          Needs a session less than a day old. If it is refused, sign out and back in.
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * Real, and the most consequential control in the app.
 *
 * The work is in lib/vault/rekey.ts; this section's job is to be honest about
 * what the work costs before it starts. Three things are stated up front rather
 * than discovered afterwards: it takes seconds and cannot be interrupted, it
 * makes existing activity rows unresolvable forever, and it retires any recovery
 * codes. All three are consequences of deriving every key from the password, and
 * none of them is fixable by being quieter about it.
 *
 * The recovery variant is the same form with the current-password field removed,
 * because there is no current password to ask for — that is the situation the
 * user is in. The old keys come from the redeemed envelope, held in the vault
 * session since the /recover page redirected here. If that has been lost (a
 * reload, a new tab), the form says the re-key cannot be done from this tab and
 * names the two ways forward, rather than presenting a field the user cannot
 * fill and a button that would fail.
 */
function ChangePasswordSection({
  email,
  afterRecovery,
  onRekeyed,
}: {
  email: string | null
  afterRecovery: boolean
  /** Fired on success so the recovery section stops describing deleted codes. */
  onRekeyed: () => void
}) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [progress, setProgress] = useState<RekeyProgress | null>(null)
  const [result, setResult] = useState<RekeyResult | null>(null)
  // Kept separate from a toast: a stranded vault needs instructions that stay on
  // screen, and a toast that scrolls away is the wrong medium for them.
  const [stranded, setStranded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Reactive rather than read once: rekey clears the recovered secrets on
  // success, and this section must stop offering the passwordless path the
  // moment they are gone.
  const recovered = useRecoveredSecrets()
  // Keyed on the secrets, not on the ?rekey=1 that put us here. The query string
  // is how the recover page asks for the right tab; whether the passwordless
  // re-key is possible is a fact about what this tab is holding, and navigating
  // away and back must not turn a working form into a field nobody can fill.
  const viaRecovery = recovered

  const busy = progress !== null && progress.stage !== "done"
  const mismatch = confirm.length > 0 && next !== confirm
  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH
  const ready =
    !!email &&
    (viaRecovery || current.length > 0) &&
    next.length >= MIN_PASSWORD_LENGTH &&
    next === confirm &&
    (viaRecovery || current !== next) &&
    !busy

  async function change(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !ready) return
    setResult(null)
    setError(null)
    setStranded(null)
    setProgress({ stage: "deriving", label: "Starting" })
    try {
      // getRecoveredSecrets rather than the boolean above: the hook drives the
      // rendering, the getter is what actually holds the material, and reading it
      // here keeps the window in which it is used as short as possible.
      const oldSecrets = viaRecovery ? getRecoveredSecrets() : null
      const outcome = oldSecrets
        ? await rekeyAfterRecovery({
            email,
            oldSecrets,
            newPassword: next,
            onProgress: setProgress,
          })
        : await changePasswordAndRekey({
            email,
            currentPassword: current,
            newPassword: next,
            onProgress: setProgress,
          })
      setResult(outcome)
      setCurrent("")
      setNext("")
      setConfirm("")
      onRekeyed()
      toast.success(
        outcome.resumed
          ? "Finished a half-completed password change"
          : "Password changed and vault re-encrypted",
        {
          description: `${outcome.keysRewrapped} portable ${outcome.keysRewrapped === 1 ? "key was" : "keys were"} re-wrapped. Other sessions were signed out.`,
        },
      )
    } catch (err) {
      if (err instanceof RekeyStrandedError) {
        setStranded(err.message)
      } else {
        setError(message(err))
      }
    } finally {
      setProgress(null)
    }
  }

  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <PasswordIcon className="size-4 text-primary" />
          Change password
        </CardTitle>
        <CardDescription>
          Re-encrypts your whole vault. It takes a few seconds and cannot be interrupted.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {recovered && (
          <Alert>
            <LifebuoyIcon className="text-primary" />
            <AlertTitle>You signed in with a recovery code</AlertTitle>
            <AlertDescription>
              <span>
                Set a new password here. Your remaining codes are retired by it, so generate a fresh
                set afterwards.
              </span>
            </AlertDescription>
          </Alert>
        )}

        {afterRecovery && !recovered && (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>This tab can no longer finish the recovery</AlertTitle>
            <AlertDescription>
              <span>
                The keys from your recovery code were dropped on reload. Redeem another code from{" "}
                <Link href="/recover" className="text-foreground underline underline-offset-4">
                  the recovery page
                </Link>{" "}
                without leaving the tab, or enter your password below.
              </span>
            </AlertDescription>
          </Alert>
        )}

        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>Two things this permanently changes</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              <li>Hostnames in your existing activity log become unreadable.</li>
              <li>Recovery codes are deleted. Generate a new set below.</li>
            </ul>
          </AlertDescription>
        </Alert>

        <form className="grid max-w-sm gap-4" onSubmit={(e) => void change(e)}>
          {!viaRecovery && (
            <div className="space-y-1.5">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                disabled={busy}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              aria-invalid={tooShort || undefined}
              minLength={MIN_PASSWORD_LENGTH}
              disabled={busy}
            />
            <p className="text-muted-foreground">
              Ten characters or more. It is never stored, so it cannot be reset.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch || undefined}
              disabled={busy}
            />
            {mismatch && <p className="text-destructive">The two entries do not match.</p>}
          </div>

          <Button type="submit" className="w-fit" disabled={!ready}>
            {busy ? (
              <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
            ) : (
              <LockKeyIcon data-icon="inline-start" />
            )}
            Change password and re-encrypt vault
          </Button>
        </form>

        {progress && <RekeyProgressPanel progress={progress} />}

        {stranded && (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>The change did not finish, and needs finishing</AlertTitle>
            <AlertDescription>{stranded}</AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>The password was not changed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && <RekeySummary result={result} />}
      </CardContent>
    </Card>
  )
}

/** Narrates a multi-second operation that must not be interrupted. */
function RekeyProgressPanel({ progress }: { progress: RekeyProgress }) {
  const done = REKEY_STAGES.indexOf(progress.stage) + 1
  const pct = Math.round((done / REKEY_STAGES.length) * 100)

  return (
    <div className="space-y-2 border border-border bg-card p-3">
      <p className="flex items-center gap-2">
        <SpinnerGapIcon className="size-4 animate-spin text-primary" />
        <span>{progress.label}…</span>
      </p>
      <Progress value={pct} />
      <p className="text-muted-foreground">Leave this tab open.</p>
    </div>
  )
}

const REKEY_STAGES: RekeyStage[] = [
  "deriving",
  "reading",
  "syncing",
  "rewrapping",
  "pushing",
  "changing",
  "installing",
  "done",
]

/** Counts, not claims. Especially the count of keys that did not re-wrap. */
function RekeySummary({ result }: { result: RekeyResult }) {
  return (
    <div className="space-y-2 border border-border bg-card p-3">
      <p className="flex items-center gap-2 font-medium">
        <CheckCircleIcon className="size-4 text-success" />
        {result.resumed
          ? "Finished a change that had already re-encrypted the vault"
          : "Password changed and vault re-encrypted"}
      </p>
      <ul className="space-y-1 text-muted-foreground">
        {result.version !== null && (
          <li>The re-encrypted vault was stored as version {result.version}.</li>
        )}
        <li>
          {result.keysRewrapped} portable SSH {result.keysRewrapped === 1 ? "key was" : "keys were"}{" "}
          unwrapped and re-wrapped under the new vault key.
        </li>
        {result.keysUnreadable > 0 && (
          <li className="text-warning">
            {result.keysUnreadable} {result.keysUnreadable === 1 ? "key" : "keys"} would not open
            with your old password and {result.keysUnreadable === 1 ? "was" : "were"} left
            untouched. They were already unusable before this ran.
          </li>
        )}
        <li>Every other session was signed out.</li>
        <li>
          {result.recoveryCleared
            ? "Recovery codes were deleted. Generate a new set below."
            : `Recovery codes could not be deleted (${result.recoveryError ?? "unknown error"}). They no longer work either way; remove them below when the server is reachable.`}
        </li>
      </ul>
    </div>
  )
}

/** Genuinely wired: Better Auth can revoke every session for this user. */
function SessionsSection() {
  const router = useRouter()
  const [busy, setBusy] = useState<"one" | "all" | null>(null)

  async function signOutHere() {
    setBusy("one")
    try {
      await signOut()
      // The vault key lives in memory only; drop it before leaving the page.
      lock()
      router.push("/sign-in")
    } catch (e) {
      toast.error("Sign out failed", { description: message(e) })
      setBusy(null)
    }
  }

  async function signOutEverywhere() {
    setBusy("all")
    try {
      const res = await authClient.revokeSessions()
      if (res.error) throw new Error(res.error.message ?? "revoke failed")
      await signOut()
      lock()
      toast.success("Every session revoked")
      router.push("/sign-in")
    } catch (e) {
      toast.error("Could not revoke sessions", { description: message(e) })
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <ClockCounterClockwiseIcon className="size-4 text-primary" />
          Sessions
        </CardTitle>
        <CardDescription>
          Signing out locks the vault. Data stored in this browser stays until you clear it.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void signOutHere()} disabled={busy !== null}>
          {busy === "one" ? (
            <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
          ) : (
            <SignOutIcon data-icon="inline-start" />
          )}
          Sign out of this browser
        </Button>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" disabled={busy !== null}>
              {busy === "all" ? (
                <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
              ) : (
                <ShieldCheckIcon data-icon="inline-start" />
              )}
              Sign out everywhere
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke every session?</AlertDialogTitle>
              <AlertDialogDescription>
                Every browser signed in to this account is signed out, including this one. Nothing
                is deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void signOutEverywhere()}>
                Revoke all sessions
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

/**
 * Real, and the one control on this page whose output is a secret the user has
 * to physically keep.
 *
 * Three states, and the UI is different in each rather than one form pretending:
 * not enrolled, enrolled (a count and a way to replace or remove), and the
 * one-time display of a freshly generated set. The generated codes exist in this
 * component's state and nowhere else — not in IndexedDB, not on the server, not
 * in a toast — so leaving the page loses them, and the page says so before it
 * shows them.
 */
function RecoveryCodesSection({
  email,
  reloadOn,
}: {
  email: string | null
  /** Changes when something outside this card invalidated the enrolled set. */
  reloadOn: number
}) {
  const [status, setStatus] = useState<RecoveryStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [password, setPassword] = useState("")
  const [progress, setProgress] = useState<EnrolmentProgress | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState<"enrol" | "disable" | null>(null)

  async function refresh() {
    try {
      setStatus(await getRecoveryStatus())
      setLoadError(null)
    } catch (e) {
      // A count we could not read is not a count of zero. Saying "none enrolled"
      // here would be a claim about someone's account recovery, made on no
      // evidence.
      setLoadError(message(e))
    }
  }

  useEffect(() => {
    void (async () => {
      await refresh()
    })()
    // Re-read on mount, and whenever something outside this card invalidated
    // the set — today that is only a password change.
  }, [reloadOn])

  async function enrol(e: React.FormEvent) {
    e.preventDefault()
    if (!email || password.length === 0) return
    setBusy("enrol")
    setCodes(null)
    setAcknowledged(false)
    setProgress({ done: 0, total: RECOVERY_CODE_COUNT })
    try {
      const generated = await enrolRecoveryCodes(email, password, setProgress)
      setCodes(generated)
      setPassword("")
      await refresh()
    } catch (err) {
      // A locked vault is a question, not a failure: the check that makes
      // enrolment trustworthy needs the session's vault key to compare against.
      if (err instanceof RecoveryLockedError) requestUnlock()
      toast.error("No recovery codes were generated", { description: message(err) })
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  async function disable() {
    setBusy("disable")
    try {
      await disableRecoveryCodes()
      setCodes(null)
      await refresh()
      toast.success("Recovery codes removed", {
        description:
          "None of them will open this account any more. Without a password there is now no way back in.",
      })
    } catch (err) {
      toast.error("Recovery codes were not removed", { description: message(err) })
    } finally {
      setBusy(null)
    }
  }

  const enrolled = status?.enrolled === true && status.remaining > 0

  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <LifebuoyIcon className="size-4 text-primary" />
          Recovery codes
        </CardTitle>
        <CardDescription>
          The only way back in if you forget your password. Each code signs you in and unlocks the
          vault, once.
        </CardDescription>
        <CardAction>
          {status === null ? (
            <Skeleton className="h-5 w-24" />
          ) : enrolled ? (
            <Badge variant="outline" className="text-success">
              {status.remaining} of {RECOVERY_CODE_COUNT} unused
            </Badge>
          ) : (
            <Badge variant="outline" className="text-warning">
              None enrolled
            </Badge>
          )}
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>A recovery code is your password, in text form</AlertTitle>
          <AlertDescription>
            <span>
              Anyone holding one can sign in as you and read your whole vault. Print them or keep
              them in a password manager.
            </span>
          </AlertDescription>
        </Alert>

        {codes ? (
          <GeneratedCodes
            codes={codes}
            onAcknowledge={() => {
              setAcknowledged(true)
              setCodes(null)
            }}
          />
        ) : (
          <>
            {loadError ? (
              <Alert variant="destructive">
                <WarningCircleIcon />
                <AlertTitle>Could not read your recovery status</AlertTitle>
                <AlertDescription>{loadError}</AlertDescription>
              </Alert>
            ) : enrolled ? (
              <Alert>
                <InfoIcon className="text-primary" />
                <AlertTitle>
                  {status.remaining} unused {status.remaining === 1 ? "code" : "codes"} remain
                </AlertTitle>
                <AlertDescription>
                  <span>
                    Generated {formatDate(status.createdAt ?? new Date())}
                    {status.lastUsedAt
                      ? `, last used ${formatDate(status.lastUsedAt)}`
                      : ", never used"}
                    . Generating a new set replaces the remaining codes.
                  </span>
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="destructive">
                <WarningCircleIcon />
                <AlertTitle>Nothing can open your vault but your password</AlertTitle>
                <AlertDescription>
                  <span>
                    Forget it and the vault is gone — we cannot reset it. Generate a set below.{" "}
                    <Link href="/security" className="text-primary hover:underline">
                      Why
                    </Link>
                    .
                  </span>
                </AlertDescription>
              </Alert>
            )}

            <form className="grid max-w-sm gap-3" onSubmit={(e) => void enrol(e)}>
              <div className="space-y-1.5">
                <Label htmlFor="recovery-password">Confirm your password</Label>
                <Input
                  id="recovery-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy !== null || !email}
                />
                <p className="text-muted-foreground">
                  Checked before any code is generated, so a typo cannot produce codes that open
                  nothing.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={busy !== null || !email || !password}>
                  {busy === "enrol" ? (
                    <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <KeyIcon data-icon="inline-start" />
                  )}
                  {enrolled ? "Replace with a new set" : "Generate recovery codes"}
                </Button>

                {enrolled && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline" disabled={busy !== null}>
                        {busy === "disable" ? (
                          <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
                        ) : (
                          <TrashIcon data-icon="inline-start" />
                        )}
                        Disable recovery codes
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete every recovery code?</AlertDialogTitle>
                        <AlertDialogDescription>
                          The codes you wrote down stop working, and your password becomes the only
                          way in. Generate a new set afterwards.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Keep them</AlertDialogCancel>
                        <AlertDialogAction
                          variant="destructive"
                          onClick={(e) => {
                            e.preventDefault()
                            void disable()
                          }}
                        >
                          Delete all codes
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>

              {progress && (
                <div className="space-y-2">
                  <Progress value={Math.round((progress.done / progress.total) * 100)} />
                  <p className="text-muted-foreground">
                    Sealing code {Math.min(progress.done + 1, progress.total)} of {progress.total}.
                  </p>
                </div>
              )}
            </form>
          </>
        )}
      </CardContent>

      {acknowledged && (
        <CardFooter>
          <p className="flex items-start gap-2 text-muted-foreground">
            <CheckCircleIcon className="mt-0.5 size-3.5 shrink-0 text-success" />
            <span className="min-w-0">The codes cannot be shown again.</span>
          </p>
        </CardFooter>
      )}
    </Card>
  )
}

/**
 * The one-time display, used by both kinds of code this app issues.
 *
 * Deliberately awkward to leave: dismissing is an explicit button, because the
 * codes cannot be recovered from anywhere once this unmounts. Copy and download
 * are offered because the realistic alternative is a screenshot.
 *
 * Shared between recovery codes and two-factor backup codes rather than
 * duplicated, because the awkwardness is the feature and two copies would drift
 * — one of them would eventually grow a way out that does not make the user
 * confirm. The defaults are the recovery-code ones, since that is the older and
 * more dangerous of the two; the TOTP card overrides all four, because a backup
 * code is a different thing and the file it downloads must not claim otherwise.
 */
function GeneratedCodes({
  codes,
  onAcknowledge,
  format = formatRecoveryCode,
  filename = `webxterm-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`,
  fileTitle = "webxterm recovery codes",
  fileNote = "Each code works once. Anyone holding one can sign in and read your vault.",
  warning = "Shown once. Save them before you leave this page.",
}: {
  codes: string[]
  onAcknowledge: () => void
  /** How one code is printed. Recovery codes are grouped; backup codes are not. */
  format?: (code: string) => string
  filename?: string
  fileTitle?: string
  /** The line in the downloaded file that says what these codes actually do. */
  fileNote?: string
  warning?: string
}) {
  const text = codes.map(format).join("\n")

  return (
    <div className="space-y-3 border border-warning/40 bg-card p-3">
      <p className="flex items-center gap-2 font-medium text-warning">
        <WarningCircleIcon className="size-4" />
        {warning}
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        {codes.map((code) => (
          <div
            key={code}
            className="bg-terminal border border-border px-3 py-2 font-mono text-[11px] tracking-widest text-foreground select-all"
          >
            {format(code)}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard
              .writeText(text)
              .then(() => toast.success("Codes copied to the clipboard"))
              .catch(() =>
                toast.error("The clipboard was refused", {
                  description: "Select the codes and copy them by hand.",
                }),
              )
          }}
        >
          <CopyIcon data-icon="inline-start" />
          Copy all
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            download(
              filename,
              `${fileTitle}\nGenerated ${new Date().toISOString()}\n\n${text}\n\n${fileNote}\n`,
              "text/plain",
            )
          }
        >
          <DownloadSimpleIcon data-icon="inline-start" />
          Download as a file
        </Button>
        <Button onClick={onAcknowledge}>
          <CheckCircleIcon data-icon="inline-start" />I have saved them
        </Button>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- data tab */

/** Real: /api/vault hands back the stored ciphertext, which is what we save. */
function ExportSection() {
  const [busy, setBusy] = useState(false)

  async function exportVault() {
    setBusy(true)
    try {
      const res = await fetch("/api/vault", { cache: "no-store" })
      if (res.status === 401) throw new Error("Session expired. Sign in again.")
      if (!res.ok) throw new Error(`The server returned ${res.status}.`)

      const payload = (await res.json()) as { version: number; blob: string | null }
      if (!payload.blob) {
        toast.info("Nothing to export yet", {
          description:
            "No vault has been pushed from this account. Connect to a host or generate a key, then sync.",
        })
        return
      }

      const stamp = new Date().toISOString().slice(0, 10)
      download(`webxterm-vault-v${payload.version}-${stamp}.json`, payload.blob, "application/json")
      toast.success(`Exported vault version ${payload.version}`, {
        description:
          "The file is the same ciphertext the server holds. Only your password can open it.",
      })
    } catch (e) {
      toast.error("Export failed", { description: message(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <DownloadSimpleIcon className="size-4 text-primary" />
          Export the vault
        </CardTitle>
        <CardDescription>
          Your hosts, keys and snippets, still encrypted. Only your password can open the file.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void exportVault()} disabled={busy}>
          {busy ? (
            <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
          ) : (
            <DownloadSimpleIcon data-icon="inline-start" />
          )}
          Download encrypted vault
        </Button>
        <span className="text-muted-foreground">Useless without your password.</span>
      </CardContent>
    </Card>
  )
}

/**
 * Inspect, then merge.
 *
 * The file is parsed and shape-checked in this tab before anything else
 * happens, and the restore that follows is a merge rather than a replacement —
 * see lib/vault/restore.ts for why that distinction is the whole feature. This
 * section's job is to make the outcome legible afterwards: how much the file
 * held, how much of it was actually new here, and what a local delete refused
 * to take back.
 */
/**
 * Generous by two orders of magnitude and still a ceiling: a vault of a thousand
 * hosts and a hundred wrapped keys is well under a megabyte of base64.
 */
const MAX_VAULT_FILE_BYTES = 16_000_000

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`

function ImportSection() {
  const inputRef = useRef<HTMLInputElement>(null)
  const unlocked = useVaultUnlocked()
  const [inspected, setInspected] = useState<
    | { ok: true; envelope: VaultEnvelope; bytes: number; name: string }
    | { ok: false; reason: string }
    | null
  >(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RestoreResult | null>(null)
  // The two failures read very differently to a user. A file that never opened
  // — wrong key, or a format this build does not know — was rejected before
  // anything local was read, so "nothing here changed" is a promise that can be
  // kept. Anything thrown later may have stopped part-way through writing
  // records, and saying otherwise would be a guess dressed as a reassurance.
  const [failure, setFailure] = useState<{
    kind: "untouched" | "partial"
    text: string
  } | null>(null)

  async function inspect(file: File) {
    setResult(null)
    setFailure(null)

    // Before the read, not after. `accept` on the input is a picker hint and
    // nothing more, and this dialog invites file-picking — a disk image or a
    // database dump dragged in here would either allocate its whole contents as
    // a string or throw a RangeError out of file.text(), and the catch below
    // would report "not valid JSON", sending the user off to hunt for a
    // corrupted export. The sibling importers in keys/ and hosts/ both guard the
    // same way.
    if (file.size > MAX_VAULT_FILE_BYTES) {
      setInspected({
        ok: false,
        reason: `${file.name} is ${megabytes(file.size)}. A vault export is base64 of one encrypted blob and is far smaller than that, so this is not one.`,
      })
      return
    }

    try {
      const text = await file.text()
      const parsed: unknown = JSON.parse(text)
      if (!isEnvelope(parsed)) {
        setInspected({
          ok: false,
          // A future format is not the same complaint as a foreign file, and
          // the remedy differs: update the app rather than go looking for the
          // right file.
          reason: looksLikeEnvelope(parsed)
            ? `This is a vault export in format v${String((parsed as { v: unknown }).v)}, which this build cannot read. It was written by a newer version of webxterm.`
            : "This is not a webxterm vault export. Expected a JSON object with v, iv and ct fields.",
        })
        return
      }
      setInspected({
        ok: true,
        envelope: parsed,
        bytes: parsed.ct.length,
        name: file.name,
      })
    } catch {
      setInspected({ ok: false, reason: "The file is not valid JSON." })
    }
  }

  async function restore() {
    if (!inspected?.ok) return
    const vaultKey = getVaultKey()
    if (!vaultKey) {
      // The key is memory-only, so a reload leaves you signed in but locked.
      // Asking for it beats failing with "no usable key".
      requestUnlock()
      return
    }

    setBusy(true)
    setResult(null)
    setFailure(null)
    try {
      const outcome = await restoreVault(inspected.envelope, vaultKey)
      setResult(outcome)
      const added =
        outcome.hosts.added + outcome.keys.added + outcome.hostKeys.added + outcome.snippets.added
      const updated =
        outcome.hosts.updated +
        outcome.keys.updated +
        outcome.hostKeys.updated +
        outcome.snippets.updated
      if (added === 0 && updated === 0) {
        toast.info("Nothing in that file was newer than what is already here")
      } else {
        toast.success(`Merged ${added} new and ${updated} updated records`)
      }
    } catch (e) {
      // A wrong key is the expected failure, not a bug: name that cause rather
      // than reporting a generic "restore failed".
      const untouched = e instanceof VaultDecryptionError || e instanceof VaultFormatError
      setFailure(
        untouched
          ? { kind: "untouched", text: (e as Error).message }
          : { kind: "partial", text: message(e) },
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <UploadSimpleIcon className="size-4 text-primary" />
          Import a vault
        </CardTitle>
        <CardDescription>
          <span className="text-foreground">Merges</span> into what this device already holds,
          newest wins. Nothing is overwritten wholesale and nothing is uploaded.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void inspect(file)
            e.target.value = ""
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={busy}>
            <UploadSimpleIcon data-icon="inline-start" />
            Choose a vault file
          </Button>
          <Button onClick={() => void restore()} disabled={!inspected?.ok || busy}>
            {busy ? (
              <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
            ) : (
              <ArrowsMergeIcon data-icon="inline-start" />
            )}
            Merge this file into my vault
          </Button>
          {!unlocked && (
            <span className="text-muted-foreground">
              The vault is locked. Restoring will ask you to unlock it first.
            </span>
          )}
        </div>

        {inspected && (
          <Alert variant={inspected.ok ? "default" : "destructive"}>
            {inspected.ok ? <CheckCircleIcon className="text-success" /> : <WarningCircleIcon />}
            <AlertTitle>
              {inspected.ok ? "Valid vault envelope" : "That file was not accepted"}
            </AlertTitle>
            <AlertDescription>
              {inspected.ok
                ? `${inspected.name}. Whether your password opens it is only known once you merge.`
                : inspected.reason}
            </AlertDescription>
          </Alert>
        )}

        {failure && (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>
              {failure.kind === "untouched"
                ? "That file did not open, and nothing here changed"
                : "The merge did not complete"}
            </AlertTitle>
            <AlertDescription>
              {failure.kind === "untouched"
                ? failure.text
                : `${failure.text} The file decrypted, so some records may already have been written; running the merge again is safe and will finish the job.`}
            </AlertDescription>
          </Alert>
        )}

        {result && <RestoreSummary result={result} />}
      </CardContent>
    </Card>
  )
}

/** What the merge did, stated as counts rather than as a claim of success. */
function RestoreSummary({ result }: { result: RestoreResult }) {
  const rows: { label: string; count: RestoreCount }[] = [
    { label: "Hosts", count: result.hosts },
    { label: "Portable keys", count: result.keys },
    { label: "Pinned host keys", count: result.hostKeys },
    { label: "Snippets", count: result.snippets },
  ]
  const blocked = rows.reduce((n, r) => n + r.count.blockedByDelete, 0)

  return (
    <div className="space-y-3 border border-border bg-card p-3">
      <p className="flex items-center gap-2 font-medium">
        <CheckCircleIcon className="size-4 text-success" />
        Merged into this device
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem] text-left">
          <thead className="text-[10px] tracking-wider text-muted-foreground uppercase">
            <tr>
              <th className="py-1 font-medium">Record</th>
              <th className="py-1 text-right font-medium">In file</th>
              <th className="py-1 text-right font-medium">New here</th>
              <th className="py-1 text-right font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-border">
                <td className="py-1.5">{row.label}</td>
                <td className="py-1.5 text-right tabular-nums">{row.count.inFile}</td>
                <td className="py-1.5 text-right tabular-nums">{row.count.added}</td>
                <td className="py-1.5 text-right tabular-nums">{row.count.updated}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {blocked > 0 && (
        <p className="text-muted-foreground">
          {blocked} record{blocked === 1 ? "" : "s"} in the file stayed deleted: they were removed
          on a device after this export was taken, and a deletion outranks an older copy.
        </p>
      )}

      <p className="text-muted-foreground">
        {result.sync
          ? result.sync.status === "offline"
            ? "The merge is on this device only — the server could not be reached. It will be pushed on the next sync."
            : result.sync.status === "up-to-date"
              ? "Nothing was pushed: after the merge, this device held exactly what the server already had."
              : `Pushed to the server as vault version ${result.sync.version}, so your other devices will pick it up on their next sync.`
          : `The merge is on this device, but the push failed: ${result.syncError ?? "unknown error"}. It will be retried on the next sync.`}
      </p>

      {result.sync !== null && result.sync.keysWithheld > 0 && (
        <p className="text-warning">
          {result.sync.keysWithheld} portable{" "}
          {result.sync.keysWithheld === 1 ? "key was" : "keys were"} kept out of the push: the
          current vault key does not open {result.sync.keysWithheld === 1 ? "its" : "their"}{" "}
          wrapping, so uploading {result.sync.keysWithheld === 1 ? "it" : "them"} would copy
          ciphertext nothing can open to every device. See the Keys page.
        </p>
      )}
    </div>
  )
}

/**
 * Real deletion, and therefore two confirmations rather than one.
 *
 * Typing the email is the deliberation step; the password is the proof. The
 * server stores a hash of the derived auth token, not of the password, so the
 * password has to be run back through Argon2id here to produce something
 * /delete-user can verify. That is slow by design — a second or so of stretch
 * on the account-destroying path is a feature.
 *
 * What this cannot do is reach every copy of the data. It clears the four
 * IndexedDB stores this app owns in this browser, which takes the device-bound
 * private keys with them irrecoverably, and it says so instead of implying a
 * wipe it cannot perform elsewhere.
 *
 * The subscription is cancelled server-side before the row that names it is
 * destroyed — lib/auth.ts, `user.deleteUser.beforeDelete`. This component does
 * not do it and does not need to know whether there is one; what it owes the
 * user is an accurate description, which is why the copy states the ordering
 * and the refusal rather than the old warning to go and cancel first.
 */
function DeleteAccountSection({ email }: { email: string | null }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)

  const target = email ?? ""
  const matches = target.length > 0 && typed.trim().toLowerCase() === target.toLowerCase()
  const ready = matches && password.length > 0 && !busy

  async function deleteAccount() {
    if (!email || !ready) return
    setBusy(true)
    try {
      await deleteAccountWithVault(email, password)

      // Order matters: the key material goes first, because everything after
      // this can fail without leaving a usable vault key in a tab whose account
      // no longer exists.
      lock()
      setPassword("")

      // Local stores outlive the account otherwise. Best-effort: a failure here
      // is reported, never swallowed, because the alternative is telling
      // someone their data is gone while it sits in this browser.
      let cleared = true
      try {
        await Promise.all([
          idbClear("hosts"),
          idbClear("keys"),
          idbClear("hostkeys"),
          idbClear("vault"),
        ])
      } catch {
        cleared = false
      }

      toast.success("Account deleted", {
        description: cleared
          ? "This browser's local copies were cleared too. Other browsers keep theirs until their site data is cleared."
          : "The account is gone, but this browser's local stores could not be cleared. Clear the site data for this origin.",
      })
      router.push("/")
    } catch (e) {
      toast.error("The account was not deleted", { description: message(e) })
      setBusy(false)
    }
  }

  return (
    <Card className="ring-destructive/30">
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2 text-destructive">
          <TrashIcon className="size-4" />
          Delete account
        </CardTitle>
        <CardDescription>
          Deletes your vault, devices, recordings and recovery codes. Any subscription is cancelled
          immediately, with no refund for the rest of the period.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <AlertDialog
          open={open}
          onOpenChange={(next) => {
            if (busy) return
            setOpen(next)
            if (!next) {
              setTyped("")
              setPassword("")
            }
          }}
        >
          <AlertDialogTrigger asChild>
            <Button variant="destructive" disabled={!email}>
              <TrashIcon data-icon="inline-start" />
              Delete this account
            </Button>
          </AlertDialogTrigger>

          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {target || "this account"}?</AlertDialogTitle>
              <AlertDialogDescription>
                This cannot be undone and we hold no copy to restore. Export your vault first if you
                want to keep it.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="confirm-email">
                  Type <span className="text-foreground">{target}</span> to confirm
                </Label>
                <Input
                  id="confirm-email"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={target}
                  disabled={busy}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirm-delete-password">Your password</Label>
                <Input
                  id="confirm-delete-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
              </div>

              <Alert>
                <InfoIcon className="text-primary" />
                <AlertTitle>This browser is cleaned up, other devices are not</AlertTitle>
                <AlertDescription>
                  <span>
                    Local data here is cleared, device-bound keys included. Other browsers keep
                    their copies until you clear the site data there.
                  </span>
                </AlertDescription>
              </Alert>
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Keep my account</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={!ready}
                // The dialog must not close on click: the request has to finish
                // first, and a wrong password has to be reportable.
                onClick={(e) => {
                  e.preventDefault()
                  void deleteAccount()
                }}
              >
                {busy ? (
                  <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <TrashIcon data-icon="inline-start" />
                )}
                Delete account
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

/* ----------------------------------------------------------------- pieces */

function NotImplemented({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-muted-foreground">
      <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/* ---------------------------------------------------------------- helpers */

/**
 * Shape check only. It establishes that the file could be a v1 envelope, never
 * that this account can open it — that question has exactly one answer, and
 * only AES-GCM can give it.
 */
function isEnvelope(value: unknown): value is VaultEnvelope {
  return looksLikeEnvelope(value) && (value as { v: unknown }).v === 1
}

/** An envelope of some version — enough to tell "wrong file" from "wrong build". */
function looksLikeEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const env = value as Record<string, unknown>
  return typeof env.v === "number" && typeof env.iv === "string" && typeof env.ct === "string"
}

function download(filename: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  const letters = parts.map((p) => p[0] ?? "").join("")
  return (letters || name.slice(0, 2) || "??").toUpperCase()
}

const DATE_FMT = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
})

function formatDate(at: Date | string): string {
  const ms = at instanceof Date ? at.getTime() : Date.parse(at)
  return Number.isFinite(ms) ? DATE_FMT.format(ms) : "unknown"
}

/**
 * Forced to UTC, unlike its sibling above.
 *
 * The billing period turns over at midnight UTC, so rendering the boundary in
 * the viewer's zone would name the wrong day for anybody west of Greenwich —
 * and the day the counter resets is the one date on this card somebody might
 * plan around.
 */
const UTC_DATE_FMT = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
})

function formatUtcDate(at: string): string {
  const ms = Date.parse(at)
  return Number.isFinite(ms) ? UTC_DATE_FMT.format(ms) : "unknown"
}

/** Local, because it names a moment that happened rather than a boundary. */
const DATE_TIME_FMT = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

function formatDateTime(at: string): string {
  const ms = Date.parse(at)
  return Number.isFinite(ms) ? DATE_TIME_FMT.format(ms) : "unknown"
}

/**
 * When this page did something, as a wall clock. Same day by construction — it
 * is a moment in this session — so the date would be noise, and the point of it
 * is to be comparable at a glance with the timestamp beside it.
 */
const CLOCK_FMT = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" })

function formatClock(ms: number): string {
  return CLOCK_FMT.format(ms)
}

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message?: unknown }).message ?? "Unknown error")
  }
  return String(e ?? "Unknown error")
}
