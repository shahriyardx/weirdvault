"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ClockCounterClockwiseIcon,
  CodeIcon,
  DesktopTowerIcon,
  DevicesIcon,
  FilmReelIcon,
  FolderOpenIcon,
  GearSixIcon,
  HardDrivesIcon,
  KeyIcon,
  PencilSimpleIcon,
  PlugsConnectedIcon,
  PlusIcon,
  RecordIcon,
  SquaresFourIcon,
  StopIcon,
  TerminalWindowIcon,
  XIcon,
} from "@phosphor-icons/react/dist/ssr";

import { Brand } from "@/components/shell/brand";
import { CredentialPrompt, useCredentialPrompt } from "@/components/ssh/credential-prompt";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
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
import type { Host } from "@/lib/hosts";
import { useRecorders } from "@/lib/recording/capture";
import { useSessionRecorder } from "@/lib/recording/use-session-recorder";
import { useSshSession } from "@/lib/ssh/session-provider";
import { useConnectHost } from "@/lib/ssh/use-connect-host";

/**
 * The application sidebar.
 *
 * Live sessions are listed individually rather than hidden behind a single
 * "Terminal" entry. With several open at once — often several to the same host,
 * one tailing logs while another deploys — the list *is* the navigation.
 * Clicking one switches to it; the × closes that session and leaves the rest
 * alone.
 *
 * The + beside the group heading is the only way to start a session in the
 * whole shell. There were three — this one, a footer entry, and a button in the
 * top bar — and all three went to the connection form, which is the wrong
 * destination for the common case: you almost always want a host you have
 * already saved, not a blank form. So + opens a picker, and the form is the last
 * item in it.
 */
export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { sessions, activeId, setActive, disconnect, renameSession, hosts, keys } = useSshSession();

  const recorders = useRecorders();
  const { start: startRecording, stop: stopRecording } = useSessionRecorder();
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  // The picker connects directly, so this shell owns the credential dialog: a
  // password host asks every time, and there is no page underneath to ask for
  // it. Mounted once here rather than per-page, since the sidebar outlives every
  // route it sits beside.
  const prompt = useCredentialPrompt();
  const { connectToHost, connecting } = useConnectHost({
    askFor: prompt.askFor,
    onConnected: () => router.push("/dashboard/terminal"),
  });

  // Most-recently-used first, so the picker's top item is usually the answer.
  const recentHosts = [...hosts]
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, 8);

  // Recordings and Snippets were shipped as routes and never linked here, so the
  // only way to reach either was to type the URL. Both are ordinary pages.
  const manage = [
    { href: "/dashboard", label: "Overview", icon: SquaresFourIcon, exact: true },
    { href: "/dashboard/files", label: "Files", icon: FolderOpenIcon },
    { href: "/dashboard/hosts", label: "Hosts", icon: HardDrivesIcon, badge: hosts.length },
    { href: "/dashboard/machines", label: "Machines", icon: DesktopTowerIcon },
    { href: "/dashboard/keys", label: "Keys", icon: KeyIcon, badge: keys.length },
    { href: "/dashboard/snippets", label: "Snippets", icon: CodeIcon },
    { href: "/dashboard/recordings", label: "Recordings", icon: FilmReelIcon },
  ] as const;

  const account = [
    { href: "/dashboard/devices", label: "Devices", icon: DevicesIcon },
    { href: "/dashboard/activity", label: "Activity", icon: ClockCounterClockwiseIcon },
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
          <NewSessionMenu hosts={recentHosts} connecting={connecting} onPick={connectToHost}>
            <SidebarGroupAction title="New session">
              <PlusIcon />
              <span className="sr-only">New session</span>
            </SidebarGroupAction>
          </NewSessionMenu>

          <SidebarGroupContent>
            <SidebarMenu>
              {/* The group action above is hidden when the sidebar is collapsed
                  to icons, which would leave the rail with no way to start a
                  session at all. Same menu, same position, shown only there. */}
              <SidebarMenuItem className="hidden group-data-[collapsible=icon]:block">
                <NewSessionMenu hosts={recentHosts} connecting={connecting} onPick={connectToHost}>
                  <SidebarMenuButton tooltip="New session">
                    <PlusIcon />
                    <span>New session</span>
                  </SidebarMenuButton>
                </NewSessionMenu>
              </SidebarMenuItem>

              {sessions.map((s) => {
                const isActive = s.id === activeId;
                const recorder = recorders.find((r) => r.sessionId === s.id) ?? null;
                const capturing = recorder?.capturing === true;

                if (renaming?.id === s.id) {
                  return (
                    <SidebarMenuItem key={s.id}>
                      <form
                        className="px-2 py-1 group-data-[collapsible=icon]:hidden"
                        onSubmit={(e) => {
                          e.preventDefault();
                          renameSession(s.id, renaming.name);
                          setRenaming(null);
                        }}
                      >
                        <Input
                          aria-label={`Rename ${s.label}`}
                          className="h-7"
                          autoFocus
                          value={renaming.name}
                          onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
                          // Blur commits rather than discards: clicking away from a
                          // name you have just typed reads as accepting it, and a
                          // rename is trivially repeatable if it does not.
                          onBlur={() => {
                            renameSession(s.id, renaming.name);
                            setRenaming(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setRenaming(null);
                          }}
                        />
                      </form>
                    </SidebarMenuItem>
                  );
                }

                return (
                  <ContextMenu key={s.id}>
                    <ContextMenuTrigger asChild>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          isActive={isActive}
                          onClick={() => openSession(s.id)}
                          tooltip={`${s.label}:${s.target.port}`}
                        >
                          <TerminalWindowIcon className={isActive ? "text-success" : undefined} />
                          <span className="truncate">{s.label}</span>
                          {/* A recording in progress has to be visible from
                              wherever you are, not only on the tab that started
                              it. The dot sits inside the button so it survives
                              the icon-collapsed rail. */}
                          {capturing && (
                            <span
                              aria-label="Recording"
                              className="bg-destructive ml-auto size-1.5 shrink-0 animate-pulse rounded-full"
                            />
                          )}
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
                    </ContextMenuTrigger>

                    <ContextMenuContent className="w-52">
                      <ContextMenuItem onSelect={() => openSession(s.id)}>
                        <TerminalWindowIcon />
                        Open
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => setRenaming({ id: s.id, name: s.label })}>
                        <PencilSimpleIcon />
                        Rename
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      {/* Disabled rather than hidden while a previous recording
                          is still saving: offering to record again would quietly
                          discard the one in flight. */}
                      <ContextMenuItem
                        disabled={recorder !== null && !capturing}
                        onSelect={() => void (capturing ? stopRecording(s.id) : startRecording(s))}
                      >
                        {capturing ? (
                          <StopIcon weight="fill" />
                        ) : (
                          <RecordIcon weight="fill" className="text-destructive" />
                        )}
                        {recorder !== null && !capturing
                          ? "Saving recording…"
                          : capturing
                            ? "Stop recording"
                            : "Record session"}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem variant="destructive" onSelect={() => disconnect(s.id)}>
                        <XIcon />
                        Close session
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
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

      <SidebarRail />

      <CredentialPrompt pending={prompt.pending} keys={keys} onSettle={prompt.settle} />
    </Sidebar>
  );
}

/**
 * The one control that starts a session, wrapped around whatever triggers it.
 *
 * A picker rather than a link, because the connection form is the rare case:
 * nearly every session goes to a host that is already saved, and making people
 * pass through a blank form to reach one was the complaint. The form is still
 * here — last item, where a fallback belongs.
 */
function NewSessionMenu({
  children,
  hosts,
  connecting,
  onPick,
}: {
  /** The trigger. Rendered through Radix's asChild, so it keeps its own styling. */
  children: React.ReactNode;
  hosts: Host[];
  /** Id of the host currently being connected, so its row cannot be double-fired. */
  connecting: string | null;
  onPick: (host: Host) => void | Promise<unknown>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="w-60">
        {hosts.length > 0 && (
          <>
            <DropdownMenuLabel>Connect to</DropdownMenuLabel>
            {hosts.map((h) => (
              <DropdownMenuItem
                key={h.id}
                disabled={connecting === h.id}
                onSelect={() => void onPick(h)}
              >
                <TerminalWindowIcon />
                <span className="min-w-0 flex-1 truncate">{h.label}</span>
                <span className="text-muted-foreground shrink-0 text-[10px]">
                  {h.username}@{h.hostname}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem asChild>
          <Link href="/dashboard/connect">
            <PlugsConnectedIcon />
            {hosts.length > 0 ? "Another host…" : "Connect to a host…"}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
