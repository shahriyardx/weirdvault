"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

import { signInWithVault, signUpWithVault } from "@/lib/auth-client";
import { setVaultKey } from "@/lib/vault/session";

export default function SignIn() {
  return <AuthForm mode="sign-in" />;
}

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
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

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold">
        {mode === "sign-up" ? "Create your account" : "Sign in"}
      </h1>
      <p className="mt-1.5 text-sm text-neutral-500">
        Your password is stretched on this device and never sent.
      </p>

      <form onSubmit={submit} className="mt-6 space-y-3">
        {mode === "sign-up" && (
          <input
            className="w-full rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        )}
        <input
          className="w-full rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="w-full rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={10}
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-[#6aa9ff] py-2 font-medium text-[#07101f] disabled:opacity-50"
        >
          {busy ? "Deriving keys…" : mode === "sign-up" ? "Create account" : "Sign in"}
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

      <p className="mt-6 text-sm text-neutral-500">
        {mode === "sign-up" ? (
          <>
            Already have an account? <Link href="/sign-in" className="underline">Sign in</Link>
          </>
        ) : (
          <>
            No account? <Link href="/sign-up" className="underline">Create one</Link>
          </>
        )}
      </p>
    </main>
  );
}
