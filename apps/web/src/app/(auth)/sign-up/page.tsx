import type { Metadata } from "next"

import { AuthForm } from "@/components/auth-form"
import { pageMetadata } from "@/lib/seo"

export const metadata: Metadata = pageMetadata({
  title: "Create account",
  description:
    "Create a weirdvault account. Unlimited hosts and devices, encrypted sync included, and a vault key that is derived on your device and never sent.",
  path: "/sign-up",
  // The landing page is what should rank for this product. These two are
  // thin duplicates of it wrapped around a form, and an indexed sign-in page
  // competes with the page that actually explains anything.
  noindex: true,
})

// Server Component: the interactive parts live in AuthForm, which is the only
// piece that needs the client.
export default function SignUp() {
  return <AuthForm mode="sign-up" />
}
