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

/**
 * Builds the relay URL for a host, fetching a short-lived access token bound to
 * this exact destination. The relay only ever sees ciphertext; the token exists
 * so it cannot be used as an open proxy.
 *
 * The dev relay accepts unauthenticated connections, so a failure to mint is
 * not fatal — but it is logged, because in production it would mean every
 * connection is about to be refused.
 */
export async function relayUrl(host: string, port: number): Promise<string> {
  const base =
    process.env.NEXT_PUBLIC_RELAY_URL ??
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

  let token = "";
  try {
    const res = await fetch("/api/relay-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, port }),
    });
    if (res.ok) {
      ({ token } = (await res.json()) as { token: string });
    } else if (res.status !== 401 && res.status !== 503) {
      console.warn(`relay token request failed: ${res.status}`);
    }
  } catch (e) {
    console.warn("relay token request failed", e);
  }

  const params = new URLSearchParams({ host, port: String(port) });
  if (token) params.set("token", token);
  return `${base}?${params}`;
}
