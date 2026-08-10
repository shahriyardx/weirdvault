import { SiteFooter } from "@/components/shell/site-footer"
import { SiteHeader } from "@/components/shell/site-header"
import { cn } from "@/lib/utils"

/**
 * The one shell.
 *
 * Public pages and the dashboard both render inside this, so navigation,
 * spacing, and chrome are identical across the whole product — signing in
 * should feel like moving deeper into the same application, not crossing into
 * a different one.
 */
export function PageShell({
  children,
  authed,
  className,
  bleed = false,
}: {
  children: React.ReactNode
  authed?: boolean
  className?: string
  /** Skip the centred container — for full-width surfaces like the dashboard. */
  bleed?: boolean
}) {
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader authed={authed} />
      <main className={cn("flex-1", !bleed && "mx-auto w-full max-w-6xl px-4 sm:px-6", className)}>
        {children}
      </main>
      <SiteFooter />
    </div>
  )
}

/** Consistent page heading for both public pages and dashboard sections. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border py-8 sm:flex-row sm:items-end">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1.5 text-xs font-medium tracking-wider text-primary uppercase">
            {eyebrow}
          </p>
        )}
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 gap-2 sm:ml-auto">{actions}</div>}
    </div>
  )
}
