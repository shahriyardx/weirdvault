"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import {
  ColumnsIcon,
  PlugsConnectedIcon,
  RowsIcon,
  SquareSplitHorizontalIcon,
  XIcon,
} from "@phosphor-icons/react/dist/ssr";

import { TerminalView, type TerminalHandle } from "@/components/terminal";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSshSession } from "@/lib/ssh/session-provider";
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
      </div>

      <div
        className={cn(
          "grid min-h-0 flex-1 gap-px",
          splitDirection === "horizontal" ? "grid-flow-col auto-cols-fr" : "grid-flow-row auto-rows-fr",
        )}
      >
        {panes.map((sessionId, index) => (
          <Pane
            key={`${sessionId}:${index}`}
            sessionId={sessionId}
            index={index}
            focused={index === focusedPane && split}
            showChrome={split}
            onFocus={() => setFocusedPane(index)}
            onClose={() => closePane(index)}
          />
        ))}
      </div>
    </div>
  );
}

function Pane({
  sessionId,
  index,
  focused,
  showChrome,
  onFocus,
  onClose,
}: {
  sessionId: string;
  index: number;
  focused: boolean;
  showChrome: boolean;
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

      <div className="min-h-0 flex-1 p-1.5">
        <TerminalView
          ref={term}
          onInput={(d) => write(sessionId, d)}
          onResize={(c, r) => resize(sessionId, c, r)}
        />
      </div>
    </div>
  );
}
