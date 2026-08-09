"use client";

/**
 * Activity log.
 *
 * A client component for two reasons. The filters are local state, and — more
 * fundamentally — the host column cannot be rendered on the server. The API
 * returns a blinded reference per event; turning that reference back into a
 * readable label requires the audit key, which only this browser holds.
 *
 * Three requests feed this page and they fail independently. /api/audit is the
 * page: without it there is nothing to show, so its failure is the page's
 * failure. /api/devices only supplies labels, so losing it degrades the device
 * column to ids rather than blanking the log. The host index is built entirely
 * locally from the vault, so it needs no request at all — but it needs the
 * vault unlocked, and when it is not, every host reads as an opaque reference.
 * Each of those states says so on screen rather than looking like an empty log.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowClockwiseIcon,
  ArrowsClockwiseIcon,
  BroadcastIcon,
  ClockCounterClockwiseIcon,
  DatabaseIcon,
  DevicesIcon,
  DownloadSimpleIcon,
  EyeSlashIcon,
  FingerprintIcon,
  FingerprintSimpleIcon,
  FunnelIcon,
  HardDrivesIcon,
  KeyIcon,
  LifebuoyIcon,
  LockKeyIcon,
  MagnifyingGlassIcon,
  MonitorIcon,
  PlugsConnectedIcon,
  PlugsIcon,
  ProhibitIcon,
  QuestionIcon,
  ShieldCheckIcon,
  SignInIcon,
  SignOutIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
  WarningOctagonIcon,
  XCircleIcon,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { PageHeader } from "@/components/shell/page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  EMITTED_EVENTS,
  EMITTED_SOURCES,
  UNEMITTED_EVENTS,
  type AuditEventType,
} from "@/lib/audit/events";
import {
  AuditFetchError,
  buildHostLabels,
  describeEvent,
  fetchAuditPage,
  fetchDevices,
  isKnownEvent,
  mergePages,
  shortId,
  shortRef,
  type AuditRow,
  type DeviceSummary,
} from "@/lib/audit/query";
import {
  AUDIT_RETENTION_LABEL,
  type AuditRetentionWindow,
} from "@/lib/audit/retention";
import { getAuditKey, requestUnlock, useVaultUnlocked } from "@/lib/vault/session";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------- model */

const EVENT_LABELS: Record<AuditEventType, string> = {
  "auth.signin": "Signed in",
  "auth.signout": "Signed out",
  "device.registered": "Device registered",
  "device.revoked": "Device revoked",
  "vault.synced": "Vault synced",
  "recovery.enrolled": "Recovery codes generated",
  "recovery.redeemed": "Recovery code used to sign in",
  "recovery.disabled": "Recovery codes removed",
  // Worded to say what they protect. None of these four touches the vault, and
  // a label like "Two-factor enabled" invites the reader to think otherwise.
  "totp.enrolled": "Authenticator app added",
  "totp.disabled": "Authenticator app removed",
  "totp.verified": "Second factor accepted at sign-in",
  "totp.codes-reissued": "Backup codes replaced",
  "passkey.registered": "Passkey added",
  "passkey.removed": "Passkey removed",
  "passkey.used": "Signed in with a passkey",
  "connection.opened": "Connection opened",
  "connection.closed": "Connection closed",
  "key.installed": "Key installed on host",
  "hostkey.pinned": "Host key pinned",
  "hostkey.mismatch": "Host key mismatch",
  "hostkey.cleared": "Host key cleared",
};

const EVENT_ICONS: Record<AuditEventType, typeof KeyIcon> = {
  "auth.signin": SignInIcon,
  "auth.signout": SignOutIcon,
  "device.registered": DevicesIcon,
  "device.revoked": ProhibitIcon,
  "vault.synced": ArrowsClockwiseIcon,
  "recovery.enrolled": LifebuoyIcon,
  "recovery.redeemed": LifebuoyIcon,
  "recovery.disabled": ProhibitIcon,
  "totp.enrolled": ShieldCheckIcon,
  "totp.disabled": ProhibitIcon,
  "totp.verified": ShieldCheckIcon,
  "totp.codes-reissued": LifebuoyIcon,
  "passkey.registered": FingerprintSimpleIcon,
  "passkey.removed": ProhibitIcon,
  "passkey.used": FingerprintSimpleIcon,
  "connection.opened": PlugsConnectedIcon,
  "connection.closed": PlugsIcon,
  "key.installed": KeyIcon,
  "hostkey.pinned": FingerprintIcon,
  "hostkey.mismatch": WarningOctagonIcon,
  "hostkey.cleared": FingerprintIcon,
};

const SOURCE_META: Record<
  string,
  { label: string; Icon: typeof DatabaseIcon; tone: string }
> = {
  server: { label: "server", Icon: DatabaseIcon, tone: "text-primary" },
  relay: { label: "relay", Icon: BroadcastIcon, tone: "text-primary" },
  client: { label: "client", Icon: MonitorIcon, tone: "text-warning" },
};

const RANGES = [
  { value: "24h", label: "Last 24 hours", minutes: 60 * 24 },
  { value: "7d", label: "Last 7 days", minutes: 60 * 24 * 7 },
  { value: "30d", label: "Last 30 days", minutes: 60 * 24 * 30 },
  { value: "12m", label: "Last 12 months", minutes: 60 * 24 * 365 },
  { value: "all", label: "Everything loaded", minutes: Number.POSITIVE_INFINITY },
] as const;

type RangeValue = (typeof RANGES)[number]["value"];

const DEFAULT_RANGE: RangeValue = "30d";

/**
 * The retention window this page is showing, derived from what the server said.
 *
 * These used to be module constants, resolved in the browser from a tier that
 * was the same for everybody. That stopped being true when Pro became a real
 * subscription: a tab knows which account it is signed into and nothing about
 * what that account pays, so a locally resolved window would show twelve months
 * to a Free account or thirty days to somebody who had just upgraded. The window
 * now arrives on the /api/audit response, from the side that enforces it.
 *
 * Which means it can be unknown, and unknown has to render as unknown. Every
 * caller below handles a null: the page says nothing about retention until the
 * first response lands, rather than filling the gap with the Free numbers and
 * being wrong for half the accounts.
 */
interface RetentionView {
  label: string;
  /** The oldest event that can exist, as the server computed it. */
  since: Date;
  /** For comparing against a selected range. */
  minutes: number;
}

function retentionView(window: AuditRetentionWindow | null): RetentionView | null {
  if (!window) return null;
  return {
    label: AUDIT_RETENTION_LABEL[window.tier],
    // The server's own cutoff rather than one recomputed here from `days`. They
    // agree by construction today, and taking the server's removes the class of
    // bug where they stop agreeing by a few hours of clock drift.
    since: new Date(window.since),
    minutes: window.days * 24 * 60,
  };
}

/**
 * A row with everything the browser had to work out attached: the device label,
 * the host label, and the metadata rendered into a line of text. All three are
 * derived once here rather than inside the render, because the text filter
 * searches over them as well as over the raw row.
 */
interface DecoratedRow {
  row: AuditRow;
  /** Never blank. Falls back to the shortened id, or to "Unknown device". */
  deviceName: string;
  deviceRevoked: boolean;
  /**
   * Null when nothing here resolved the reference: no matching host in this
   * vault, or no audit key in this tab to try one with. The row still renders.
   */
  hostLabel: string | null;
  detail: string | null;
}

/** How the audit request itself is doing. Everything else degrades in place. */
type LogState =
  | { phase: "loading" }
  | { phase: "ready" }
  | { phase: "unauthorized" }
  | { phase: "error"; message: string };

/**
 * How host resolution is doing. "locked" is the ordinary case after a page
 * reload — the audit key lives in memory only — and is recoverable from here.
 */
type HostIndexState = "resolving" | "ready" | "locked" | "no-audit-key" | "failed";

/**
 * What to say about a reference that did not resolve.
 *
 * The words have to distinguish "this vault has no such host" from "this tab
 * could not look", because the first is a fact about the account and the second
 * is a fact about the browser. Every variant ends the same way: the server
 * cannot resolve it either, which is the property the blinding exists for and
 * the reason this column is not a bug.
 */
const OPAQUE_COPY: Record<HostIndexState, { caption: string; tooltip: string }> = {
  ready: {
    caption: "not in this vault",
    tooltip:
      "This is HMAC(audit key, host and port), and no host saved in this vault produces it — a one-off connection, or one saved on a device that has not synced here. The server cannot resolve it either: it has never held the name.",
  },
  resolving: {
    caption: "resolving…",
    tooltip:
      "This device is still hashing your saved hosts to see which reference each one produces.",
  },
  locked: {
    caption: "vault locked",
    tooltip:
      "This is HMAC(audit key, host and port). Unlock the vault and this device can hash your saved hosts and match them. The server can never match them: it has never held the name.",
  },
  "no-audit-key": {
    caption: "no audit key here",
    tooltip:
      "This tab holds the vault key but not the audit branch it is derived alongside, so references cannot be matched. The server cannot match them either: it has never held the name.",
  },
  failed: {
    caption: "host list unreadable",
    tooltip:
      "The saved host list could not be read in this browser, so there was nothing to match this reference against. The server cannot resolve it either: it has never held the name.",
  },
};

/* -------------------------------------------------------------------- page */

export default function ActivityPage() {
  const unlocked = useVaultUnlocked();

  const [state, setState] = useState<LogState>({ phase: "loading" });
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /**
   * The window the server applied, as it reported it. Null until the first
   * response lands, and null it stays if the response carried no usable block —
   * every sentence about retention below is suppressed rather than guessed.
   */
  const [retentionWindow, setRetentionWindow] = useState<AuditRetentionWindow | null>(null);
  /** Fixed when the first page lands, so every timestamp on screen agrees. */
  const [readAt, setReadAt] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);

  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [devicesFailed, setDevicesFailed] = useState(false);

  const [hostLabels, setHostLabels] = useState<Map<string, string>>(() => new Map());
  const [hostIndex, setHostIndex] = useState<HostIndexState>("resolving");

  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | string>("all");
  const [source, setSource] = useState<"all" | string>("all");
  const [device, setDevice] = useState<"all" | string>("all");
  const [range, setRange] = useState<RangeValue>(DEFAULT_RANGE);

  // The log itself. `attempt` is what the retry button bumps.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setState({ phase: "loading" });
      try {
        const page = await fetchAuditPage();
        if (cancelled) return;
        setRows(page.rows);
        setCursor(page.nextCursor);
        setRetentionWindow(page.retention);
        setReadAt(Date.now());
        setState({ phase: "ready" });
      } catch (error) {
        if (cancelled) return;
        const kind = error instanceof AuditFetchError ? error.kind : "server";
        setState(
          kind === "unauthorized"
            ? { phase: "unauthorized" }
            : { phase: "error", message: message(error) },
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Device labels. A failure here is not the page's failure: the rows still
  // carry ids, so the column degrades to those and says why.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const list = await fetchDevices();
        if (cancelled) return;
        setDevices(list);
        setDevicesFailed(false);
      } catch {
        if (!cancelled) setDevicesFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Host resolution. Re-runs when the vault unlocks, which is the whole reason
  // `unlocked` is read reactively rather than as a one-off.
  useEffect(() => {
    let cancelled = false;
    const auditKey = getAuditKey();

    void (async () => {
      if (!auditKey) {
        // Locked is the common case after a reload; unlocked-without-an-audit-key
        // means the key was derived without its HMAC branch, which needs saying
        // differently because unlocking again is not the fix.
        setHostLabels(new Map());
        setHostIndex(unlocked ? "no-audit-key" : "locked");
        return;
      }

      setHostIndex("resolving");
      try {
        const index = await buildHostLabels(auditKey);
        if (cancelled) return;
        setHostLabels(index);
        setHostIndex("ready");
      } catch {
        if (cancelled) return;
        setHostLabels(new Map());
        setHostIndex("failed");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [unlocked]);

  const deviceIndex = useMemo(
    () => new Map(devices.map((d) => [d.id, d])),
    [devices],
  );

  const deviceLabel = useCallback(
    (id: string) => deviceIndex.get(id)?.label ?? null,
    [deviceIndex],
  );

  const decorated = useMemo<DecoratedRow[]>(
    () =>
      rows.map((row) => {
        const known = row.deviceId ? deviceIndex.get(row.deviceId) : undefined;
        return {
          row,
          deviceName: describeDevice(row.deviceId, known, devicesFailed),
          deviceRevoked: known?.revokedAt != null,
          hostLabel: row.targetRef ? (hostLabels.get(row.targetRef) ?? null) : null,
          detail: describeEvent(row, deviceLabel),
        };
      }),
    [rows, deviceIndex, devicesFailed, hostLabels, deviceLabel],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const minutes = RANGES.find((r) => r.value === range)?.minutes ?? Infinity;
    const cutoff = Number.isFinite(minutes) ? readAt - minutes * 60_000 : -Infinity;

    return decorated.filter((item) => {
      const { row } = item;
      if (row.at < cutoff) return false;
      if (type !== "all" && row.eventType !== type) return false;
      if (source !== "all" && row.source !== source) return false;
      if (device !== "all" && row.deviceId !== device) return false;
      if (!needle) return true;

      const haystack = [
        eventLabel(row.eventType),
        row.eventType,
        row.source,
        item.deviceName,
        item.hostLabel ?? "",
        row.targetRef ?? "",
        row.ipPrefix ?? "",
        item.detail ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [decorated, query, type, source, device, range, readAt]);

  const unresolved = useMemo(
    () => filtered.filter((item) => item.row.targetRef && !item.hostLabel).length,
    [filtered],
  );

  /**
   * The device filter lists registered devices plus any id that appears in the
   * loaded rows without one. Dropping those would hide the events most worth
   * looking at — a device that is gone from the registry but wrote rows.
   */
  const deviceOptions = useMemo(() => {
    const options = devices.map((d) => ({
      id: d.id,
      label: d.revokedAt ? `${d.label} (revoked)` : d.label,
    }));
    const listed = new Set(devices.map((d) => d.id));
    for (const row of rows) {
      if (row.deviceId && !listed.has(row.deviceId)) {
        listed.add(row.deviceId);
        options.push({ id: row.deviceId, label: `Unknown device ${shortId(row.deviceId)}` });
      }
    }
    return options;
  }, [devices, rows]);

  /**
   * The window as this page will render it, or null while it is unknown.
   *
   * The oldest event that can exist is the server's own cutoff rather than one
   * recomputed here, so the boundary on screen is the boundary in the WHERE
   * clause and not an approximation of it.
   */
  const retention = useMemo(() => retentionView(retentionWindow), [retentionWindow]);

  /**
   * Whether the chosen range asks for more history than is kept.
   *
   * Worth saying out loud, because the two ways this page can be empty look
   * identical and mean opposite things: nothing happened, or it happened and was
   * deleted. A user checking twelve months back for a device registration they
   * half remember deserves to know which of those they are looking at.
   *
   * False while the window is unknown. Warning that a range exceeds a window
   * nobody has told us about would be inventing the very number this page stopped
   * inventing.
   */
  const selectedRange = RANGES.find((r) => r.value === range);
  const rangeLabel = selectedRange?.label ?? "This range";
  const rangeExceedsWindow =
    retention !== null && (selectedRange?.minutes ?? Infinity) > retention.minutes;

  const filtersActive =
    query !== "" ||
    type !== "all" ||
    source !== "all" ||
    device !== "all" ||
    range !== DEFAULT_RANGE;

  function clearFilters() {
    setQuery("");
    setType("all");
    setSource("all");
    setDevice("all");
    setRange(DEFAULT_RANGE);
  }

  async function loadOlder() {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await fetchAuditPage({ before: cursor });
      setRows((prev) => mergePages(prev, page.rows));
      setCursor(page.nextCursor);
      // Re-stated on every page, and taken every time: a subscription that
      // started or lapsed between two requests changes the window, and the later
      // response is the one the server is enforcing.
      setRetentionWindow(page.retention);
      if (page.rows.length === 0) {
        toast.message("No older events came back", {
          description: "The server had nothing before that point.",
        });
      }
    } catch (error) {
      toast.error("Could not load older events", { description: message(error) });
    } finally {
      setLoadingOlder(false);
    }
  }

  /**
   * Both exports are built here, from the rows on screen, with the labels this
   * device resolved. The server cannot produce either file: it has never seen a
   * host name, and it holds no device label for a row it only knows by id.
   */
  function exportEvents(format: "json" | "csv") {
    if (filtered.length === 0) return;

    const records = filtered.map((item) => ({
      time: new Date(item.row.at).toISOString(),
      type: item.row.eventType,
      source: item.row.source,
      deviceId: item.row.deviceId,
      device: item.row.deviceId ? (deviceLabel(item.row.deviceId) ?? null) : null,
      hostRef: item.row.targetRef,
      host: item.hostLabel,
      network: item.row.ipPrefix,
      detail: item.detail,
      // Carried for the JSON export only; the CSV writes named columns, and
      // flattening an open-ended object into them would either lose keys or
      // grow a column per event type.
      metadata: item.row.metadata,
    }));

    const name = `webxterm-activity-${stamp(readAt)}.${format}`;
    if (format === "json") {
      download(
        name,
        JSON.stringify({ exportedAt: new Date().toISOString(), events: records }, null, 2),
        "application/json",
      );
    } else {
      download(name, toCsv(records), "text/csv");
    }

    toast.success(
      `Exported ${filtered.length} ${filtered.length === 1 ? "event" : "events"}`,
      {
        description:
          unresolved > 0
            ? `${unresolved} ${unresolved === 1 ? "row keeps" : "rows keep"} an unresolved host reference, exactly as stored.`
            : "Host labels were resolved in this tab. The copy on the server holds references only.",
      },
    );
  }

  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow="Account"
        title="Activity"
        description="Device registrations and revocations, recovery-code use, host key decisions and keys installed on a host. Session contents are never recorded — no commands, no keystrokes, no file names."
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={filtered.length === 0}>
                <DownloadSimpleIcon data-icon="inline-start" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => exportEvents("json")}>
                JSON, with raw metadata
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => exportEvents("csv")}>
                CSV, one row per event
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
        Hosts are stored as blinded references and resolved to names here, on
        this device. Rows marked <span className="text-foreground">client</span>{" "}
        are self-reported by a browser;{" "}
        <span className="text-foreground">server</span> and{" "}
        <span className="text-foreground">relay</span> rows are written outside
        it.{" "}
        <Link href="/security#threat-model" className="underline underline-offset-4 hover:text-foreground">
          How this works
        </Link>
      </p>

      {/* ------------------------------------------------- what cannot resolve */}
      {(hostIndex === "locked" || hostIndex === "no-audit-key" || hostIndex === "failed") && (
        <HostIndexNotice state={hostIndex} />
      )}

      {devicesFailed && (
        <Alert className="mt-4">
          <WarningCircleIcon />
          <AlertTitle>Device names are unavailable</AlertTitle>
          <AlertDescription>
            <p>
              The device list could not be read, so the device column shows the
              shortened id each row was written with. The log itself is
              unaffected — device names are only a lookup performed here.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* --------------------------------------------------------- the filters */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:max-w-64">
          <MagnifyingGlassIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by event, device or host"
            aria-label="Filter events"
            className="pl-8"
          />
        </div>

        <Select value={type} onValueChange={setType}>
          <SelectTrigger aria-label="Event type" className="min-w-36">
            <SelectValue placeholder="All events" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All events</SelectItem>
            {/* Only the types something writes. Offering "Signed in" as a
                filter that can never match is a way of claiming the log records
                sign-ins; see EMITTED_EVENTS. */}
            {EMITTED_EVENTS.map((t) => (
              <SelectItem key={t} value={t}>
                {EVENT_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={source} onValueChange={setSource}>
          <SelectTrigger aria-label="Written by" className="min-w-32">
            <SelectValue placeholder="Any source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any source</SelectItem>
            {/* No "Relay": the relay has no database connection and writes no
                rows, so the option could only ever return nothing. */}
            {EMITTED_SOURCES.map((written) => (
              <SelectItem key={written} value={written}>
                {written === "server" ? "Server" : "Client"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={device} onValueChange={setDevice}>
          <SelectTrigger aria-label="Device" className="min-w-36">
            <SelectValue placeholder="All devices" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All devices</SelectItem>
            {deviceOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={range} onValueChange={(v) => setRange(v as RangeValue)}>
          <SelectTrigger aria-label="Time range" className="min-w-32">
            <SelectValue placeholder="Last 30 days" />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <XCircleIcon data-icon="inline-start" />
            Clear
          </Button>
        )}
      </div>

      <p className="mt-2 flex items-start gap-1.5 text-xs/relaxed text-muted-foreground">
        <FunnelIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0">
          Filtering runs in this tab, over the rows loaded so far — the time
          range narrows what is shown, it does not fetch further back. Searching
          by host name server-side is not something we can offer: the server
          cannot read the reference, so it cannot match it against a name.
        </span>
      </p>

      {rangeExceedsWindow && retention && (
        <p className="mt-2 flex items-start gap-1.5 text-xs/relaxed text-warning">
          <WarningCircleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            {range === "all"
              ? `“Everything loaded” still stops at the ${retention.label} this log is kept.`
              : `“${rangeLabel}” reaches further back than the ${retention.label} this log is kept.`}{" "}
            Nothing before {day(retention.since.getTime())} can appear here,
            whatever the filters say — those events are deleted, not hidden. An
            empty stretch at that end is the retention window, not a quiet month.
          </span>
        </p>
      )}

      {/* ----------------------------------------------------------- the table */}
      {state.phase === "loading" ? (
        <LoadingState />
      ) : state.phase === "unauthorized" ? (
        <SignedOutState />
      ) : state.phase === "error" ? (
        <ErrorState message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : rows.length === 0 ? (
        <NoEvents retention={retention} />
      ) : filtered.length === 0 ? (
        <NoMatches
          onClear={clearFilters}
          retention={rangeExceedsWindow ? retention : null}
        />
      ) : (
        <Card className="mt-4">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-(--card-spacing)">Time</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead className="pr-(--card-spacing)">Target</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((item) => (
                  <EventRow
                    key={item.row.id}
                    item={item}
                    now={readAt}
                    hostIndex={hostIndex}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>

          <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-(--card-spacing) text-muted-foreground">
            <span className="min-w-0">
              Showing {filtered.length} of {rows.length} loaded{" "}
              {rows.length === 1 ? "event" : "events"}
              {unresolved > 0 && (
                <>
                  {" · "}
                  {unresolved}{" "}
                  {unresolved === 1
                    ? "references a host this device cannot resolve"
                    : "reference hosts this device cannot resolve"}
                </>
              )}
              {". "}
              {cursor
                ? retention
                  ? `There are older events on the server that have not been loaded, back as far as ${day(retention.since.getTime())}.`
                  : "There are older events on the server that have not been loaded."
                : retention
                  ? `That is the whole log the server returned. Nothing older survives: the log keeps ${retention.label}, so anything before ${day(retention.since.getTime())} is deleted rather than withheld.`
                  : "That is the whole log the server returned. It did not say how far back it keeps, so this page will not guess."}
            </span>

            {cursor && (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
              >
                {loadingOlder ? (
                  <SpinnerGapIcon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <ClockCounterClockwiseIcon data-icon="inline-start" />
                )}
                Load older
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* --------------------------------------------------------- retention */}
      <Card size="sm" className="mt-6">
        <CardContent className="flex flex-col gap-2.5 text-muted-foreground">
          <p className="flex items-start gap-2.5">
            <ClockCounterClockwiseIcon className="mt-0.5 size-4 shrink-0 text-primary" />
            <span className="min-w-0">
              {retention ? (
                <>
                  <span className="text-foreground">
                    Retention: {retention.label}, currently back to{" "}
                    {day(retention.since.getTime())}.
                  </span>{" "}
                  {retention.label === AUDIT_RETENTION_LABEL.pro ? (
                    <>
                      That is the Pro window. If the subscription lapses, the
                      window becomes {AUDIT_RETENTION_LABEL.free} and everything
                      older than that is deleted — not archived, and not held
                      back pending a renewal.
                    </>
                  ) : (
                    <>
                      That is the Free window. Pro keeps{" "}
                      {AUDIT_RETENTION_LABEL.pro}; see{" "}
                      <Link href="/pricing" className="text-primary hover:underline">
                        pricing
                      </Link>
                      .
                    </>
                  )}{" "}
                  This window is the one the server applied to this page rather
                  than one worked out in your browser, which cannot know what
                  your account is on.
                </>
              ) : (
                <span className="text-foreground">
                  Retention: not read yet. The server states the window with the
                  events, and this page shows nothing until it has — a browser
                  cannot tell which window your account is on, and a guess here
                  would be a promise nothing enforces.
                </span>
              )}{" "}
              Older events are deleted, not hidden — there is no archive, no
              soft-delete flag and no support request that brings one back. The
              query that feeds this page refuses to return anything past the
              window, so the boundary holds even between runs of the job that
              does the deleting.
            </span>
          </p>
          <p className="flex items-start gap-2.5">
            <DatabaseIcon className="mt-0.5 size-4 shrink-0 text-warning" />
            <span className="min-w-0">
              <span className="text-foreground">
                What that leaves undone on this deployment:
              </span>{" "}
              the deleting is a script (
              <code className="text-foreground">bun run audit:prune</code>) and
              nothing schedules it. If the operator has not put it on a timer,
              rows past the window are still sitting in the database — unreadable
              through this page, and still on disk. That is the honest state of
              it: the window you are shown is enforced, the erasure behind it
              happens when somebody runs the job.
            </span>
          </p>
          <p className="flex items-start gap-2.5">
            <MonitorIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="text-foreground">Addresses:</span> truncated to a
              network on write, for every event type — including the sign-in and
              device registration events the catalogue marks as keeping a full
              address, which no writer honours today. An address is recorded only
              when a trusted proxy is configured in front of the app; otherwise
              the field is left empty rather than filled from a header the caller
              controls.
            </span>
          </p>
          <p className="flex items-start gap-2.5">
            <WarningCircleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
            <span className="min-w-0">
              <span className="text-foreground">
                Not recorded yet, so absence here means nothing:
              </span>{" "}
              {UNEMITTED_EVENTS.map((t) => EVENT_LABELS[t].toLowerCase()).join(", ")}.
              These types exist in the catalogue and the API would accept them,
              but nothing in this build writes one — sign-in and sign-out need a
              hook on the auth layer, vault syncs need one in the vault route,
              and the connection events are the relay&rsquo;s to write and it has
              no database. They are left out of the filters above rather than
              offered as searches that can only ever come back empty.
            </span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------------- row */

function EventRow({
  item,
  now,
  hostIndex,
}: {
  item: DecoratedRow;
  now: number;
  /** Decides what an unresolved reference means: no key here, or no such host. */
  hostIndex: HostIndexState;
}) {
  const { row } = item;
  const opaque = OPAQUE_COPY[hostIndex];
  const meta = SOURCE_META[row.source];
  const Icon = isKnownEvent(row.eventType) ? EVENT_ICONS[row.eventType] : QuestionIcon;
  const alarming = row.eventType === "hostkey.mismatch";

  return (
    <TableRow>
      <TableCell className="pl-(--card-spacing) align-top">
        <div className="tabular-nums text-foreground">{absolute(row.at)}</div>
        <div className="text-muted-foreground">{relative(row.at, now)}</div>
      </TableCell>

      <TableCell className="align-top">
        <div className="flex items-center gap-1.5">
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              alarming ? "text-destructive" : "text-muted-foreground",
            )}
          />
          <span className={cn("font-medium", alarming ? "text-destructive" : "text-foreground")}>
            {eventLabel(row.eventType)}
          </span>
        </div>
        {item.detail && <div className="mt-0.5 text-muted-foreground">{item.detail}</div>}
      </TableCell>

      <TableCell className="align-top">
        {meta ? (
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            <meta.Icon className={meta.tone} />
            {meta.label}
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            <QuestionIcon />
            {row.source}
          </Badge>
        )}
      </TableCell>

      <TableCell className="align-top">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground">{item.deviceName}</span>
          {item.deviceRevoked && (
            <span className="text-muted-foreground text-[10px] tracking-wider uppercase">
              revoked
            </span>
          )}
        </div>
        <div className="text-muted-foreground tabular-nums">
          {row.ipPrefix ?? "no address recorded"}
        </div>
      </TableCell>

      <TableCell className="pr-(--card-spacing) align-top">
        {!row.targetRef ? (
          <span className="text-muted-foreground">Account</span>
        ) : item.hostLabel ? (
          <>
            <div className="flex items-center gap-1.5">
              <HardDrivesIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-foreground">{item.hostLabel}</span>
            </div>
            <div className="text-muted-foreground">{shortRef(row.targetRef)}</div>
          </>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-block cursor-help text-left">
                <span className="flex items-center gap-1.5">
                  <EyeSlashIcon className="size-3.5 shrink-0 text-warning" />
                  <span className="text-foreground">{shortRef(row.targetRef)}</span>
                </span>
                <span className="block text-muted-foreground">{opaque.caption}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="block max-w-sm">{opaque.tooltip}</TooltipContent>
          </Tooltip>
        )}
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------------------------------------------ states */

function HostIndexNotice({ state }: { state: HostIndexState }) {
  if (state === "failed") {
    return (
      <Alert className="mt-4">
        <WarningCircleIcon />
        <AlertTitle>Host names could not be resolved</AlertTitle>
        <AlertDescription>
          <p>
            The local host list could not be read, so every host reference below
            stays opaque. The log is complete; only the names are missing.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  if (state === "no-audit-key") {
    return (
      <Alert className="mt-4">
        <LockKeyIcon />
        <AlertTitle>No audit key in this tab</AlertTitle>
        <AlertDescription>
          <p>
            The vault is open here but the audit branch of the key was not
            derived, so host references cannot be matched. Reload the page and
            unlock again to derive both. Everything else below is unaffected.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert className="mt-4">
      <LockKeyIcon />
      <AlertTitle>The vault is locked, so hosts stay as references</AlertTitle>
      <AlertDescription>
        <p>
          Host names are recovered by hashing your saved hosts with the audit key
          and matching the results against the references in the log. That key is
          held in memory only, so a page reload leaves it behind. Every other
          column below is real and complete.
        </p>
        <Button variant="outline" size="sm" className="mt-1" onClick={requestUnlock}>
          Unlock to resolve hosts
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function LoadingState() {
  return (
    <Card className="mt-4" aria-busy="true" aria-label="Loading activity">
      <CardContent className="space-y-3 py-1">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-3 w-28 shrink-0" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="hidden h-3 w-16 sm:block" />
            <Skeleton className="ml-auto h-3 w-24 shrink-0" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SignedOutState() {
  return (
    <Card className="mt-4">
      <CardContent className="flex flex-col items-start gap-2 py-4">
        <span
          aria-hidden
          className="grid size-8 place-items-center rounded-sm border border-border bg-secondary text-warning"
        >
          <SignInIcon className="size-4" />
        </span>
        <p className="font-heading text-sm font-medium">This browser is signed out</p>
        <p className="max-w-lg text-muted-foreground">
          The log is per account, so it cannot be read without a session. Signing
          in again will also let you unlock the vault, which is what turns host
          references back into names.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-1">
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="mt-4">
      <CardContent className="flex flex-col items-start gap-2 py-4">
        <span
          aria-hidden
          className="grid size-8 place-items-center rounded-sm border border-border bg-secondary text-destructive"
        >
          <WarningCircleIcon className="size-4" />
        </span>
        <p className="font-heading text-sm font-medium">The activity log could not be read</p>
        <p className="max-w-lg text-muted-foreground">
          {message} Nothing is shown rather than a partial log, because a log
          missing rows without saying so is worse than no log at all.
        </p>
        <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
          <ArrowClockwiseIcon data-icon="inline-start" />
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * `retention` is nullable here for the same reason it is nullable everywhere
 * else on this page: the window comes from the server, and this component can
 * render before one has been reported. The sentence about the log ending is
 * dropped rather than filled in with a number nobody stated.
 */
function NoEvents({ retention }: { retention: RetentionView | null }) {
  return (
    <Card className="mt-4">
      <CardContent className="flex flex-col items-start gap-2 py-4">
        <span
          aria-hidden
          className="grid size-8 place-items-center rounded-sm border border-border bg-secondary text-primary"
        >
          <ClockCounterClockwiseIcon className="size-4" />
        </span>
        <p className="font-heading text-sm font-medium">No events recorded yet</p>
        <p className="max-w-lg text-muted-foreground">
          Registering or revoking a device, generating or using a recovery
          code, pinning a host key and installing a key on a host each write a
          row here. The log starts the first time one of those happens — and
          note what is missing from that list: sign-ins, vault syncs and
          connections are catalogued but nothing writes them yet, so an empty
          log is not evidence that nobody signed in.
          {retention ? (
            <>
              {" "}
              It also ends — the log keeps {retention.label} — so an account that
              has been quiet for longer than that reads exactly like an account
              that has never done anything.
            </>
          ) : null}
        </p>
        <Button asChild variant="outline" size="sm" className="mt-1">
          <Link href="/dashboard/terminal">Open terminal</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function NoMatches({
  onClear,
  retention,
}: {
  onClear: () => void;
  /**
   * Non-null only when the range asks for history the log does not keep, in
   * which case "widen it" is bad advice and the window is worth naming. Null
   * covers both "the range is fine" and "the window is not known yet".
   */
  retention: RetentionView | null;
}) {
  return (
    <Card className="mt-4">
      <CardContent className="flex flex-col items-start gap-2 py-4">
        <span
          aria-hidden
          className="grid size-8 place-items-center rounded-sm border border-border bg-secondary text-muted-foreground"
        >
          <FunnelIcon className="size-4" />
        </span>
        <p className="font-heading text-sm font-medium">No events match these filters</p>
        <p className="max-w-lg text-muted-foreground">
          {retention ? (
            <>
              The time range is already as wide as the log goes — it keeps{" "}
              {retention.label} and older events are deleted, so widening it
              further cannot bring anything back. Clear the other filters
              instead.{" "}
            </>
          ) : (
            <>
              Widen the time range, or clear the filters to see everything
              loaded so far.{" "}
            </>
          )}
          Events referencing hosts that are not in this device&apos;s vault will
          not match a host name search, because there is no name here to match
          against.
        </p>
        <Button variant="outline" size="sm" className="mt-1" onClick={onClear}>
          Clear filters
        </Button>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------- rendering */

function eventLabel(type: string): string {
  // An event type this build has no label for is shown as it was stored. That
  // is uglier than a friendly name and more honest than inventing one.
  return isKnownEvent(type) ? EVENT_LABELS[type] : type;
}

function describeDevice(
  deviceId: string | null,
  known: DeviceSummary | undefined,
  listUnavailable: boolean,
): string {
  if (!deviceId) return "No device recorded";
  if (known) return known.label;
  // Two different unknowns: the registry says this id is not one of yours, or
  // the registry could not be asked. They deserve different words.
  return listUnavailable
    ? `Device ${shortId(deviceId)}`
    : `Unknown device ${shortId(deviceId)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* --------------------------------------------------------------- download */

function download(name: string, body: string, mime: string) {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

const CSV_COLUMNS = [
  "time",
  "type",
  "source",
  "device",
  "deviceId",
  "host",
  "hostRef",
  "network",
  "detail",
] as const;

function toCsv(records: Record<string, unknown>[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const record of records) {
    lines.push(CSV_COLUMNS.map((column) => csvCell(record[column])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Quotes every cell rather than only the ones that need it. A blinded reference
 * can begin with a hyphen, and a bare leading hyphen or equals sign is what
 * turns a CSV cell into a formula in a spreadsheet.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

/* -------------------------------------------------------------- formatting */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local time, fixed width, so the column scans as a column. */
function absolute(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A date with no time of day, for the retention boundary. The exact minute the
 * window rolls over is real but not useful — it moves while you read the page.
 */
function day(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function stamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** Relative to the moment the page read the log, so every row agrees. */
function relative(at: number, now: number): string {
  const delta = at - now;
  const abs = Math.abs(delta);
  if (abs < 60_000) return "just now";
  for (const [unit, ms] of UNITS) {
    if (abs >= ms) return RTF.format(Math.round(delta / ms), unit);
  }
  return "just now";
}
