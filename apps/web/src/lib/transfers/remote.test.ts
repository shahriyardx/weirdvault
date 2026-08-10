import { describe, expect, test } from "bun:test";

import { copyBetweenHosts, type RemoteCopyEndpoint } from "./remote";
import type { SftpHandle, SshSession, TransferResult } from "@/lib/ssh/types";

/**
 * The host-to-host copy, tested for the failures that hang rather than the ones
 * that throw.
 *
 * A copy between two hosts is a reader and a writer running concurrently with a
 * bounded queue between them, and every interesting bug in that shape is a
 * deadlock: a writer waiting on a chunk from a reader that has already died, a
 * reader waiting for room in a queue nobody will drain again. Those do not fail
 * a test, they hang it — so every case here is written so that a deadlock times
 * out rather than passing quietly, and the assertions are about which side's
 * error surfaces and whether both halves were released.
 *
 * The bytes themselves are the easy part and are checked once.
 */

const text = (s: string) => new TextEncoder().encode(s);
const RESULT: TransferResult = { bytes: 0, ms: 1, mbPerSec: 0 };

/**
 * A source that pushes `chunks` at the sink, honouring the backpressure the
 * sink applies. Records how far it got, which is what proves the queue actually
 * pushed back rather than swallowing everything at once.
 */
function source(chunks: Uint8Array[]) {
  const pushed: number[] = [];
  const handle = {
    async download(_path: string, onChunk: (c: Uint8Array) => void | Promise<void>) {
      for (const [i, chunk] of chunks.entries()) {
        await onChunk(chunk);
        pushed.push(i);
      }
      return RESULT;
    },
  } as unknown as SftpHandle;
  return { handle, pushed };
}

/** A sink that collects what it is handed, optionally stalling or failing. */
function sink(opts: { failAfter?: number; gate?: Promise<void> } = {}) {
  const received: Uint8Array[] = [];
  const handle = {
    async upload(_path: string, next: () => Promise<Uint8Array | null>) {
      if (opts.gate) await opts.gate;
      for (;;) {
        const chunk = await next();
        if (chunk === null) return RESULT;
        received.push(chunk);
        if (opts.failAfter !== undefined && received.length > opts.failAfter) {
          throw new Error("disk full");
        }
      }
    },
  } as unknown as SftpHandle;
  return { handle, received };
}

const noSession = {} as SshSession;
const endpoint = (sftp: SftpHandle): RemoteCopyEndpoint => ({ session: noSession, sftp });

/** Fails the test rather than hanging the suite when a copy deadlocks. */
function withTimeout<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timed out — the copy deadlocked")), ms),
    ),
  ]);
}

describe("copyBetweenHosts", () => {
  test("moves every byte, in order", async () => {
    const src = source([text("one"), text("two"), text("three")]);
    const dst = sink();

    await withTimeout(
      copyBetweenHosts(endpoint(src.handle), endpoint(dst.handle), "/srv/a.txt", "/var/www", false),
    );

    expect(Buffer.concat(dst.received.map((c) => Buffer.from(c))).toString()).toBe("onetwothree");
  });

  test("the destination filename is the source basename, in the target directory", async () => {
    const src = source([text("x")]);
    let wrotePath = "";
    const dst = {
      async upload(path: string, next: () => Promise<Uint8Array | null>) {
        wrotePath = path;
        while ((await next()) !== null) {
          /* drain */
        }
        return RESULT;
      },
    } as unknown as SftpHandle;

    await withTimeout(
      copyBetweenHosts(
        endpoint(src.handle),
        endpoint(dst),
        "/srv/api/deploy.sh",
        "/var/www",
        false,
      ),
    );

    expect(wrotePath).toBe("/var/www/deploy.sh");
  });

  test("a trailing slash on the destination does not double up", async () => {
    const src = source([text("x")]);
    let wrotePath = "";
    const dst = {
      async upload(path: string, next: () => Promise<Uint8Array | null>) {
        wrotePath = path;
        while ((await next()) !== null) {
          /* drain */
        }
        return RESULT;
      },
    } as unknown as SftpHandle;

    await withTimeout(
      copyBetweenHosts(endpoint(src.handle), endpoint(dst), "/srv/a.txt", "/", false),
    );

    expect(wrotePath).toBe("/a.txt");
  });

  test("the reader stalls once the queue fills, rather than buffering it all", async () => {
    // Twice the high-water mark, so a source that ignored backpressure would
    // finish pushing before the gated sink has taken anything.
    const chunks = Array.from({ length: 16 }, (_, i) => text(String(i)));
    const src = source(chunks);

    let openGate = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const dst = sink({ gate });

    const copy = copyBetweenHosts(
      endpoint(src.handle),
      endpoint(dst.handle),
      "/srv/a",
      "/dst",
      false,
    );

    // Let the reader run as far as it can while the writer is held.
    await new Promise((r) => setTimeout(r, 20));
    expect(src.pushed.length).toBeLessThan(chunks.length);

    openGate();
    await withTimeout(copy);
    expect(dst.received).toHaveLength(chunks.length);
  });

  test("a failing destination surfaces its error instead of hanging the source", async () => {
    const src = source(Array.from({ length: 32 }, () => text("data")));
    const dst = sink({ failAfter: 2 });

    await expect(
      withTimeout(
        copyBetweenHosts(endpoint(src.handle), endpoint(dst.handle), "/srv/a", "/dst", false),
      ),
    ).rejects.toThrow("disk full");
  });

  test("a failing source surfaces its error instead of hanging the destination", async () => {
    const failing = {
      async download(_path: string, onChunk: (c: Uint8Array) => void | Promise<void>) {
        await onChunk(text("partial"));
        throw new Error("permission denied");
      },
    } as unknown as SftpHandle;
    const dst = sink();

    await expect(
      withTimeout(
        copyBetweenHosts(endpoint(failing), endpoint(dst.handle), "/srv/a", "/dst", false),
      ),
    ).rejects.toThrow("permission denied");
  });

  test("aborting releases both halves", async () => {
    const controller = new AbortController();
    // A source that never ends on its own: only the abort can finish this.
    //
    // The yield is load-bearing in the test rather than in the product. Without
    // it the reader and the writer hand chunks back and forth entirely in
    // microtasks, which starves the timer below and hangs the test on a copy
    // that is working perfectly. Real transfers cross the WASM boundary and do
    // actual I/O, so they yield on their own.
    const endless = {
      async download(_path: string, onChunk: (c: Uint8Array) => void | Promise<void>) {
        for (;;) {
          await onChunk(text("x"));
          await new Promise((r) => setTimeout(r, 0));
        }
      },
    } as unknown as SftpHandle;
    const dst = sink();

    const copy = copyBetweenHosts(
      endpoint(endless),
      endpoint(dst.handle),
      "/srv/a",
      "/dst",
      false,
      { signal: controller.signal },
    );

    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    await expect(withTimeout(copy)).rejects.toThrow("cancelled");
  });

  test("a directory goes through tar on both ends", async () => {
    const chunks = [text("tar-header"), text("tar-body")];
    let tarSource = "";
    let tarDest = "";

    const from: RemoteCopyEndpoint = {
      sftp: {} as SftpHandle,
      session: {
        async downloadTar(path: string, onChunk: (c: Uint8Array) => void | Promise<void>) {
          tarSource = path;
          for (const c of chunks) await onChunk(c);
          return RESULT;
        },
      } as unknown as SshSession,
    };

    const received: Uint8Array[] = [];
    const to: RemoteCopyEndpoint = {
      sftp: {} as SftpHandle,
      session: {
        async uploadTar(dir: string, next: () => Promise<Uint8Array | null>) {
          tarDest = dir;
          for (;;) {
            const c = await next();
            if (c === null) return RESULT;
            received.push(c);
          }
        },
      } as unknown as SshSession,
    };

    const { strategy } = await withTimeout(
      copyBetweenHosts(from, to, "/srv/api/logs", "/var/www", true),
    );

    expect(strategy).toBe("tar");
    // The extract side is handed the destination directory, never the final
    // path: tar names its own entries after the source basename, so telling it
    // /var/www/logs would produce /var/www/logs/logs.
    expect(tarSource).toBe("/srv/api/logs");
    expect(tarDest).toBe("/var/www");
    expect(Buffer.concat(received.map((c) => Buffer.from(c))).toString()).toBe(
      "tar-headertar-body",
    );
  });

  test("a missing tar is reported as a missing tar", async () => {
    const from: RemoteCopyEndpoint = {
      sftp: {} as SftpHandle,
      session: {
        async downloadTar() {
          throw new Error("tar: command not found");
        },
      } as unknown as SshSession,
    };
    const to: RemoteCopyEndpoint = {
      sftp: {} as SftpHandle,
      session: {
        async uploadTar(_dir: string, next: () => Promise<Uint8Array | null>) {
          while ((await next()) !== null) {
            /* drain */
          }
          return RESULT;
        },
      } as unknown as SshSession,
    };

    await expect(
      withTimeout(copyBetweenHosts(from, to, "/srv/logs", "/var/www", true)),
    ).rejects.toThrow(/does not appear to have it/);
  });

  test("reports progress as bytes move", async () => {
    const src = source([text("aaaa"), text("bb")]);
    const dst = sink();
    const seen: number[] = [];

    await withTimeout(
      copyBetweenHosts(endpoint(src.handle), endpoint(dst.handle), "/a", "/b", false, {
        onProgress: (bytes) => seen.push(bytes),
      }),
    );

    // Cumulative, not per-chunk: a progress bar wants the total so far.
    expect(seen).toEqual([4, 6]);
  });
});
