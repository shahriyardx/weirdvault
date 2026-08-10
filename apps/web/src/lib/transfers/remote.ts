/**
 * Copying between two remote hosts.
 *
 * There is no server-to-server path and there is not going to be one. Both SSH
 * connections terminate in this tab, so a copy from web-01 to web-02 is read
 * down one and written up the other, through here. That costs the bytes twice
 * over the relay and is bounded by the narrower half of the user's own
 * connection — which is worth saying out loud in the UI rather than discovering
 * from a progress bar that moves at half the expected speed.
 *
 * What it is not is a buffer. The two halves run concurrently and the bridge
 * below holds a handful of chunks, so a 2 GB directory does not become 2 GB of
 * JS heap. That is the entire reason this file exists rather than a
 * `download-to-Blob-then-upload` of four lines.
 *
 * Directories go through tar for the same reason uploads do: a thousand small
 * files over SFTP is a thousand round trips, and `tar -c | tar -x` is one
 * stream. It needs `tar` on both ends, which is a fair assumption on anything
 * running sshd and is reported plainly when it turns out to be wrong.
 */

import type { SftpHandle, SshSession, TransferResult } from "@/lib/ssh/types"

/**
 * How many chunks may sit between the reader and the writer.
 *
 * The queue is the only thing decoupling a fast source from a slow destination.
 * Too small and the two halves lockstep, losing the overlap that makes this
 * faster than doing it in two passes; too large and a slow destination lets the
 * source fill memory. Eight chunks is a few hundred kilobytes at the sizes the
 * SFTP layer emits.
 */
const HIGH_WATER_CHUNKS = 8

/**
 * Turns a push-based producer into a pull-based consumer, with backpressure.
 *
 * `sftp.download` pushes chunks at a sink; `sftp.upload` pulls them from a
 * source. Bridging them needs a queue, and the queue needs to push back or the
 * faster side wins by filling the heap. `push` does not resolve while the queue
 * is full, which stalls the reader — and because the reader's promise is what
 * the Go side awaits before requesting more data, that stall reaches all the way
 * down to the SSH window.
 *
 * Exactly one reader and one writer. Two of either would need a real channel.
 */
class ChunkBridge {
  private queue: Uint8Array[] = []
  private ended = false
  private failure: unknown = null
  private wakeReader: (() => void) | null = null
  private wakeWriter: (() => void) | null = null

  private wake() {
    this.wakeReader?.()
    this.wakeReader = null
    this.wakeWriter?.()
    this.wakeWriter = null
  }

  /** Called by the download sink. Resolves once there is room for more. */
  async push(chunk: Uint8Array): Promise<void> {
    if (this.failure) throw this.failure
    this.queue.push(chunk)
    this.wakeReader?.()
    this.wakeReader = null

    while (this.queue.length >= HIGH_WATER_CHUNKS && !this.failure && !this.ended) {
      await new Promise<void>((resolve) => {
        this.wakeWriter = resolve
      })
    }
    if (this.failure) throw this.failure
  }

  /** The source is exhausted. The reader drains what is left, then sees null. */
  end() {
    this.ended = true
    this.wake()
  }

  /**
   * Something broke on either side. Both halves have to learn about it: a writer
   * left awaiting a chunk that will never arrive, or a reader awaiting room in a
   * queue nobody will drain, hangs the whole copy silently.
   */
  fail(error: unknown) {
    this.failure = error ?? new Error("transfer failed")
    this.wake()
  }

  /** Called by the upload source. Null ends the stream. */
  async next(): Promise<Uint8Array | null> {
    for (;;) {
      if (this.failure) throw this.failure
      const chunk = this.queue.shift()
      if (chunk) {
        this.wakeWriter?.()
        this.wakeWriter = null
        return chunk
      }
      if (this.ended) return null
      await new Promise<void>((resolve) => {
        this.wakeReader = resolve
      })
    }
  }
}

export interface RemoteCopyEndpoint {
  session: SshSession
  sftp: SftpHandle
}

export interface RemoteCopyOptions {
  signal?: AbortSignal
  /** Total bytes moved so far. There is no denominator for a directory. */
  onProgress?: (bytes: number) => void
}

export type RemoteCopyStrategy = "sftp" | "tar"

/**
 * Copies one entry from `from` to a directory on `to`.
 *
 * Never deletes anything. A move between hosts is a copy the user follows with
 * a delete they chose; doing it implicitly would mean a failed verification
 * somewhere in here could lose the only copy of a file.
 */
export async function copyBetweenHosts(
  from: RemoteCopyEndpoint,
  to: RemoteCopyEndpoint,
  sourcePath: string,
  destinationDir: string,
  isDir: boolean,
  opts: RemoteCopyOptions = {},
): Promise<{ result: TransferResult; strategy: RemoteCopyStrategy }> {
  const bridge = new ChunkBridge()
  let moved = 0

  const abort = () => bridge.fail(new Error("cancelled"))
  opts.signal?.addEventListener("abort", abort, { once: true })
  if (opts.signal?.aborted) abort()

  const sink = async (chunk: Uint8Array) => {
    moved += chunk.byteLength
    opts.onProgress?.(moved)
    await bridge.push(chunk)
  }

  // `tar -cf - -C <dir> <base>` names its entries after the basename, and the
  // extract side runs in the destination directory, so the tree lands at
  // <destinationDir>/<base> without either side being told the final path.
  const read = isDir
    ? from.session.downloadTar(sourcePath, sink)
    : from.sftp.download(sourcePath, sink)

  const base = basename(sourcePath)
  const write = isDir
    ? to.session.uploadTar(destinationDir, () => bridge.next())
    : to.sftp.upload(joinPath(destinationDir, base), () => bridge.next())

  // Each half tells the bridge when it is finished or has failed, so the other
  // half is never left waiting on a peer that has already given up.
  const reading = read.then(
    () => bridge.end(),
    (error: unknown) => {
      bridge.fail(error)
      throw error
    },
  )
  const writing = write.catch((error: unknown) => {
    bridge.fail(error)
    throw error
  })

  try {
    // allSettled rather than all: the rejection that matters is whichever failed
    // first, and `all` would surface the follow-on "cancelled" from the other
    // half just as readily. Reported below in a fixed order instead.
    const [readOutcome, writeOutcome] = await Promise.allSettled([reading, writing])
    if (readOutcome.status === "rejected") throw asError(readOutcome.reason, from, isDir)
    if (writeOutcome.status === "rejected") throw asError(writeOutcome.reason, to, isDir)
    return {
      strategy: isDir ? "tar" : "sftp",
      result: writeOutcome.value,
    }
  } finally {
    opts.signal?.removeEventListener("abort", abort)
  }
}

/**
 * A missing `tar` reports as a non-zero exit with nothing useful attached, which
 * reads as a mystery failure on a copy that would have worked as a file.
 */
function asError(reason: unknown, _end: RemoteCopyEndpoint, isDir: boolean): Error {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (isDir && /not found|no such file|127/i.test(message)) {
    return new Error(
      `${message} — copying a directory between hosts uses tar on both ends, and one of them does not appear to have it.`,
    )
  }
  return reason instanceof Error ? reason : new Error(message)
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`
}
