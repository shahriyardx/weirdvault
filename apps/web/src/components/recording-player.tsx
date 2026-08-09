"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import {
  ArrowCounterClockwiseIcon,
  PauseIcon,
  PlayIcon,
} from "@phosphor-icons/react/dist/ssr";
import "@xterm/xterm/css/xterm.css";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { castEnd, eventsUpTo, frameAt, type Cast } from "@/lib/recording/format";
import { terminalTheme } from "@/lib/terminal-theme";

/**
 * Replaying a recording.
 *
 * This does not reuse TerminalView, and the reason is geometry rather than
 * taste. That component exists to be a live shell: it loads the fit addon,
 * watches its container with a ResizeObserver and re-fits on every layout
 * change, which is exactly right when the size it computes is the size it then
 * tells the far end about. A recording has a size already — the one the session
 * actually ran at — and fitting to the dialog would re-wrap every line the
 * transcript laid out, which is the specific failure the format stores the
 * geometry to avoid. Two smaller reasons follow from the same split: seeking
 * backwards needs a full `reset()`, which the live handle does not expose
 * because a live shell has nothing to reset to; and this terminal must never
 * carry input handlers, because there is nowhere for a keystroke to go.
 *
 * So the emulator is created at the recording's own cols and rows and then
 * scaled down with a CSS transform to fit whatever box it is given. A transform
 * does not touch layout, so the character grid stays exactly as recorded and
 * only the pixels shrink.
 *
 * Seeking is a reset and a replay of everything before the target. There is no
 * cheaper correct way: the state of a terminal at a point in time is the sum of
 * every byte before it — an alternate-screen switch in the first second decides
 * what the last minute looks like — so a seek that started mid-stream would
 * render a screen the session never showed.
 *
 * One property worth knowing: the clock is requestAnimationFrame, so playback
 * stops advancing while the tab is in the background and picks up where it left
 * off. For a replay that is the right behaviour, and it is the honest one —
 * nothing is being missed while you are not looking.
 */

const SPEEDS = [0.5, 1, 2, 4] as const;

/** The keys a range input responds to; everything else is navigation. */
const SCRUB_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export function RecordingPlayer({ cast }: { cast: Cast }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  const end = castEnd(cast);

  // The true playhead lives in a ref because the animation loop reads and
  // writes it every frame; the state copy exists only to move the seek bar, and
  // is updated at a rate a person can see rather than sixty times a second.
  const playheadRef = useRef(0);
  const indexRef = useRef(0);
  const speedRef = useRef<number>(1);

  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [scrub, setScrub] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const [boxHeight, setBoxHeight] = useState<number | null>(null);

  /* --------------------------------------------------------- the emulator */

  /**
   * The emulator, primed at zero, and the measurement that scales it.
   *
   * Both live in one effect because they are one thing: the grid decides the
   * natural size, and the natural size decides the scale. The caller mounts a
   * fresh player per recording (the recordings page keys it on the recording
   * id), so `cast` does not change under a live instance and this runs once.
   */
  useEffect(() => {
    const outer = outerRef.current;
    const screen = screenRef.current;
    if (!outer || !screen) return;

    const term = new Terminal({
      cols: cast.header.cols,
      rows: cast.header.rows,
      fontFamily: monoFontStack(),
      fontSize: 13,
      lineHeight: 1.2,
      // No cursor blink and no input: this is a transcript, and a blinking
      // cursor on a paused replay reads as a live shell waiting for a command.
      cursorBlink: false,
      disableStdin: true,
      scrollback: 0,
      theme: terminalTheme,
    });
    term.open(screen);
    termRef.current = term;

    // Show the first frame rather than an empty box. Anything stamped at zero
    // belongs on screen before the clock has run at all.
    const first = frameAt(cast, 0);
    term.resize(first.cols, first.rows);
    if (first.data.length > 0) term.write(first.data);
    indexRef.current = first.next;
    playheadRef.current = 0;

    // offsetWidth/offsetHeight rather than getBoundingClientRect: they ignore
    // the transform this measurement is about to decide, and measuring a scaled
    // element to compute its scale converges on zero.
    const measure = () => {
      const naturalWidth = screen.offsetWidth;
      const naturalHeight = screen.offsetHeight;
      if (naturalWidth === 0 || naturalHeight === 0) return;
      const next = Math.min(1, outer.clientWidth / naturalWidth);
      setScale(next);
      setBoxHeight(naturalHeight * next);
    };

    // xterm needs a frame to lay the grid out, so the first measurement waits
    // for one instead of reading zeros.
    const raf = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    // The screen is observed too: a resize event inside the recording changes
    // the grid, and with it how much room the replay needs.
    observer.observe(screen);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      termRef.current = null;
      term.dispose();
    };
  }, [cast]);

  /* -------------------------------------------------------------- seeking */

  const seek = useCallback(
    (to: number) => {
      const term = termRef.current;
      if (!term) return;
      const target = Math.max(0, Math.min(end, to));
      const frame = frameAt(cast, target);

      term.reset();
      term.resize(frame.cols, frame.rows);
      if (frame.data.length > 0) term.write(frame.data);

      indexRef.current = frame.next;
      playheadRef.current = target;
      setPlayhead(target);
    },
    [cast, end],
  );

  /* ------------------------------------------------------------- playback */

  useEffect(() => {
    if (!playing) return;
    const term = termRef.current;
    if (!term) return;

    let frame = 0;
    let last = performance.now();
    let lastShown = 0;

    const step = (now: number) => {
      const advance = (now - last) * speedRef.current;
      last = now;
      playheadRef.current = Math.min(end, playheadRef.current + advance);

      const { events, next } = eventsUpTo(cast, indexRef.current, playheadRef.current);
      for (const event of events) {
        if (event.kind === "output") term.write(event.bytes);
        else term.resize(event.cols, event.rows);
      }
      indexRef.current = next;

      if (now - lastShown > 100) {
        lastShown = now;
        setPlayhead(playheadRef.current);
      }

      if (playheadRef.current >= end) {
        setPlayhead(end);
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, cast, end]);

  /* --------------------------------------------------------------- scrub */

  // Dragging the bar pauses, so the thumb does not fight the clock, and the seek
  // is committed on release: a 4 MB transcript is replayed on every seek, and
  // doing that on every pixel of a drag would lock the tab up.
  const resumeAfterScrub = useRef(false);

  function beginScrub() {
    if (scrub !== null) return;
    resumeAfterScrub.current = playing;
    setPlaying(false);
    setScrub(playheadRef.current);
  }

  function commitScrub() {
    if (scrub === null) return;
    seek(scrub);
    setScrub(null);
    if (resumeAfterScrub.current) setPlaying(true);
    resumeAfterScrub.current = false;
  }

  const atEnd = playhead >= end && !playing;
  const shown = scrub ?? playhead;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        ref={outerRef}
        className="min-w-0 overflow-hidden bg-terminal p-2"
        style={boxHeight !== null ? { height: boxHeight + 16 } : undefined}
      >
        <div
          ref={screenRef}
          className="w-fit font-mono"
          style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            if (atEnd) seek(0);
            setPlaying((p) => !p);
          }}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
          {playing ? "Pause" : atEnd ? "Replay" : "Play"}
        </Button>

        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Back to the start"
          onClick={() => {
            setPlaying(false);
            seek(0);
          }}
        >
          <ArrowCounterClockwiseIcon />
        </Button>

        <input
          type="range"
          min={0}
          max={Math.max(end, 1)}
          step={100}
          value={shown}
          aria-label="Seek"
          onPointerDown={beginScrub}
          // Only the keys that actually move the thumb. Tabbing through the
          // control would otherwise pause playback and replay the transcript
          // from the top to land back where it already was.
          onKeyDown={(e) => {
            if (SCRUB_KEYS.has(e.key)) beginScrub();
          }}
          onChange={(e) => setScrub(Number(e.target.value))}
          onPointerUp={commitScrub}
          onKeyUp={(e) => {
            if (SCRUB_KEYS.has(e.key)) commitScrub();
          }}
          onBlur={commitScrub}
          className="h-1 min-w-32 flex-1 cursor-pointer accent-primary"
        />

        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {clock(shown)} / {clock(end)}
        </span>

        <Select
          value={String(speed)}
          onValueChange={(v) => {
            const next = Number(v);
            speedRef.current = next;
            setSpeed(next);
          }}
        >
          <SelectTrigger size="sm" aria-label="Playback speed" className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SPEEDS.map((s) => (
              <SelectItem key={s} value={String(s)}>
                {s}×
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {cast.header.cols}×{cast.header.rows} as recorded, scaled to fit. This is
        a replay of what the terminal printed — nothing here is connected to a
        host and nothing you press is sent anywhere.
      </p>
    </div>
  );
}

/**
 * The same font resolution TerminalView does, and for the same reason: xterm
 * paints to a canvas and cannot resolve `var(--font-mono)`, so it would measure
 * cells in one font and draw glyphs in another.
 */
function monoFontStack(): string {
  const fallback = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  if (typeof window === "undefined") return fallback;
  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return resolved ? `${resolved}, ${fallback}` : fallback;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
