"use client";

/**
 * The recording format: webxterm cast v1.
 *
 * A recording is the terminal's output stream and nothing else — the bytes the
 * server sent back, stamped with when they arrived, plus the size the terminal
 * was at the time. Replaying it is writing those bytes into a fresh emulator on
 * the same clock, which is why the format is barely a format at all: a header
 * line and one line per event, newline-delimited JSON.
 *
 * Size is in here because a transcript without it is unreadable. A terminal is a
 * grid, and every box-drawing character, every progress bar and every wrapped
 * line was laid out against a specific column count. Replay 132 columns of `top`
 * into an 80-column emulator and you get a wall of broken glyphs, so the initial
 * geometry is in the header and every later resize is an event of its own.
 *
 * Two deliberate departures from asciinema's v2 cast, which this is otherwise
 * modelled on:
 *
 *  - Output payloads are base64 of the raw bytes, not text. asciinema stores
 *    strings, which means passing the stream through a UTF-8 decoder — and a
 *    terminal stream is not guaranteed to be UTF-8. `cat` a binary, run a
 *    program that emits latin-1, and a decoder replaces those bytes with U+FFFD.
 *    The recording would then be a transcript of something that never happened.
 *    Base64 costs a third more space and keeps the bytes exact.
 *  - Timestamps are integer milliseconds since the start of the recording, not
 *    float seconds. The capture clock produces milliseconds; float seconds would
 *    only add rounding to every event and a drift argument to every comparison.
 *
 * `toAsciicast` exists for people who want to play a recording somewhere else,
 * and it makes exactly the trade this format refuses to: it decodes to text, so
 * anything that is not valid UTF-8 comes out as a replacement character. That is
 * a lossy export of a lossless recording, and the download says so.
 *
 * Everything a human reads — the label, which host it was, the account — lives
 * in the header, which is inside the ciphertext. The server holds the blinded
 * host reference and a byte count, and could not build this file if it tried.
 */

import { fromB64, toB64 } from "@/lib/vault/crypto";

/** Bumped only for a change a v1 decoder could not read correctly. */
export const CAST_VERSION = 1;

export interface CastHeader {
  v: number;
  /** Terminal geometry at the first byte. Resizes after that are events. */
  cols: number;
  rows: number;
  /** Milliseconds since the epoch, for "when was this". */
  startedAt: number;
  /**
   * How long the recording ran, which is not the timestamp of the last event:
   * a session left idle for five minutes before stopping has five minutes of
   * nothing at the end, and the seek bar has to know about it.
   */
  durationMs: number;
  /** What the person called it. Never leaves the tab except as ciphertext. */
  label?: string;
  /** "user@host:port". Same rule: inside the envelope, never in a column. */
  host?: string;
}

export type CastEvent =
  | { at: number; kind: "output"; bytes: Uint8Array }
  | { at: number; kind: "resize"; cols: number; rows: number };

export interface Cast {
  header: CastHeader;
  /** Non-decreasing in `at`. The decoder does not sort; the capture is ordered. */
  events: CastEvent[];
}

export class CastFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastFormatError";
  }
}

/* ------------------------------------------------------------------ encode */

export function encodeCast(cast: Cast): string {
  const lines = [JSON.stringify(cast.header)];
  for (const event of cast.events) {
    lines.push(
      event.kind === "output"
        ? JSON.stringify([event.at, "o", toB64(event.bytes)])
        : JSON.stringify([event.at, "r", `${event.cols}x${event.rows}`]),
    );
  }
  // Trailing newline so the file is a well-formed text file and appending to it
  // later cannot join two records into one line.
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ decode */

/**
 * Parses a cast, refusing anything it cannot read exactly.
 *
 * There is no lenient mode on purpose. A decoder that skips the lines it does
 * not understand hands back a transcript with holes in it and no way to tell,
 * and a transcript you cannot trust to be complete is not evidence of anything.
 * Blank lines are the one exception, because they carry nothing.
 */
export function decodeCast(text: string): Cast {
  const lines = text.split("\n");
  let cursor = 0;
  while (cursor < lines.length && lines[cursor].trim() === "") cursor++;
  if (cursor >= lines.length) throw new CastFormatError("the recording is empty");

  const header = parseHeader(lines[cursor], cursor + 1);
  const events: CastEvent[] = [];

  for (let i = cursor + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    events.push(parseEvent(line, i + 1));
  }

  return { header, events };
}

function parseHeader(line: string, lineNumber: number): CastHeader {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new CastFormatError(`line ${lineNumber} is not a JSON header`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CastFormatError(`line ${lineNumber} is not a JSON header`);
  }

  const h = raw as Record<string, unknown>;
  if (h.v !== CAST_VERSION) {
    throw new CastFormatError(
      `this build reads cast v${CAST_VERSION}; the recording says v${String(h.v)}`,
    );
  }

  const cols = positiveInt(h.cols, "cols");
  const rows = positiveInt(h.rows, "rows");
  const startedAt = finite(h.startedAt, "startedAt");
  const durationMs = finite(h.durationMs, "durationMs");

  return {
    v: CAST_VERSION,
    cols,
    rows,
    startedAt,
    durationMs,
    ...(typeof h.label === "string" ? { label: h.label } : {}),
    ...(typeof h.host === "string" ? { host: h.host } : {}),
  };
}

function parseEvent(line: string, lineNumber: number): CastEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new CastFormatError(`line ${lineNumber} is not a JSON event`);
  }
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw new CastFormatError(`line ${lineNumber} is not a [time, kind, data] event`);
  }

  const [at, kind, data] = raw as [unknown, unknown, unknown];
  const stamp = finite(at, `line ${lineNumber} timestamp`);

  if (kind === "o") {
    if (typeof data !== "string") {
      throw new CastFormatError(`line ${lineNumber} output payload is not a string`);
    }
    try {
      return { at: stamp, kind: "output", bytes: fromB64(data) };
    } catch {
      throw new CastFormatError(`line ${lineNumber} output payload is not base64`);
    }
  }

  if (kind === "r") {
    const match = typeof data === "string" ? /^(\d+)x(\d+)$/.exec(data) : null;
    if (!match) {
      throw new CastFormatError(`line ${lineNumber} resize payload is not "COLSxROWS"`);
    }
    return { at: stamp, kind: "resize", cols: Number(match[1]), rows: Number(match[2]) };
  }

  throw new CastFormatError(`line ${lineNumber} has an unknown event kind ${String(kind)}`);
}

function finite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CastFormatError(`${what} is not a number`);
  }
  return value;
}

function positiveInt(value: unknown, what: string): number {
  const n = finite(value, what);
  if (!Number.isInteger(n) || n <= 0) throw new CastFormatError(`${what} is not a positive integer`);
  return n;
}

/* ------------------------------------------------------------ timing model */

/**
 * The terminal's state at a point in time, as the bytes that produced it.
 *
 * Seeking in a terminal recording is not seeking in a video: frame 900 is not
 * self-contained, it is the sum of every byte before it. `alternate screen on`
 * at second two decides what second sixty looks like. So a seek means resetting
 * the emulator and replaying everything up to the target — which is fast, since
 * it is one write of a few megabytes at most, but it is the only correct way to
 * do it. Anything cleverer would render a screen the session never showed.
 */
export interface CastFrame {
  cols: number;
  rows: number;
  /** Every output byte at or before the requested time, concatenated. */
  data: Uint8Array;
  /** Index of the first event after the requested time. */
  next: number;
}

export function frameAt(cast: Cast, atMs: number): CastFrame {
  let cols = cast.header.cols;
  let rows = cast.header.rows;
  let total = 0;
  let next = cast.events.length;

  for (let i = 0; i < cast.events.length; i++) {
    const event = cast.events[i];
    if (event.at > atMs) {
      next = i;
      break;
    }
    if (event.kind === "output") total += event.bytes.length;
    else {
      cols = event.cols;
      rows = event.rows;
    }
  }

  const data = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < next; i++) {
    const event = cast.events[i];
    if (event.kind !== "output") continue;
    data.set(event.bytes, offset);
    offset += event.bytes.length;
  }

  return { cols, rows, data, next };
}

/**
 * The events between where playback got to and where the clock is now.
 *
 * `from` is an index rather than a timestamp so that an event landing exactly on
 * a frame boundary is emitted once, not once per frame and not never. Playback
 * keeps the index; the clock only decides how far it advances.
 */
export function eventsUpTo(
  cast: Cast,
  from: number,
  atMs: number,
): { events: CastEvent[]; next: number } {
  let next = from;
  while (next < cast.events.length && cast.events[next].at <= atMs) next++;
  return { events: cast.events.slice(from, next), next };
}

/**
 * How long the seek bar is. The header's duration wins when it is longer, which
 * is how trailing idle time survives — but a recording whose events run past its
 * recorded duration is trusted over its own header rather than truncated.
 */
export function castEnd(cast: Cast): number {
  const last = cast.events.length > 0 ? cast.events[cast.events.length - 1].at : 0;
  return Math.max(cast.header.durationMs, last);
}

/* ------------------------------------------------------------------ export */

/**
 * Converts to asciinema's v2 cast, for playing a recording in another tool.
 *
 * This is the lossy direction and the only one. Output is decoded as UTF-8 with
 * a streaming decoder, so a multi-byte character split across two chunks is put
 * back together — but a byte that is not valid UTF-8 becomes U+FFFD, because the
 * asciinema format has nowhere else for it to go. For an ordinary shell session
 * that changes nothing; for a session that printed binary it changes those
 * bytes, and the UI offering this download says so rather than implying the two
 * files are interchangeable.
 */
export function toAsciicast(cast: Cast): string {
  const header = {
    version: 2,
    width: cast.header.cols,
    height: cast.header.rows,
    timestamp: Math.floor(cast.header.startedAt / 1000),
    duration: castEnd(cast) / 1000,
    ...(cast.header.label ? { title: cast.header.label } : {}),
  };

  const decoder = new TextDecoder("utf-8");
  const lines = [JSON.stringify(header)];

  for (const event of cast.events) {
    const seconds = event.at / 1000;
    if (event.kind === "output") {
      lines.push(JSON.stringify([seconds, "o", decoder.decode(event.bytes, { stream: true })]));
    } else {
      lines.push(JSON.stringify([seconds, "r", `${event.cols}x${event.rows}`]));
    }
  }

  // Flush whatever the decoder was holding for a continuation that never came.
  const tail = decoder.decode();
  if (tail) lines.push(JSON.stringify([castEnd(cast) / 1000, "o", tail]));

  return `${lines.join("\n")}\n`;
}
