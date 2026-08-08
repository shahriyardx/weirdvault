"use client";

// Client component: hosts live in IndexedDB and the encrypted vault, so the
// list can only be read after decryption in the browser. There is no server
// render of this data — the server holds ciphertext it cannot open.

import * as React from "react";
import Link from "next/link";
import {
  DotsThreeIcon,
  FingerprintIcon,
  HardDrivesIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  ShieldWarningIcon,
  TerminalWindowIcon,
  TrashIcon,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { PageHeader } from "@/components/shell/page-shell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { deleteHost, listHosts, saveHost, type Host } from "@/lib/hosts";
import { listPins, type PinnedHostKey } from "@/lib/hostkeys";
import { listStoredKeys, type StoredKey } from "@/lib/keys";

/* -------------------------------------------------------------------- form */

interface HostForm {
  id?: string;
  createdAt?: number;
  lastUsedAt?: number;
  label: string;
  hostname: string;
  port: string;
  username: string;
  keyId: string;
  folder: string;
  tags: string;
}

const NO_KEY = "__none__";

const blankForm = (): HostForm => ({
  label: "",
  hostname: "",
  port: "22",
  username: "",
  keyId: NO_KEY,
  folder: "",
  tags: "",
});

const formFor = (host: Host): HostForm => ({
  id: host.id,
  createdAt: host.createdAt,
  lastUsedAt: host.lastUsedAt,
  label: host.label,
  hostname: host.hostname,
  port: String(host.port),
  username: host.username,
  keyId: host.keyId ?? NO_KEY,
  folder: host.folder ?? "",
  tags: (host.tags ?? []).join(", "),
});

/* -------------------------------------------------------------------- page */

export default function HostsPage() {
  const [hosts, setHosts] = React.useState<Host[]>([]);
  const [pins, setPins] = React.useState<PinnedHostKey[]>([]);
  const [keys, setKeys] = React.useState<StoredKey[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [query, setQuery] = React.useState("");

  const [form, setForm] = React.useState<HostForm | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<Host | null>(null);

  const refresh = React.useCallback(async () => {
    const [h, p, k] = await Promise.all([listHosts(), listPins(), listStoredKeys()]);
    setHosts(h);
    setPins(p);
    setKeys(k);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [h, p, k] = await Promise.all([listHosts(), listPins(), listStoredKeys()]);
        if (cancelled) return;
        setHosts(h);
        setPins(p);
        setKeys(k);
      } catch {
        if (!cancelled) toast.error("Could not read the local host store.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pinFor = React.useCallback(
    (host: Host) => pins.find((p) => p.id === `${host.hostname}:${host.port}`),
    [pins],
  );

  const keyLabel = React.useCallback(
    (id?: string) => (id ? keys.find((k) => k.id === id)?.label : undefined),
    [keys],
  );

  // Search is client-side because it has to be: the vault is a blob the server
  // cannot index. Matching on the fields a person actually remembers.
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return hosts;
    return hosts.filter((h) =>
      [
        h.label,
        h.hostname,
        h.username,
        h.folder ?? "",
        (h.tags ?? []).join(" "),
        `${h.username}@${h.hostname}:${h.port}`,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [hosts, query]);

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;

    const hostname = form.hostname.trim();
    const username = form.username.trim();
    const port = Number(form.port);

    if (!hostname || !username) {
      toast.error("Hostname and username are both required.");
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error("Port must be a whole number between 1 and 65535.");
      return;
    }

    setSaving(true);
    try {
      const tags = form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      await saveHost({
        id: form.id,
        createdAt: form.createdAt,
        lastUsedAt: form.lastUsedAt,
        label: form.label.trim() || `${username}@${hostname}`,
        hostname,
        port,
        username,
        keyId: form.keyId === NO_KEY ? undefined : form.keyId,
        folder: form.folder.trim() || undefined,
        tags: tags.length ? tags : undefined,
      });

      await refresh();
      setForm(null);
      toast.success(form.id ? "Host updated." : "Host added.");
    } catch {
      toast.error("Could not write to the local host store.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    const { id, label } = pendingDelete;
    setPendingDelete(null);
    try {
      await deleteHost(id);
      await refresh();
      toast.success(`Removed ${label}.`);
    } catch {
      toast.error("Could not remove the host.");
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Hosts"
        description="Saved connections, stored encrypted on this device and synced to your other devices as ciphertext. Editing one here changes it everywhere you are signed in."
        actions={
          <Button onClick={() => setForm(blankForm())}>
            <PlusIcon /> Add host
          </Button>
        }
      />

      <div className="py-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-xs">
            <MagnifyingGlassIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search hosts"
              aria-label="Search hosts"
              className="pl-8"
              type="search"
            />
          </div>
          <p className="text-xs text-muted-foreground sm:ml-auto">
            {loading
              ? "Reading the local store"
              : `${filtered.length} of ${hosts.length} ${hosts.length === 1 ? "host" : "hosts"}`}
          </p>
        </div>

        <div className="mt-4">
          {loading ? (
            <LoadingRows />
          ) : hosts.length === 0 ? (
            <EmptyState onAdd={() => setForm(blankForm())} />
          ) : filtered.length === 0 ? (
            <NoMatches query={query} onClear={() => setQuery("")} />
          ) : (
            <div className="rounded-sm border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Host</TableHead>
                    <TableHead className="hidden md:table-cell">Key</TableHead>
                    <TableHead className="hidden lg:table-cell">Host key</TableHead>
                    <TableHead className="hidden sm:table-cell">Last used</TableHead>
                    <TableHead className="w-10">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((host) => (
                    <HostRow
                      key={host.id}
                      host={host}
                      pin={pinFor(host)}
                      keyLabel={keyLabel(host.keyId)}
                      onEdit={() => setForm(formFor(host))}
                      onDelete={() => setPendingDelete(host)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {!loading && hosts.length > 0 && (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Search runs in this tab. The vault syncs as an encrypted blob, so the
            server has nothing to query.
          </p>
        )}
      </div>

      {/* ------------------------------------------------ add / edit dialog */}
      <Dialog open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form?.id ? "Edit host" : "Add host"}</DialogTitle>
            <DialogDescription>
              Saved to this browser and to the encrypted vault. Nothing here is
              readable by the relay or by us.
            </DialogDescription>
          </DialogHeader>

          {form && (
            <form onSubmit={handleSave} className="grid gap-3">
              <Field id="host-label" label="Label">
                <Input
                  id="host-label"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder="build-01"
                  autoComplete="off"
                />
              </Field>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_5.5rem]">
                <Field id="host-hostname" label="Hostname" required>
                  <Input
                    id="host-hostname"
                    value={form.hostname}
                    onChange={(e) => setForm({ ...form, hostname: e.target.value })}
                    placeholder="10.0.4.21"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                  />
                </Field>
                <Field id="host-port" label="Port" required>
                  <Input
                    id="host-port"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: e.target.value })}
                    inputMode="numeric"
                    placeholder="22"
                    required
                  />
                </Field>
              </div>

              <Field id="host-username" label="Username" required>
                <Input
                  id="host-username"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder="deploy"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              </Field>

              <div className="grid gap-1.5">
                <Label htmlFor="host-key">Key</Label>
                <Select
                  value={form.keyId}
                  onValueChange={(v) => setForm({ ...form, keyId: v })}
                >
                  <SelectTrigger id="host-key" className="w-full">
                    <SelectValue placeholder="Choose a key" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_KEY}>Ask on connect</SelectItem>
                    {keys.map((k) => (
                      <SelectItem key={k.id} value={k.id}>
                        {k.label} · {k.mode}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Device-bound keys only work in this browser. Portable keys
                  travel with the vault.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field id="host-folder" label="Folder">
                  <Input
                    id="host-folder"
                    value={form.folder}
                    onChange={(e) => setForm({ ...form, folder: e.target.value })}
                    placeholder="production"
                    autoComplete="off"
                  />
                </Field>
                <Field id="host-tags" label="Tags">
                  <Input
                    id="host-tags"
                    value={form.tags}
                    onChange={(e) => setForm({ ...form, tags: e.target.value })}
                    placeholder="eu-west, db"
                    autoComplete="off"
                  />
                </Field>
              </div>

              <DialogFooter className="mt-1">
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving" : form.id ? "Save changes" : "Add host"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------------ delete confirm */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingDelete?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the saved connection on every synced device. The
              pinned host key and any SSH keys stay where they are, and the
              server itself is untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              Remove host
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/* --------------------------------------------------------------- table row */

function HostRow({
  host,
  pin,
  keyLabel,
  onEdit,
  onDelete,
}: {
  host: Host;
  pin?: PinnedHostKey;
  keyLabel?: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const target = `${host.username}@${host.hostname}:${host.port}`;

  return (
    <TableRow>
      <TableCell className="max-w-[16rem] py-2.5 whitespace-normal">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-foreground">{host.label}</span>
          <span className="truncate text-muted-foreground">{target}</span>
          <div className="mt-1 flex flex-wrap items-center gap-1 sm:hidden">
            <span className="text-muted-foreground">{lastUsed(host)}</span>
          </div>
          {(host.folder || (host.tags?.length ?? 0) > 0) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {host.folder && (
                <Badge variant="secondary" className="font-normal">
                  {host.folder}
                </Badge>
              )}
              {host.tags?.map((tag) => (
                <Badge key={tag} variant="outline" className="font-normal">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </TableCell>

      <TableCell className="hidden md:table-cell">
        {keyLabel ? (
          <span className="text-foreground">{keyLabel}</span>
        ) : (
          <span className="text-muted-foreground">Ask on connect</span>
        )}
      </TableCell>

      <TableCell className="hidden lg:table-cell">
        <Fingerprint pin={pin} />
      </TableCell>

      <TableCell className="hidden text-muted-foreground sm:table-cell">
        {lastUsed(host)}
      </TableCell>

      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${host.label}`}>
              <DotsThreeIcon weight="bold" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem asChild>
              <Link href={`/workspace?host=${encodeURIComponent(host.id)}`}>
                <TerminalWindowIcon /> Connect
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>
              <PencilSimpleIcon /> Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <TrashIcon /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function Fingerprint({ pin }: { pin?: PinnedHostKey }) {
  if (!pin) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-default items-center gap-1.5 text-muted-foreground">
            <ShieldWarningIcon className="size-3.5" />
            Not pinned
          </span>
        </TooltipTrigger>
        <TooltipContent>
          No host key pinned yet. The first connection pins whatever the server
          presents, and every reconnect after that is checked against it.
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default items-center gap-1.5">
          <FingerprintIcon className="size-3.5 text-success" />
          <span className="text-muted-foreground">{truncate(pin.fingerprint)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <span className="flex flex-col gap-1">
          <span className="break-all">{pin.fingerprint}</span>
          <span className="opacity-70">
            {pin.type} · pinned {formatDate(pin.pinnedAt)}
          </span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/* ------------------------------------------------------------ empty states */

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-4 py-10 sm:px-8">
        <div className="grid size-9 place-items-center rounded-sm border border-border bg-secondary text-primary">
          <HardDrivesIcon />
        </div>
        <div className="max-w-xl">
          <h2 className="font-heading text-sm font-medium">No hosts saved yet</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            A host is a label, an address and the key to use. Everything you add
            is encrypted in the browser before it is stored, and the ciphertext
            syncs to your other devices, so the same list is there when you open
            a tab somewhere else.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            The server holds a blob it has no key for, which means it cannot
            search your hosts on your behalf. That is why the search box above
            filters locally, over records this tab has already decrypted.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onAdd}>
            <PlusIcon /> Add host
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard/terminal">Connect without saving</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-3 py-10">
        <h2 className="font-heading text-sm font-medium">
          Nothing matches &ldquo;{query}&rdquo;
        </h2>
        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
          The filter looks at labels, addresses, usernames, folders and tags on
          the hosts this tab has decrypted.
        </p>
        <Button variant="outline" onClick={onClear}>
          Clear search
        </Button>
      </CardContent>
    </Card>
  );
}

function LoadingRows() {
  return (
    <div className="rounded-sm border border-border">
      <div className="divide-y divide-border">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-4 p-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="hidden h-3 w-24 sm:block" />
            <Skeleton className="size-7" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Field({
  id,
  label,
  required,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label}
        {!required && (
          <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
            optional
          </span>
        )}
      </Label>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ format */

/** SHA256:base64 fingerprints are too long for a column; the tooltip has it all. */
function truncate(fingerprint: string) {
  return fingerprint.length > 22 ? `${fingerprint.slice(0, 22)}…` : fingerprint;
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

function lastUsed(host: Host) {
  if (!host.lastUsedAt) return "Never connected";
  const delta = host.lastUsedAt - Date.now();
  const abs = Math.abs(delta);
  if (abs < 60_000) return "Just now";

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, ms] of UNITS) {
    if (abs >= ms) return rtf.format(Math.round(delta / ms), unit);
  }
  return "Just now";
}
