"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClockCounterClockwiseIcon,
  DevicesIcon,
  GearSixIcon,
  HardDrivesIcon,
  KeyIcon,
  SquaresFourIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react/dist/ssr";

import { cn } from "@/lib/utils";

const SECTIONS = [
  {
    title: "Workspace",
    items: [
      { href: "/dashboard", label: "Overview", icon: SquaresFourIcon, exact: true },
      { href: "/dashboard/hosts", label: "Hosts", icon: HardDrivesIcon },
      { href: "/dashboard/keys", label: "Keys", icon: KeyIcon },
    ],
  },
  {
    title: "Account",
    items: [
      { href: "/dashboard/devices", label: "Devices", icon: DevicesIcon },
      { href: "/dashboard/activity", label: "Activity", icon: ClockCounterClockwiseIcon },
      { href: "/dashboard/team", label: "Team", icon: UsersThreeIcon },
      { href: "/dashboard/settings", label: "Settings", icon: GearSixIcon },
    ],
  },
] as const;

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-6 py-6">
      {SECTIONS.map((section) => (
        <div key={section.title}>
          <p className="mb-2 px-3 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
            {section.title}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active =
                "exact" in item && item.exact
                  ? pathname === item.href
                  : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-sm px-3 py-1.5 text-sm transition-colors",
                      active
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    <Icon className={cn("size-4", active && "text-primary")} />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
