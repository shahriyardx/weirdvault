"use client"

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { LockSimpleIcon } from "@phosphor-icons/react/dist/ssr"
import "@xterm/xterm/css/xterm.css"

import { Button } from "@/components/ui/button"
import { terminalTheme } from "@/lib/terminal-theme"
import { cn } from "@/lib/utils"

/**
 * The monospace stack as a literal font string.
 *
 * xterm.js renders to a canvas (and to WebGL), and neither can resolve CSS
 * custom properties — passing `var(--font-mono)` leaves it measuring cells with
 * one font and painting glyphs with another, which shows up as wildly spaced,
 * unreadable text. So resolve the variable to its actual family name here and
 * hand xterm a real stack.
 */
function monoFontStack(): string {
  const fallback = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
  if (typeof window === "undefined") return fallback
  const resolved = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim()
  return resolved ? `${resolved}, ${fallback}` : fallback
}

const COARSE_POINTER = "(hover: none) and (pointer: coarse)"

// Created once, on first use, so that subscribing does not build a new
// MediaQueryList on every render — and so nothing touches matchMedia until a
// component actually asks, which keeps the module importable on the server.
let coarseQuery: MediaQueryList | null = null

function coarsePointerQuery(): MediaQueryList {
  if (!coarseQuery) coarseQuery = window.matchMedia(COARSE_POINTER)
  return coarseQuery
}

function subscribeCoarsePointer(onChange: () => void): () => void {
  const mql = coarsePointerQuery()
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

/**
 * Is this a touch device, as opposed to a small window on a laptop?
 *
 * The accessory bar exists because a soft keyboard has no Ctrl, no Esc and no
 * arrows — not because the viewport is narrow. A narrow window on a desktop has
 * a real keyboard and does not need one, so the test is the input device rather
 * than a breakpoint, and it is a media query rather than a user-agent string
 * because the latter is wrong for iPads, hybrids and every device released
 * after whatever list you hard-coded.
 *
 * `useSyncExternalStore` is what keeps this SSR-safe: the server snapshot is
 * always false, so the markup React produces on the server and the markup it
 * hydrates with agree, and the real value only lands in the commit afterwards.
 * Reading `matchMedia` during render would tear hydration apart.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribeCoarsePointer,
    () => coarsePointerQuery().matches,
    () => false,
  )
}

/* -------------------------------------------------------------------------- */
/* Accessory keys                                                             */
/* -------------------------------------------------------------------------- */

type ModifierName = "ctrl" | "alt"

/**
 * Sticky modifiers have three states, not two.
 *
 * "armed" survives exactly one key and then falls away, which is what you want
 * for Ctrl-C. "locked" survives until you tap it off, which is what you want
 * when arrowing around with Alt held. The middle state is the common one, so a
 * single tap arms; locking takes a deliberate second tap in quick succession.
 */
type ModifierState = "off" | "armed" | "locked"

type ModifierMap = Record<ModifierName, ModifierState>

/** A key whose wire form is a character that modifiers fold into. */
interface LiteralKey {
  kind: "literal"
  label: string
  /** Single character (or C0 byte); the Ctrl fold assumes length one. */
  value: string
  aria: string
}

/** Arrows, Home and End: SS3 under DECCKM, CSI otherwise. */
interface CursorKey {
  kind: "cursor"
  label: string
  final: string
  aria: string
}

/** Keys encoded as `CSI <n> ~`, which is the page-up family. */
interface TildeKey {
  kind: "tilde"
  label: string
  code: number
  aria: string
}

interface ModifierKey {
  kind: "modifier"
  label: string
  mod: ModifierName
  aria: string
}

type SendableKey = LiteralKey | CursorKey | TildeKey
type AccessoryKey = SendableKey | ModifierKey

/**
 * The row, in groups.
 *
 * Ordered by how often a hand reaches for them, because the row scrolls and
 * whatever is off the right edge costs an extra gesture. Shift is deliberately
 * absent: every soft keyboard already has one, and duplicating it here would
 * fight the platform for no gain.
 */
const KEY_GROUPS: AccessoryKey[][] = [
  [
    { kind: "literal", label: "Esc", value: "\x1b", aria: "Escape" },
    { kind: "literal", label: "Tab", value: "\t", aria: "Tab" },
    { kind: "modifier", label: "Ctrl", mod: "ctrl", aria: "Control" },
    { kind: "modifier", label: "Alt", mod: "alt", aria: "Alt" },
  ],
  [
    { kind: "literal", label: "^C", value: "\x03", aria: "Control C, interrupt" },
    { kind: "literal", label: "^D", value: "\x04", aria: "Control D, end of input" },
    { kind: "literal", label: "^Z", value: "\x1a", aria: "Control Z, suspend" },
    { kind: "literal", label: "^L", value: "\x0c", aria: "Control L, clear screen" },
  ],
  [
    { kind: "cursor", label: "←", final: "D", aria: "Left arrow" },
    { kind: "cursor", label: "↑", final: "A", aria: "Up arrow" },
    { kind: "cursor", label: "↓", final: "B", aria: "Down arrow" },
    { kind: "cursor", label: "→", final: "C", aria: "Right arrow" },
  ],
  [
    { kind: "cursor", label: "Home", final: "H", aria: "Home" },
    { kind: "cursor", label: "End", final: "F", aria: "End" },
    { kind: "tilde", label: "PgUp", code: 5, aria: "Page up" },
    { kind: "tilde", label: "PgDn", code: 6, aria: "Page down" },
  ],
  [
    { kind: "literal", label: "-", value: "-", aria: "Hyphen" },
    { kind: "literal", label: "_", value: "_", aria: "Underscore" },
    { kind: "literal", label: "~", value: "~", aria: "Tilde" },
    { kind: "literal", label: "/", value: "/", aria: "Forward slash" },
    { kind: "literal", label: "|", value: "|", aria: "Pipe" },
    { kind: "literal", label: "*", value: "*", aria: "Asterisk" },
    { kind: "literal", label: "`", value: "`", aria: "Backtick" },
  ],
]

/** xterm's modifier parameter: one plus a bitmask, alt 2, ctrl 4. */
function modifierParam(mods: { ctrl: boolean; alt: boolean }): number {
  return 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
}

/** Ctrl folds a character to its C0 form; Alt prefixes it with ESC. */
function foldCharacter(char: string, mods: { ctrl: boolean; alt: boolean }): string {
  let out = char
  if (mods.ctrl) out = String.fromCharCode(out.toUpperCase().charCodeAt(0) & 0x1f)
  if (mods.alt) out = `\x1b${out}`
  return out
}

/** Printable ASCII is the only thing a sticky modifier can meaningfully fold. */
function isFoldable(data: string): boolean {
  if (data.length !== 1) return false
  const code = data.charCodeAt(0)
  return code >= 0x20 && code <= 0x7e
}

/**
 * Turn a tapped key into the bytes a real keyboard would have produced.
 *
 * The three encodings are not interchangeable. Ctrl on a character is the
 * ASCII fold — mask the uppercased code with 0x1f, which is how Ctrl-C becomes
 * 0x03. Alt is the ESC prefix, the convention every readline-based program
 * expects. Cursor keys carry their modifiers in a CSI parameter instead, and
 * must switch to CSI even when the application asked for SS3 (DECCKM), because
 * an SS3 sequence has nowhere to put the parameter — this mirrors what
 * xterm.js itself sends for a physical arrow key, which is the point: the shell
 * should not be able to tell the difference.
 */
function encodeKey(
  key: SendableKey,
  mods: { ctrl: boolean; alt: boolean },
  applicationCursor: boolean,
): string {
  switch (key.kind) {
    case "literal":
      return foldCharacter(key.value, mods)
    case "cursor": {
      const param = modifierParam(mods)
      if (param > 1) return `\x1b[1;${param}${key.final}`
      return applicationCursor ? `\x1bO${key.final}` : `\x1b[${key.final}`
    }
    case "tilde": {
      const param = modifierParam(mods)
      return param > 1 ? `\x1b[${key.code};${param}~` : `\x1b[${key.code}~`
    }
  }
}

/** A second tap inside this window locks the modifier rather than clearing it. */
const LOCK_TAP_MS = 400
/** How far a finger may travel and still count as a tap rather than a scroll. */
const TAP_SLOP_PX = 10

export interface TerminalHandle {
  write(data: string | Uint8Array): void
  clear(): void
  focus(): void
  size(): { cols: number; rows: number }
}

/**
 * Terminal cell size, in pixels.
 *
 * A range rather than a free number: below about 9px the glyphs stop being
 * distinguishable at any DPI, and above about 24 a normal window holds too few
 * columns for the output most shell tools assume. The default matches what the
 * dashboard's other monospace surfaces use.
 */
export const MIN_FONT_SIZE = 9
export const MAX_FONT_SIZE = 24
export const DEFAULT_FONT_SIZE = 13

interface Props {
  ref?: Ref<TerminalHandle>
  onInput?: (data: string) => void
  onResize?: (cols: number, rows: number) => void
  /**
   * Render the touch accessory row. Decided by the caller so the terminal page
   * can offer a manual override, and so only the focused pane grows a bar when
   * the view is split.
   */
  showKeyboardBar?: boolean
  /**
   * Cell size in pixels.
   *
   * Owned by the caller because it is a preference that outlives any one pane
   * and has to be the same in all of them — four panes at four sizes is not a
   * feature. Changing it re-fits, so the column count changes with it and the
   * remote PTY is told; that is the point rather than a side effect, since
   * zooming in on a shell means fewer, bigger columns.
   */
  fontSize?: number
}

export function TerminalView({
  ref,
  onInput,
  onResize,
  showKeyboardBar = false,
  fontSize = DEFAULT_FONT_SIZE,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Held so a font-size change can clear the glyph atlas. Null where WebGL was
  // refused and the canvas fallback is doing the painting, which needs nothing.
  const webglRef = useRef<WebglAddon | null>(null)

  // Modifier state is held twice on purpose. The state renders the row; the
  // ref is what input is judged against, because keystrokes arrive from xterm
  // synchronously and cannot wait for a render to know whether Ctrl was armed.
  const [mods, setMods] = useState<ModifierMap>({ ctrl: "off", alt: "off" })
  const modsRef = useRef<ModifierMap>({ ctrl: "off", alt: "off" })
  const lastModTap = useRef<Partial<Record<ModifierName, number>>>({})
  const [keyboardInset, setKeyboardInset] = useState(0)

  const updateMods = useCallback((fn: (prev: ModifierMap) => ModifierMap) => {
    const next = fn(modsRef.current)
    modsRef.current = next
    setMods(next)
  }, [])

  const resetMods = useCallback(() => updateMods(() => ({ ctrl: "off", alt: "off" })), [updateMods])

  /** Spend the armed modifiers, leaving locked ones in place. */
  const spendMods = useCallback(
    () =>
      updateMods((prev) => ({
        ctrl: prev.ctrl === "armed" ? "off" : prev.ctrl,
        alt: prev.alt === "armed" ? "off" : prev.alt,
      })),
    [updateMods],
  )

  // Keep the latest callbacks without tearing down the terminal on re-render.
  // The write happens in an effect rather than during render: a render can be
  // thrown away or replayed, and mutating a ref on a render that never commits
  // would leave the terminal calling a callback that the committed tree does
  // not have. Both readers below fire from xterm events, which cannot run
  // before the commit that installed them, so the one-commit delay is not
  // observable.
  const cbs = useRef({ onInput, onResize })
  useEffect(() => {
    cbs.current = { onInput, onResize }
  }, [onInput, onResize])

  const fontSizeRef = useRef(fontSize)
  useEffect(() => {
    fontSizeRef.current = fontSize
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    // The cell size has changed, so the grid that fitted the container no longer
    // does. Re-fit, and clear the WebGL atlas — it caches glyphs at the old size
    // and would otherwise paint them scaled and blurred into the new cells.
    webglRef.current?.clearTextureAtlas()
    try {
      fitRef.current?.fit()
    } catch {
      /* not laid out */
    }
  }, [fontSize])

  useImperativeHandle(ref, () => ({
    write: (d) => termRef.current?.write(d as string),
    clear: () => termRef.current?.clear(),
    focus: () => termRef.current?.focus(),
    size: () => ({ cols: termRef.current?.cols ?? 80, rows: termRef.current?.rows ?? 24 }),
  }))

  useEffect(() => {
    if (!containerRef.current) return
    let disposed = false

    const term = new Terminal({
      fontFamily: monoFontStack(),
      // Read from the ref, not the prop: this effect deliberately runs once, so
      // closing over the prop would pin the terminal to whatever the size was at
      // mount. The effect below applies later changes.
      fontSize: fontSizeRef.current,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10_000,
      theme: terminalTheme,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)

    // WebGL is a large perf win but unavailable in some environments; a
    // failure here should degrade rendering, not break the terminal.
    let webgl: WebglAddon | null = null
    try {
      webgl = webglRef.current = new WebglAddon()
      term.loadAddon(webgl)
    } catch {
      /* canvas fallback */
    }

    // xterm measures the character cell once, at construction, and if the
    // webfont is not loaded it measures a fallback while painting with
    // something else — which renders as wildly spaced, unreadable text.
    //
    // `document.fonts.ready` is not enough: next/font only declares the family,
    // and the browser never fetches a font nothing uses, so `ready` resolves
    // immediately with the font still absent. Request it explicitly, then
    // re-measure and drop the WebGL glyph atlas so it redraws.
    void document.fonts
      .load(`${term.options.fontSize}px ${term.options.fontFamily}`)
      .catch(() => [])
      .then(() => {
        if (disposed) return
        webgl?.clearTextureAtlas()
        try {
          fit.fit()
        } catch {
          /* not laid out yet */
        }
        term.refresh(0, term.rows - 1)
      })

    /**
     * Report the size before the first fit, not after.
     *
     * This registration used to sit sixty lines further down, after `fit.fit()`
     * had already run. xterm fires onResize only when the dimensions actually
     * change, so the one fit that matters — the jump from xterm's default 80×24
     * to the real geometry — fired into a handler that did not exist yet. If no
     * later fit changed the numbers again, nothing was ever reported: the remote
     * PTY kept its opening size and the session's recorded geometry stayed null,
     * which is why `startRecording` fell back to 80×24 and replayed a 170-column
     * transcript wrapped at 80. The live pane looked right because xterm was
     * rendering at the true size the whole time; only everything downstream of
     * the callback was wrong.
     */
    term.onResize(({ cols, rows }) => cbs.current.onResize?.(cols, rows))

    fit.fit()
    // And once explicitly, because "no change" is a real outcome: a container
    // that happens to fit exactly 80×24, or a fit that ran before layout and
    // computed nothing, both leave onResize silent. Publishing unconditionally
    // costs one redundant call and removes the whole class of failure.
    cbs.current.onResize?.(term.cols, term.rows)

    termRef.current = term
    fitRef.current = fit

    // The WebGL renderer paints to canvas, so terminal text never lands in the
    // DOM and end-to-end tests have nothing to assert against. Expose the
    // instance in development only.
    if (process.env.NODE_ENV === "development") {
      ;(window as unknown as { __webxtermTerm?: Terminal }).__webxtermTerm = term
    }

    /**
     * A sticky modifier has to reach the keys the bar does not carry.
     *
     * Arming Ctrl and then typing "r" on the phone's own keyboard is the whole
     * point — the bar cannot hold the alphabet, so folding only its own keys
     * would leave Ctrl-R, Ctrl-A and Ctrl-W unreachable. onData is the right
     * seam for it: soft keyboards report almost nothing useful through keydown,
     * but every character they produce passes through here.
     *
     * Anything that is not a single printable character — a paste, an escape
     * sequence from a hardware keyboard, an emoji — goes through untouched but
     * still spends the modifier. Leaving it armed for an unbounded time would
     * be a worse surprise than losing it on a key that could not carry it.
     */
    const foldTyped = (data: string): string => {
      const current = modsRef.current
      const active = { ctrl: current.ctrl !== "off", alt: current.alt !== "off" }
      if (!active.ctrl && !active.alt) return data
      spendMods()
      return isFoldable(data) ? foldCharacter(data, active) : data
    }

    term.onData((d) => cbs.current.onInput?.(foldTyped(d)))

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* container not laid out yet */
      }
    })
    ro.observe(containerRef.current)

    return () => {
      disposed = true
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      webglRef.current = null
    }
    // spendMods is stable for the life of the component; this effect must run
    // exactly once, because re-running it throws away the terminal and every
    // line of scrollback with it.
  }, [spendMods])

  // The measurement is kept rather than cleared when the bar goes away; the
  // padding that actually gets applied is derived, so a stale reading cannot
  // leak into a layout that has no bar in it.
  const keyboardPadding = showKeyboardBar ? keyboardInset : 0

  // The bar sits in the flex column rather than on top of the terminal, so
  // showing it shrinks the canvas box and the ResizeObserver above re-fits.
  // Re-fitting explicitly here as well means the row count is correct even if
  // the observer is delayed — a bar that has quietly parked itself over the
  // last line of output is the failure mode this whole layout is avoiding.
  useEffect(() => {
    try {
      fitRef.current?.fit()
    } catch {
      /* not laid out yet */
    }
  }, [showKeyboardBar, keyboardPadding])

  /**
   * Keep the bar above the soft keyboard on browsers that overlay it.
   *
   * Android generally shrinks the layout viewport when the keyboard opens, so
   * ordinary flex layout already does the right thing and the measured overlap
   * is zero. iOS does not: the layout viewport keeps its full height and the
   * keyboard covers the bottom of it, which would leave the accessory row
   * underneath the very keyboard it exists to supplement. visualViewport
   * reports the part still on screen, so pad the column by however much of this
   * element falls outside it — padding is inside the border box, so the
   * terminal loses exactly that height and nothing is covered.
   *
   * Not handled: a pinch-zoomed page reports the same kind of overlap and will
   * briefly pad too, and browsers without visualViewport get the plain layout.
   */
  useEffect(() => {
    const vv = typeof window === "undefined" ? null : window.visualViewport
    if (!showKeyboardBar || !vv) return

    const measure = () => {
      const root = rootRef.current
      if (!root) return
      const overlap = root.getBoundingClientRect().bottom - (vv.offsetTop + vv.height)
      const next = Math.max(0, Math.round(overlap))
      // The element's own bottom edge is fixed by its parent, so this padding
      // cannot feed back into the measurement; the epsilon is only to stop
      // sub-pixel jitter from re-rendering on every scroll event.
      setKeyboardInset((prev) => (Math.abs(prev - next) > 1 ? next : prev))
    }

    // visualViewport settles a frame or two after the keyboard animates in, so
    // take the first reading on the next frame rather than during the effect.
    const first = requestAnimationFrame(measure)
    vv.addEventListener("resize", measure)
    vv.addEventListener("scroll", measure)
    return () => {
      cancelAnimationFrame(first)
      vv.removeEventListener("resize", measure)
      vv.removeEventListener("scroll", measure)
    }
  }, [showKeyboardBar])

  /**
   * Feed a tapped key in as though it had been typed.
   *
   * `term.input` is the same entry point xterm uses for a real keystroke: it
   * fires onData (so the session writes it over SSH), clears the selection and
   * scrolls to the bottom. Writing to the session directly would skip all of
   * that and leave the local view behaving differently depending on whether you
   * used the bar or the keyboard.
   */
  function sendKey(key: SendableKey) {
    const term = termRef.current
    if (!term) return

    const current = modsRef.current
    const active = { ctrl: current.ctrl !== "off", alt: current.alt !== "off" }
    const data = encodeKey(key, active, term.modes.applicationCursorKeysMode)

    // Spend the modifiers before the write, not after: term.input dispatches
    // onData synchronously, and the fold there would otherwise apply Ctrl a
    // second time to a byte that already has it.
    spendMods()
    term.input(data)

    // The tap happened on a button, not the textarea, so nothing has moved
    // focus — but if focus was elsewhere entirely this puts it back, and doing
    // it inside the gesture is what lets iOS re-open the keyboard.
    term.focus()
  }

  function toggleModifier(mod: ModifierName) {
    const now = Date.now()
    const previousTap = lastModTap.current[mod] ?? 0
    lastModTap.current[mod] = now

    updateMods((prev) => {
      const state = prev[mod]
      if (state === "off") return { ...prev, [mod]: "armed" }
      if (state === "armed" && now - previousTap < LOCK_TAP_MS) {
        return { ...prev, [mod]: "locked" }
      }
      return { ...prev, [mod]: "off" }
    })
  }

  return (
    <div
      ref={rootRef}
      className="flex h-full w-full min-h-0 flex-col"
      style={keyboardPadding > 0 ? { paddingBottom: keyboardPadding } : undefined}
    >
      <div ref={containerRef} className="min-h-0 w-full min-w-0 flex-1 font-mono" />
      {showKeyboardBar && (
        <KeyboardBar
          mods={mods}
          onKey={sendKey}
          onModifier={toggleModifier}
          onUnmount={resetMods}
        />
      )}
    </div>
  )
}

/**
 * The accessory row.
 *
 * Everything here is subordinate to one rule: touching a key must not take
 * focus from the terminal's hidden textarea, because losing it dismisses the
 * soft keyboard and a bar that closes the keyboard is worse than no bar at all.
 * That is why each key cancels its own pointerdown — a cancelled pointerdown
 * suppresses the mousedown that would otherwise move focus — and why the key
 * fires on pointerup instead: pointerdown also fires at the start of a drag,
 * and sending Ctrl-C to someone who was only trying to scroll the row would be
 * unforgivable. A drag past the slop threshold, or a pointercancel from the
 * browser taking the gesture over for panning, sends nothing.
 */
function KeyboardBar({
  mods,
  onKey,
  onModifier,
  onUnmount,
}: {
  mods: ModifierMap
  onKey: (key: SendableKey) => void
  onModifier: (mod: ModifierName) => void
  onUnmount: () => void
}) {
  const downs = useRef(new Map<number, { x: number; y: number }>())

  // An armed modifier folds into keys typed on the soft keyboard too, so it
  // must not outlive the row that shows it. Hiding the bar with Ctrl armed
  // would otherwise leave an invisible modifier waiting to turn the next
  // letter into a control character.
  useEffect(() => onUnmount, [onUnmount])

  function press(key: AccessoryKey) {
    if (key.kind === "modifier") onModifier(key.mod)
    else onKey(key)
  }

  function keyHandlers(key: AccessoryKey) {
    return {
      onPointerDown(e: React.PointerEvent) {
        e.preventDefault()
        downs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      },
      onPointerUp(e: React.PointerEvent) {
        const down = downs.current.get(e.pointerId)
        downs.current.delete(e.pointerId)
        if (!down) return
        if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_SLOP_PX) return
        press(key)
      },
      onPointerCancel(e: React.PointerEvent) {
        downs.current.delete(e.pointerId)
      },
      // There is deliberately no onClick: a mouse tap would fire both it and
      // the pointerup above, sending the key twice. That leaves keyboard
      // activation with nothing to hang off, so Enter and Space are handled
      // here — and cancelled, so the click the browser would synthesise from
      // them cannot arrive later and double-send.
      onKeyDown(e: React.KeyboardEvent) {
        if (e.key !== "Enter" && e.key !== " ") return
        e.preventDefault()
        press(key)
      },
    }
  }

  return (
    <div
      role="toolbar"
      aria-label="Terminal keys"
      aria-orientation="horizontal"
      // The keys cancel their own pointerdown, but the row is not solid keys:
      // there is a couple of pixels of gap between them, padding at each end
      // and a divider between groups. A tap that lands on any of that hits this
      // container, which is not focusable, and the default action of a mousedown
      // on a non-focusable element is to blur whatever was focused — closing the
      // soft keyboard from a near-miss. Cancelling mousedown here suppresses
      // exactly that default and nothing else; it is the mouse event rather than
      // the pointer event on purpose, because touch-action governs panning and
      // cancelling pointerdown on the scroll container is the sort of thing that
      // stops the row scrolling on some engines.
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        "bg-card border-border flex shrink-0 items-center gap-0.5 overflow-x-auto border-t px-1",
        // pan-x keeps the row scrollable by drag while suppressing double-tap
        // zoom; the scrollbar is hidden because on a phone it is only clutter.
        "touch-pan-x overscroll-x-contain select-none",
        "pb-[env(safe-area-inset-bottom)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      )}
    >
      {KEY_GROUPS.map((group, groupIndex) => (
        <div key={groupIndex} className="flex shrink-0 items-center gap-0.5">
          {groupIndex > 0 && <span aria-hidden className="bg-border mx-1 h-5 w-px shrink-0" />}
          {group.map((key) => {
            const state = key.kind === "modifier" ? mods[key.mod] : "off"
            return (
              <Button
                key={key.label}
                type="button"
                variant="ghost"
                size="lg"
                aria-label={key.aria}
                aria-pressed={key.kind === "modifier" ? state !== "off" : undefined}
                title={key.kind === "modifier" ? modifierTitle(key.label, state) : key.aria}
                className={cn(
                  "h-10 min-w-10 shrink-0 px-2.5 font-mono text-[13px] font-normal",
                  state === "armed" && "bg-primary/15 text-primary border-primary/40",
                  state === "locked" && "bg-primary text-primary-foreground",
                )}
                {...keyHandlers(key)}
              >
                {key.label}
                {state === "locked" && <LockSimpleIcon className="size-3" weight="fill" />}
              </Button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function modifierTitle(label: string, state: ModifierState): string {
  if (state === "locked") return `${label} locked — tap to release`
  if (state === "armed") return `${label} applies to the next key — tap twice to lock`
  return `${label} for the next key`
}
