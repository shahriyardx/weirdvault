import type { ITheme } from "@xterm/xterm"

/**
 * The xterm palette.
 *
 * Kept as concrete values rather than CSS variables because xterm renders to a
 * canvas and needs real colours, not `var(--terminal)` — and because the ANSI
 * 16 are a palette in their own right, not theme tokens. These deliberately
 * mirror the oklch tokens in globals.css: the background matches `--terminal`
 * (a step darker than cards, so the emulator reads as content rather than
 * chrome) and the accents match `--primary` and friends.
 */
export const terminalTheme: ITheme = {
  background: "#0e1117",
  foreground: "#d7dce5",
  cursor: "#6ea8ff",
  cursorAccent: "#0e1117",
  selectionBackground: "#2a3a5c",

  black: "#1b1f2a",
  red: "#f2777a",
  green: "#5fd08a",
  yellow: "#e5c07b",
  blue: "#6ea8ff",
  magenta: "#c99df0",
  cyan: "#56b6c2",
  white: "#c8cdd8",

  brightBlack: "#5c6472",
  brightRed: "#ff8f92",
  brightGreen: "#79e3a3",
  brightYellow: "#f0d194",
  brightBlue: "#8dbcff",
  brightMagenta: "#dbb4ff",
  brightCyan: "#74ccd8",
  brightWhite: "#eef1f6",
}
