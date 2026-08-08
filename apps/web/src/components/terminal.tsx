"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import { terminalTheme } from "@/lib/terminal-theme";

export interface TerminalHandle {
  write(data: string | Uint8Array): void;
  clear(): void;
  focus(): void;
  size(): { cols: number; rows: number };
}

interface Props {
  ref?: Ref<TerminalHandle>;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export function TerminalView({ ref, onInput, onResize }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Keep the latest callbacks without tearing down the terminal on re-render.
  const cbs = useRef({ onInput, onResize });
  cbs.current = { onInput, onResize };

  useImperativeHandle(ref, () => ({
    write: (d) => termRef.current?.write(d as string),
    clear: () => termRef.current?.clear(),
    focus: () => termRef.current?.focus(),
    size: () => ({ cols: termRef.current?.cols ?? 80, rows: termRef.current?.rows ?? 24 }),
  }));

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10_000,
      theme: terminalTheme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    // WebGL is a large perf win but unavailable in some environments; a
    // failure here should degrade rendering, not break the terminal.
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* canvas fallback */
    }

    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // The WebGL renderer paints to canvas, so terminal text never lands in the
    // DOM and end-to-end tests have nothing to assert against. Expose the
    // instance in development only.
    if (process.env.NODE_ENV === "development") {
      (window as unknown as { __webxtermTerm?: Terminal }).__webxtermTerm = term;
    }

    term.onData((d) => cbs.current.onInput?.(d));
    term.onResize(({ cols, rows }) => cbs.current.onResize?.(cols, rows));

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* container not laid out yet */
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  return <div ref={containerRef} className="h-full w-full" />;
}
