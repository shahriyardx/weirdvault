"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { LockKeyIcon, LockKeyOpenIcon, SignOutIcon } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { signOut } from "@/lib/auth-client"
import { lock, requestUnlock, useVaultUnlocked } from "@/lib/vault/session"

export function DashboardTopBar() {
  const vaultUnlocked = useVaultUnlocked()
  const router = useRouter()
  const [signingOut, setSigningOut] = React.useState(false)

  /**
   * Sign out, lock, leave — in that order, and all three.
   *
   * This used to be `void signOut()` and nothing else, which ended the session
   * on the server and changed nothing on screen. The dashboard's gate is in a
   * server layout, and Next does not re-run a layout on a client transition
   * between its own children, so nothing was left to notice: the user stayed on
   * a dashboard that looked signed in until they happened to reload.
   *
   * The vault is the half that matters more than the redirect. The key lives in
   * tab memory, so a sign-out that does not lock leaves every host, key and
   * snippet decrypted and on screen after the session that authorised reading
   * them is gone — on a shared machine, for whoever sits down next. Settings has
   * always done both; this control did neither.
   *
   * `replace` rather than `push`: Back from here should not restore a cached
   * dashboard that this session can no longer load.
   */
  async function handleSignOut() {
    setSigningOut(true)
    try {
      await signOut()
      lock()
      router.replace("/sign-in")
    } catch (e) {
      // Left signed in and told why, rather than navigating to /sign-in over a
      // session that is still open.
      toast.error("Sign out failed", {
        description: e instanceof Error ? e.message : String(e),
      })
      setSigningOut(false)
    }
  }

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
              disabled={signingOut}
              onClick={() => void handleSignOut()}
            >
              <SignOutIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Sign out</TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
