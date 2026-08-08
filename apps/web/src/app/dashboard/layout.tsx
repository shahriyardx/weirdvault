import { AppSidebar } from "@/components/shell/app-sidebar";
import { DashboardContent } from "@/components/shell/dashboard-content";
import { DashboardTopBar } from "@/components/shell/dashboard-top-bar";
import { VaultUnlock } from "@/components/vault-unlock";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { SessionProvider } from "@/lib/ssh/session-provider";

/**
 * The dashboard is the application, not a section of the website.
 *
 * It gets an app shell — collapsible sidebar, full height, no marketing
 * chrome — and the SSH session lives above the router so navigating between
 * Terminal and Files keeps one connection alive rather than reconnecting.
 */
export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return (
    <SessionProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="flex h-svh min-w-0 flex-col overflow-hidden">
          <DashboardTopBar />
          <DashboardContent>{children}</DashboardContent>
          <VaultUnlock />
        </SidebarInset>
      </SidebarProvider>
    </SessionProvider>
  );
}
