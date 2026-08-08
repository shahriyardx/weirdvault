import type { Metadata } from "next";

import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = {
  title: "Create account",
  description:
    "Create a webxterm account. Unlimited hosts and devices, encrypted sync included, and a vault key that is derived on your device and never sent.",
};

// Server Component: the interactive parts live in AuthForm, which is the only
// piece that needs the client.
export default function SignUp() {
  return <AuthForm mode="sign-up" />;
}
