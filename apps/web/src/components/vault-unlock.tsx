"use client";

import { useState } from "react";
import { LockKeyIcon } from "@phosphor-icons/react/dist/ssr";

import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { useSession } from "@/lib/auth-client";
import { deriveSecrets } from "@/lib/vault/kdf";
import { setVaultKey, useVaultUnlocked } from "@/lib/vault/session";

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

  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const needsUnlock = !isPending && Boolean(session?.user) && !unlocked && !dismissed;

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
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={needsUnlock} onOpenChange={(open) => !open && setDismissed(true)}>
      <DialogContent className="sm:max-w-md">
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
            <Button type="button" variant="ghost" size="sm" onClick={() => setDismissed(true)}>
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
