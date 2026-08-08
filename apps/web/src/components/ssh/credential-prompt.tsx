"use client";

/**
 * Asking for whatever the host did not already specify.
 *
 * Two things can be missing at connect time: which key to use (a host saved
 * with "Ask on connect") and a password (we never store one, so a password host
 * asks every time). Both are the same interaction — a dialog that blocks the
 * connect until it is answered — so they are one component.
 *
 * Silently falling back to some other key was worse than asking: it produced a
 * handshake failure from the server instead of a question from us.
 */

import * as React from "react";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Host } from "@/lib/hosts";
import type { SshKey } from "@/lib/keys";

export type Need = "key" | "password";

/** What the prompt hands back: a chosen key id, or a password. */
export type Credential = { keyId: string } | { password: string };

interface Pending {
  host: { label: string; username: string; hostname: string; port: number };
  need: Need;
  resolve: (credential: Credential | null) => void;
}

export function useCredentialPrompt() {
  const [pending, setPending] = React.useState<Pending | null>(null);

  const askFor = React.useCallback(
    (host: Pending["host"], need: Need) =>
      new Promise<Credential | null>((resolve) => setPending({ host, need, resolve })),
    [],
  );

  const settle = React.useCallback((credential: Credential | null) => {
    setPending((p) => {
      p?.resolve(credential);
      return null;
    });
  }, []);

  return { pending, askFor, settle };
}

export function CredentialPrompt({
  pending,
  keys,
  onSettle,
}: {
  pending: Pick<Pending, "host" | "need"> | null;
  keys: SshKey[];
  onSettle: (credential: Credential | null) => void;
}) {
  const [password, setPassword] = React.useState("");
  const [keyId, setKeyId] = React.useState("");
  /**
   * What is being entered right now, which starts at what the host asked for
   * but is not fixed to it — a key host might be reachable with a password
   * today, and a password host might be the one you have a key for.
   */
  const [mode, setMode] = React.useState<Need>("key");

  // Never let a password survive from one prompt into the next.
  React.useEffect(() => {
    if (!pending) return;
    setPassword("");
    setKeyId(keys[0]?.id ?? "");
    setMode(pending.need);
  }, [pending, keys]);

  const host = pending?.host;
  const target = host ? `${host.username}@${host.hostname}:${host.port}` : "";
  const ready = mode === "password" ? password.length > 0 : keyId.length > 0;
  const canUseKey = keys.length > 0;

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && onSettle(null)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Connect to {host?.label}</DialogTitle>
          <DialogDescription>
            {target} —{" "}
            {mode === "password"
              ? "the password is sent inside the encrypted SSH channel, and never stored."
              : "this host was saved without a key, so pick the one to authenticate with."}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            onSettle(mode === "password" ? { password } : { keyId });
          }}
        >
          {mode === "password" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="connect-password">Password</Label>
              <Input
                id="connect-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus
                required
              />
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="connect-key">Key</Label>
              <Select value={keyId} onValueChange={setKeyId}>
                <SelectTrigger id="connect-key" className="w-full">
                  <SelectValue placeholder="Choose a key" />
                </SelectTrigger>
                <SelectContent>
                  {keys.map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.label} · {k.mode}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Either method can be the right one for a given host, so the other
              is always one click away rather than a trip back to the form. */}
          {(mode === "password" ? canUseKey : true) && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="justify-self-start px-0"
              onClick={() => setMode(mode === "password" ? "key" : "password")}
            >
              {mode === "password" ? "Use a key instead" : "Use a password instead"}
            </Button>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onSettle(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready}>
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
