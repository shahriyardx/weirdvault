"use client";

// Client component: keys live in this browser's IndexedDB as non-extractable
// WebCrypto handles, and the vault key exists only in this tab's memory. The
// server holds ciphertext it has no key for, so there is nothing to render on
// it — the list can only be read after the browser has decrypted it.

import * as React from "react";
import Link from "next/link";
import {
  CheckIcon,
  CloudArrowUpIcon,
  CopyIcon,
  DesktopTowerIcon,
  KeyIcon,
  LockKeyIcon,
  PlusIcon,
  TrashIcon,
  WarningIcon,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  authorizedKeysLine,
  deleteKey,
  generateKey,
  listStoredKeys,
  type KeyMode,
  type StoredKey,
} from "@/lib/keys";
import { getVaultKey, useVaultUnlocked } from "@/lib/vault/session";
import { syncVault } from "@/lib/vault/sync";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ helpers */

/** The line as it must appear in ~/.ssh/authorized_keys. */
function lineFor(key: StoredKey): string {
  return authorizedKeysLine({
    publicKeyRaw: new Uint8Array(key.publicKeyRaw),
    label: key.label,
  });
}

/** What we put on the clipboard: the whole command, not just the key. */
function installCommand(line: string): string {
  return `echo '${line}' >> ~/.ssh/authorized_keys`;
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/* --------------------------------------------------------------------- page */

export default function KeysPage() {
  const [keys, setKeys] = React.useState<StoredKey[]>([]);
  const [loading, setLoading] = React.useState(true);
  const unlocked = useVaultUnlocked();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [label, setLabel] = React.useState("webxterm");
  const [mode, setMode] = React.useState<KeyMode>("device-bound");
  const [generating, setGenerating] = React.useState(false);

  const [pendingDelete, setPendingDelete] = React.useState<StoredKey | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await listStoredKeys();
        if (cancelled) return;
        setKeys(stored);
      } catch {
        if (!cancelled) toast.error("Could not read the local key store.");
      } finally {
        if (!cancelled) {
          // The vault key is held in memory only, so this is a per-tab fact and
          // can only be read after mount.
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Best-effort push of the encrypted vault; never blocks the local write. */
  const pushVault = React.useCallback(async () => {
    const vaultKey = getVaultKey();
    if (!vaultKey) return;
    try {
      await syncVault(vaultKey);
    } catch {
      toast.message("Saved on this device. The vault will sync on the next attempt.");
    }
  }, []);

  function openDialog() {
    // `unlocked` is reactive, so it is already current here.
    setMode(unlocked ? "portable" : "device-bound");
    setLabel("webxterm");
    setDialogOpen(true);
  }

  async function handleGenerate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const vaultKey = getVaultKey();

    if (mode === "portable" && !vaultKey) {
      toast.error("The vault is locked, so a portable key cannot be wrapped.");
      return;
    }

    setGenerating(true);
    try {
      const created = await generateKey(
        label.trim() || "webxterm",
        mode,
        vaultKey ?? undefined,
      );
      setKeys(await listStoredKeys());
      setDialogOpen(false);
      toast.success(`Generated ${created.label}. Add its line to your server.`);
      if (mode === "portable") await pushVault();
    } catch (error) {
      // generateKey refuses a portable key without a vault key; surface its
      // message rather than a generic failure.
      toast.error(String((error as Error).message ?? error));
    } finally {
      setGenerating(false);
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    const { id, label: name } = pendingDelete;
    setPendingDelete(null);
    try {
      await deleteKey(id);
      setKeys(await listStoredKeys());
      toast.success(`Deleted ${name}. Remove its line from your servers.`);
      await pushVault();
    } catch {
      toast.error("Could not delete the key from the local store.");
    }
  }

  const deviceBoundCount = keys.filter((k) => k.mode === "device-bound").length;

  return (
    <>
      <PageHeader
        eyebrow="Dashboard"
        title="Keys"
        description="Ed25519 keys generated inside this browser. The private half is a non-extractable WebCrypto handle: it signs the SSH handshake, and nothing — our code included — can read its bytes."
        actions={
          <Button onClick={openDialog}>
            <PlusIcon /> Generate key
          </Button>
        }
      />

      <div className="flex flex-col gap-4 py-6">
        {!loading && !unlocked && keys.some((k) => k.mode === "portable") && (
          <Alert>
            <LockKeyIcon />
            <AlertTitle>The vault is locked in this tab</AlertTitle>
            <AlertDescription>
              <p>
                Portable keys are stored wrapped with your vault key, which lives
                only in memory and is cleared on reload. They are listed below,
                but they cannot sign until you sign in again. Device-bound keys
                are unaffected.
              </p>
              <p>
                <Link href="/sign-in">Sign in to unlock</Link>
              </p>
            </AlertDescription>
          </Alert>
        )}

        {loading ? (
          <LoadingCards />
        ) : keys.length === 0 ? (
          <EmptyState onGenerate={openDialog} />
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {keys.map((key) => (
                <KeyCard
                  key={key.id}
                  storedKey={key}
                  vaultUnlocked={unlocked}
                  onDelete={() => setPendingDelete(key)}
                />
              ))}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {deviceBoundCount > 0
                ? `${deviceBoundCount} of these ${
                    deviceBoundCount === 1 ? "key exists" : "keys exist"
                  } only in this browser profile. Clearing site data for this origin deletes ${
                    deviceBoundCount === 1 ? "it" : "them"
                  } with no way back.`
                : "Every key here is portable, so the same set is available on any device you sign in on."}
            </p>
          </>
        )}
      </div>

      {/* ------------------------------------------------------ generate key */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Generate key</DialogTitle>
            <DialogDescription>
              An Ed25519 pair is created in WebCrypto. The private key is
              non-extractable in use; only the public half ever leaves this page.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleGenerate} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="key-label">Label</Label>
              <Input
                id="key-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="webxterm"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Becomes the comment at the end of the authorized_keys line, so
                you can tell your keys apart in the file.
              </p>
            </div>

            <fieldset className="grid gap-2">
              <legend className="mb-2 text-xs font-medium">Custody</legend>

              <ModeOption
                id="mode-portable"
                checked={mode === "portable"}
                disabled={!unlocked}
                onSelect={() => setMode("portable")}
                icon={<CloudArrowUpIcon />}
                title="Portable"
                body="Wrapped with your vault key the moment it is generated, then re-imported non-extractable. The wrapped copy syncs as ciphertext, so this key is usable on every device you sign in on, and one authorized_keys line covers all of them."
              />

              <ModeOption
                id="mode-device-bound"
                checked={mode === "device-bound"}
                onSelect={() => setMode("device-bound")}
                icon={<DesktopTowerIcon />}
                title="Device-bound"
                body="Generated non-extractable from the start and never wrapped, so it cannot sync anywhere. Each browser you work from needs its own key, and therefore its own line on every server."
              />
            </fieldset>

            {!unlocked && (
              <Alert>
                <LockKeyIcon />
                <AlertTitle>Portable needs the vault unlocked</AlertTitle>
                <AlertDescription>
                  <p>
                    Wrapping happens with the vault key, which is derived from
                    your password in the browser and never persisted. This tab
                    does not have it, so portable is unavailable until you sign
                    in again. A device-bound key can be generated right now.
                  </p>
                  <p>
                    <Link href="/sign-in">Sign in to unlock the vault</Link>
                  </p>
                </AlertDescription>
              </Alert>
            )}

            {mode === "device-bound" && (
              <Alert className="border-warning/40">
                <WarningIcon className="text-warning" />
                <AlertTitle>This key cannot be recovered</AlertTitle>
                <AlertDescription>
                  There is no wrapped copy and no export, so clearing site data,
                  using a private window, or reinstalling this browser destroys
                  it permanently. Recovering means generating a new key and
                  adding its line to every server again.
                </AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={generating}>
                {generating ? "Generating" : "Generate key"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* -------------------------------------------------------- delete key */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.mode === "device-bound"
                ? "This key exists only in this browser and cannot be exported, so deleting it is final. Its line stays in ~/.ssh/authorized_keys on every server you added it to — the server will keep offering it until you remove the line yourself."
                : "The wrapped copy is deleted here and on your other devices at the next sync. Its line stays in ~/.ssh/authorized_keys on every server you added it to — the server will keep offering it until you remove the line yourself."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              Delete key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/* ----------------------------------------------------------------- key card */

function KeyCard({
  storedKey,
  vaultUnlocked,
  onDelete,
}: {
  storedKey: StoredKey;
  vaultUnlocked: boolean;
  onDelete: () => void;
}) {
  const line = React.useMemo(() => lineFor(storedKey), [storedKey]);
  const deviceBound = storedKey.mode === "device-bound";

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-heading truncate text-sm font-medium text-foreground">
                {storedKey.label}
              </h2>
              <Badge variant={deviceBound ? "outline" : "secondary"} className="font-normal">
                {deviceBound ? <DesktopTowerIcon /> : <CloudArrowUpIcon />}
                {storedKey.mode}
              </Badge>
            </div>
            <p className="mt-1 text-muted-foreground">
              ssh-ed25519 · created {formatDate(storedKey.createdAt)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            aria-label={`Delete ${storedKey.label}`}
          >
            <TrashIcon />
          </Button>
        </div>

        <div className="rounded-sm border border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5">
            <span className="truncate text-muted-foreground">
              ~/.ssh/authorized_keys line
            </span>
            <CopyButton value={installCommand(line)} />
          </div>
          {/* break-all rather than a scroller: the line must never push the
              page sideways on a phone. */}
          <pre className="bg-terminal px-2.5 py-2 text-[11px] leading-relaxed break-all whitespace-pre-wrap">
            <code>{line}</code>
          </pre>
        </div>

        <p className="text-muted-foreground">
          The copy button gives you{" "}
          <code className="text-foreground">
            echo &apos;…&apos; &gt;&gt; ~/.ssh/authorized_keys
          </code>
          , ready to paste into a shell on the server. Stock sshd, no agent, no
          daemon.
        </p>

        {deviceBound && (
          <Alert className="border-warning/40">
            <WarningIcon className="text-warning" />
            <AlertTitle>Bound to this browser</AlertTitle>
            <AlertDescription>
              Clearing site data for this origin destroys this key
              irrecoverably; there is no wrapped copy anywhere to restore from.
              It also does not sync, so any other device needs its own key and
              its own line on this server.
            </AlertDescription>
          </Alert>
        )}

        {!deviceBound && !vaultUnlocked && (
          <p className="text-muted-foreground">
            <LockKeyIcon className="mr-1.5 inline size-3.5 align-[-2px]" />
            Wrapped with the vault key, which this tab does not currently hold.
            Sign in again before connecting with it.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------- copy button */

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("The browser refused clipboard access. Select the line and copy it by hand.");
    }
  }

  return (
    <Button variant="ghost" size="xs" onClick={copy} className="shrink-0">
      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      {copied ? "Copied" : "Copy command"}
    </Button>
  );
}

/* -------------------------------------------------------------- mode option */

function ModeOption({
  id,
  checked,
  disabled,
  onSelect,
  icon,
  title,
  body,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer gap-3 rounded-sm border border-border p-3 transition-colors",
        checked ? "border-primary bg-secondary/50" : "hover:border-primary/40",
        disabled && "cursor-not-allowed opacity-50 hover:border-border",
      )}
    >
      <input
        type="radio"
        id={id}
        name="key-mode"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      <span
        className={cn(
          "mt-0.5 grid size-7 shrink-0 place-items-center rounded-sm border border-border bg-secondary",
          checked ? "text-primary" : "text-muted-foreground",
        )}
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="font-heading block text-sm font-medium text-foreground">
          {title}
        </span>
        <span className="mt-1 block leading-relaxed text-muted-foreground">{body}</span>
      </span>
    </label>
  );
}

/* ------------------------------------------------------- empty and loading */

function EmptyState({ onGenerate }: { onGenerate: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-4 py-6 sm:px-8">
        <div className="grid size-9 place-items-center rounded-sm border border-border bg-secondary text-primary">
          <KeyIcon />
        </div>
        <div className="max-w-xl">
          <h2 className="font-heading text-sm font-medium">No keys yet</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            A key is generated here, in the page, and the private half is a
            WebCrypto handle marked non-extractable. It can sign the SSH
            handshake and nothing else; there is no file to leak and no
            passphrase to forget.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Setting up a server is one line appended to ~/.ssh/authorized_keys
            on stock sshd. If you would rather not paste it, connect once with a
            password and webxterm installs the line for you.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onGenerate}>
            <PlusIcon /> Generate key
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard/terminal">Connect with a password once</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LoadingCards() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1].map((i) => (
        <Card key={i}>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-4 w-16" />
            </div>
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-14 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
