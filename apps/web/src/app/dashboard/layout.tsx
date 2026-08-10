import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { AppSidebar } from "@/components/shell/app-sidebar"
import { DashboardContent } from "@/components/shell/dashboard-content"
import { DashboardTopBar } from "@/components/shell/dashboard-top-bar"
import { VaultUnlock } from "@/components/vault-unlock"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { SessionProvider } from "@/lib/ssh/session-provider"
import { VaultSync } from "@/lib/vault/auto-sync"
import { dashboardRootMetadata } from "@/lib/seo"
import { accountGate } from "@/lib/auth"

/**
 * Nothing under here is for a crawler. A signed-out visit redirects to
 * /sign-in, so without this every dashboard URL would index as a copy of the
 * sign-in page — a dozen duplicates standing in for pages the public cannot
 * reach. robots.ts disallows the path as well; this is the half that still
 * applies to a crawler that ignores robots.txt.
 *
 * The title is the overview's own, and the fallback for any dashboard route
 * that has not given itself one.
 */
export const metadata = dashboardRootMetadata()

/**
 * The dashboard is the application, not a section of the website.
 *
 * It gets an app shell — collapsible sidebar, full height, no marketing
 * chrome — and the SSH session lives above the router so navigating between
 * Terminal and Files keeps one connection alive rather than reconnecting.
 *
 * ---------------------------------------------------------------------------
 * The gate, and what it is really for
 *
 * OAuth made this necessary. A GitHub sign-in produces a session and no secret,
 * so an account can reach this shell fully authenticated with no vault key in
 * existence anywhere — every host it tried to save would have nothing to
 * encrypt under. Discovering that at the moment of pressing Save, on a form
 * already filled in, is a bad way to find out, so it is decided here instead:
 * an account with no password credential goes to /set-vault-password and cannot
 * come back until it has one.
 *
 * It lives in the layout rather than in each page so that a page added next
 * month inherits it without anybody remembering to. That placement has a known
 * limit, and it is why the sentence above says "decided" rather than "enforced":
 * Next's partial rendering does not re-run a layout on a client-side transition
 * between its own children, so this runs on entry to the dashboard and on full
 * loads, not on every navigation inside it. That is the right shape for what
 * this is — routing, not authorization. The authorization is in the API routes,
 * which each check the session themselves, and the vault is protected by
 * arithmetic rather than by routing: with no password there is no key, and
 * nothing this shell renders can encrypt anything without one.
 *
 * Two loops were available here and neither is taken. /set-vault-password is in
 * the (auth) group, outside this layout, so nothing bounces between the two;
 * and the bootstrap page sends a finished account to /dashboard only after
 * confirming the credential exists, which is the same fact this gate reads.
 *
 * The signed-out redirect is new too. Before this, an unauthenticated visit
 * rendered the whole shell and let the client discover the problem — an empty
 * sidebar and a vault dialog over nothing. Sending them to /sign-in cannot loop:
 * /sign-in is outside this layout and never redirects here on its own.
 *
 * The cost is a top-level await before any of this streams, plus one database
 * query for the account list. Both are paid once per dashboard entry.
 */
export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const gate = await accountGate(await headers())
  if (gate === "signed-out") redirect("/sign-in")
  if (gate === "no-vault-password") redirect("/set-vault-password")

  return (
    <SessionProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="flex h-svh min-w-0 flex-col overflow-hidden">
          <DashboardTopBar />
          <DashboardContent>{children}</DashboardContent>
          <VaultUnlock />
          {/* Renders nothing. It is what makes the vault pull as well as push:
              on unlock, on focus, and on a slow timer. Here rather than in each
              page so a page added later inherits it, and so navigating between
              Hosts and Keys does not restart the timer. */}
          <VaultSync />
        </SidebarInset>
      </SidebarProvider>
    </SessionProvider>
  )
}
