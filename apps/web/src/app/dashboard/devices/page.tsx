"use client";

/**
 * Registered devices.
 *
 * A client component, and it has to be. The list itself comes from
 * GET /api/devices, but two of the facts on this page exist only inside this
 * browser: which record is *this* device (src/lib/device.ts keeps the id in
 * IndexedDB next to a non-extractable Ed25519 signing key) and how many
 * device-bound SSH keys are stored here. The server cannot answer either one —
 * that is the whole point of device-bound custody — which is why every key
 * count on this page is scoped to this browser and says so, rather than being
 * presented per row as if the server knew.
 *
 * Revocation is a real DELETE. The server tombstones the record instead of
 * deleting it, so a revoked row stays visible here afterwards; the page refetches
 * so what you see is the state the server actually holds, not an optimistic guess.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AppleLogoIcon,
  ArrowsClockwiseIcon,
  DevicesIcon,
  GlobeIcon,
  KeyIcon,
  LinuxLogoIcon,
  LockKeyIcon,
  MonitorIcon,
  ProhibitIcon,
  ShieldWarningIcon,
  SignOutIcon,
  WarningCircleIcon,
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
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentDeviceId } from "@/lib/device";
import { listStoredKeys } from "@/lib/keys";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------- model */

type Platform = "macos" | "windows" | "linux" | "ios" | "android" | "other";

/**
 * One row of GET /api/devices, exactly as it arrives. Timestamps cross the wire
 * as ISO strings because that is what JSON does to a Date, and `platform` is
 * nullable because a device may have enrolled before the column existed or from
 * a client that did not send one.
 */
interface ApiDevice {
  id: string;
  label: string;
  platform: string | null;
  lastSeenAt: string | null;
  lastSeenIpPrefix: string | null;
  createdAt: string | null;
  revokedAt: string | null;
}

interface DeviceRecord {
  id: string;
  /** Defaulted to "<browser> on <os>" when the device enrolled. */
  label: string;
  platform: Platform;
  /** Epoch ms, or null when the server sent something unparseable. */
  createdAt: number | null;
  lastSeenAt: number | null;
  /**
   * The network the device was last seen on, already truncated server-side: /24
   * for IPv4, /48 for IPv6. Null when the request reached the app without a
   * forwarded address, which happens on a local or non-proxied deployment.
   */
  network: string | null;
  /** Set once revoked. The row is tombstoned, never deleted. */
  revokedAt: number | null;
}

const PLATFORMS: Record<Platform, { label: string; Icon: typeof AppleLogoIcon }> = {
  macos: { label: "macOS", Icon: AppleLogoIcon },
  windows: { label: "Windows", Icon: WindowsLogoIcon },
  linux: { label: "Linux", Icon: LinuxLogoIcon },
  ios: { label: "iOS", Icon: AppleLogoIcon },
  android: { label: "Android", Icon: GlobeIcon },
  other: { label: "Unknown platform", Icon: MonitorIcon },
};

/**
 * The four things this page can be showing. Errors are kept as a state rather
 * than a toast because a failed load leaves nothing on screen: the reason has
 * to live where the list would have been, next to a way to try again.
 */
type LoadState =
  | { status: "loading" }
  | { status: "ready"; devices: DeviceRecord[]; readAt: number }
  | { status: "unauthorized" }
  | { status: "error"; reason: string };

function toPlatform(value: string | null): Platform {
  return value !== null && value in PLATFORMS ? (value as Platform) : "other";
}

/** ISO string to epoch ms. A NaN would silently poison the relative formatter. */
function toTime(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function parseDevice(row: ApiDevice): DeviceRecord {
  return {
    id: row.id,
    label: row.label,
    platform: toPlatform(row.platform),
    createdAt: toTime(row.createdAt),
    lastSeenAt: toTime(row.lastSeenAt),
    network: row.lastSeenIpPrefix,
    revokedAt: toTime(row.revokedAt),
  };
}

/* -------------------------------------------------------------------- page */

export default function DevicesPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  /**
   * Both of these are browser-local and can only be read after mount. They stay
   * null when IndexedDB is unavailable (a private window, blocked storage) or
   * when this browser has simply never enrolled — in which case no row is marked
   * as "this device" and no key count is shown, which is the honest outcome.
   */
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [localBoundKeys, setLocalBoundKeys] = useState<number | null>(null);

  const load = useCallback(async (): Promise<"ok" | "unauthorized" | "error"> => {
    try {
      const res = await fetch("/api/devices", { cache: "no-store" });
      if (res.status === 401) {
        setState({ status: "unauthorized" });
        return "unauthorized";
      }
      if (!res.ok) {
        setState({ status: "error", reason: await failure(res) });
        return "error";
      }
      const payload = (await res.json()) as { devices?: ApiDevice[] };
      setState({
        status: "ready",
        devices: (payload.devices ?? []).map(parseDevice),
        // Captured once so every relative timestamp on the page agrees.
        readAt: Date.now(),
      });
      return "ok";
    } catch (e) {
      setState({ status: "error", reason: message(e) });
      return "error";
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // getCurrentDeviceId only reads; it does not enrol this browser, so
        // opening this page never creates a device record as a side effect.
        const [id, keys] = await Promise.all([getCurrentDeviceId(), listStoredKeys()]);
        if (cancelled) return;
        setCurrentDeviceId(id ?? null);
        setLocalBoundKeys(keys.filter((k) => k.mode === "device-bound").length);
      } catch {
        if (!cancelled) {
          setCurrentDeviceId(null);
          setLocalBoundKeys(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function revoke(device: DeviceRecord) {
    const isCurrent = device.id === currentDeviceId;
    setRevokingId(device.id);
    try {
      const res = await fetch(`/api/devices?id=${encodeURIComponent(device.id)}`, {
        method: "DELETE",
      });

      if (res.status === 401) {
        // Nothing was revoked, and the list on screen is no longer trustworthy
        // either, so drop to the signed-out view rather than leaving stale rows.
        setState({ status: "unauthorized" });
        throw new Error("The session has expired, so nothing was revoked. Sign in and try again.");
      }
      if (res.status === 404) {
        // The route answers 404 for "no such device, or already revoked". Either
        // way our view is stale, so say nothing happened and re-read.
        toast.error("Nothing was revoked", {
          description:
            "The server has no active device with that id — it may have been revoked already. Reloading the list.",
        });
        await load();
        return;
      }
      if (!res.ok) throw new Error(await failure(res));

      // Re-read rather than patch local state: the server tombstones, so the row
      // must come back marked revoked instead of disappearing. Refetching is also
      // how we find out what revoking *this* browser did to this session.
      const after = await load();

      if (isCurrent) {
        toast.success(`Revoked ${device.label}`, {
          description:
            after === "unauthorized"
              ? "That was this browser and the session went with it. Sign in again to enrol as a new device."
              : after === "ok"
                ? "The id is tombstoned, so this browser cannot re-register under it. The session row is deleted, but this reload was answered from the cached session cookie, so it stays usable for a few more minutes — sign out to end it now."
                : "The id is tombstoned, so this browser cannot re-register under it. The list could not be re-read, so whether this session survived is unknown — sign out to be sure.",
        });
      } else {
        toast.success(`Revoked ${device.label}`, {
          description:
            "The id is tombstoned, so that browser cannot register under it again.",
        });
      }
    } catch (e) {
      toast.error("Revoke failed", { description: message(e) });
    } finally {
      setRevokingId(null);
    }
  }

  const devices = state.status === "ready" ? state.devices : null;

  const rows = useMemo(() => {
    if (!devices) return [];
    // The API sorts by last seen. Revoked records are kept for reference rather
    // than for action, so they sink below the live ones; sort is stable, so the
    // server's ordering survives within each group.
    return [...devices].sort(
      (a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null),
    );
  }, [devices]);

  const stats = useMemo(() => {
    if (!devices) return null;
    const active = devices.filter((d) => d.revokedAt === null).length;
    return { total: devices.length, active, revoked: devices.length - active };
  }, [devices]);

  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow="Account"
        title="Devices"
        description="Every browser that has enrolled holds a non-extractable signing key and a record here. This is the list of things that can currently sign in as you and sync your vault."
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
            Revoking marks the record revoked, deletes the sessions stamped with
            that device id, and refuses any later attempt to register that
            browser&rsquo;s signing key again. A session is stamped when that
            browser registers, which happens on every sign-in — a session older
            than its browser&rsquo;s first registration carries no device id and
            is not matched, so use &ldquo;sign out everywhere&rdquo; in Settings
            if you need to be certain. The id is tombstoned rather than deleted,
            so it is never reissued and older activity rows stay resolvable.
            Signing in there again enrols a new device, with a new key and a new
            record.
          </p>
          <p>
            What it does not do: reach into a browser you no longer control. A
            connection already open there is not torn down, a relay token already
            issued stays valid for the rest of its minute, and device-bound keys
            stay in that browser&rsquo;s storage. If the device is lost, also
            remove those keys from{" "}
            <code className="text-foreground">~/.ssh/authorized_keys</code> on the
            hosts it could reach.
          </p>
        </AlertDescription>
      </Alert>

      {state.status === "loading" ? (
        <LoadingState />
      ) : state.status === "unauthorized" ? (
        <UnauthorizedState />
      ) : state.status === "error" ? (
        <ErrorState reason={state.reason} onRetry={() => void refresh()} busy={refreshing} />
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <Card className="mt-6">
          <CardHeader className="border-b border-border">
            <CardTitle>Registered devices</CardTitle>
            <CardDescription>
              {stats?.active === 1 ? "1 active device" : `${stats?.active} active devices`}
              {stats && stats.revoked > 0 && ` · ${stats.revoked} revoked`}
              {localBoundKeys !== null && localBoundKeys > 0 && (
                <>
                  {" · "}
                  {localBoundKeys} device-bound {localBoundKeys === 1 ? "key" : "keys"}{" "}
                  in this browser
                </>
              )}
              . Key counts exist for this browser only: a device-bound key never
              leaves the machine that made it, so neither the server nor this page
              can say what any other device holds.
            </CardDescription>
            <CardAction>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void refresh()}
                disabled={refreshing}
              >
                <ArrowsClockwiseIcon
                  data-icon="inline-start"
                  className={cn(refreshing && "animate-spin")}
                />
                Refresh
              </Button>
            </CardAction>
          </CardHeader>

          <CardContent className="px-0">
            <ul className="divide-y divide-border">
              {rows.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  now={state.readAt}
                  isCurrent={device.id === currentDeviceId}
                  localBoundKeys={localBoundKeys}
                  busy={revokingId === device.id}
                  onRevoke={() => void revoke(device)}
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
            key that this browser generated and cannot export. Revoking it ends
            the sessions stamped with its id and refuses that key for good. Say
            what is not true of it: the server never challenges the key, so
            registering a device is authenticated by your session and not by a
            signature — a stolen session could enrol a device of its own choosing
            until a challenge-response exists. Last-seen networks are truncated to
            a /24 for IPv4 and a /48 for IPv6, and are only as trustworthy as the
            proxy in front of the app; with none configured they are recorded as
            unknown rather than guessed.{" "}
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
  isCurrent,
  localBoundKeys,
  busy,
  onRevoke,
}: {
  device: DeviceRecord;
  now: number;
  isCurrent: boolean;
  /** Device-bound keys in *this* browser; only meaningful on the current row. */
  localBoundKeys: number | null;
  busy: boolean;
  onRevoke: () => void;
}) {
  const { label, Icon } = PLATFORMS[device.platform];
  const revoked = device.revokedAt !== null;
  const boundKeys = isCurrent ? localBoundKeys : null;

  return (
    <li
      className={cn(
        "flex flex-wrap items-start gap-x-4 gap-y-3 px-(--card-spacing) py-3",
        revoked && "opacity-70",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-8 shrink-0 place-items-center rounded-sm border border-border bg-secondary",
          revoked ? "text-muted-foreground" : isCurrent ? "text-primary" : "text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>

      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "truncate font-medium text-foreground",
              revoked && "line-through decoration-muted-foreground",
            )}
          >
            {device.label}
          </span>
          {isCurrent && (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <MonitorIcon className="text-primary" />
              This device
            </Badge>
          )}
          {revoked && (
            <Badge variant="destructive" className="gap-1">
              <ProhibitIcon />
              Revoked
            </Badge>
          )}
          {boundKeys !== null && boundKeys > 0 && (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <KeyIcon className="text-warning" />
              {boundKeys} device-bound here
            </Badge>
          )}
        </div>

        <p className="mt-0.5 truncate text-muted-foreground">
          {label} · registered {stamp(device.createdAt, now)}
        </p>

        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
          <Field
            term="Last seen"
            value={stamp(device.lastSeenAt, now)}
            title={absolute(device.lastSeenAt)}
          />
          <Field term="Network" value={device.network ?? "Not recorded"} mono />
          {revoked && (
            <Field
              term="Revoked"
              value={stamp(device.revokedAt, now)}
              title={absolute(device.revokedAt)}
            />
          )}
        </dl>
      </div>

      <div className="ml-auto shrink-0">
        {revoked ? (
          // Nothing to offer here: the row is a tombstone, and the API answers
          // 404 to a second DELETE. A disabled control that explains itself beats
          // a button that would only produce an error.
          <span className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground">
            <ProhibitIcon className="size-3.5" />
            Tombstoned · cannot re-register
          </span>
        ) : (
          <RevokeDialog
            device={device}
            isCurrent={isCurrent}
            localBoundKeys={boundKeys}
            busy={busy}
            onConfirm={onRevoke}
          />
        )}
      </div>
    </li>
  );
}

function Field({
  term,
  value,
  mono,
  title,
}: {
  term: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        {term}
      </dt>
      <dd className={cn("truncate text-foreground", mono && "tabular-nums")} title={title}>
        {value}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ revoke */

function RevokeDialog({
  device,
  isCurrent,
  localBoundKeys,
  busy,
  onConfirm,
}: {
  device: DeviceRecord;
  isCurrent: boolean;
  localBoundKeys: number | null;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10"
          disabled={busy}
        >
          <SignOutIcon data-icon="inline-start" />
          {busy ? "Revoking…" : "Revoke"}
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {device.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            {isCurrent
              ? "This is the browser you are using. Confirming deletes the sessions stamped with this device id, which will sign you out here, and there is no undo."
              : "The record is tombstoned and the sessions stamped with that device id are deleted."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <ul className="space-y-2 text-left text-xs/relaxed text-muted-foreground">
          <li className="flex gap-2">
            <span aria-hidden className="text-muted-foreground">
              —
            </span>
            <span className="min-w-0">
              Sessions stamped with this device id are deleted, so that
              browser&rsquo;s next request is rejected — with up to five minutes
              of lag, because a session that has read itself recently is served
              from a short-lived cookie cache rather than the database. A session
              that was never tied to a device id is not matched at all, and stays
              live until it expires or is signed out.
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
              {isCurrent && localBoundKeys !== null
                ? localBoundKeys > 0
                  ? `${localBoundKeys} device-bound ${localBoundKeys === 1 ? "key stays" : "keys stay"} in this browser's storage — revoking the device record does not delete them. Remove the matching ${localBoundKeys === 1 ? "line" : "lines"} from ~/.ssh/authorized_keys to cut off access to your hosts.`
                  : "No device-bound keys are stored in this browser, so nothing is stranded. Portable keys are wrapped in the vault and stay available wherever you unlock it."
                : "Whether that browser holds device-bound keys cannot be answered from here — such keys never leave the machine that made them, so neither the server nor this page has ever seen them. If it might hold any, remove the matching lines from ~/.ssh/authorized_keys."}
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

/**
 * The device list is per-account, so without a session there is nothing to show
 * and no useful subset to guess at.
 */
function UnauthorizedState() {
  return (
    <Card className="mt-6">
      <CardContent className="flex flex-col items-start gap-2 py-4">
        <span
          aria-hidden
          className="grid size-8 place-items-center rounded-sm border border-border bg-secondary text-primary"
        >
          <LockKeyIcon className="size-4" />
        </span>
        <p className="font-heading text-sm font-medium">Sign in to see your devices</p>
        <p className="max-w-lg text-muted-foreground">
          The device registry belongs to an account, and this session is not
          signed in — or it has just ended, which is what happens when you revoke
          the browser you are sitting at.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-1">
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function ErrorState({
  reason,
  onRetry,
  busy,
}: {
  reason: string;
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <Alert variant="destructive" className="mt-6">
      <WarningCircleIcon />
      <AlertTitle>Could not load your devices</AlertTitle>
      <AlertDescription>
        <p>
          {reason} Nothing is listed below because nothing was read — this is not
          an empty registry, it is an unanswered request.
        </p>
        <Button variant="outline" size="sm" className="mt-1" onClick={onRetry} disabled={busy}>
          <ArrowsClockwiseIcon
            data-icon="inline-start"
            className={cn(busy && "animate-spin")}
          />
          Try again
        </Button>
      </AlertDescription>
    </Alert>
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
          A device is registered the first time a browser enrols with this
          account. The registry is genuinely empty — the request succeeded and
          returned nothing.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-1">
          <Link href="/dashboard/terminal">Open terminal</Link>
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

/** An unparseable timestamp says so rather than rendering as 1970 or NaN. */
function stamp(at: number | null, now: number): string {
  return at === null ? "unknown" : relative(at, now);
}

function absolute(at: number | null): string | undefined {
  return at === null ? undefined : new Date(at).toLocaleString();
}

/* ------------------------------------------------------------------ errors */

/**
 * The API answers failures with { error }. Showing that string beats a generic
 * apology: "device revoked" and "id required" mean different things to whoever
 * has to fix them.
 */
async function failure(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) {
      return `The server refused the request: ${body.error} (HTTP ${res.status}).`;
    }
  } catch {
    // No JSON body — a proxy error page or an empty response. Fall through.
  }
  return `The server returned ${res.status}.`;
}

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message?: unknown }).message ?? "Unknown error");
  }
  return String(e ?? "Unknown error");
}
