import { dashboardMetadata } from "@/lib/seo"

/**
 * Names the tab for the account, its plan and its security factors.
 *
 * A layout rather than a page export because page.tsx is a Client Component and
 * cannot export metadata. dashboardMetadata carries the noindex with it, so a
 * route cannot gain a title and lose the directive.
 */
export const metadata = dashboardMetadata("Settings")

export default function Layout({ children }: LayoutProps<"/dashboard/settings">) {
  return children
}
