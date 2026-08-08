"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { PlugsConnectedIcon } from "@phosphor-icons/react/dist/ssr";

import { TerminalView, type TerminalHandle } from "@/components/terminal";
import { Button } from "@/components/ui/button";
import { useSshSession } from "@/lib/ssh/session-provider";

/**
 * The terminal, as a route.
 *
 * The session lives in the provider, so leaving this page for Files and coming
 * back reattaches to the same shell — including whatever scrolled past while
 * you were gone, which the provider buffers.
 */
export default function TerminalPage() {
  const term = useRef<TerminalHandle>(null);
  const { phase, subscribe, write, resize } = useSshSession();

  useEffect(() => {
    if (phase !== "connected") return;
    // subscribe() replays the buffer first, so a remount restores scrollback.
    const unsubscribe = subscribe((bytes) => term.current?.write(bytes));
    term.current?.focus();
    return unsubscribe;
  }, [phase, subscribe]);

  if (phase !== "connected") {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm text-center">
          <h2 className="font-heading text-sm font-medium">No active session</h2>
          <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
            Connect to a host and the terminal opens here. The same connection
            also powers the file explorer, so it costs no second login.
          </p>
          <Button asChild className="mt-4" size="sm">
            <Link href="/dashboard/connect">
              <PlugsConnectedIcon />
              Connect to a host
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-terminal h-full p-2">
      <TerminalView ref={term} onInput={write} onResize={resize} />
    </div>
  );
}
