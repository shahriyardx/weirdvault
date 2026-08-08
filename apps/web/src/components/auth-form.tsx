"use client";

// Client Component: this form owns local field state and — more importantly —
// runs the Argon2id derivation in the browser. Neither can happen on the server
// without defeating the point of the split KDF.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { SpinnerGapIcon, WarningCircleIcon } from "@phosphor-icons/react/dist/ssr";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInWithVault, signUpWithVault } from "@/lib/auth-client";
import { setVaultKey } from "@/lib/vault/session";

export type AuthMode = "sign-in" | "sign-up";

/**
 * One form, two modes, so sign-in and sign-up cannot drift apart — the vault
 * handling below is the security-critical path and should exist exactly once.
 */
export function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Argon2id runs here, in the browser. What goes over the wire is an HKDF
      // branch — the server never sees anything that can open the vault.
      const { vaultKey } =
        mode === "sign-up"
          ? await signUpWithVault(email, password, name)
          : await signInWithVault(email, password);

      setVaultKey(vaultKey);
      router.push("/workspace");
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }

  const signUp = mode === "sign-up";

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-base">
          {signUp ? "Create your account" : "Sign in"}
        </CardTitle>
        <CardDescription>
          {signUp
            ? "Your email and password derive the vault key on this device. Only a separate, one-way branch of it is sent to us."
            : "Your password is stretched on this device and never sent. What reaches the server cannot open the vault."}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          {signUp && (
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                autoComplete="name"
                placeholder="Ada Lovelace"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                required
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={signUp ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              required
              minLength={10}
              aria-describedby={signUp ? "password-hint" : undefined}
            />
            {signUp && (
              <p id="password-hint" className="text-xs/relaxed text-muted-foreground">
                Ten characters or more. It is never stored anywhere, on your
                device or ours, so choose something you can reproduce exactly.
              </p>
            )}
          </div>

          {error && (
            <Alert variant="destructive">
              <WarningCircleIcon weight="fill" />
              <AlertTitle>
                {signUp ? "Could not create the account" : "Could not sign in"}
              </AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" size="lg" disabled={busy} className="w-full">
            {busy ? (
              <>
                <SpinnerGapIcon className="animate-spin" />
                Deriving keys…
              </>
            ) : signUp ? (
              "Create account"
            ) : (
              "Sign in"
            )}
          </Button>

          <p className="text-xs/relaxed text-muted-foreground">
            The button pauses for a second or two — longer on a phone. That is
            Argon2id stretching your password with 64 MiB of memory and three
            passes, in this tab. The wait is the work.
          </p>
        </form>
      </CardContent>

      <CardFooter className="text-xs text-muted-foreground">
        {signUp ? (
          <p>
            Already have an account?{" "}
            <Link
              href="/sign-in"
              className="text-foreground underline underline-offset-4 hover:text-primary"
            >
              Sign in
            </Link>
          </p>
        ) : (
          <p>
            No account yet?{" "}
            <Link
              href="/sign-up"
              className="text-foreground underline underline-offset-4 hover:text-primary"
            >
              Create one
            </Link>
          </p>
        )}
      </CardFooter>
    </Card>
  );
}
