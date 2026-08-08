"use client";

import Link from "next/link";
import { ShieldCheckIcon, SignOutIcon } from "@phosphor-icons/react/dist/ssr";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { signOut } from "@/lib/auth-client";
import { useSshSession } from "@/lib/ssh/session-provider";
import { useVaultUnlocked } from "@/lib/vault/session";

export function DashboardTopBar() {
  const { phase, active, sessions, disconnect } = useSshSession();
  const connected = Boolean(active);
  const vaultUnlocked = useVaultUnlocked();

  return (
    <header className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <SidebarTrigger className="size-7" />
      <Separator orientation="vertical" className="!h-5 self-center" />

      <Badge variant={connected ? "default" : "outline"} className="gap-1.5 text-[10px] font-normal">
        <span
          aria-hidden
          className={`size-1.5 rounded-full ${connected ? "bg-success" : "bg-muted-foreground"}`}
        />
        {phase === "connecting" ? "Connecting" : connected ? "Live" : "Not connected"}
      </Badge>

      {active && (
        <span className="text-muted-foreground truncate text-xs">
          {active.label}:{active.target.port}
          {sessions.length > 1 && (
            <span className="ml-1.5">· {sessions.length} sessions</span>
          )}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="gap-1.5 text-[10px] font-normal">
              <ShieldCheckIcon
                className={vaultUnlocked ? "text-success" : "text-muted-foreground"}
              />
              {vaultUnlocked ? "Vault unlocked" : "Local only"}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            {vaultUnlocked
              ? "Hosts, keys and pins sync as ciphertext the server cannot read"
              : "Sign in to sync hosts and keys across devices"}
          </TooltipContent>
        </Tooltip>

        {connected ? (
          <Button variant="outline" size="sm" onClick={() => disconnect()}>
            Disconnect
          </Button>
        ) : (
          <Button asChild size="sm">
            <Link href="/dashboard/connect">Connect</Link>
          </Button>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              onClick={() => void signOut()}
            >
              <SignOutIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Sign out</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
