import type { Metadata } from "next"

import { AuthForm } from "@/components/auth-form"
import { pageMetadata } from "@/lib/seo"

export const metadata: Metadata = pageMetadata({
  title: "Sign in",
  description:
    "Sign in to weirdvault. Your password is stretched with Argon2id in the browser; only a one-way derived token reaches the server.",
  path: "/sign-in",
  // The landing page is what should rank for this product. These two are
  // thin duplicates of it wrapped around a form, and an indexed sign-in page
  // competes with the page that actually explains anything.
  noindex: true,
})

// Server Component: the interactive parts live in AuthForm, which is the only
// piece that needs the client.
export default function SignIn() {
  return <AuthForm mode="sign-in" />
}
