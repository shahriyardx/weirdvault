import { DashboardNav } from "@/components/shell/dashboard-nav";
import { SiteHeader } from "@/components/shell/site-header";

/**
 * The dashboard reuses the public site header rather than introducing separate
 * app chrome, so signing in reads as going deeper into the same product instead
 * of crossing into a different one.
 */
export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader authed />
      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-8 px-4 sm:px-6">
        <aside className="hidden w-52 shrink-0 border-r border-border pr-2 md:block">
          <DashboardNav />
        </aside>
        <main className="min-w-0 flex-1 pb-16">{children}</main>
      </div>
    </div>
  );
}
