"use client";

/**
 * Activity log.
 *
 * A client component for two reasons. The filters are local state, and — more
 * fundamentally — the host column cannot be rendered on the server. The API
 * returns a blinded reference per event; turning that reference back into a
 * readable label requires the vault, which only this browser can decrypt.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowsClockwiseIcon,
  BroadcastIcon,
  ClockCounterClockwiseIcon,
  DatabaseIcon,
  DevicesIcon,
  DownloadSimpleIcon,
  EyeSlashIcon,
  FingerprintIcon,
  FunnelIcon,
  HardDrivesIcon,
  KeyIcon,
  LockKeyIcon,
  MagnifyingGlassIcon,
  MonitorIcon,
  PlugsConnectedIcon,
  PlugsIcon,
  ProhibitIcon,
  SignInIcon,
  SignOutIcon,
  WarningOctagonIcon,
  XCircleIcon,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { PageHeader } from "@/components/shell/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { AUDIT_EVENTS, type AuditEventType, type AuditSource } from "@/lib/audit/events";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------- model */

interface AuditRow {
  id: string;
  type: AuditEventType;
  /**
   * Minutes before this page loaded. The API returns absolute timestamps —
   * offsets keep the placeholder plausible whenever the page is opened.
   */
  ago: number;
  deviceId: string;
  /**
   * HMAC(auditKey, host|port), truncated. This is the only host identifier the
   * server holds. Absent on account-level events, which concern no host.
   */
  hostRef?: string;
  /**
   * The address the event was written from. Truncated to a network except on
   * sign-in and device registration, where the catalogue keeps the full
   * address — see AUDIT_EVENTS[type].ip.
   */
  network: string | null;
  /** Rendered form of the validated metadata object the API returns. */
  detail?: string;
}

/** Blinded host handles. Deterministic, so the server can group by them. */
const REF_WEB = "7f3c9d2a41b6e5c8";
const REF_DB = "b1e04c7fa9d3251e";
const REF_UNKNOWN = "5a92cf01d7be34aa";

/**
 * PLACEHOLDER DATA — awaiting GET /api/audit.
 *
 * Shaped like the rows that endpoint will return: an event type from the closed
 * catalogue, a device id, a blinded host ref, and metadata already validated
 * against the allowlist. No request is made here, because the route does not
 * exist yet.
 */
const PLACEHOLDER_EVENTS: AuditRow[] = [
  {
    id: "e-0001",
    type: "vault.synced",
    ago: 2,
    deviceId: "6f1c9a24-4c1b-4a8e-9d0a-2b7f5e11c3a2",
    network: "203.0.113.0/24",
    detail: "version 184 · 39 records",
  },
  {
    id: "e-0002",
    type: "connection.closed",
    ago: 6,
    deviceId: "6f1c9a24-4c1b-4a8e-9d0a-2b7f5e11c3a2",
    hostRef: REF_WEB,
    network: "203.0.113.0/24",
    detail: "18 min · 2.4 MB up · 61.7 MB down",
  },
  {
    id: "e-0003",
    type: "connection.opened",
    ago: 24,
    deviceId: "6f1c9a24-4c1b-4a8e-9d0a-2b7f5e11c3a2",
    hostRef: REF_WEB,
    network: "203.0.113.0/24",
    detail: "port 22",
  },
  {
    id: "e-0004",
    type: "key.installed",
    ago: 95,
    deviceId: "6f1c9a24-4c1b-4a8e-9d0a-2b7f5e11c3a2",
    hostRef: REF_DB,
    network: "203.0.113.0/24",
    detail: "installed · SHA256:9pJfR1…",
  },
  {
    id: "e-0005",
    type: "hostkey.pinned",
    ago: 96,
    deviceId: "6f1c9a24-4c1b-4a8e-9d0a-2b7f5e11c3a2",
    hostRef: REF_DB,
    network: "203.0.113.0/24",
    detail: "ssh-ed25519 · SHA256:tZ2qL8…",
  },
  {
    id: "e-0006",
    type: "connection.opened",
    ago: 97,
    deviceId: "6f1c9a24-4c1b-4a8e-9d0a-2b7f5e11c3a2",
    hostRef: REF_DB,
    network: "203.0.113.0/24",
    detail: "port 2222",
  },
  {
    id: "e-0007",
    type: "auth.signin",
    ago: 141,
    deviceId: "6f1c9a24-4c1b-4a8e-9d0a-2b7f5e11c3a2",
    network: "203.0.113.42",
    detail: "password",
  },
  {
    id: "e-0008",
    type: "connection.closed",
    ago: 60 * 19,
    deviceId: "b3d8e770-1f42-4b6d-8f9c-51a0c6d2e884",
    hostRef: REF_UNKNOWN,
    network: "198.51.100.0/24",
    detail: "3 h 12 min · 1.1 MB up · 4.9 MB down",
  },
  {
    id: "e-0009",
    type: "connection.opened",
    ago: 60 * 22,
    deviceId: "b3d8e770-1f42-4b6d-8f9c-51a0c6d2e884",
    hostRef: REF_UNKNOWN,
    network: "198.51.100.0/24",
    detail: "port 22",
  },
  {
    id: "e-0010",
    type: "hostkey.cleared",
    ago: 60 * 22 + 30,
    deviceId: "b3d8e770-1f42-4b6d-8f9c-51a0c6d2e884",
    hostRef: REF_UNKNOWN,
    network: "198.51.100.0/24",
    detail: "SHA256:Lq7dV3…",
  },
  {
    id: "e-0011",
    type: "hostkey.mismatch",
    ago: 60 * 23,
    deviceId: "b3d8e770-1f42-4b6d-8f9c-51a0c6d2e884",
    hostRef: REF_UNKNOWN,
    network: "198.51.100.0/24",
    detail: "expected SHA256:Lq7dV3… · presented SHA256:Xk4bQm…",
  },
  {
    id: "e-0012",
    type: "vault.synced",
    ago: 60 * 26,
    deviceId: "b3d8e770-1f42-4b6d-8f9c-51a0c6d2e884",
    network: "198.51.100.0/24",
    detail: "version 183 · 39 records",
  },
  {
    id: "e-0013",
    type: "auth.signin",
    ago: 60 * 30,
    deviceId: "b3d8e770-1f42-4b6d-8f9c-51a0c6d2e884",
    network: "198.51.100.77",
    detail: "passkey",
  },
  {
    id: "e-0014",
    type: "connection.closed",
    ago: 60 * 24 * 5,
    deviceId: "cc41b0f5-9a3e-4d17-b2c8-6e0f4a9d1b73",
    hostRef: REF_WEB,
    network: "2001:db8:4f2::/48",
    detail: "4 min · 82 kB up · 340 kB down",
  },
  {
    id: "e-0015",
    type: "connection.opened",
    ago: 60 * 24 * 5 + 4,
    deviceId: "cc41b0f5-9a3e-4d17-b2c8-6e0f4a9d1b73",
    hostRef: REF_WEB,
    network: "2001:db8:4f2::/48",
    detail: "port 22",
  },
  {
    id: "e-0016",
    type: "device.registered",
    ago: 60 * 24 * 22,
    deviceId: "cc41b0f5-9a3e-4d17-b2c8-6e0f4a9d1b73",
    network: "2001:db8:4f2:1a::9",
    detail: "ios",
  },
  {
    id: "e-0017",
    type: "hostkey.cleared",
    ago: 60 * 24 * 33,
    deviceId: "6f1c9a24-4c1b-4a8e-9d0a-2b7f5e11c3a2",
    hostRef: REF_DB,
    network: "203.0.113.0/24",
    detail: "SHA256:tZ2qL8…",
  },
  {
    id: "e-0018",
    type: "auth.signout",
    ago: 60 * 24 * 63,
    deviceId: "0a7e2d63-58cf-42b1-9e35-cd8a71f4b206",
    network: "192.0.2.0/24",
    detail: "all sessions",
  },
];

/**
 * PLACEHOLDER — device labels come from GET /api/devices; the audit rows carry
 * ids only.
 */
const DEVICE_LABELS: Record<string, string> = {
  "6f1c9a24-4c1b-4a8e-9d0a-2b7f5e11c3a2": "Chrome on Mac",
  "b3d8e770-1f42-4b6d-8f9c-51a0c6d2e884": "Firefox on Linux",
  "cc41b0f5-9a3e-4d17-b2c8-6e0f4a9d1b73": "Safari on iPhone",
  "0a7e2d63-58cf-42b1-9e35-cd8a71f4b206": "Edge on the office desktop",
};

/**
 * PLACEHOLDER — in the real page this map is built locally by hashing every
 * host in the decrypted vault with the audit key (see buildRefIndex in
 * src/lib/audit/blind.ts) and matching the results against the refs in the
 * response. REF_UNKNOWN is deliberately absent: it belongs to a host this
 * device has no record of, so it stays opaque here too.
 */
const RESOLVED_HOSTS: Record<string, string> = {
  [REF_WEB]: "prod-web-1",
  [REF_DB]: "pg-primary",
};

const EVENT_LABELS: Record<AuditEventType, string> = {
  "auth.signin": "Signed in",
  "auth.signout": "Signed out",
  "device.registered": "Device registered",
  "device.revoked": "Device revoked",
  "vault.synced": "Vault synced",
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
  "connection.opened": PlugsConnectedIcon,
  "connection.closed": PlugsIcon,
  "key.installed": KeyIcon,
  "hostkey.pinned": FingerprintIcon,
  "hostkey.mismatch": WarningOctagonIcon,
  "hostkey.cleared": FingerprintIcon,
};

const SOURCE_META: Record<
  AuditSource,
  { label: string; Icon: typeof DatabaseIcon; tone: string; note: string }
> = {
  server: {
    label: "server",
    Icon: DatabaseIcon,
    tone: "text-primary",
    note: "Written by the control plane when it handled the request.",
  },
  relay: {
    label: "relay",
    Icon: BroadcastIcon,
    tone: "text-primary",
    note: "Written by the relay as it opened or closed the socket.",
  },
  client: {
    label: "client",
    Icon: MonitorIcon,
    tone: "text-warning",
    note: "Reported by a browser. Accurate only if that browser was honest.",
  },
};

const RANGES = [
  { value: "24h", label: "Last 24 hours", minutes: 60 * 24 },
  { value: "7d", label: "Last 7 days", minutes: 60 * 24 * 7 },
  { value: "30d", label: "Last 30 days", minutes: 60 * 24 * 30 },
  { value: "all", label: "All retained", minutes: Number.POSITIVE_INFINITY },
] as const;

type RangeValue = (typeof RANGES)[number]["value"];

interface Snapshot {
  rows: AuditRow[];
  /** Captured once so every timestamp on the page agrees. */
  readAt: number;
}

/* -------------------------------------------------------------------- page */

export default function ActivityPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | AuditEventType>("all");
  const [source, setSource] = useState<"all" | AuditSource>("all");
  const [device, setDevice] = useState<"all" | string>("all");
  const [range, setRange] = useState<RangeValue>("30d");

  useEffect(() => {
    // Stands in for `fetch("/api/audit")`. The delay is here so the loading
    // state is real rather than decorative; replace the whole effect body with
    // the request once the route lands.
    const timer = setTimeout(
      () => setSnapshot({ rows: PLACEHOLDER_EVENTS, readAt: Date.now() }),
      420,
    );
    return () => clearTimeout(timer);
  }, []);

  const filtered = useMemo(() => {
    if (!snapshot) return [];
    const needle = query.trim().toLowerCase();
    const cutoff = RANGES.find((r) => r.value === range)?.minutes ?? Infinity;

    return snapshot.rows.filter((row) => {
      if (row.ago > cutoff) return false;
      if (type !== "all" && row.type !== type) return false;
      if (source !== "all" && AUDIT_EVENTS[row.type].source !== source) return false;
      if (device !== "all" && row.deviceId !== device) return false;
      if (!needle) return true;

      const haystack = [
        EVENT_LABELS[row.type],
        row.type,
        DEVICE_LABELS[row.deviceId] ?? row.deviceId,
        row.hostRef ? (RESOLVED_HOSTS[row.hostRef] ?? "") : "",
        row.hostRef ?? "",
        row.network ?? "",
        row.detail ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [snapshot, query, type, source, device, range]);

  const unresolved = useMemo(
    () => filtered.filter((r) => r.hostRef && !RESOLVED_HOSTS[r.hostRef]).length,
    [filtered],
  );

  const filtersActive =
    query !== "" || type !== "all" || source !== "all" || device !== "all" || range !== "30d";

  function clearFilters() {
    setQuery("");
    setType("all");
    setSource("all");
    setDevice("all");
    setRange("30d");
  }

  function exportEvents() {
    if (!snapshot) return;
    // Built here, from the rows already on screen, with the labels this device
    // resolved. The server has no way to produce this file.
    const payload = {
      exportedAt: new Date(snapshot.readAt).toISOString(),
      events: filtered.map((row) => ({
        time: new Date(snapshot.readAt - row.ago * 60_000).toISOString(),
        type: row.type,
        source: AUDIT_EVENTS[row.type].source,
        deviceId: row.deviceId,
        device: DEVICE_LABELS[row.deviceId] ?? null,
        hostRef: row.hostRef ?? null,
        host: row.hostRef ? (RESOLVED_HOSTS[row.hostRef] ?? null) : null,
        network: row.network,
        detail: row.detail ?? null,
      })),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `webxterm-activity-${stamp(snapshot.readAt)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);

    toast.success(`Exported ${filtered.length} ${filtered.length === 1 ? "event" : "events"}`, {
      description:
        "Written in this tab, with host labels resolved locally. The copy on the server holds references only.",
    });
  }

  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow="Account"
        title="Activity"
        description="Sign-ins, device changes, vault syncs, connections and host key decisions. Session contents are never recorded — no commands, no keystrokes, no file names."
        actions={
          <Button variant="outline" onClick={exportEvents} disabled={!snapshot}>
            <DownloadSimpleIcon data-icon="inline-start" />
            Export
          </Button>
        }
      />

      {/* ------------------------------------------------- the framing callout */}
      <div className="mt-6 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader className="border-b border-border">
            <CardTitle className="flex items-center gap-2">
              <LockKeyIcon className="size-4 text-primary" />
              The server groups by host without knowing the host
            </CardTitle>
            <CardDescription>
              Why the Target column below is filled in here and nowhere else.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-3 text-muted-foreground">
            <p>
              Every event that concerns a host is stored against a blinded
              reference. Your browser computes an HMAC of the hostname and port
              under a key derived on this device, and sends only that. The server
              gets a stable, opaque handle: it can group your activity by host and
              count connections to it, without ever learning which host it is.
            </p>
            <pre className="bg-terminal overflow-x-auto border border-border px-3 py-3 text-[11px] leading-relaxed">
{`  prod-web-1:22
     │  HMAC(auditKey, host|port)   ← key never leaves this device
     ▼
  h/7f3c9d2a41b6e5c8               ← all the server stores, and all it can group by
     │
     ▼  matched against the vault, decrypted in this tab
  "prod-web-1"                     ← resolved locally, never sent`}
            </pre>
            <p>
              The readable labels are not in the API response. They are resolved
              here, after the vault is decrypted, by hashing your saved hosts with
              the same key and matching the results. A reference to a host this
              device has no record of stays opaque — which is the honest thing to
              show, rather than guessing at a name.
            </p>
            <p>
              The deliberate leak: the reference is deterministic, so the server
              can tell that two events concern the same unknown host. That is what
              makes grouping work, and the relay already sees each connection as it
              happens.{" "}
              <Link href="/security" className="text-primary hover:underline">
                Read the threat model
              </Link>
              .
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="border-b border-border">
            <CardTitle>What each row can prove</CardTitle>
            <CardDescription>
              Not every line in an audit log is worth the same.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-3 px-0">
            <ul className="divide-y divide-border">
              {(Object.keys(SOURCE_META) as AuditSource[]).map((key) => {
                const meta = SOURCE_META[key];
                return (
                  <li key={key} className="flex gap-2.5 px-(--card-spacing) py-2.5">
                    <meta.Icon className={cn("mt-0.5 size-4 shrink-0", meta.tone)} />
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">{meta.label}</p>
                      <p className="text-muted-foreground">{meta.note}</p>
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="space-y-3 px-(--card-spacing) text-muted-foreground">
              <p>
                Rows marked <span className="text-foreground">client</span> are
                self-reported: a browser told us a host key was pinned or a key
                installed. A tab that has been compromised can lie about those, or
                stay quiet and never send them at all.
              </p>
              <p>
                Rows marked <span className="text-foreground">server</span> and{" "}
                <span className="text-foreground">relay</span> are written outside
                your browser, on the machines that handled the request. A
                compromised tab cannot suppress, backdate or forge them — a
                connection it opens is recorded whether or not it admits to it.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

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

        <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
          <SelectTrigger aria-label="Event type" className="min-w-36">
            <SelectValue placeholder="All events" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All events</SelectItem>
            {(Object.keys(EVENT_LABELS) as AuditEventType[]).map((t) => (
              <SelectItem key={t} value={t}>
                {EVENT_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={source} onValueChange={(v) => setSource(v as typeof source)}>
          <SelectTrigger aria-label="Written by" className="min-w-32">
            <SelectValue placeholder="Any source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any source</SelectItem>
            <SelectItem value="server">Server</SelectItem>
            <SelectItem value="relay">Relay</SelectItem>
            <SelectItem value="client">Client</SelectItem>
          </SelectContent>
        </Select>

        <Select value={device} onValueChange={setDevice}>
          <SelectTrigger aria-label="Device" className="min-w-36">
            <SelectValue placeholder="All devices" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All devices</SelectItem>
            {Object.entries(DEVICE_LABELS).map(([id, label]) => (
              <SelectItem key={id} value={id}>
                {label}
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
          Filtering runs in this tab, over rows that are already decrypted here.
          Searching by host name server-side is not something we can offer: the
          server cannot read the reference, so it cannot match it against a name.
        </span>
      </p>

      {/* ----------------------------------------------------------- the table */}
      {snapshot === null ? (
        <LoadingState />
      ) : snapshot.rows.length === 0 ? (
        <NoEvents />
      ) : filtered.length === 0 ? (
        <NoMatches onClear={clearFilters} />
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
                {filtered.map((row) => (
                  <EventRow key={row.id} row={row} now={snapshot.readAt} />
                ))}
              </TableBody>
            </Table>
          </CardContent>

          <CardContent className="border-t border-border pt-(--card-spacing) text-muted-foreground">
            Showing {filtered.length} of {snapshot.rows.length}{" "}
            {snapshot.rows.length === 1 ? "event" : "events"}
            {unresolved > 0 && (
              <>
                {" · "}
                {unresolved}{" "}
                {unresolved === 1
                  ? "references a host this device cannot resolve"
                  : "reference hosts this device cannot resolve"}
              </>
            )}
            .
          </CardContent>
        </Card>
      )}

      {/* --------------------------------------------------------- retention */}
      <Card size="sm" className="mt-6">
        <CardContent className="flex items-start gap-2.5 text-muted-foreground">
          <ClockCounterClockwiseIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          <p className="min-w-0">
            <span className="text-foreground">Retention:</span> events are deleted
            by age after 90 days; Team plans keep 12 months. Export before then if
            you need a longer record — nothing is archived elsewhere. Addresses are
            truncated to a network on write, except on sign-in and device
            registration, where an exact address is the point of the record.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------------- row */

function EventRow({ row, now }: { row: AuditRow; now: number }) {
  const at = now - row.ago * 60_000;
  const meta = SOURCE_META[AUDIT_EVENTS[row.type].source];
  const Icon = EVENT_ICONS[row.type];
  const alarming = row.type === "hostkey.mismatch";
  const host = row.hostRef ? RESOLVED_HOSTS[row.hostRef] : undefined;

  return (
    <TableRow>
      <TableCell className="pl-(--card-spacing) align-top">
        <div className="tabular-nums text-foreground">{absolute(at)}</div>
        <div className="text-muted-foreground">{relative(at, now)}</div>
      </TableCell>

      <TableCell className="align-top">
        <div className="flex items-center gap-1.5">
          <Icon className={cn("size-3.5 shrink-0", alarming ? "text-destructive" : "text-muted-foreground")} />
          <span className={cn("font-medium", alarming ? "text-destructive" : "text-foreground")}>
            {EVENT_LABELS[row.type]}
          </span>
        </div>
        {row.detail && (
          <div className="mt-0.5 text-muted-foreground">{row.detail}</div>
        )}
      </TableCell>

      <TableCell className="align-top">
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <meta.Icon className={meta.tone} />
          {meta.label}
        </Badge>
      </TableCell>

      <TableCell className="align-top">
        <div className="text-foreground">
          {DEVICE_LABELS[row.deviceId] ?? "Revoked device"}
        </div>
        <div className="text-muted-foreground tabular-nums">{row.network ?? "—"}</div>
      </TableCell>

      <TableCell className="pr-(--card-spacing) align-top">
        {!row.hostRef ? (
          <span className="text-muted-foreground">Account</span>
        ) : host ? (
          <>
            <div className="flex items-center gap-1.5">
              <HardDrivesIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-foreground">{host}</span>
            </div>
            <div className="text-muted-foreground">h/{row.hostRef.slice(0, 10)}…</div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <EyeSlashIcon className="size-3.5 shrink-0 text-warning" />
              <span className="text-foreground">h/{row.hostRef.slice(0, 10)}…</span>
            </div>
            <div className="text-muted-foreground">not in this vault</div>
          </>
        )}
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------------------------------------------ states */

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

function NoEvents() {
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
          Signing in, registering a device, syncing the vault, opening a
          connection and pinning a host key all write a row here. The log starts
          the first time one of those happens.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-1">
          <Link href="/workspace">Open workspace</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function NoMatches({ onClear }: { onClear: () => void }) {
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
          Widen the time range, or clear the filters to see everything that is
          still retained. Events referencing hosts that are not in this
          device&apos;s vault will not match a host name search, because there is
          no name here to match against.
        </p>
        <Button variant="outline" size="sm" className="mt-1" onClick={onClear}>
          Clear filters
        </Button>
      </CardContent>
    </Card>
  );
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
