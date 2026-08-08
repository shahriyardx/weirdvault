"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { PlugsConnectedIcon } from "@phosphor-icons/react/dist/ssr";

import { TerminalView, type TerminalHandle } from "@/components/terminal";
import { Button } from "@/components/ui/button";
import { useSshSession } from "@/lib/ssh/session-provider";

/**
 * The active session's shell.
 *
 * Keyed on the session id so switching sessions in the sidebar tears down one
 * terminal and mounts another — each replays its own buffered output, so a
 * session you left running comes back with everything it printed while you
 * were elsewhere.
 */
export default function TerminalPage() {
  const { activeId } = useSshSession();

  if (!activeId) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm text-center">
          <h2 className="font-heading text-sm font-medium">No active session</h2>
          <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
            Connect to a host and its shell opens here. You can hold several
            sessions at once, including more than one to the same host.
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

  return <SessionTerminal key={activeId} id={activeId} />;
}

function SessionTerminal({ id }: { id: string }) {
  const term = useRef<TerminalHandle>(null);
  const { subscribe, write, resize } = useSshSession();

  useEffect(() => {
    // subscribe() replays this session's buffer before streaming, so a remount
    // restores scrollback rather than starting blank.
    const unsubscribe = subscribe(id, (bytes) => term.current?.write(bytes));
    term.current?.focus();
    return unsubscribe;
  }, [id, subscribe]);

  return (
    <div className="bg-terminal h-full p-2">
      <TerminalView
        ref={term}
        onInput={(d) => write(id, d)}
        onResize={(c, r) => resize(id, c, r)}
      />
    </div>
  );
}
