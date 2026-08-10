import { dashboardMetadata } from "@/lib/seo"

/**
 * Names the tab for security-relevant events on this account.
 *
 * A layout rather than a page export because page.tsx is a Client Component and
 * cannot export metadata. dashboardMetadata carries the noindex with it, so a
 * route cannot gain a title and lose the directive.
 */
export const metadata = dashboardMetadata("Activity")

export default function Layout({ children }: LayoutProps<"/dashboard/activity">) {
  return children
}
