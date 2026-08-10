"use client";

/**
 * Streaming uploads, including whole directories.
 *
 * Two strategies, chosen automatically:
 *
 *  - per-file SFTP, which is simple and gives exact per-file progress;
 *  - a single tar stream through an exec channel, which is dramatically faster
 *    when there are many small files because SFTP costs a round trip per file.
 *    A node_modules tree is thousands of round trips; as one tar stream it is
 *    just bytes.
 *
 * Files are read via File.stream(), so nothing is ever fully in memory.
 */

import type { SftpHandle, SshSession, TransferResult } from "@/lib/ssh/types";
import { buildTar } from "./tar";

/** Above this many files, or below this mean size, tar wins decisively. */
const TAR_FILE_COUNT_THRESHOLD = 24;
const TAR_MEAN_SIZE_THRESHOLD = 512 * 1024;

export interface UploadItem {
  /** Path relative to the upload root, e.g. "src/index.ts". */
  path: string;
  file: File;
}

export interface UploadOptions {
  onProgress?: (done: number, total: number, current?: string) => void;
  signal?: AbortSignal;
  /** Force a strategy instead of choosing by shape. */
  strategy?: "sftp" | "tar";
}

export type UploadStrategy = "sftp" | "tar";

export function chooseStrategy(items: UploadItem[]): UploadStrategy {
  if (items.length <= 1) return "sftp";
  const total = items.reduce((n, i) => n + i.file.size, 0);
  const mean = total / items.length;
  return items.length >= TAR_FILE_COUNT_THRESHOLD || mean < TAR_MEAN_SIZE_THRESHOLD
    ? "tar"
    : "sftp";
}

export async function upload(
  session: SshSession,
  sftp: SftpHandle,
  remoteDir: string,
  items: UploadItem[],
  opts: UploadOptions = {},
): Promise<{ result: TransferResult; strategy: UploadStrategy }> {
  const strategy = opts.strategy ?? chooseStrategy(items);
  return strategy === "tar"
    ? { strategy, result: await uploadViaTar(session, remoteDir, items, opts) }
    : { strategy, result: await uploadViaSftp(sftp, remoteDir, items, opts) };
}

async function uploadViaSftp(
  sftp: SftpHandle,
  remoteDir: string,
  items: UploadItem[],
  opts: UploadOptions,
): Promise<TransferResult> {
  const total = items.reduce((n, i) => n + i.file.size, 0);
  const start = performance.now();
  let done = 0;

  // Create directories first so per-file writes never fail on a missing parent.
  const dirs = new Set<string>();
  for (const item of items) {
    const dir = item.path.includes("/")
      ? `${remoteDir}/${item.path.slice(0, item.path.lastIndexOf("/"))}`
      : remoteDir;
    dirs.add(dir);
  }
  for (const dir of [...dirs].sort()) await sftp.mkdir(dir);

  for (const item of items) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    opts.onProgress?.(done, total, item.path);

    const reader = item.file.stream().getReader();
    await sftp.upload(`${remoteDir}/${item.path}`, async () => {
      if (opts.signal?.aborted) throw new Error("cancelled");
      const { value, done: finished } = await reader.read();
      if (finished) return null;
      done += value.length;
      opts.onProgress?.(done, total, item.path);
      return value;
    });
  }

  const ms = performance.now() - start;
  return { bytes: total, ms, mbPerSec: total / 1048576 / (ms / 1000) };
}

async function uploadViaTar(
  session: SshSession,
  remoteDir: string,
  items: UploadItem[],
  opts: UploadOptions,
): Promise<TransferResult> {
  const total = items.reduce((n, i) => n + i.file.size, 0);
  let done = 0;

  const next = buildTar(items, {
    onFile: (path) => opts.onProgress?.(done, total, path),
    onBytes: (n) => {
      done += n;
      opts.onProgress?.(done, total);
    },
    signal: opts.signal,
  });

  return session.uploadTar(remoteDir, next);
}

/* --------------------------------------------------------- drag & drop --- */

/**
 * Flattens a drop into a file list, walking directories.
 *
 * `DataTransferItem.webkitGetAsEntry` is the only way to see a dropped folder's
 * contents; `DataTransfer.files` silently gives you the folder as a zero-byte
 * entry instead. Non-standard, but supported everywhere that matters.
 */
export async function itemsFromDataTransfer(dt: DataTransfer): Promise<UploadItem[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    return Array.from(dt.files).map((file) => ({ path: file.name, file }));
  }

  const out: UploadItem[] = [];
  await Promise.all(entries.map((e) => walkEntry(e, "", out)));
  return out;
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: UploadItem[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ path, file });
    return;
  }

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns at most ~100 at a time and signals completion with an
  // empty batch, so it has to be drained in a loop.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    await Promise.all(batch.map((child) => walkEntry(child, path, out)));
  }
}

/** For <input type="file" webkitdirectory>, which reports relative paths. */
export function itemsFromInput(files: FileList): UploadItem[] {
  return Array.from(files).map((file) => ({
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    file,
  }));
}
