"use client"

/**
 * Dashboard overview.
 *
 * A client component on purpose: hosts, keys and pinned host keys live in this
 * browser's IndexedDB, and the copy on the server is ciphertext it has no way
 * to open. Nothing on this page could be rendered server-side even if we wanted
 * it to be — it has to be read here, after the page loads, on the device that
 * holds the vault.
 */

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ArrowRightIcon,
  CaretRightIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  DevicesIcon,
  FingerprintIcon,
  HardDrivesIcon,
  InfoIcon,
  KeyIcon,
  LockKeyIcon,
  PlugsConnectedIcon,
  PulseIcon,
  ShieldCheckIcon,
  ShieldWarningIcon,
  TerminalWindowIcon,
  WarningIcon,
} from "@phosphor-icons/react/dist/ssr"

import { PageHeader } from "@/components/shell/page-shell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { CredentialPrompt, useCredentialPrompt } from "@/components/ssh/credential-prompt"
import { listPins, type PinnedHostKey } from "@/lib/hostkeys"
import { listHosts, type Host } from "@/lib/hosts"
import { listStoredKeys, type StoredKey } from "@/lib/keys"
import { useSshSession } from "@/lib/ssh/session-provider"
import { useConnectHost } from "@/lib/ssh/use-connect-host"
import { cn } from "@/lib/utils"

const WEEK = 7 * 24 * 60 * 60 * 1000

interface VaultSnapshot {
  hosts: Host[]
  keys: StoredKey[]
  pins: PinnedHostKey[]
  /** Captured once per load so every relative timestamp agrees. */
  readAt: number
}

export default function DashboardOverview() {
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const [hosts, keys, pins] = await Promise.all([listHosts(), listStoredKeys(), listPins()])
        if (!cancelled) setSnapshot({ hosts, keys, pins, readAt: Date.now() })
      } catch (e) {
        if (cancelled) return
        setError((e as Error)?.message ?? "IndexedDB is unavailable in this browser context.")
        setSnapshot({ hosts: [], keys: [], pins: [], readAt: Date.now() })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow="Dashboard"
        title="Overview"
        description="Read out of this browser's vault. The server holds the same records as ciphertext it cannot open, so this page is assembled locally, on this device."
        actions={
          <Button asChild>
            <Link href="/dashboard/terminal">
              Open terminal
              <ArrowRightIcon data-icon="inline-end" />
            </Link>
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive" className="mt-6">
          <ShieldWarningIcon />
          <AlertTitle>Local storage could not be read</AlertTitle>
          <AlertDescription>
            {error} Private browsing windows and blocked site data both prevent the vault from
            opening. Nothing was lost — the records are still on any device where you have unlocked
            the vault.
          </AlertDescription>
        </Alert>
      )}

      {snapshot === null ? (
        <LoadingState />
      ) : snapshot.hosts.length === 0 &&
        snapshot.keys.length === 0 &&
        snapshot.pins.length === 0 ? (
        <EmptyState />
      ) : (
        <PopulatedState snapshot={snapshot} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ states */

function LoadingState() {
  return (
    <div className="mt-6 space-y-6" role="status" aria-busy="true" aria-label="Reading local vault">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} size="sm">
            <CardContent className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-10" />
              <Skeleton className="h-3 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {[0, 1].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-32" />
              </CardHeader>
              <CardContent className="space-y-3">
                {[0, 1, 2, 3].map((r) => (
                  <div key={r} className="flex items-center gap-3">
                    <Skeleton className="size-6 shrink-0" />
                    <Skeleton className="h-3 w-full max-w-56" />
                    <Skeleton className="ml-auto h-3 w-14 shrink-0" />
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-4 w-36" />
          </CardHeader>
          <CardContent className="space-y-3">
            {[0, 1, 2, 3].map((r) => (
              <Skeleton key={r} className="h-3 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/**
 * Most people arrive here with an empty vault, so the empty state is the whole
 * setup path rather than an apology for having no data.
 */
function EmptyState() {
  return (
    <div className="mt-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrivesIcon className="size-4 text-primary" />
            Nothing stored on this device yet
          </CardTitle>
          <CardDescription>
            Three steps, none of which install anything. If you already use weirdvault elsewhere,
            sign in and unlock the vault instead — your hosts and portable keys arrive with the
            first sync.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5 border-t border-border pt-4">
          <Step
            n={1}
            title="Generate a key"
            body="Portable keys are wrapped with your vault key and follow you to your other devices. Device-bound keys never leave this browser. In both modes the private key is a non-extractable WebCrypto key, so nothing running on the page can read it."
          />
          <Step
            n={2}
            title="Authorize it on the server"
            body="One line appended to ~/.ssh/authorized_keys on stock sshd. No agent, no daemon, no extra port. Or connect once with a password and weirdvault installs the key for you."
          >
            <pre className="bg-terminal mt-3 overflow-x-auto border border-border px-3 py-2 text-[11px] leading-relaxed">
              <span className="text-muted-foreground">$ </span>
              <span className="text-foreground">echo </span>
              <span className="text-success">&apos;ssh-ed25519 AAAAC3Nza…&apos;</span>
              <span className="text-foreground"> &gt;&gt; ~/.ssh/authorized_keys</span>
            </pre>
          </Step>
          <Step
            n={3}
            title="Connect"
            body="The host key is pinned on first connection and verified on every one after it. A mismatch refuses the connection rather than offering to continue anyway."
          />

          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button asChild>
              <Link href="/dashboard/terminal">
                <TerminalWindowIcon data-icon="inline-start" />
                Open terminal
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/dashboard/keys">Generate a key</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/security">How the encryption works</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardContent className="flex items-start gap-2.5 text-muted-foreground">
          <LockKeyIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          <p className="min-w-0">
            This page stays empty until you add something, even if your account already has hosts.
            The vault is a zero-knowledge blob — the server cannot list it, search it, or render it
            for you.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function Step({
  n,
  title,
  body,
  children,
}: {
  n: number
  title: string
  body: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex gap-3">
      <span
        aria-hidden
        className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-sm border border-border bg-secondary text-[11px] text-primary"
      >
        {n}
      </span>
      <div className="min-w-0">
        <h3 className="font-heading text-sm font-medium">{title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{body}</p>
        {children}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- populated */

function PopulatedState({ snapshot }: { snapshot: VaultSnapshot }) {
  const { hosts, keys, pins, readAt } = snapshot

  const router = useRouter()
  const { keys: usableKeys } = useSshSession()
  const prompt = useCredentialPrompt()
  const { connectToHost, connecting } = useConnectHost({
    askFor: prompt.askFor,
    onConnected: () => router.push("/dashboard/terminal"),
  })

  const derived = useMemo(() => {
    const portable = keys.filter((k) => k.mode === "portable").length
    const deviceBound = keys.length - portable
    const activeThisWeek = hosts.filter(
      (h) => h.lastUsedAt !== undefined && readAt - h.lastUsedAt < WEEK,
    ).length
    const lastUsed = hosts.reduce<number>((max, h) => Math.max(max, h.lastUsedAt ?? 0), 0)

    return { portable, deviceBound, activeThisWeek, lastUsed }
  }, [hosts, keys, readAt])

  const activity = useMemo(() => buildActivity(hosts, keys, pins), [hosts, keys, pins])
  const posture = useMemo(() => buildPosture({ keys, ...derived }), [keys, derived])

  return (
    <div className="mt-6 space-y-6">
      <CredentialPrompt pending={prompt.pending} keys={usableKeys} onSettle={prompt.settle} />
      {/* ------------------------------------------------------------ stats */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={<HardDrivesIcon />}
          label="Hosts"
          value={hosts.length}
          caption={hosts.length === 0 ? "None saved on this device" : "Saved on this device"}
        />
        <Stat
          icon={<KeyIcon />}
          label="Keys"
          value={keys.length}
          caption={
            keys.length === 0
              ? "No key generated yet"
              : `${derived.portable} portable · ${derived.deviceBound} device-bound`
          }
        />
        <Stat
          icon={<DevicesIcon />}
          label="Devices"
          value={1}
          caption="This browser. Registered devices are listed under Devices."
        />
        <Stat
          icon={<PulseIcon />}
          label="Connected · 7d"
          value={derived.activeThisWeek}
          caption={
            derived.lastUsed
              ? `Last connection ${relative(derived.lastUsed, readAt)}`
              : "No connections recorded here yet"
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {/* ------------------------------------------------------- hosts */}
          <Card>
            <CardHeader className="border-b border-border">
              <CardTitle>Your hosts</CardTitle>
              <CardDescription>Quick connect, ordered by last use.</CardDescription>
              <CardAction>
                <Button asChild variant="ghost" size="xs">
                  <Link href="/dashboard/hosts">
                    All hosts
                    <CaretRightIcon data-icon="inline-end" />
                  </Link>
                </Button>
              </CardAction>
            </CardHeader>

            <CardContent className="px-0">
              {hosts.length === 0 ? (
                <InlineEmpty
                  icon={<PlugsConnectedIcon />}
                  title="No hosts saved yet"
                  body="A host is remembered the first time you connect to it."
                  action={{ href: "/dashboard/terminal", label: "Open terminal" }}
                />
              ) : (
                <ul className="divide-y divide-border">
                  {hosts.slice(0, 6).map((h) => (
                    <li
                      key={h.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-(--card-spacing) py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        {/* No host-key badge here. It read as a "pin to top"
                            marker rather than as key trust, and the state it
                            reported is not one anybody acts on: pinning happens
                            by itself on first connection, and a mismatch
                            refuses the connection outright rather than asking. */}
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium text-foreground">{h.label}</span>
                        </div>
                        <p className="truncate text-muted-foreground">
                          {h.username}@{h.hostname}:{h.port}
                          {h.lastUsedAt
                            ? ` · ${relative(h.lastUsedAt, readAt)}`
                            : " · never connected"}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="ml-auto shrink-0"
                        disabled={connecting === h.id}
                        onClick={() => void connectToHost(h)}
                      >
                        <TerminalWindowIcon data-icon="inline-start" />
                        {connecting === h.id ? "Connecting" : "Connect"}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>

            {hosts.length > 6 && (
              <CardContent className="border-t border-border pt-(--card-spacing) text-muted-foreground">
                {hosts.length - 6} more {hosts.length - 6 === 1 ? "host" : "hosts"} on this device.{" "}
                <Link href="/dashboard/hosts" className="text-primary hover:underline">
                  See all
                </Link>
                .
              </CardContent>
            )}
          </Card>

          {/* ---------------------------------------------------- activity */}
          <Card>
            <CardHeader className="border-b border-border">
              <CardTitle>Recent activity</CardTitle>
              <CardDescription>
                Reconstructed from local records. Session contents are never recorded, here or
                anywhere else.
              </CardDescription>
              <CardAction>
                <Button asChild variant="ghost" size="xs">
                  <Link href="/dashboard/activity">
                    Full log
                    <CaretRightIcon data-icon="inline-end" />
                  </Link>
                </Button>
              </CardAction>
            </CardHeader>

            <CardContent className="px-0">
              {activity.length === 0 ? (
                <InlineEmpty
                  icon={<ClockCounterClockwiseIcon />}
                  title="Nothing has happened on this device yet"
                  body="Generating a key, pinning a host key and connecting all show up here."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {activity.slice(0, 7).map((e) => (
                    <li key={e.id} className="flex items-start gap-3 px-(--card-spacing) py-2.5">
                      <span
                        aria-hidden
                        className="mt-px grid size-6 shrink-0 place-items-center rounded-sm border border-border bg-secondary text-primary"
                      >
                        {e.icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-foreground">{e.title}</p>
                        <p className="truncate text-muted-foreground">{e.detail}</p>
                      </div>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {relative(e.at, readAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ------------------------------------------------------- posture */}
        <div className="min-w-0">
          <Card className="lg:sticky lg:top-6">
            <CardHeader className="border-b border-border">
              <CardTitle className="flex items-center gap-2">
                <ShieldCheckIcon className="size-4 text-primary" />
                Security posture
              </CardTitle>
              <CardDescription>
                What this device can actually verify, not what we would like to claim.
              </CardDescription>
            </CardHeader>

            <CardContent className="px-0">
              <ul className="divide-y divide-border">
                {posture.map((p) => (
                  <li key={p.text} className="flex items-start gap-2.5 px-(--card-spacing) py-2.5">
                    <span
                      className={cn(
                        "mt-px shrink-0",
                        p.tone === "ok" && "text-success",
                        p.tone === "warn" && "text-warning",
                        p.tone === "info" && "text-muted-foreground",
                      )}
                    >
                      {p.tone === "ok" ? (
                        <CheckCircleIcon weight="fill" className="size-4" />
                      ) : p.tone === "warn" ? (
                        <WarningIcon weight="fill" className="size-4" />
                      ) : (
                        <InfoIcon className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0 text-foreground">
                      {p.text}
                      {p.hint && <span className="block text-muted-foreground">{p.hint}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>

            <CardContent className="border-t border-border pt-(--card-spacing)">
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link href="/security">Read the threat model</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- pieces */

function Stat({
  icon,
  label,
  value,
  caption,
}: {
  icon: React.ReactNode
  label: string
  value: number
  caption: string
}) {
  return (
    <Card size="sm">
      <CardContent className="min-w-0">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span className="[&_svg]:size-3.5">{icon}</span>
          <span className="truncate text-[10px] font-medium tracking-wider uppercase">{label}</span>
        </div>
        <p className="mt-1.5 font-heading text-2xl leading-none font-semibold tabular-nums">
          {value}
        </p>
        <p className="mt-1.5 text-muted-foreground">{caption}</p>
      </CardContent>
    </Card>
  )
}

function InlineEmpty({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode
  title: string
  body: string
  action?: { href: string; label: string }
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-(--card-spacing) py-6">
      <span
        aria-hidden
        className="grid size-8 place-items-center rounded-sm border border-border bg-secondary text-primary"
      >
        {icon}
      </span>
      <p className="font-heading text-sm font-medium">{title}</p>
      <p className="max-w-md text-muted-foreground">{body}</p>
      {action && (
        <Button asChild variant="outline" size="sm" className="mt-1">
          <Link href={action.href}>{action.label}</Link>
        </Button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- derivation */

interface ActivityEntry {
  id: string
  at: number
  title: string
  detail: string
  icon: React.ReactNode
}

/**
 * There is no local event log — nothing writes one, and the server's audit rows
 * are keyed by an HMAC it cannot reverse. So the timeline is derived from the
 * timestamps the records already carry, which is honest about its resolution:
 * one entry per record, not one per event.
 */
function buildActivity(hosts: Host[], keys: StoredKey[], pins: PinnedHostKey[]): ActivityEntry[] {
  const entries: ActivityEntry[] = []

  for (const h of hosts) {
    if (h.lastUsedAt) {
      entries.push({
        id: `host-used-${h.id}`,
        at: h.lastUsedAt,
        title: `Connected to ${h.label}`,
        detail: `${h.username}@${h.hostname}:${h.port}`,
        icon: <PlugsConnectedIcon className="size-3.5" />,
      })
    } else {
      entries.push({
        id: `host-added-${h.id}`,
        at: h.createdAt,
        title: `Saved host ${h.label}`,
        detail: `${h.username}@${h.hostname}:${h.port}`,
        icon: <HardDrivesIcon className="size-3.5" />,
      })
    }
  }

  for (const p of pins) {
    entries.push({
      id: `pin-${p.id}`,
      at: p.pinnedAt,
      title: `Pinned ${p.type} host key for ${p.id}`,
      detail: shortFingerprint(p.fingerprint),
      icon: <FingerprintIcon className="size-3.5" />,
    })
  }

  for (const k of keys) {
    entries.push({
      id: `key-${k.id}`,
      at: k.createdAt,
      title: `Generated ${k.mode} key ${k.label}`,
      detail:
        k.mode === "portable"
          ? "Wrapped with the vault key, syncs as ciphertext"
          : "Stays in this browser, never synced",
      icon: <KeyIcon className="size-3.5" />,
    })
  }

  return entries.sort((a, b) => b.at - a.at)
}

interface PostureLine {
  tone: "ok" | "warn" | "info"
  text: string
  hint?: string
}

function buildPosture({
  keys,
  portable,
  deviceBound,
}: {
  keys: StoredKey[]
  portable: number
  deviceBound: number
}): PostureLine[] {
  const lines: PostureLine[] = []

  if (keys.length === 0) {
    lines.push({
      tone: "warn",
      text: "No SSH key on this device",
      hint: "Generate one to connect without sending a password.",
    })
  } else if (portable > 0) {
    lines.push({
      tone: "ok",
      text: `Vault sync enabled · ${portable} portable ${plural(portable, "key")}`,
      hint: "Wrapped with your vault key before it leaves the tab.",
    })
  } else {
    lines.push({
      tone: "info",
      text: "No portable keys",
      hint: "Nothing here will appear on your other devices.",
    })
  }

  /* Host-key pinning used to contribute two lines here, one of them a warning
     about hosts nobody had connected to yet. Both were removed with the badge:
     they described bookkeeping the user does not drive and cannot act on. A
     mismatch still refuses the connection, which is where it matters. */

  if (deviceBound > 0) {
    lines.push({
      tone: "info",
      text: `${deviceBound} device-bound ${plural(deviceBound, "key")} won't sync`,
      hint: "Deliberate: it never leaves this browser, so another device needs its own key in authorized_keys.",
    })
  }

  lines.push({
    tone: "ok",
    text: "Private keys are non-extractable",
    hint: "WebCrypto refuses to export them — this page cannot read them either.",
  })

  return lines
}

/* ------------------------------------------------------------ formatting */

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}

function shortFingerprint(fp: string): string {
  return fp.length > 30 ? `${fp.slice(0, 30)}…` : fp
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
]

const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

/** Relative to the snapshot's read time, so every row on the page agrees. */
function relative(at: number, now: number): string {
  const delta = at - now
  const abs = Math.abs(delta)
  if (abs < 60_000) return "just now"
  for (const [unit, ms] of UNITS) {
    if (abs >= ms) return RTF.format(Math.round(delta / ms), unit)
  }
  return "just now"
}
