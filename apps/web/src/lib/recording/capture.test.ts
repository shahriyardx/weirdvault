import { describe, expect, test } from "bun:test";

import { CastBuffer } from "./capture";
import { MAX_CAPTURE_BYTES } from "./limits";
import {
  CastFormatError,
  castEnd,
  decodeCast,
  encodeCast,
  eventsUpTo,
  frameAt,
  toAsciicast,
  type Cast,
  type CastEvent,
} from "./format";

/**
 * These tests cover the two parts of recording that have to be exactly right
 * and can be checked without a browser: the file a recording is stored as, and
 * the arithmetic that decides what is on screen at a given moment.
 *
 * The bias throughout is towards the ways a transcript could lie. A byte that
 * does not survive the round trip, an event replayed twice, a seek that lands
 * on a screen the session never showed — each of those produces a recording
 * that looks fine and is wrong, which is worse than one that fails to open.
 */

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (s: string) => new TextEncoder().encode(s);

function cast(events: CastEvent[], durationMs = 0): Cast {
  return {
    header: {
      v: 1,
      cols: 80,
      rows: 24,
      startedAt: 1_700_000_000_000,
      durationMs,
      label: "web@example",
      host: "web@example.com:22",
    },
    events,
  };
}

describe("cast round trip", () => {
  test("survives every byte value, not just printable text", () => {
    // The reason payloads are base64 rather than strings. A terminal stream is
    // not guaranteed to be UTF-8, and a format that decodes it would rewrite
    // these bytes into replacement characters and call the result a transcript.
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;

    const decoded = decodeCast(encodeCast(cast([{ at: 12, kind: "output", bytes: all }])));

    expect(decoded.events).toHaveLength(1);
    const event = decoded.events[0];
    expect(event.kind).toBe("output");
    if (event.kind !== "output") throw new Error("unreachable");
    expect([...event.bytes]).toEqual([...all]);
  });

  test("keeps the header, the timings and the resizes", () => {
    const original = cast(
      [
        { at: 0, kind: "output", bytes: text("$ ") },
        { at: 1500, kind: "resize", cols: 132, rows: 43 },
        { at: 1600, kind: "output", bytes: text("hello\r\n") },
      ],
      9000,
    );

    const decoded = decodeCast(encodeCast(original));

    expect(decoded.header).toEqual(original.header);
    expect(decoded.events).toEqual(original.events);
  });

  test("a recording with no output is still a valid recording", () => {
    const decoded = decodeCast(encodeCast(cast([], 4000)));
    expect(decoded.events).toEqual([]);
    expect(castEnd(decoded)).toBe(4000);
  });

  test("refuses what it cannot read rather than dropping it", () => {
    // A decoder that skipped bad lines would return a transcript with holes and
    // no way to know. Every one of these is a hole.
    const good = encodeCast(cast([{ at: 1, kind: "output", bytes: text("x") }]));

    expect(() => decodeCast("")).toThrow(CastFormatError);
    expect(() => decodeCast('{"v":99,"cols":80,"rows":24,"startedAt":0,"durationMs":0}')).toThrow(
      /v1/,
    );
    expect(() => decodeCast(`${good}[1,"z","x"]\n`)).toThrow(/unknown event kind/);
    expect(() => decodeCast(`${good}not json\n`)).toThrow(CastFormatError);
    expect(() => decodeCast(`${good}[1,"r","wide"]\n`)).toThrow(/COLSxROWS/);
    expect(() =>
      decodeCast('{"v":1,"cols":0,"rows":24,"startedAt":0,"durationMs":0}'),
    ).toThrow(/cols/);
  });

  test("blank lines are the one thing skipped", () => {
    const decoded = decodeCast(
      `${encodeCast(cast([{ at: 1, kind: "output", bytes: text("x") }]))}\n\n`,
    );
    expect(decoded.events).toHaveLength(1);
  });

  test("the asciinema export is the lossy direction, and only there", () => {
    // A three-byte character split across two chunks has to come back out whole,
    // which is what the streaming decoder is for.
    const euro = text("€");
    const exported = toAsciicast(
      cast([
        { at: 0, kind: "output", bytes: euro.slice(0, 1) },
        { at: 10, kind: "output", bytes: euro.slice(1) },
        { at: 20, kind: "resize", cols: 100, rows: 30 },
      ]),
    );

    const lines = exported.trim().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({ version: 2, width: 80, height: 24 });
    // Seconds, not milliseconds, because that is what asciinema reads.
    expect(JSON.parse(lines[3])).toEqual([0.02, "r", "100x30"]);
    expect(lines.map((l) => JSON.parse(l)[2]).join("")).toContain("€");
  });
});

describe("timing model", () => {
  const events: CastEvent[] = [
    { at: 0, kind: "output", bytes: text("a") },
    { at: 100, kind: "output", bytes: text("b") },
    { at: 100, kind: "resize", cols: 120, rows: 40 },
    { at: 250, kind: "output", bytes: text("c") },
    { at: 900, kind: "output", bytes: text("d") },
  ];
  const recording = cast(events, 1200);

  test("a seek is the sum of everything before it, not a slice", () => {
    // The property that makes seeking correct: the emulator is reset and fed
    // every byte up to the target, because byte 900 means nothing without them.
    expect(new TextDecoder().decode(frameAt(recording, 300).data)).toBe("abc");
    expect(new TextDecoder().decode(frameAt(recording, 0).data)).toBe("a");
    expect(new TextDecoder().decode(frameAt(recording, 99).data)).toBe("a");
    expect(new TextDecoder().decode(frameAt(recording, 10_000).data)).toBe("abcd");
  });

  test("a seek restores the geometry of that moment", () => {
    expect(frameAt(recording, 99)).toMatchObject({ cols: 80, rows: 24 });
    expect(frameAt(recording, 100)).toMatchObject({ cols: 120, rows: 40 });
    expect(frameAt(recording, 5000)).toMatchObject({ cols: 120, rows: 40 });
  });

  test("an event on the boundary belongs to the frame that reaches it", () => {
    // Off by one in either direction is a real bug: exclusive at both ends
    // drops the event forever, inclusive at both replays it every frame.
    const first = eventsUpTo(recording, 0, 100);
    expect(first.events).toHaveLength(3);
    expect(eventsUpTo(recording, first.next, 100).events).toHaveLength(0);
  });

  test("playback emits every event exactly once, in order", () => {
    const seen: CastEvent[] = [];
    let index = 0;
    for (let playhead = 0; playhead <= castEnd(recording); playhead += 16) {
      const step = eventsUpTo(recording, index, playhead);
      seen.push(...step.events);
      index = step.next;
    }
    expect(seen).toEqual(events);
  });

  test("speed scales the clock, not the stream", () => {
    // Twice the speed means the same events out of half as many frames — and
    // the same events, in the same order, with none dropped.
    const run = (speed: number) => {
      const seen: CastEvent[] = [];
      let index = 0;
      let playhead = 0;
      let frames = 0;
      while (playhead < castEnd(recording)) {
        playhead += 16 * speed;
        frames++;
        const step = eventsUpTo(recording, index, playhead);
        seen.push(...step.events);
        index = step.next;
      }
      return { seen, frames };
    };

    const single = run(1);
    const double = run(2);
    expect(double.seen).toEqual(single.seen);
    expect(double.frames).toBe(Math.ceil(single.frames / 2));
  });

  test("trailing idle time is part of the recording", () => {
    // A session left sitting at a prompt for a minute before stopping is a
    // minute long. Ending the seek bar at the last byte would make the recording
    // claim it stopped when the output did.
    expect(castEnd(recording)).toBe(1200);
    // ...but events that run past the stated duration are trusted over it.
    expect(castEnd(cast(events, 10))).toBe(900);
  });
});

describe("the capture buffer", () => {
  test("keeps what it is given, with monotonic timestamps", () => {
    const buffer = new CastBuffer(100, 30, 1_700_000_000_000);
    buffer.output(10, text("one"));
    // A clock that went backwards would replay part of the session twice.
    buffer.output(5, text("two"));

    const built = buffer.toCast({ durationMs: 50 });
    expect(built.events.map((e) => e.at)).toEqual([10, 10]);
    expect(built.header).toMatchObject({ cols: 100, rows: 30, startedAt: 1_700_000_000_000 });
  });

  test("the header carries the starting geometry, not the final one", () => {
    // Playback sets the emulator up from the header and then replays the
    // resizes. Storing the final size would render the first half at the wrong
    // width, which is every box-drawing character in it.
    const buffer = new CastBuffer(80, 24);
    buffer.output(0, text("before"));
    buffer.resize(100, 132, 43);
    buffer.output(200, text("after"));

    const built = buffer.toCast({ durationMs: 300 });
    expect(built.header).toMatchObject({ cols: 80, rows: 24 });
    expect(built.events[1]).toEqual({ at: 100, kind: "resize", cols: 132, rows: 43 });
  });

  test("a resize to the size it already is is not an event", () => {
    const buffer = new CastBuffer(80, 24);
    buffer.resize(10, 80, 24);
    buffer.resize(20, 80, 25);
    buffer.resize(30, 80, 25);
    expect(buffer.eventCount).toBe(1);
  });

  test("duration is at least as long as the last event", () => {
    const buffer = new CastBuffer(80, 24);
    buffer.output(5000, text("late"));
    expect(buffer.toCast({ durationMs: 0 }).header.durationMs).toBe(5000);
  });

  test("the cap drops the chunk that would cross it, whole", () => {
    // Truncating mid-chunk can cut an escape sequence in half, and half an
    // escape sequence does not render as slightly less output — it renders as
    // everything after it being wrong.
    const buffer = new CastBuffer(80, 24);
    const chunk = new Uint8Array(1024 * 1024);
    for (let i = 0; i < MAX_CAPTURE_BYTES / chunk.length; i++) {
      expect(buffer.output(i, chunk)).toBe(true);
    }

    expect(buffer.bytes).toBe(MAX_CAPTURE_BYTES);
    expect(buffer.isFull).toBe(false);

    expect(buffer.output(9999, bytes(1, 2, 3))).toBe(false);
    expect(buffer.isFull).toBe(true);
    expect(buffer.bytes).toBe(MAX_CAPTURE_BYTES);
  });

  test("nothing is recorded after the cap, including resizes", () => {
    // The UI reads isFull to stop claiming to record. Anything that slipped in
    // after it would be a transcript with a gap in the middle of it.
    const buffer = new CastBuffer(80, 24);
    buffer.output(0, new Uint8Array(MAX_CAPTURE_BYTES));
    expect(buffer.output(1, bytes(65))).toBe(false);

    const after = buffer.eventCount;
    buffer.resize(2, 200, 60);
    buffer.output(3, bytes(66));
    expect(buffer.eventCount).toBe(after);
  });

  test("an empty chunk is not an event", () => {
    const buffer = new CastBuffer(80, 24);
    expect(buffer.output(0, new Uint8Array(0))).toBe(false);
    expect(buffer.eventCount).toBe(0);
    expect(buffer.isFull).toBe(false);
  });

  test("what it produces is what the decoder reads back", () => {
    const buffer = new CastBuffer(90, 30);
    buffer.output(0, text("$ ls\r\n"));
    buffer.resize(40, 100, 30);
    buffer.output(80, bytes(0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xff));

    const built = buffer.toCast({ durationMs: 500, label: "web@host", host: "web@host:22" });
    expect(decodeCast(encodeCast(built))).toEqual(built);
  });
});
