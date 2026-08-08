"use client";

import Link from "next/link";
import { PlusIcon, ShieldCheckIcon, SignOutIcon } from "@phosphor-icons/react/dist/ssr";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { signOut } from "@/lib/auth-client";
import { useSshSession } from "@/lib/ssh/session-provider";
import { useVaultUnlocked } from "@/lib/vault/session";

export function DashboardTopBar() {
  const { sessions } = useSshSession();
  const vaultUnlocked = useVaultUnlocked();

  return (
    <header className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <SidebarTrigger className="size-7" />
      <Separator orientation="vertical" className="!h-5 self-center" />

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

        <Button asChild size="sm" variant={sessions.length ? "outline" : "default"}>
          <Link href="/dashboard/connect">
            <PlusIcon />
            New session
          </Link>
        </Button>

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
