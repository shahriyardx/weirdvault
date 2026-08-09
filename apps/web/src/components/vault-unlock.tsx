"use client";

import { useState } from "react";
import { InfoIcon, LockKeyIcon } from "@phosphor-icons/react/dist/ssr";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePasswordlessSignIn, useSession } from "@/lib/auth-client";
import { deriveSecrets } from "@/lib/vault/kdf";
import {
  dismissUnlock,
  setVaultKey,
  useUnlockRequested,
  useVaultUnlocked,
} from "@/lib/vault/session";
import { useSshSession } from "@/lib/ssh/session-provider";

/**
 * Why a session can be signed in and still locked, said in one place.
 *
 * There are now two routes into this app that authenticate without a password —
 * a GitHub callback and a passkey — and both end in exactly this state: a valid
 * session, no vault key, and a host list that renders empty. A user who is not
 * told why will read that as their data having been lost, and the first thing
 * they will do about it is try to restore something.
 *
 * The two sentences live here rather than beside each sign-in button because
 * this dialog is where the consequence actually arrives, and because a second
 * copy written next to the passkey control would drift from the first the moment
 * either was edited. lib/auth-client.ts records which route it was; if it was
 * neither, the reason is the ordinary one (a reload) and no explanation is
 * needed because nothing surprising happened.
 */
const PASSWORDLESS_REASON: Record<string, { title: string; body: string }> = {
  passkey: {
    title: "You signed in with a passkey, so the vault is still locked",
    body:
      "A passkey proves who you are; it does not carry your vault key. That key is " +
      "derived from your password on this device and exists nowhere else, so it can " +
      "only come from the password. Your hosts and keys are still there — they are " +
      "ciphertext until this is filled in.",
  },
  github: {
    title: "You signed in with GitHub, so the vault is still locked",
    body:
      "GitHub proves who you are. It has not given us anything that could decrypt " +
      "your data, and neither has anything else, which is the point. Your hosts and " +
      "keys are still there — they are ciphertext until this is filled in.",
  },
};

/**
 * Re-unlocking after a page load.
 *
 * The vault key is memory-only, so a refresh leaves you signed in but locked —
 * portable keys cannot be unwrapped and sync cannot run. Without this, the only
 * way back would be to sign out and in again, which is a terrible answer to a
 * predictable state.
 *
 * The password is stretched here exactly as at sign-in; nothing is sent.
 */
export function VaultUnlock() {
  const { data: session, isPending } = useSession();
  const unlocked = useVaultUnlocked();
  const requested = useUnlockRequested();
  const passwordless = usePasswordlessSignIn();
  const { refreshKeys } = useSshSession();
  const reason = passwordless ? PASSWORDLESS_REASON[passwordless] : undefined;

  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Show on arrival, and again whenever something actually needs the vault —
  // "dismissed" only silences the automatic prompt, never an explicit request.
  const needsUnlock =
    !isPending && Boolean(session?.user) && !unlocked && (requested || !dismissed);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!session?.user.email) return;
    setBusy(true);
    setError(null);
    try {
      const { vaultKey, auditKey } = await deriveSecrets(session.user.email, password);
      // There is no server round trip to check this against, so a wrong
      // password produces a key that simply fails to decrypt. Sync surfaces
      // that; we cannot verify it here without weakening the model.
      setVaultKey(vaultKey, auditKey);
      setPassword("");
      // Portable keys only become usable once the vault is open.
      await refreshKeys();
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={needsUnlock}
      onOpenChange={(open) => {
        if (!open) {
          setDismissed(true);
          dismissUnlock();
        }
      }}
    >
      <DialogContent className="sm:max-w-md" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LockKeyIcon className="text-primary" />
            Unlock your vault
          </DialogTitle>
          <DialogDescription>
            Your vault key is derived on this device and never stored, so
            reloading the page locks it again. Enter your password to unlock
            portable keys and sync.
          </DialogDescription>
        </DialogHeader>

        {/* Only when the session came from a route that types no password. The
            ordinary case — a reload — needs no explanation, and an alert that
            appeared every time would be read past by the time it mattered. */}
        {reason && (
          <Alert>
            <InfoIcon className="text-primary" />
            <AlertTitle>{reason.title}</AlertTitle>
            <AlertDescription>
              <span>{reason.body}</span>
            </AlertDescription>
          </Alert>
        )}

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="vault-password">Password</Label>
            <Input
              id="vault-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDismissed(true);
                dismissUnlock();
              }}
            >
              Continue locked
            </Button>
            <Button type="submit" disabled={busy || !password}>
              {busy ? "Deriving keys…" : "Unlock"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
