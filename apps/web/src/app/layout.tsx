import type { Metadata, Viewport } from "next"
import { Geist, JetBrains_Mono } from "next/font/google"

import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
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
  title: {
    default: "weirdvault — SSH in your browser",
    template: "%s · weirdvault",
  },
  description:
    "A zero-install SSH client. Generate a key in the browser, connect to any server, " +
    "and get a terminal, file explorer and remote editor — with keys that never leave your device.",
  applicationName: "weirdvault",
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
