"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ClockCounterClockwiseIcon,
  DevicesIcon,
  FolderOpenIcon,
  GearSixIcon,
  HardDrivesIcon,
  KeyIcon,
  PlugsConnectedIcon,
  PlusIcon,
  SquaresFourIcon,
  TerminalWindowIcon,
  UsersThreeIcon,
  XIcon,
} from "@phosphor-icons/react/dist/ssr";

import { Brand } from "@/components/shell/brand";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { useSshSession } from "@/lib/ssh/session-provider";

/**
 * The application sidebar.
 *
 * Live sessions are listed individually rather than hidden behind a single
 * "Terminal" entry. With several open at once — often several to the same host,
 * one tailing logs while another deploys — the list *is* the navigation.
 * Clicking one switches to it; the × closes that session and leaves the rest
 * alone.
 */
export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { sessions, activeId, setActive, disconnect, hosts, keys } = useSshSession();

  const manage = [
    { href: "/dashboard", label: "Overview", icon: SquaresFourIcon, exact: true },
    { href: "/dashboard/files", label: "Files", icon: FolderOpenIcon },
    { href: "/dashboard/hosts", label: "Hosts", icon: HardDrivesIcon, badge: hosts.length },
    { href: "/dashboard/keys", label: "Keys", icon: KeyIcon, badge: keys.length },
  ] as const;

  const account = [
    { href: "/dashboard/devices", label: "Devices", icon: DevicesIcon },
    { href: "/dashboard/activity", label: "Activity", icon: ClockCounterClockwiseIcon },
    { href: "/dashboard/team", label: "Team", icon: UsersThreeIcon },
    { href: "/dashboard/settings", label: "Settings", icon: GearSixIcon },
  ] as const;

  function openSession(id: string) {
    setActive(id);
    // These entries carry a terminal icon and are labelled with the shell they
    // belong to, so they open the shell — always. Files is its own destination
    // with its own session picker.
    router.push("/dashboard/terminal");
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-sidebar-border h-12 shrink-0 justify-center border-b p-0 px-3 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-0">
        <Brand size="sm" href="/dashboard" labelClassName="group-data-[collapsible=icon]:hidden" />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>
            Sessions
            {sessions.length > 0 && (
              <span className="text-muted-foreground ml-1.5">{sessions.length}</span>
            )}
          </SidebarGroupLabel>
          <SidebarGroupAction asChild title="New session">
            <Link href="/dashboard/connect">
              <PlusIcon />
              <span className="sr-only">New session</span>
            </Link>
          </SidebarGroupAction>

          <SidebarGroupContent>
            <SidebarMenu>
              {sessions.map((s) => {
                const isActive = s.id === activeId;
                return (
                  <SidebarMenuItem key={s.id}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => openSession(s.id)}
                      tooltip={`${s.label}:${s.target.port}`}
                    >
                      <TerminalWindowIcon className={isActive ? "text-success" : undefined} />
                      <span className="truncate">{s.label}</span>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      onClick={() => disconnect(s.id)}
                      title={`Close ${s.label}`}
                    >
                      <XIcon />
                      <span className="sr-only">Close session</span>
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                );
              })}

              {sessions.length === 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="Connect to a host">
                    <Link href="/dashboard/connect">
                      <PlugsConnectedIcon />
                      <span className="text-muted-foreground">No sessions</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}

            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <NavGroup label="Manage" items={manage} pathname={pathname} />
        <NavGroup label="Account" items={account} pathname={pathname} />
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Connect to a host">
              <Link href="/dashboard/connect">
                <PlugsConnectedIcon className={sessions.length ? "text-success" : undefined} />
                <span className="truncate">New session</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

function NavGroup({
  label,
  items,
  pathname,
}: {
  label: string;
  items: readonly {
    href: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    exact?: boolean;
    badge?: number;
  }[];
  pathname: string;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                  <Link href={item.href}>
                    <Icon />
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
                {item.badge ? (
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
  );
}
