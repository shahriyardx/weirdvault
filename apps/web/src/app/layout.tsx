import type { Metadata, Viewport } from "next"
import { Geist, JetBrains_Mono } from "next/font/google"

import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { metadataBase, SITE_DESCRIPTION, SITE_NAME } from "@/lib/seo"
import { cn } from "@/lib/utils"

import "./globals.css"

const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" })
const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" })

/**
 * Every route renders per request, and the reason is the CSP.
 *
 * src/proxy.ts mints a fresh nonce per request and puts it in the
 * Content-Security-Policy. Next applies that nonce to its own script tags only
 * while it is *rendering* — a statically prerendered page was built long before
 * the request, so its HTML carries no nonce at all, and every script in it is
 * blocked by the very header meant to allow them. The page then serves, looks
 * right, and does nothing: no hydration, no effects, no interactive controls.
 *
 * That is not a theoretical failure. It shipped: /sign-in was prerendered, all
 * fifteen of its scripts loaded without a nonce, and the browser refused them
 * all — which showed up as two missing buttons rather than as a broken page.
 *
 * So the choice is between static rendering and a nonce-based CSP, and the
 * nonce wins. This is an application behind authentication, not a content site;
 * what prerendering buys here is a few milliseconds on the marketing pages,
 * and what it costs is the control docs/THREAT-MODEL.md names as the mitigation
 * for the largest residual risk.
 */
export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  // Every relative URL below — canonicals, Open Graph URLs, the OG image —
  // resolves against this. Without it Next cannot make them absolute, and a
  // relative canonical is worse than none.
  ...(metadataBase() ? { metadataBase: metadataBase() } : {}),
  title: {
    default: `${SITE_NAME} — SSH in your browser`,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  // The home page is the canonical entry. Pages override this with their own.
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: `${SITE_NAME} — SSH in your browser`,
    description: SITE_DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} — SSH in your browser`,
    description: SITE_DESCRIPTION,
  },
  // Said explicitly rather than left to a crawler's defaults, and paired with
  // the per-route noindex on everything behind the sign-in page.
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
}

export const viewport: Viewport = {
  // Dark only, so tell the browser up front and let native controls match.
  colorScheme: "dark",
  themeColor: "#111318",
  width: "device-width",
  initialScale: 1,
  // The terminal needs the full viewport when the on-screen keyboard opens.
  viewportFit: "cover",
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={cn("h-full font-sans antialiased", geistSans.variable, jetbrainsMono.variable)}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground flex min-h-full flex-col">
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  )
}
