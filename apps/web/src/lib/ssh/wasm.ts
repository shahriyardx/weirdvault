"use client"

import { relayQuotaError } from "@/lib/usage"

import type { ConnectConfig, ImportedKey, ParsedConfigHost, SshSession } from "./types"

/**
 * Loads the Go SSH core.
 *
 * Fetched from /public with an explicit instantiateStreaming rather than run
 * through the bundler — the WASM is a 6 MB opaque asset, and letting webpack
 * inline or transform it costs build time and gains nothing. It also means the
 * Service Worker can cache it by URL like any other static file.
 */
let loading: Promise<void> | null = null
let ready = false

/**
 * Download progress for the core.
 *
 * Six megabytes is long enough on a bad connection that a button which simply
 * does nothing for twenty seconds reads as broken, so callers can watch the
 * bytes arrive. `total` is 0 when the server sends no Content-Length, and the
 * header describes the *compressed* size when the asset is served gzipped —
 * `loaded` counts decompressed bytes, so treat the ratio as an estimate and
 * clamp it rather than trusting it to land on 100%.
 */
export interface SshLoadProgress {
  loaded: number
  total: number
  done: boolean
}

const watchers = new Set<(p: SshLoadProgress) => void>()
let lastProgress: SshLoadProgress = { loaded: 0, total: 0, done: false }

function emit(p: SshLoadProgress) {
  lastProgress = p
  for (const watcher of watchers) watcher(p)
}

export function loadSSH(onProgress?: (p: SshLoadProgress) => void): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("SSH core is browser-only"))
  }
  if (onProgress) {
    watchers.add(onProgress)
    // Fire once immediately: a caller that arrives after the core is already
    // in memory would otherwise sit on a progress bar that never moves.
    onProgress(ready ? { ...lastProgress, done: true } : lastProgress)
  }

  loading ??= (async () => {
    if (!window.Go) await injectScript("/wasm_exec.js")
    const go = new window.Go!()
    const response = await fetch("/ssh.wasm")
    if (!response.ok) {
      throw new Error(`could not fetch ssh.wasm: ${response.status}`)
    }
    const { instance } = await WebAssembly.instantiateStreaming(
      countBytes(response),
      go.importObject,
    )
    // Never resolves: the Go runtime parks and waits for callbacks.
    void go.run(instance)
    // go.run() sets up globals synchronously before it parks, but yield once
    // so the export is definitely visible.
    await new Promise((r) => setTimeout(r, 0))
    if (!window.webxtermSSH) throw new Error("ssh.wasm did not export webxtermSSH")
    ready = true
    emit({ ...lastProgress, done: true })
  })().catch((error: unknown) => {
    // A failed load must not be cached forever. The usual cause is being
    // offline for the first click, and the usual fix is clicking again.
    loading = null
    lastProgress = { loaded: 0, total: 0, done: false }
    throw error
  })

  const pending = loading
  if (!onProgress) return pending
  return pending.finally(() => {
    watchers.delete(onProgress)
  })
}

/**
 * Re-wraps the response so the bytes can be counted on the way past.
 *
 * The stream is passed straight through, so compilation still happens while
 * the download is in flight — buffering it into an ArrayBuffer to measure it
 * would trade the streaming compile for a progress bar, which is a bad deal.
 */
function countBytes(response: Response): Response {
  if (!response.body) return response
  const total = Number(response.headers.get("Content-Length") ?? 0)
  let loaded = 0

  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength
        emit({ loaded, total, done: false })
        controller.enqueue(chunk)
      },
    }),
  )
  // The headers are copied because instantiateStreaming refuses anything that
  // is not Content-Type: application/wasm.
  return new Response(counted, { headers: response.headers })
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script")
    el.src = src
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`failed to load ${src}`))
    document.head.appendChild(el)
  })
}

export async function connect(config: ConnectConfig): Promise<SshSession> {
  await loadSSH()
  return window.webxtermSSH!.connect(config)
}

/**
 * Parses an existing private key.
 *
 * Resolves with plaintext PKCS#8 in `pkcs8`. Only lib/keys.ts should call this;
 * everything else should go through importKey/inspectImportedKey there, which
 * own the "import non-extractably, then zero it" half of the contract.
 */
export async function importKey(pem: string, passphrase?: string): Promise<ImportedKey> {
  await loadSSH()
  return window.webxtermSSH!.importKey(pem, passphrase)
}

export async function parseSSHConfig(text: string): Promise<ParsedConfigHost[]> {
  await loadSSH()
  return window.webxtermSSH!.parseSSHConfig(text)
}

/**
 * Thrown when a relay access token could not be minted for any reason other
 * than the transfer allowance.
 *
 * A type of its own rather than a bare Error, so a caller can tell "we could
 * not authorise this connection" apart from "the handshake with your server
 * failed" — they are debugged in completely different places. `status` is the
 * HTTP status /api/relay-token answered with, or null when the request never
 * got a reply.
 */
export class RelayTokenError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null) {
    super(message)
    this.name = "RelayTokenError"
    this.status = status
  }
}

function explainMintFailure(status: number): string {
  if (status === 503) {
    return (
      "The relay is not configured on this deployment: the server has no shared " +
      "secret to sign a relay access token with, so it refused to mint one (503). " +
      "The connection was not attempted, because our relay will not carry it " +
      "without a token. This is a server-side setting, not something wrong with " +
      "your host or your key."
    )
  }
  if (status === 401 || status === 403) {
    return (
      `The server refused to mint a relay access token (${status}). This browser ` +
      "is most likely no longer signed in — sign in again and retry. The " +
      "connection was not attempted."
    )
  }
  return (
    `The relay access token could not be minted: the server returned ${status}. ` +
    "Our relay verifies that token before it will carry anything, so the " +
    "connection was not attempted rather than started and left to fail opaquely."
  )
}

/**
 * Builds the relay URL for a host, fetching a short-lived access token bound to
 * this exact destination. The relay only ever sees ciphertext; the token exists
 * so it cannot be used as an open proxy.
 *
 * A failure to mint is fatal, and that is the correction rather than the
 * design. This used to fall through to a tokenless URL on the stated grounds
 * that "the dev relay accepts unauthenticated connections". No relay in this
 * repo has ever done that: apps/relay/src/main.rs exits at startup without
 * RELAY_SECRET, `token` is a required query parameter on /ws, and every upgrade
 * is verified before it is accepted. So the fall-through could only produce a
 * connection that cannot succeed, refused with an HTTP status a browser is not
 * allowed to show us — the user would read "handshake failed" and go debug
 * their server, their key and their network for a missing environment variable
 * on ours.
 *
 * What is NOT solved: there is no escape hatch here for a permissive relay. If
 * one is ever wanted, it has to be gated on an explicit flag that names it,
 * because a fallback gated on a guess about the other end is how this went
 * wrong the first time.
 *
 * Two refusals are told apart because they deserve different words. A 402 means
 * the account has used its monthly relay transfer allowance and the mint was a
 * decision about that account; everything else is configuration, a session or a
 * network, and says which with the status in it.
 */
export async function relayUrl(host: string, port: number): Promise<string> {
  return buildRelayUrl({ host, port })
}

/**
 * The relay URL for a machine that cannot be dialled.
 *
 * Same shape, different destination: instead of naming an address for the relay
 * to connect to, this names an agent that has already connected to the relay and
 * is waiting. The token is minted by the same endpoint and is *not*
 * interchangeable with the address kind — see token.rs.
 *
 * The port still travels, because the agent forwards to a port on its own
 * loopback and a machine does not have to run sshd on 22. The agent refuses
 * anything outside its own allowlist regardless of what is asked for here.
 */
export async function agentRelayUrl(agent: string, port: number): Promise<string> {
  return buildRelayUrl({ agent, port })
}

async function buildRelayUrl(
  destination: { host: string; port: number } | { agent: string; port: number },
): Promise<string> {
  const base =
    process.env.NEXT_PUBLIC_RELAY_URL ??
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`

  let res: Response
  try {
    res = await fetch("/api/relay-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(destination),
    })
  } catch (e) {
    throw new RelayTokenError(
      `The request for a relay access token never reached the server (${e instanceof Error ? e.message : String(e)}). ` +
        "You may be offline. The connection was not attempted.",
      null,
    )
  }

  if (!res.ok) {
    const quota = await relayQuotaError(res)
    if (quota) throw quota
    throw new RelayTokenError(explainMintFailure(res.status), res.status)
  }

  const body = (await res.json().catch(() => ({}))) as { token?: unknown }
  if (typeof body.token !== "string" || body.token === "") {
    // A 200 with nothing usable in it is a bug on our side, and it has to be as
    // loud as a refusal: the relay would reject the connection just the same.
    throw new RelayTokenError(
      "The server accepted the request for a relay access token but returned none. " +
        "The connection was not attempted.",
      res.status,
    )
  }

  const params = new URLSearchParams(
    "agent" in destination
      ? { agent: destination.agent, port: String(destination.port), token: body.token }
      : { host: destination.host, port: String(destination.port), token: body.token },
  )
  return `${base}?${params}`
}
