"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ColumnsIcon,
  KeyboardIcon,
  PlugsConnectedIcon,
  RowsIcon,
  SquareSplitHorizontalIcon,
  XIcon,
} from "@phosphor-icons/react/dist/ssr";

import { CredentialPrompt, useCredentialPrompt } from "@/components/ssh/credential-prompt";
import { TerminalView, useCoarsePointer, type TerminalHandle } from "@/components/terminal";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { listHosts, type Host } from "@/lib/hosts";
import { useSshSession } from "@/lib/ssh/session-provider";
import { useConnectHost } from "@/lib/ssh/use-connect-host";
import { cn } from "@/lib/utils";

/**
 * Terminal panes.
 *
 * Up to four sessions side by side. Each pane points at a session of its own,
 * so you can watch a log in one while working in another — including two panes
 * on the same host. The focused pane is what the sidebar retargets when you
 * click a session, which is what makes switching predictable with a split open.
 */
export default function TerminalPage() {
  const {
    sessions,
    panes,
    splitDirection,
    focusedPane,
    setFocusedPane,
    setSplitDirection,
    splitPane,
    closePane,
  } = useSshSession();

  // The key bar follows the input device by default, but the override has to
  // exist in both directions: a laptop needs to be able to summon it to test
  // the thing, and a phone needs to be able to put it away when it is reading
  // output rather than typing.
  const coarsePointer = useCoarsePointer();
  const [keyBarOverride, setKeyBarOverride] = useState<boolean | null>(null);
  const keyBar = keyBarOverride ?? coarsePointer;

  if (sessions.length === 0 || panes.length === 0) {
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

  const split = panes.length > 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px] font-normal"
              onClick={() => splitPane()}
              disabled={panes.length >= 4}
            >
              <SquareSplitHorizontalIcon />
              Split
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {panes.length >= 4 ? "Four panes is the limit" : "Open another pane"}
          </TooltipContent>
        </Tooltip>

        {split && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={
                  splitDirection === "horizontal" ? "Stack panes vertically" : "Place panes side by side"
                }
                onClick={() =>
                  setSplitDirection(splitDirection === "horizontal" ? "vertical" : "horizontal")
                }
              >
                {splitDirection === "horizontal" ? <RowsIcon /> : <ColumnsIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {splitDirection === "horizontal" ? "Stack vertically" : "Side by side"}
            </TooltipContent>
          </Tooltip>
        )}

        <span className="text-muted-foreground ml-auto text-[11px]">
          {panes.length} {panes.length === 1 ? "pane" : "panes"}
        </span>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn("ml-1 size-7", keyBar && "bg-muted text-foreground")}
              aria-label={keyBar ? "Hide the key bar" : "Show the key bar"}
              aria-pressed={keyBar}
              onClick={() => setKeyBarOverride(!keyBar)}
            >
              <KeyboardIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {keyBar
              ? "Hide Ctrl, Esc and the arrow keys"
              : "Show Ctrl, Esc and the arrow keys"}
          </TooltipContent>
        </Tooltip>
      </div>

      <div
        className={cn(
          "grid min-h-0 flex-1 gap-px",
          splitDirection === "horizontal" ? "grid-flow-col auto-cols-fr" : "grid-flow-row auto-rows-fr",
        )}
      >
        {panes.map((sessionId, index) =>
          sessionId === "" ? (
            <EmptyPane
              key={`empty:${index}`}
              index={index}
              focused={index === focusedPane}
              onFocus={() => setFocusedPane(index)}
              onClose={() => closePane(index)}
            />
          ) : (
            <Pane
              key={`${sessionId}:${index}`}
              sessionId={sessionId}
              index={index}
              focused={index === focusedPane && split}
              showChrome={split}
              // One bar, on the pane the keys would go to. Four panes each with
              // their own row would eat the screen and leave you guessing which
              // shell was about to receive the Ctrl-C.
              keyBar={keyBar && index === Math.min(focusedPane, panes.length - 1)}
              onFocus={() => setFocusedPane(index)}
              onClose={() => closePane(index)}
            />
          ),
        )}
      </div>
    </div>
  );
}

/**
 * A pane that has been opened but not pointed at anything.
 *
 * Splitting used to clone the session you were already looking at, which is
 * almost never the reason anyone splits. With nothing spare to show, the pane
 * asks which host to open instead — and connects into itself.
 */
function EmptyPane({
  index,
  focused,
  onFocus,
  onClose,
}: {
  index: number;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
}) {
  const { keys: usableKeys, sessions, setPaneSession } = useSshSession();
  const [hosts, setHosts] = useState<Host[]>([]);

  const prompt = useCredentialPrompt();
  const { connectToHost, connecting } = useConnectHost({
    askFor: prompt.askFor,
    onConnected: (id) => setPaneSession(index, id),
  });

  useEffect(() => {
    void listHosts().then(setHosts).catch(() => setHosts([]));
  }, []);

  return (
    <div
      onMouseDown={onFocus}
      className={cn(
        "bg-terminal flex min-h-0 min-w-0 flex-col ring-1",
        focused ? "ring-primary/50" : "ring-border",
      )}
    >
      <div className="border-border flex shrink-0 items-center gap-1 border-b px-1.5 py-1">
        <span className="text-muted-foreground px-1 text-[11px]">Empty pane</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-5"
          aria-label={`Close pane ${index + 1}`}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 place-items-center p-4">
        <div className="flex max-w-xs flex-col items-center gap-3 text-center">
          <p className="text-muted-foreground text-xs leading-relaxed">
            Pick a host to open here, or a session you already have running.
          </p>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary" disabled={connecting !== null}>
                <PlugsConnectedIcon />
                {connecting !== null ? "Connecting" : "Select host"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="w-56">
              {hosts.length === 0 && sessions.length === 0 ? (
                <DropdownMenuItem disabled>No saved hosts</DropdownMenuItem>
              ) : null}

              {hosts.length > 0 && <DropdownMenuLabel>Saved hosts</DropdownMenuLabel>}
              {hosts.map((host) => (
                <DropdownMenuItem
                  key={host.id}
                  onSelect={() => void connectToHost(host)}
                  className="flex-col items-start gap-0"
                >
                  <span className="truncate">{host.label}</span>
                  <span className="text-muted-foreground truncate text-[11px]">
                    {host.username}@{host.hostname}:{host.port}
                  </span>
                </DropdownMenuItem>
              ))}

              {sessions.length > 0 && (
                <>
                  {hosts.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel>Running sessions</DropdownMenuLabel>
                  {sessions.map((s) => (
                    <DropdownMenuItem key={s.id} onSelect={() => setPaneSession(index, s.id)}>
                      {s.label}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button asChild size="sm" variant="ghost" className="text-xs">
            <Link href="/dashboard/connect">New connection…</Link>
          </Button>
        </div>
      </div>

      <CredentialPrompt
        pending={prompt.pending}
        keys={usableKeys}
        onSettle={prompt.settle}
      />
    </div>
  );
}

function Pane({
  sessionId,
  index,
  focused,
  showChrome,
  keyBar,
  onFocus,
  onClose,
}: {
  sessionId: string;
  index: number;
  focused: boolean;
  showChrome: boolean;
  keyBar: boolean;
  onFocus: () => void;
  onClose: () => void;
}) {
  const term = useRef<TerminalHandle>(null);
  const { sessions, subscribe, write, resize, setPaneSession } = useSshSession();
  const entry = sessions.find((s) => s.id === sessionId);

  useEffect(() => {
    // Replays this session's buffer, so a pane opened later still shows the
    // banner and everything printed before it existed.
    const unsubscribe = subscribe(sessionId, (bytes) => term.current?.write(bytes));
    return unsubscribe;
  }, [sessionId, subscribe]);

  if (!entry) {
    return (
      <div className="text-muted-foreground bg-terminal grid place-items-center text-xs">
        That session has closed.
      </div>
    );
  }

  return (
    <div
      onMouseDown={onFocus}
      className={cn(
        "bg-terminal flex min-h-0 min-w-0 flex-col",
        showChrome && "ring-1",
        focused ? "ring-primary/50" : "ring-border",
      )}
    >
      {showChrome && (
        <div className="border-border flex shrink-0 items-center gap-1 border-b px-1.5 py-1">
          <Select value={sessionId} onValueChange={(v) => setPaneSession(index, v)}>
            <SelectTrigger
              size="sm"
              className="h-6 w-auto max-w-full border-0 bg-transparent px-1 text-[11px] shadow-none"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sessions.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-5"
            aria-label={`Close pane ${index + 1}`}
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
      )}

      {/* The key bar wants to sit flush with the bottom edge — inset by the
          pane's padding it would leave a strip of terminal below it, and the
          safe-area inset it carries would land in the wrong place. */}
      <div className={cn("min-h-0 flex-1 p-1.5", keyBar && "pb-0")}>
        <TerminalView
          ref={term}
          showKeyboardBar={keyBar}
          onInput={(d) => write(sessionId, d)}
          onResize={(c, r) => resize(sessionId, c, r)}
        />
      </div>
    </div>
  );
}
