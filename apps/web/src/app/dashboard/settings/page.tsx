"use client";

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
 *   Wired:      sign out, sign out everywhere, export the encrypted vault.
 *   Not wired:  change password, recovery codes, vault import, account
 *               deletion. Each says so on the surface, with the reason.
 */

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  DatabaseIcon,
  DownloadSimpleIcon,
  IdentificationCardIcon,
  InfoIcon,
  KeyIcon,
  LifebuoyIcon,
  LockKeyIcon,
  PasswordIcon,
  ShieldCheckIcon,
  SignOutIcon,
  SpinnerGapIcon,
  TrashIcon,
  UploadSimpleIcon,
  UserIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { PageHeader } from "@/components/shell/page-shell";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { authClient, signOut, useSession } from "@/lib/auth-client";
import { lock } from "@/lib/vault/session";

export default function SettingsPage() {
  const { data: session, isPending } = useSession();
  const user = session?.user;

  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Your identity, the password that derives your vault key, and the data we hold on your behalf — which is one encrypted blob and some timestamps."
      />

      <Tabs defaultValue="account" className="mt-6 gap-6">
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
        </TabsContent>

        <TabsContent value="security" className="space-y-6">
          <ChangePasswordSection />
          <SessionsSection />
          <RecoveryCodesSection />
        </TabsContent>

        <TabsContent value="data" className="space-y-6">
          <ExportSection />
          <ImportSection />
          <DeleteAccountSection email={user?.email ?? null} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* -------------------------------------------------------------- account tab */

function AccountSection({
  name,
  email,
  createdAt,
  loading,
}: {
  name: string | null;
  email: string | null;
  createdAt: Date | string | null;
  loading: boolean;
}) {
  const display = name?.trim() || email || "No session";

  return (
    <>
      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle className="flex items-center gap-2">
            <IdentificationCardIcon className="size-4 text-primary" />
            Profile
          </CardTitle>
          <CardDescription>
            The only two things we know about you by name. Everything else you
            store — hosts, keys, snippets — reaches us as ciphertext.
          </CardDescription>
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
                  <p className="truncate font-heading text-sm font-medium">
                    {display}
                  </p>
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
                <Field label="Plan" value="Free (no billing configured)" />
              </dl>
            </div>
          )}
        </CardContent>

        <CardFooter>
          <NotImplemented>
            Editing the display name is not wired up yet. It is cosmetic — it
            appears in a team roster and nowhere else.
          </NotImplemented>
        </CardFooter>
      </Card>

      <Alert>
        <InfoIcon className="text-primary" />
        <AlertTitle>Your email address is part of the key derivation</AlertTitle>
        <AlertDescription>
          <span>
            The vault key is derived from your password using your email address
            as the Argon2id salt, so a new device can unlock the vault with
            nothing but those two values and no server round trip. The
            consequence is that changing the email changes the key, which means
            re-encrypting the vault — the same migration as changing the
            password. It is deliberately not a one-click action.
          </span>
        </AlertDescription>
      </Alert>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-foreground">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------- security tab */

/**
 * The form is real and the explanation is real; the submission is not, because
 * the migration behind it does not exist yet. A password change has to derive a
 * new auth token and a new vault key, decrypt the vault under the old key,
 * re-encrypt it under the new one, and land both changes together — a
 * half-applied version of that locks the account out of its own data.
 */
function ChangePasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const mismatch = confirm.length > 0 && next !== confirm;

  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <PasswordIcon className="size-4 text-primary" />
          Change password
        </CardTitle>
        <CardDescription>
          Your password is stretched with Argon2id in this tab and split by HKDF
          into an auth token, which is sent, and a vault key, which is not.
          Changing the password therefore re-derives the vault key, so the entire
          vault has to be decrypted under the old key and re-encrypted under the
          new one before the change can be committed.
        </CardDescription>
        <CardAction>
          <Badge variant="outline" className="text-warning">
            Not implemented
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent>
        <form
          className="grid max-w-sm gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            toast.error("Password changes are not enabled yet", {
              description:
                "The re-encryption migration is not shipped. Rather than change the auth token and strand the vault, this form does nothing.",
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              disabled
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              disabled
            />
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
              disabled
            />
            {mismatch && (
              <p className="text-destructive">The two entries do not match.</p>
            )}
          </div>

          <Button type="submit" className="w-fit" disabled>
            Change password and re-encrypt vault
          </Button>
        </form>
      </CardContent>

      <CardFooter>
        <NotImplemented>
          Disabled until the migration lands: derive the new secrets, pull the
          vault, re-encrypt it, and commit the new auth token and the new blob
          atomically. Until then, a partial change would leave a readable account
          with an unreadable vault.
        </NotImplemented>
      </CardFooter>
    </Card>
  );
}

/** Genuinely wired: Better Auth can revoke every session for this user. */
function SessionsSection() {
  const router = useRouter();
  const [busy, setBusy] = useState<"one" | "all" | null>(null);

  async function signOutHere() {
    setBusy("one");
    try {
      await signOut();
      // The vault key lives in memory only; drop it before leaving the page.
      lock();
      router.push("/sign-in");
    } catch (e) {
      toast.error("Sign out failed", { description: message(e) });
      setBusy(null);
    }
  }

  async function signOutEverywhere() {
    setBusy("all");
    try {
      const res = await authClient.revokeSessions();
      if (res.error) throw new Error(res.error.message ?? "revoke failed");
      await signOut();
      lock();
      toast.success("Every session revoked");
      router.push("/sign-in");
    } catch (e) {
      toast.error("Could not revoke sessions", { description: message(e) });
      setBusy(null);
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
          Signing out ends a session and clears the vault key from memory. It
          does not erase what is already stored in this browser — hosts, pinned
          host keys and device-bound keys stay in IndexedDB until they are
          deleted or the site data is cleared.
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
                Every browser signed in to this account is signed out, including
                this one. Nothing is deleted and no key is rotated — use this
                when a device is lost or a session might be someone else&apos;s.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => void signOutEverywhere()}
              >
                Revoke all sessions
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

function RecoveryCodesSection() {
  return (
    <Card>
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <LifebuoyIcon className="size-4 text-primary" />
          Recovery codes
        </CardTitle>
        <CardDescription>
          A recovery code is a second way into the vault: the vault key wrapped
          under a high-entropy code that is shown once and never stored by us.
          Present the code, unwrap the key, set a new password. It is the only
          construction that survives a forgotten password without giving us
          something we could decrypt with.
        </CardDescription>
        <CardAction>
          <Badge variant="outline" className="text-warning">
            Not implemented
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          {["————-————-————", "————-————-————", "————-————-————", "————-————-————"].map(
            (row, i) => (
              <div
                key={i}
                aria-hidden
                className="bg-terminal border border-border px-3 py-2 text-[11px] tracking-widest text-muted-foreground/50"
              >
                {row}
              </div>
            ),
          )}
        </div>

        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>There is no password recovery today</AlertTitle>
          <AlertDescription>
            <span>
              Until this ships, forgetting your password means the vault cannot
              be opened — not by you and not by us, because we never held
              anything that could open it. Export the encrypted vault from the
              Data tab and keep your password somewhere you trust.{" "}
              <Link href="/security" className="text-primary hover:underline">
                Why we cannot reset it for you
              </Link>
              .
            </span>
          </AlertDescription>
        </Alert>
      </CardContent>

      <CardFooter>
        <Button variant="outline" disabled>
          <KeyIcon data-icon="inline-start" />
          Generate recovery codes
        </Button>
      </CardFooter>
    </Card>
  );
}

/* ----------------------------------------------------------------- data tab */

/** Real: /api/vault hands back the stored ciphertext, which is what we save. */
function ExportSection() {
  const [busy, setBusy] = useState(false);

  async function exportVault() {
    setBusy(true);
    try {
      const res = await fetch("/api/vault", { cache: "no-store" });
      if (res.status === 401) throw new Error("Session expired. Sign in again.");
      if (!res.ok) throw new Error(`The server returned ${res.status}.`);

      const payload = (await res.json()) as { version: number; blob: string | null };
      if (!payload.blob) {
        toast.info("Nothing to export yet", {
          description:
            "No vault has been pushed from this account. Connect to a host or generate a key, then sync.",
        });
        return;
      }

      const stamp = new Date().toISOString().slice(0, 10);
      download(
        `webxterm-vault-v${payload.version}-${stamp}.json`,
        payload.blob,
        "application/json",
      );
      toast.success(`Exported vault version ${payload.version}`, {
        description:
          "The file is the same ciphertext the server holds. Only your password can open it.",
      });
    } catch (e) {
      toast.error("Export failed", { description: message(e) });
    } finally {
      setBusy(false);
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
          Downloads the encrypted blob exactly as stored: AES-256-GCM under your
          vault key, with the IV and ciphertext base64-encoded. Hosts, portable
          keys and pinned host keys are inside it. We cannot read the file we
          just handed you, and we cannot help you open it later.
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
        <span className="text-muted-foreground">
          Keep it anywhere. It is useless without your password.
        </span>
      </CardContent>
    </Card>
  );
}

/**
 * Half-real on purpose: the file is genuinely parsed and checked in the browser,
 * and the result reported truthfully. Restoring is not wired, because a restore
 * has to merge with what is already on this device rather than overwrite it.
 */
function ImportSection() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [inspected, setInspected] = useState<
    { ok: true; bytes: number; name: string } | { ok: false; reason: string } | null
  >(null);

  async function inspect(file: File) {
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      if (!isEnvelope(parsed)) {
        setInspected({
          ok: false,
          reason:
            "This is not a webxterm vault export. Expected a JSON object with v, iv and ct fields.",
        });
        return;
      }
      setInspected({ ok: true, bytes: parsed.ct.length, name: file.name });
    } catch {
      setInspected({ ok: false, reason: "The file is not valid JSON." });
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
          Selecting a file checks its shape here, in this tab. Nothing is
          uploaded and nothing is decrypted — the ciphertext only opens under the
          vault key derived from the password that produced it.
        </CardDescription>
        <CardAction>
          <Badge variant="outline" className="text-warning">
            Restore not implemented
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void inspect(file);
            e.target.value = "";
          }}
        />
        <Button variant="outline" onClick={() => inputRef.current?.click()}>
          <UploadSimpleIcon data-icon="inline-start" />
          Choose a vault file
        </Button>

        {inspected && (
          <Alert variant={inspected.ok ? "default" : "destructive"}>
            {inspected.ok ? (
              <CheckCircleIcon className="text-success" />
            ) : (
              <WarningCircleIcon />
            )}
            <AlertTitle>
              {inspected.ok
                ? "Valid vault envelope"
                : "That file was not accepted"}
            </AlertTitle>
            <AlertDescription>
              {inspected.ok
                ? `${inspected.name} carries ${inspected.bytes.toLocaleString()} base64 characters of ciphertext in format v1. Whether your password opens it can only be established by decrypting, which restore would do.`
                : inspected.reason}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>

      <CardFooter>
        <NotImplemented>
          Restore is disabled because it must merge, not overwrite: the same
          record-level last-write-wins pass that sync uses, so importing an old
          export on an active device cannot silently delete newer hosts and keys.
        </NotImplemented>
      </CardFooter>
    </Card>
  );
}

function DeleteAccountSection({ email }: { email: string | null }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");

  const target = email ?? "";
  const matches = target.length > 0 && typed.trim().toLowerCase() === target.toLowerCase();

  return (
    <Card className="ring-destructive/30">
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2 text-destructive">
          <TrashIcon className="size-4" />
          Delete account
        </CardTitle>
        <CardDescription>
          Removes the account, its sessions, its team memberships and the
          encrypted vault blob. What stays behind is whatever this browser has in
          IndexedDB, and whatever public keys you left in an authorized_keys file
          — deleting an account here cannot reach into your servers.
        </CardDescription>
        <CardAction>
          <Badge variant="outline" className="text-warning">
            Not implemented
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent>
        <AlertDialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setTyped("");
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
                This cannot be undone. The vault blob is deleted with the
                account, and since we never held a key for it, there is no copy
                anywhere that we could restore. Export it first if you want to
                keep it.
              </AlertDialogDescription>
            </AlertDialogHeader>

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
              />
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel>Keep my account</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={!matches}
                onClick={() =>
                  toast.error("Account deletion is not enabled yet", {
                    description:
                      "The server does not expose a delete endpoint, so nothing was removed. Sign out everywhere and export your vault if you are leaving.",
                  })
                }
              >
                Delete account
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>

      <CardFooter>
        <NotImplemented>
          The confirmation flow is real; the deletion is not. Better Auth&apos;s
          delete-user endpoint is disabled on this deployment, so confirming
          reports the failure instead of pretending the account is gone.
        </NotImplemented>
      </CardFooter>
    </Card>
  );
}

/* ----------------------------------------------------------------- pieces */

function NotImplemented({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-muted-foreground">
      <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/* ---------------------------------------------------------------- helpers */

function isEnvelope(value: unknown): value is { v: number; iv: string; ct: string } {
  if (typeof value !== "object" || value === null) return false;
  const env = value as Record<string, unknown>;
  return env.v === 1 && typeof env.iv === "string" && typeof env.ct === "string";
}

function download(filename: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((p) => p[0] ?? "").join("");
  return (letters || name.slice(0, 2) || "??").toUpperCase();
}

const DATE_FMT = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function formatDate(at: Date | string): string {
  const ms = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(ms) ? DATE_FMT.format(ms) : "unknown";
}

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message?: unknown }).message ?? "Unknown error");
  }
  return String(e ?? "Unknown error");
}
