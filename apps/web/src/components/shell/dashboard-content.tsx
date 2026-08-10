"use client";

import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * Content width for dashboard routes.
 *
 * Management pages get a measured column — prose running the full width of a
 * 1440px window is unreadable, and it was making action buttons collide with
 * body copy. The terminal and file explorer are the exception: they are tools
 * that should use every pixel, so they render full-bleed.
 */
const FULL_BLEED = ["/dashboard/terminal", "/dashboard/files"];

export function DashboardContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const bleed = FULL_BLEED.some((p) => pathname.startsWith(p));

  return (
    <div className={cn("min-h-0 flex-1", bleed ? "overflow-hidden" : "overflow-auto")}>
      <div className={cn(bleed ? "h-full" : "mx-auto w-full max-w-4xl px-6 py-6")}>{children}</div>
    </div>
  );
}
