"use client"

/**
 * A streaming USTAR writer.
 *
 * Built here rather than pulled from a library because the whole point is that
 * nothing is buffered: this yields 512-byte headers and file data as the files
 * are read, so a 10 GB directory streams through a few hundred KB of memory.
 * Most tar libraries want a Buffer or a Node stream.
 */

import type { UploadItem } from "./upload"

const BLOCK = 512
const ZERO = new Uint8Array(BLOCK)

interface TarOptions {
  onFile?: (path: string) => void
  onBytes?: (n: number) => void
  signal?: AbortSignal
}

/**
 * Returns a pull callback matching the WASM uploadTar contract:
 * `() => Promise<Uint8Array | null>`, null meaning end of stream.
 */
export function buildTar(
  items: UploadItem[],
  opts: TarOptions = {},
): () => Promise<Uint8Array | null> {
  const gen = tarChunks(items, opts)
  return async () => {
    const { value, done } = await gen.next()
    return done ? null : value
  }
}

async function* tarChunks(items: UploadItem[], opts: TarOptions): AsyncGenerator<Uint8Array> {
  for (const item of items) {
    if (opts.signal?.aborted) throw new Error("cancelled")
    opts.onFile?.(item.path)

    const name = normalize(item.path)
    const size = item.file.size

    // Paths too long for the 100-byte name field get a GNU long-name entry,
    // which every modern tar understands.
    const long = longNameEntry(name)
    if (long) yield long

    yield header(long ? truncate(name) : name, size, item.file.lastModified)

    let written = 0
    const reader = item.file.stream().getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (opts.signal?.aborted) throw new Error("cancelled")
      written += value.length
      opts.onBytes?.(value.length)
      yield value
    }

    // A file that changed size mid-read would corrupt the archive, since the
    // header already declared a length. Better to fail than ship a bad tar.
    if (written !== size) {
      throw new Error(
        `${item.path} changed while being read (declared ${size} bytes, read ${written})`,
      )
    }

    const pad = padding(size)
    if (pad > 0) yield new Uint8Array(pad)
  }

  // Two zero blocks terminate the archive.
  yield new Uint8Array(BLOCK * 2)
}

function normalize(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/{2,}/g, "/")
}

function padding(size: number): number {
  const rem = size % BLOCK
  return rem === 0 ? 0 : BLOCK - rem
}

function truncate(name: string): string {
  return name.length > 100 ? name.slice(0, 100) : name
}

function longNameEntry(name: string): Uint8Array | null {
  const bytes = new TextEncoder().encode(name)
  if (bytes.length <= 100) return null

  const head = header("././@LongLink", bytes.length, 0, "L")
  const pad = padding(bytes.length)
  const out = new Uint8Array(head.length + bytes.length + pad)
  out.set(head, 0)
  out.set(bytes, head.length)
  return out
}

function header(name: string, size: number, mtimeMs: number, type = "0"): Uint8Array {
  const buf = new Uint8Array(BLOCK)
  const enc = new TextEncoder()

  const put = (offset: number, len: number, value: string) => {
    const b = enc.encode(value)
    buf.set(b.subarray(0, len), offset)
  }
  const octal = (n: number, len: number) =>
    `${n
      .toString(8)
      .padStart(len - 1, "0")
      .slice(-(len - 1))}\0`

  put(0, 100, name)
  put(100, 8, octal(0o644, 8)) // mode
  put(108, 8, octal(0, 8)) // uid
  put(116, 8, octal(0, 8)) // gid
  put(124, 12, octal(size, 12))
  put(136, 12, octal(Math.floor(mtimeMs / 1000), 12))
  put(148, 8, "        ") // checksum placeholder: spaces
  put(156, 1, type)
  put(257, 6, "ustar\0")
  put(263, 2, "00")
  put(265, 32, "weirdvault") // uname
  put(297, 32, "weirdvault") // gname

  // Checksum is the unsigned sum of all header bytes with the checksum field
  // read as spaces, stored as six octal digits, NUL, space.
  let sum = 0
  for (const b of buf) sum += b
  put(148, 8, `${sum.toString(8).padStart(6, "0").slice(-6)}\0 `)

  return buf
}

/** Kept for symmetry with the writer; used by the download-as-tar path. */
export { BLOCK as TAR_BLOCK_SIZE, ZERO as TAR_ZERO_BLOCK }
