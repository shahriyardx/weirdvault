import type { Metadata } from "next";

import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Sign in to webxterm. Your password is stretched with Argon2id in the browser; only a one-way derived token reaches the server.",
};

// Server Component: the interactive parts live in AuthForm, which is the only
// piece that needs the client.
export default function SignIn() {
  return <AuthForm mode="sign-in" />;
}
