# Phase 2 Spike — SFTP & Streaming Transfers: GO

**Date:** 2026-08-08
**Verdict:** the file explorer is buildable as specced. No architecture change needed.

## The questions

Phase 0 proved the SSH core. It did not touch files. Two open risks:

1. Is SFTP throughput usable through a browser + relay round trip?
2. **Does a large transfer stream, or does it buffer?** A file explorer that
   holds a 4 GB upload in tab memory is not a file explorer, it's a crash.

The second is the one that could have forced a redesign.

## Results

| Gate | Target | Measured | |
|---|---|---|---|
| SFTP opens on the existing SSH connection | must | works, no second login | PASS |
| Upload throughput | > 20 MB/s | **21.3 MB/s** | PASS |
| Download throughput | > 20 MB/s | **38.5 MB/s** | PASS |
| Upload retained heap after GC | < 16 MB | **−0.9 MB** | PASS |
| Download retained heap after GC | < 16 MB | **−6.8 MB** | PASS |
| **Memory does not scale with file size** | < 1.5× | **0.92×** | PASS |
| Uploaded file intact on server | exact | 134217728 bytes | PASS |
| Bundle size delta from SFTP | — | +0.07 MB Brotli (1.25 → 1.32) | — |

Measured with the standalone SFTP spike, since deleted; see git history.

## How streaming was actually proven

Peak heap during a transfer is a bad metric — it measures allocation rate and
GC timing, not whether you're holding the file. Two better ones:

**Retained heap after forced GC.** Chromium launched with `--js-flags=--expose-gc`,
heap sampled after the transfer with the collector given a chance to run.
Result was *negative* for both directions: the tab ends smaller than it started.
Nothing is held.

**Scaling ratio — the decisive test.** Upload 64 MB, then 128 MB, and compare
peak growth. A buffering implementation scales ~1.0 with file size (2× data,
2× memory). Measured: **0.92× for 2× the data.** Flat. That is what streaming
looks like, and no single-size measurement could have shown it.

## Design that produced this

- **Uploads pull, downloads push.** WASM calls a JS callback for the next chunk
  (`Promise<Uint8Array|null>`); for downloads it invokes a sink callback and
  awaits the returned promise. Awaiting is what gives backpressure — a slow
  consumer slows the transfer instead of queueing into memory.
- **`io.CopyBuffer` with 256 KB buffers**, letting `pkg/sftp`'s `WriteTo`/
  `ReadFrom` concurrent paths engage.
- **`sftp.MaxPacket(32 KB)` + concurrent reads/writes.** The relay round trip
  makes small packets expensive; the default 32 KB packet was the throughput
  limiter before tuning.
- **SFTP rides the existing `ssh.Client`** and opens lazily, so a shell-only
  session never pays for the subsystem and the file explorer needs no second
  login. This is what makes MobaXterm's "SFTP attached to every session" free.

## What this does NOT prove

- **Still localhost.** 21–38 MB/s excludes WAN RTT; real transfers will be
  bandwidth-bound, not client-bound. The result says the client isn't the
  bottleneck, not that users get 38 MB/s.
- **No File System Access API path yet.** Downloads discarded bytes rather than
  writing to disk. `showSaveFilePicker` + `WritableStream` (and the Service
  Worker fallback for Firefox/Safari) is untested.
- **Upload source was a synthetic Blob**, not a real drag-dropped `File`. Same
  `.stream()` interface, but directory drops via `DataTransferItem` recursion
  are untested.
- **No resume.** Interrupted transfers restart from zero today.
- **Tar-pipe fast path not built.** Many-small-files folders will still be slow
  via per-file SFTP; the plan's `tar` fast path remains unimplemented.
- Asymmetric throughput (21 up vs 38 down) is unexplained — likely write-path
  packet sizing. Worth a look before Phase 2 proper, not a blocker.

## Consequences

- File explorer, drag-drop upload, and Monaco remote editing are all clear to
  build on this foundation.
- Bundle budget remains healthy: 1.32 MB Brotli with SSH + SFTP.
- Next unproven area: **disk-backed downloads** (File System Access API and the
  Service Worker fallback), and **directory upload**. Both are browser-API risk
  rather than protocol risk, so they belong in Phase 2 proper rather than a
  separate spike.
