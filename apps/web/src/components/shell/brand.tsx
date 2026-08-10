import Link from "next/link"

import { Mark } from "@/components/shell/mark"
import { cn } from "@/lib/utils"

/**
 * The wordmark, shared by every surface — marketing, auth, dashboard, and the
 * dashboard — so the product reads as one thing rather than a site with an app
 * bolted on.
 */
export function Brand({
  className,
  href = "/",
  size = "md",
  labelClassName,
}: {
  className?: string
  href?: string
  size?: "sm" | "md"
  /** Lets a collapsed sidebar hide the wordmark and keep the glyph. */
  labelClassName?: string
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex items-center gap-2 font-heading font-semibold tracking-tight",
        size === "sm" ? "text-sm" : "text-base",
        className,
      )}
    >
      <Mark
        className={cn(
          "text-primary transition-colors group-hover:text-primary/80",
          size === "sm" ? "size-5" : "size-6",
        )}
      />
      <span className={labelClassName}>weirdvault</span>
    </Link>
  )
}
