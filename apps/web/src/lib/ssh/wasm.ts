"use client";

import type { ConnectConfig, SshSession } from "./types";

/**
 * Loads the Go SSH core.
 *
 * Fetched from /public with an explicit instantiateStreaming rather than run
 * through the bundler — the WASM is a 6 MB opaque asset, and letting webpack
 * inline or transform it costs build time and gains nothing. It also means the
 * Service Worker can cache it by URL like any other static file.
 */
let loading: Promise<void> | null = null;

export function loadSSH(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("SSH core is browser-only"));
  }
  loading ??= (async () => {
    if (!window.Go) await injectScript("/wasm_exec.js");
    const go = new window.Go!();
    const { instance } = await WebAssembly.instantiateStreaming(
      fetch("/ssh.wasm"),
      go.importObject,
    );
    // Never resolves: the Go runtime parks and waits for callbacks.
    void go.run(instance);
    // go.run() sets up globals synchronously before it parks, but yield once
    // so the export is definitely visible.
    await new Promise((r) => setTimeout(r, 0));
    if (!window.webxtermSSH) throw new Error("ssh.wasm did not export webxtermSSH");
  })();
  return loading;
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(el);
  });
}

export async function connect(config: ConnectConfig): Promise<SshSession> {
  await loadSSH();
  return window.webxtermSSH!.connect(config);
}

/** Builds the relay URL for a host. The relay only ever sees ciphertext. */
export function relayUrl(host: string, port: number): string {
  const base =
    process.env.NEXT_PUBLIC_RELAY_URL ??
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  return `${base}?host=${encodeURIComponent(host)}&port=${port}`;
}
