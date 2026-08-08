"use client";

import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

import { registerDevice } from "@/lib/device";
import { deriveSecrets } from "@/lib/vault/kdf";

export const authClient = createAuthClient({
  plugins: [organizationClient()],
});

export const { useSession, signOut, organization } = authClient;

/**
 * Sign-up and sign-in both go through the split KDF, so the raw password never
 * touches the network. Callers get the vault key back and must keep it in
 * memory only — persisting it anywhere would undo the point.
 */
export async function signUpWithVault(
  email: string,
  password: string,
  name: string,
) {
  const { authToken, vaultKey, auditKey } = await deriveSecrets(email, password);
  const res = await authClient.signUp.email({
    email,
    password: authToken,
    name,
  });
  if (res.error) throw new Error(res.error.message ?? "sign up failed");
  // Best-effort: a device that fails to register can still work, it just
  // won't appear in "where am I signed in".
  void registerDevice();
  return { vaultKey, auditKey, user: res.data?.user };
}

export async function signInWithVault(email: string, password: string) {
  const { authToken, vaultKey, auditKey } = await deriveSecrets(email, password);
  const res = await authClient.signIn.email({ email, password: authToken });
  if (res.error) throw new Error(res.error.message ?? "sign in failed");
  void registerDevice();
  return { vaultKey, auditKey, user: res.data?.user };
}
