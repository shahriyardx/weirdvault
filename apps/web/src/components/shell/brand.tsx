import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * The wordmark, shared by every surface — marketing, auth, dashboard, and the
 * workspace — so the product reads as one thing rather than a site with an app
 * bolted on.
 */
export function Brand({
  className,
  href = "/",
  size = "md",
  labelClassName,
}: {
  className?: string;
  href?: string;
  size?: "sm" | "md";
  /** Lets a collapsed sidebar hide the wordmark and keep the glyph. */
  labelClassName?: string;
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
      <span
        aria-hidden
        className={cn(
          "grid place-items-center rounded-sm border border-border bg-card text-primary",
          "transition-colors group-hover:border-primary/60",
          size === "sm" ? "size-5 text-[10px]" : "size-6 text-[11px]",
        )}
      >
        {">_"}
      </span>
      <span className={labelClassName}>webxterm</span>
    </Link>
  );
}
