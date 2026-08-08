"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClockCounterClockwiseIcon,
  DevicesIcon,
  FolderOpenIcon,
  GearSixIcon,
  HardDrivesIcon,
  KeyIcon,
  PlugsConnectedIcon,
  SquaresFourIcon,
  TerminalWindowIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react/dist/ssr";

import { Brand } from "@/components/shell/brand";
import { Badge } from "@/components/ui/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { useSshSession } from "@/lib/ssh/session-provider";

/**
 * The application sidebar.
 *
 * Everything the product actually does is reachable from here — terminal,
 * files, hosts, keys — rather than being buried inside a single workspace
 * route. Items that need a live SSH connection are disabled and say so when
 * there isn't one, which is more honest than letting someone click into an
 * empty file browser and wonder what broke.
 */
export function AppSidebar() {
  const pathname = usePathname();
  const { phase, target, hosts, keys } = useSshSession();
  const connected = phase === "connected";

  const groups = [
    {
      label: "Session",
      items: [
        {
          href: "/dashboard/terminal",
          label: "Terminal",
          icon: TerminalWindowIcon,
          needsSession: true,
        },
        {
          href: "/dashboard/files",
          label: "Files",
          icon: FolderOpenIcon,
          needsSession: true,
        },
      ],
    },
    {
      label: "Manage",
      items: [
        { href: "/dashboard", label: "Overview", icon: SquaresFourIcon, exact: true },
        { href: "/dashboard/hosts", label: "Hosts", icon: HardDrivesIcon, badge: hosts.length },
        { href: "/dashboard/keys", label: "Keys", icon: KeyIcon, badge: keys.length },
      ],
    },
    {
      label: "Account",
      items: [
        { href: "/dashboard/devices", label: "Devices", icon: DevicesIcon },
        { href: "/dashboard/activity", label: "Activity", icon: ClockCounterClockwiseIcon },
        { href: "/dashboard/team", label: "Team", icon: UsersThreeIcon },
        { href: "/dashboard/settings", label: "Settings", icon: GearSixIcon },
      ],
    },
  ] as const;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-sidebar-border h-12 shrink-0 justify-center border-b p-0 px-3 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-0">
        <Brand
          size="sm"
          href="/dashboard"
          labelClassName="group-data-[collapsible=icon]:hidden"
        />
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const active =
                    "exact" in item && item.exact
                      ? pathname === item.href
                      : pathname.startsWith(item.href);
                  const disabled = "needsSession" in item && item.needsSession && !connected;
                  const Icon = item.icon;

                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild={!disabled}
                        isActive={active && !disabled}
                        disabled={disabled}
                        tooltip={
                          disabled ? `${item.label} — connect to a host first` : item.label
                        }
                      >
                        {disabled ? (
                          <>
                            <Icon />
                            <span>{item.label}</span>
                          </>
                        ) : (
                          <Link href={item.href}>
                            <Icon />
                            <span>{item.label}</span>
                          </Link>
                        )}
                      </SidebarMenuButton>
                      {"badge" in item && item.badge ? (
                        <SidebarMenuBadge className="group-data-[collapsible=icon]:hidden">
                          {item.badge}
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip={connected ? `Connected to ${target?.hostname}` : "Not connected"}
            >
              <Link href="/dashboard/connect">
                <PlugsConnectedIcon className={connected ? "text-success" : undefined} />
                <span className="truncate group-data-[collapsible=icon]:hidden">
                  {connected && target
                    ? `${target.username}@${target.hostname}`
                    : phase === "connecting"
                      ? "Connecting…"
                      : "Connect"}
                </span>
              </Link>
            </SidebarMenuButton>
            {connected && (
              <SidebarMenuBadge className="group-data-[collapsible=icon]:hidden">
                <Badge variant="outline" className="h-4 px-1 text-[9px] font-normal">
                  live
                </Badge>
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
