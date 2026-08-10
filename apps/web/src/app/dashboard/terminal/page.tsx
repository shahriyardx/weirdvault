"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  ColumnsIcon,
  KeyboardIcon,
  MinusIcon,
  PlugsConnectedIcon,
  PlusIcon,
  RecordIcon,
  RowsIcon,
  SpinnerGapIcon,
  SquareSplitHorizontalIcon,
  StopIcon,
  XIcon,
} from "@phosphor-icons/react/dist/ssr";

import { CredentialPrompt, useCredentialPrompt } from "@/components/ssh/credential-prompt";
import {
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  TerminalView,
  useCoarsePointer,
  type TerminalHandle,
} from "@/components/terminal";
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
import { useBilling } from "@/lib/billing/client";
import { listHosts, type Host } from "@/lib/hosts";
import { useRecorders } from "@/lib/recording/capture";
import { MAX_CAPTURE_BYTES } from "@/lib/recording/limits";
import { useSessionRecorder } from "@/lib/recording/use-session-recorder";
import { useSshSession, type SessionEntry } from "@/lib/ssh/session-provider";
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

  const [fontSize, setFontSize] = useTerminalFontSize();

  // Which session the toolbar's record button acts on. `panes` can hold "" for a
  // pane that has been split but not pointed anywhere yet, and focusedPane can
  // outlive the pane it names while a close is settling, so both lookups are
  // allowed to come back empty rather than assumed.
  const focusedSession = sessions.find((s) => s.id === panes[focusedPane]) ?? null;

  if (sessions.length === 0 || panes.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm text-center">
          <h2 className="font-heading text-sm font-medium">No active session</h2>
          <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
            Connect to a host and its shell opens here. You can hold several sessions at once,
            including more than one to the same host.
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
                  splitDirection === "horizontal"
                    ? "Stack panes vertically"
                    : "Place panes side by side"
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

        {/* Recording, on the session you are actually in. It used to be reachable
            only from the Recordings page, which meant deciding to record before
            you had a reason to. The button follows the focused pane, so with a
            split open it records the shell you last clicked into — the same rule
            that decides where a keystroke goes. */}
        {focusedSession && <RecordToggle session={focusedSession} />}

        <span className="text-muted-foreground ml-auto text-[11px]">
          {panes.length} {panes.length === 1 ? "pane" : "panes"}
        </span>

        {/* Text size, without touching the browser's own zoom — which scales the
            sidebar and the dashboard chrome along with the shell, and is the
            thing people reach for only because nothing else is offered. Both
            buttons re-fit the grid, so zooming in trades columns for legibility
            and the remote PTY is told about it. */}
        <div className="ml-1 flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Smaller text"
                disabled={fontSize <= MIN_FONT_SIZE}
                onClick={() => setFontSize(fontSize - 1)}
              >
                <MinusIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Smaller text</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-1.5 text-[11px] font-normal tabular-nums"
                aria-label={`Text size ${fontSize} pixels. Reset to default.`}
                onClick={() => setFontSize(DEFAULT_FONT_SIZE)}
              >
                {fontSize}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reset to {DEFAULT_FONT_SIZE}px</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Larger text"
                disabled={fontSize >= MAX_FONT_SIZE}
                onClick={() => setFontSize(fontSize + 1)}
              >
                <PlusIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Larger text</TooltipContent>
          </Tooltip>
        </div>

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
            {keyBar ? "Hide Ctrl, Esc and the arrow keys" : "Show Ctrl, Esc and the arrow keys"}
          </TooltipContent>
        </Tooltip>
      </div>

      <div
        className={cn(
          "grid min-h-0 flex-1 gap-px",
          splitDirection === "horizontal"
            ? "grid-flow-col auto-cols-fr"
            : "grid-flow-row auto-rows-fr",
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
              fontSize={fontSize}
              onFocus={() => setFocusedPane(index)}
              onClose={() => closePane(index)}
            />
          ),
        )}
      </div>
    </div>
  );
}

const FONT_SIZE_KEY = "webxterm:terminal-font-size";

/**
 * The terminal's text size, remembered across visits.
 *
 * localStorage rather than the vault: it is a display preference with nothing
 * private in it, and putting it in the vault would mean the terminal rendered at
 * the wrong size until you unlocked.
 *
 * A module-level store read through useSyncExternalStore rather than state
 * seeded by an effect. The effect version is the obvious one and is wrong twice:
 * it renders the default first and corrects it on the next tick, so every visit
 * starts with a visible jump, and with two panes mounted each would own a copy
 * of the same preference.
 */
let fontSizeValue = DEFAULT_FONT_SIZE;
let fontSizeLoaded = false;
const fontSizeListeners = new Set<() => void>();

function fontSizeSnapshot(): number {
  // Read once, on the first browser snapshot. Subsequent calls return the cached
  // number, which is what useSyncExternalStore requires — a snapshot that
  // re-read storage every time would still be equal, but only by luck.
  if (!fontSizeLoaded) {
    fontSizeLoaded = true;
    try {
      const stored = Number(window.localStorage.getItem(FONT_SIZE_KEY));
      if (Number.isFinite(stored) && stored >= MIN_FONT_SIZE && stored <= MAX_FONT_SIZE) {
        fontSizeValue = stored;
      }
    } catch {
      /* storage blocked; the default stands */
    }
  }
  return fontSizeValue;
}

function subscribeFontSize(fn: () => void): () => void {
  fontSizeListeners.add(fn);
  return () => {
    fontSizeListeners.delete(fn);
  };
}

function useTerminalFontSize(): [number, (next: number) => void] {
  const size = useSyncExternalStore(
    subscribeFontSize,
    fontSizeSnapshot,
    // Prerender: there is no localStorage on the server, so the default is the
    // only honest answer. React swaps in the stored value after hydration.
    () => DEFAULT_FONT_SIZE,
  );

  const update = useCallback((next: number) => {
    const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(next)));
    if (clamped === fontSizeValue) return;
    fontSizeValue = clamped;
    fontSizeLoaded = true;
    try {
      window.localStorage.setItem(FONT_SIZE_KEY, String(clamped));
    } catch {
      // Private windows and blocked site data both refuse writes. The size still
      // applies for this visit; only remembering it is lost.
    }
    for (const fn of fontSizeListeners) fn();
  }, []);

  return [size, update];
}

/**
 * Start or stop recording the focused session.
 *
 * Three states rather than a toggle with a spinner bolted on, because the third
 * one is where the interesting failures live: capture can end on its own — at
 * the size cap, or when the shell hangs up — and the save that follows can fail
 * on a locked vault, a dead network or a Free plan. This button owns none of
 * that. It hands off to the recorder and the recorder toasts the outcome, so a
 * recording that ends while you are on another route still reports itself.
 *
 * A recorder that has stopped capturing but is still saving or still holding an
 * error keeps the button out of the "start" state: offering to record a session
 * whose previous recording is unsaved would quietly discard it.
 */
function RecordToggle({ session }: { session: SessionEntry }) {
  const recorders = useRecorders();
  const { start, stop } = useSessionRecorder();
  const { billing } = useBilling();
  // Absent while the plan is still loading. Fail toward access, as the server
  // does — the save is where the refusal is enforced, and it enforces it there
  // whatever this button believes.
  const canRecord = billing?.limits.sessionRecording ?? true;

  const recorder = recorders.find((r) => r.sessionId === session.id) ?? null;
  const capturing = recorder?.capturing === true;
  const settling = recorder !== null && !capturing;
  const pct = recorder ? Math.round((recorder.bytes / MAX_CAPTURE_BYTES) * 100) : 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 gap-1.5 px-2 text-[11px] font-normal",
            capturing && "text-destructive",
          )}
          aria-pressed={capturing}
          disabled={settling || (!capturing && !canRecord)}
          onClick={() => void (capturing ? stop(session.id) : start(session))}
        >
          {settling ? (
            <SpinnerGapIcon className="animate-spin" />
          ) : capturing ? (
            <StopIcon weight="fill" />
          ) : (
            <RecordIcon weight="fill" />
          )}
          {settling ? "Saving" : capturing ? "Stop" : "Record"}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {settling
          ? "Saving the recording"
          : capturing
            ? `Recording ${session.label} — ${pct}% of the capture limit. Stop to save it.`
            : canRecord
              ? `Record ${session.label}. Everything the shell prints is captured in this tab.`
              : "Session recording is a Pro feature"}
      </TooltipContent>
    </Tooltip>
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
    void listHosts()
      .then(setHosts)
      .catch(() => setHosts([]));
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

      <CredentialPrompt pending={prompt.pending} keys={usableKeys} onSettle={prompt.settle} />
    </div>
  );
}

function Pane({
  sessionId,
  index,
  focused,
  showChrome,
  keyBar,
  fontSize,
  onFocus,
  onClose,
}: {
  sessionId: string;
  index: number;
  focused: boolean;
  showChrome: boolean;
  keyBar: boolean;
  fontSize: number;
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
          fontSize={fontSize}
          onInput={(d) => write(sessionId, d)}
          onResize={(c, r) => resize(sessionId, c, r)}
        />
      </div>
    </div>
  );
}
