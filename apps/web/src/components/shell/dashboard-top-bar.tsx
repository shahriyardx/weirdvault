"use client";

import {
  LockKeyIcon,
  LockKeyOpenIcon,
  SignOutIcon,
} from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { signOut } from "@/lib/auth-client";
import { lock, requestUnlock, useVaultUnlocked } from "@/lib/vault/session";

export function DashboardTopBar() {
  const vaultUnlocked = useVaultUnlocked();

  return (
    <header className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <SidebarTrigger className="size-7" />
      <div className="ml-auto flex items-center gap-2">
        {/* State and its action in one control, because they are the same
            decision. This used to be an inert badge reading "Local only" when
            the vault was shut, which named the consequence instead of the state
            and gave no way to change it — and there was no way to lock the vault
            deliberately at all, short of signing out. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              className="font-normal"
              onClick={() => (vaultUnlocked ? lock() : requestUnlock())}
            >
              {vaultUnlocked ? (
                <LockKeyOpenIcon data-icon="inline-start" className="text-success" />
              ) : (
                <LockKeyIcon data-icon="inline-start" className="text-warning" />
              )}
              {vaultUnlocked ? "Vault unlocked" : "Vault locked"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {vaultUnlocked
              ? "Lock the vault. The key is dropped from memory; your session stays open."
              : "Unlock to read your hosts, keys and snippets."}
          </TooltipContent>
        </Tooltip>

        {/* No "New session" button here. Starting a session lives in exactly one
            place — the + beside Sessions in the sidebar — and three entry points
            to the same connection form was two too many. */}
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
