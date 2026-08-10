"use client"

/**
 * Streaming downloads to disk.
 *
 * The obvious implementation — collect chunks into a Blob, then create an
 * object URL — dies on anything large: the whole file has to fit in memory
 * first. Both paths here write straight to disk instead.
 *
 *  1. File System Access API (Chromium): a real WritableStream to a file the
 *     user picked.
 *  2. Service Worker (Firefox, Safari): the worker answers a navigation with a
 *     ReadableStream we feed, so the browser's own download manager streams it.
 *
 * A Blob fallback exists for tiny files only, where the ceremony isn't worth it.
 */

import type { SftpHandle, TransferResult } from "@/lib/ssh/types"

const BLOB_FALLBACK_LIMIT = 64 * 1024 * 1024

export type DownloadStrategy = "file-system-access" | "service-worker" | "blob"

export interface DownloadOptions {
  onProgress?: (bytes: number) => void
  signal?: AbortSignal
}

export function supportsFileSystemAccess(): boolean {
  return typeof window !== "undefined" && "showSaveFilePicker" in window
}

export async function downloadFile(
  sftp: SftpHandle,
  remotePath: string,
  size: number,
  opts: DownloadOptions = {},
): Promise<{ result: TransferResult; strategy: DownloadStrategy }> {
  const filename = remotePath.split("/").pop() || "download"

  if (supportsFileSystemAccess()) {
    return {
      strategy: "file-system-access",
      result: await viaFileSystemAccess(sftp, remotePath, filename, opts),
    }
  }

  const sw = await serviceWorkerReady()
  if (sw) {
    return {
      strategy: "service-worker",
      result: await viaServiceWorker(sftp, remotePath, filename, size, sw, opts),
    }
  }

  if (size > BLOB_FALLBACK_LIMIT) {
    throw new Error(
      `This browser has no streaming download path, and ${filename} is too large ` +
        `to buffer in memory. Use a Chromium browser, or enable service workers.`,
    )
  }
  return { strategy: "blob", result: await viaBlob(sftp, remotePath, filename, opts) }
}

/* ----------------------------------------------- File System Access API --- */

interface SaveFilePickerOptions {
  suggestedName?: string
}
type SavePicker = (o?: SaveFilePickerOptions) => Promise<{
  createWritable: () => Promise<WritableStream<Uint8Array>>
}>

async function viaFileSystemAccess(
  sftp: SftpHandle,
  remotePath: string,
  filename: string,
  opts: DownloadOptions,
): Promise<TransferResult> {
  const picker = (window as unknown as { showSaveFilePicker: SavePicker }).showSaveFilePicker
  const handle = await picker({ suggestedName: filename })
  const writable = await handle.createWritable()
  const writer = writable.getWriter()

  let written = 0
  try {
    return await sftp.download(remotePath, async (chunk) => {
      if (opts.signal?.aborted) throw new Error("cancelled")
      // Awaiting the writer is the backpressure: SFTP slows to disk speed
      // instead of queueing chunks in memory.
      await writer.write(chunk)
      written += chunk.length
      opts.onProgress?.(written)
    })
  } finally {
    await writer.close().catch(() => {})
  }
}

/* ----------------------------------------------------- Service Worker --- */

async function serviceWorkerReady(): Promise<ServiceWorker | null> {
  if (!("serviceWorker" in navigator)) return null
  try {
    const reg = await navigator.serviceWorker.register("/sw.js")
    await navigator.serviceWorker.ready
    return reg.active ?? navigator.serviceWorker.controller
  } catch {
    return null
  }
}

async function viaServiceWorker(
  sftp: SftpHandle,
  remotePath: string,
  filename: string,
  size: number,
  sw: ServiceWorker,
  opts: DownloadOptions,
): Promise<TransferResult> {
  const id = crypto.randomUUID()
  const channel = new MessageChannel()

  // The worker replies "pull" whenever it wants more; resolving this gate is
  // how we avoid outrunning the browser's writer.
  let releasePull: (() => void) | null = null
  const waitForPull = () => new Promise<void>((r) => (releasePull = r))

  const ready = new Promise<void>((resolve, reject) => {
    channel.port1.onmessage = (e) => {
      if (e.data === "ready") resolve()
      else if (e.data === "pull") releasePull?.()
      else if (e.data?.type === "cancelled") reject(new Error("download cancelled"))
    }
  })

  sw.postMessage({ type: "download-start", id, filename, size }, [channel.port2])
  await ready

  // Triggering the navigation makes the browser attach its download manager to
  // the stream the worker is about to serve.
  const frame = document.createElement("iframe")
  frame.hidden = true
  frame.src = `/__download/${id}`
  document.body.appendChild(frame)

  let written = 0
  try {
    return await sftp.download(remotePath, async (chunk) => {
      if (opts.signal?.aborted) {
        channel.port1.postMessage({ type: "abort", reason: "cancelled" })
        throw new Error("cancelled")
      }
      const pulled = waitForPull()
      // Copy: the underlying buffer is reused by the WASM bridge on the next read.
      channel.port1.postMessage(chunk.slice())
      written += chunk.length
      opts.onProgress?.(written)
      await pulled
    })
  } finally {
    channel.port1.postMessage(null)
    setTimeout(() => frame.remove(), 2000)
  }
}

/* ------------------------------------------------------------- Blob --- */

async function viaBlob(
  sftp: SftpHandle,
  remotePath: string,
  filename: string,
  opts: DownloadOptions,
): Promise<TransferResult> {
  const parts: Uint8Array[] = []
  let written = 0
  const result = await sftp.download(remotePath, (chunk) => {
    parts.push(chunk.slice())
    written += chunk.length
    opts.onProgress?.(written)
  })

  const url = URL.createObjectURL(new Blob(parts as BlobPart[]))
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return result
}
