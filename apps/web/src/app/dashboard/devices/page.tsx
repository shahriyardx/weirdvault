"use client";

/**
 * Registered devices.
 *
 * A client component because the list is mutated in place: revoking a device
 * removes a row, and the confirmation lives in an alert dialog with its own
 * state. Nothing here can be rendered on the server anyway — the device record
 * is about this browser as much as about the account.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AppleLogoIcon,
  DevicesIcon,
  GlobeIcon,
  KeyIcon,
  LinuxLogoIcon,
  MonitorIcon,
  ProhibitIcon,
  ShieldWarningIcon,
  SignOutIcon,
  WindowsLogoIcon,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { PageHeader } from "@/components/shell/page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------- model */

type Platform = "macos" | "windows" | "linux" | "ios" | "android" | "other";

interface DeviceRecord {
  id: string;
  /** User-editable name; defaults to "<browser> on <os>" when the device enrols. */
  label: string;
  platform: Platform;
  browser: string;
  /**
   * Minutes before this page loaded. The API returns absolute timestamps —
   * offsets keep the placeholder plausible whenever the page is opened.
   */
  registeredAgo: number;
  lastSeenAgo: number;
  /**
   * The network the device was last seen on, already truncated: /24 for IPv4,
   * /48 for IPv6. Full addresses are not shown on this page.
   */
  network: string;
  /** Keys generated on that device that were never synced anywhere else. */
  deviceBoundKeys: number;
  current?: boolean;
}

/**
 * PLACEHOLDER DATA — awaiting GET /api/devices.
 *
 * Shaped like the response that endpoint will return, so swapping this constant
 * for a fetch is the only change this page needs. No request is made here: the
 * route does not exist yet and inventing one would fail silently in the UI.
 */
const PLACEHOLDER_DEVICES: DeviceRecord[] = [
  {
    id: "6f1c9a24-4c1b-4a8e-9d0a-2b7f5e11c3a2",
    label: "Chrome on Mac",
    platform: "macos",
    browser: "Chrome 141",
    registeredAgo: 60 * 24 * 96,
    lastSeenAgo: 2,
    network: "203.0.113.0/24",
    deviceBoundKeys: 1,
    current: true,
  },
  {
    id: "b3d8e770-1f42-4b6d-8f9c-51a0c6d2e884",
    label: "Firefox on Linux",
    platform: "linux",
    browser: "Firefox 145",
    registeredAgo: 60 * 24 * 41,
    lastSeenAgo: 60 * 19,
    network: "198.51.100.0/24",
    deviceBoundKeys: 2,
  },
  {
    id: "cc41b0f5-9a3e-4d17-b2c8-6e0f4a9d1b73",
    label: "Safari on iPhone",
    platform: "ios",
    browser: "Safari 26",
    registeredAgo: 60 * 24 * 22,
    lastSeenAgo: 60 * 24 * 5,
    network: "2001:db8:4f2::/48",
    deviceBoundKeys: 0,
  },
  {
    id: "0a7e2d63-58cf-42b1-9e35-cd8a71f4b206",
    label: "Edge on the office desktop",
    platform: "windows",
    browser: "Edge 141",
    registeredAgo: 60 * 24 * 137,
    lastSeenAgo: 60 * 24 * 63,
    network: "192.0.2.0/24",
    deviceBoundKeys: 0,
  },
];

const PLATFORMS: Record<Platform, { label: string; Icon: typeof AppleLogoIcon }> = {
  macos: { label: "macOS", Icon: AppleLogoIcon },
  windows: { label: "Windows", Icon: WindowsLogoIcon },
  linux: { label: "Linux", Icon: LinuxLogoIcon },
  ios: { label: "iOS", Icon: AppleLogoIcon },
  android: { label: "Android", Icon: GlobeIcon },
  other: { label: "Unknown platform", Icon: MonitorIcon },
};

interface Snapshot {
  devices: DeviceRecord[];
  /** Captured once so every relative timestamp on the page agrees. */
  readAt: number;
}

/* -------------------------------------------------------------------- page */

export default function DevicesPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    // Stands in for `fetch("/api/devices")`. The delay is here so the loading
    // state is real rather than decorative; replace the whole effect body with
    // the request once the route lands.
    const timer = setTimeout(
      () => setSnapshot({ devices: PLACEHOLDER_DEVICES, readAt: Date.now() }),
      420,
    );
    return () => clearTimeout(timer);
  }, []);

  function revoke(device: DeviceRecord) {
    // Local only until DELETE /api/devices/:id exists. The row is dropped so
    // the interaction is complete end to end; nothing is sent anywhere.
    setSnapshot((prev) =>
      prev ? { ...prev, devices: prev.devices.filter((d) => d.id !== device.id) } : prev,
    );
    toast.success(`Revoked ${device.label}`, {
      description:
        "The device is signed out and its id is tombstoned, so it cannot register again.",
    });
  }

  const stats = useMemo(() => {
    if (!snapshot) return null;
    const boundKeys = snapshot.devices.reduce((n, d) => n + d.deviceBoundKeys, 0);
    return { count: snapshot.devices.length, boundKeys };
  }, [snapshot]);

  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow="Account"
        title="Devices"
        description="Every browser that has unlocked your vault holds a non-extractable signing key and a record here. This is the list of things that can currently sync."
        actions={
          <Button asChild variant="outline">
            <Link href="/dashboard/activity">Device history</Link>
          </Button>
        }
      />

      <Alert className="mt-6">
        <ProhibitIcon />
        <AlertTitle>Revoking is permanent for that device</AlertTitle>
        <AlertDescription>
          <p>
            Revoking signs the device out immediately, refuses its next sync, and
            tombstones its id so the same browser cannot re-register under it. If
            you sign in there again it enrols as a new device with a new key and
            a new record — the revoked id is never reissued, which is what keeps
            older activity rows resolvable.
          </p>
          <p>
            Revocation cannot reach into a browser you no longer control.
            Device-bound keys stay in its storage, so if the device is lost,
            remove that key from <code className="text-foreground">~/.ssh/authorized_keys</code>{" "}
            on the hosts it could reach.
          </p>
        </AlertDescription>
      </Alert>

      {snapshot === null ? (
        <LoadingState />
      ) : snapshot.devices.length === 0 ? (
        <EmptyState />
      ) : (
        <Card className="mt-6">
          <CardHeader className="border-b border-border">
            <CardTitle>Registered devices</CardTitle>
            <CardDescription>
              {stats?.count === 1 ? "1 device" : `${stats?.count} devices`}
              {stats && stats.boundKeys > 0 && (
                <>
                  {" · "}
                  {stats.boundKeys} device-bound{" "}
                  {stats.boundKeys === 1 ? "key" : "keys"} that exist nowhere else
                </>
              )}
            </CardDescription>
          </CardHeader>

          <CardContent className="px-0">
            <ul className="divide-y divide-border">
              {snapshot.devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  now={snapshot.readAt}
                  onRevoke={() => revoke(device)}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card size="sm" className="mt-6">
        <CardContent className="flex items-start gap-2.5 text-muted-foreground">
          <ShieldWarningIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          <p className="min-w-0">
            A device record is a label, a platform string and an Ed25519 public
            key. The matching private key is non-extractable and stays in that
            browser, which is what makes &ldquo;revoke that laptop&rdquo;
            meaningful rather than a cookie you could copy. Last-seen networks
            are truncated to a /24 for IPv4 and a /48 for IPv6 — enough to
            recognise an unfamiliar one, not a precise locator.{" "}
            <Link href="/security" className="text-primary hover:underline">
              Read the threat model
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------------- row */

function DeviceRow({
  device,
  now,
  onRevoke,
}: {
  device: DeviceRecord;
  now: number;
  onRevoke: () => void;
}) {
  const { label, Icon } = PLATFORMS[device.platform];

  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 px-(--card-spacing) py-3">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-8 shrink-0 place-items-center rounded-sm border border-border bg-secondary",
          device.current ? "text-primary" : "text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>

      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium text-foreground">{device.label}</span>
          {device.current && (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <MonitorIcon className="text-primary" />
              This device
            </Badge>
          )}
          {device.deviceBoundKeys > 0 && (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <KeyIcon className="text-warning" />
              {device.deviceBoundKeys} device-bound
            </Badge>
          )}
        </div>

        <p className="mt-0.5 truncate text-muted-foreground">
          {device.browser} · {label} · registered {relative(now - device.registeredAgo * 60_000, now)}
        </p>

        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
          <Field
            term="Last seen"
            value={
              device.current
                ? "Now, in this tab"
                : relative(now - device.lastSeenAgo * 60_000, now)
            }
          />
          <Field term="Network" value={device.network} mono />
        </dl>
      </div>

      <div className="ml-auto shrink-0">
        <RevokeDialog device={device} onConfirm={onRevoke} />
      </div>
    </li>
  );
}

function Field({ term, value, mono }: { term: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        {term}
      </dt>
      <dd className={cn("truncate text-foreground", mono && "tabular-nums")}>{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------ revoke */

function RevokeDialog({
  device,
  onConfirm,
}: {
  device: DeviceRecord;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10">
          <SignOutIcon data-icon="inline-start" />
          Revoke
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {device.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            {device.current
              ? "This is the browser you are using. Confirming signs you out here and you will need to sign in again, which enrols this browser as a new device."
              : "The device is signed out at once and its next sync is refused."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <ul className="space-y-2 text-left text-xs/relaxed text-muted-foreground">
          <li className="flex gap-2">
            <span aria-hidden className="text-muted-foreground">
              —
            </span>
            <span className="min-w-0">
              Open sessions end. The relay stops forwarding for that device the
              moment it checks in.
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="text-muted-foreground">
              —
            </span>
            <span className="min-w-0">
              The id is tombstoned, not deleted, so it can never be registered
              again and existing activity rows still resolve to a name.
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="text-muted-foreground">
              —
            </span>
            <span className="min-w-0">
              {device.deviceBoundKeys > 0
                ? `${device.deviceBoundKeys} device-bound ${device.deviceBoundKeys === 1 ? "key stays" : "keys stay"} in that browser's storage. Remove the matching public ${device.deviceBoundKeys === 1 ? "key" : "keys"} from ~/.ssh/authorized_keys to cut off access to your hosts.`
                : "No device-bound keys are stored there, so nothing is stranded. Portable keys stay in the vault and remain available on your other devices."}
            </span>
          </li>
        </ul>

        <AlertDialogFooter>
          <AlertDialogCancel>Keep device</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Revoke device
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ------------------------------------------------------------------ states */

function LoadingState() {
  return (
    <Card className="mt-6" aria-busy="true" aria-label="Loading devices">
      <CardHeader className="border-b border-border">
        <Skeleton className="h-4 w-40" />
      </CardHeader>
      <CardContent className="px-0">
        <ul className="divide-y divide-border">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-start gap-4 px-(--card-spacing) py-3">
              <Skeleton className="size-8 shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-3 w-56" />
                <div className="flex gap-6 pt-1">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-28" />
                </div>
              </div>
              <Skeleton className="h-7 w-16 shrink-0" />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card className="mt-6">
      <CardContent className="flex flex-col items-start gap-2 py-4">
        <span
          aria-hidden
          className="grid size-8 place-items-center rounded-sm border border-border bg-secondary text-primary"
        >
          <DevicesIcon className="size-4" />
        </span>
        <p className="font-heading text-sm font-medium">No devices registered</p>
        <p className="max-w-lg text-muted-foreground">
          A device is registered the first time a browser unlocks your vault. If
          you have just revoked everything, sign in again on the browser you want
          to keep and it will enrol with a new key.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-1">
          <Link href="/workspace">Open workspace</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------- formatting */

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** Relative to the snapshot's read time, so every row on the page agrees. */
function relative(at: number, now: number): string {
  const delta = at - now;
  const abs = Math.abs(delta);
  if (abs < 60_000) return "just now";
  for (const [unit, ms] of UNITS) {
    if (abs >= ms) return RTF.format(Math.round(delta / ms), unit);
  }
  return "just now";
}
