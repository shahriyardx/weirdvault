/**
 * The relay-to-control-plane wire contract, from the receiving side.
 *
 * Nothing compiles both halves of this. The relay is Rust and encodes the batch
 * by hand in `encode_batch`; this side validates it in TypeScript. The failure
 * that matters is silent in both directions: the route ignores keys it does not
 * recognise, so a rename on either side produces batches that are accepted, add
 * up to nothing, and leave the allowance unenforced while the meter reads zero.
 * Neither `cargo test` nor `bun test` would notice on its own.
 *
 * So this test asserts two things. First, that the validator accepts exactly the
 * JSON the relay's own test says it emits — the field names in the object below
 * are copied from `encodes_the_field_names_the_ingest_endpoint_reads` in
 * apps/relay/src/reporter.rs, and the two tests reference each other. Second,
 * that the relay's source still spells those names, which is crude but is the
 * only check available across a language boundary without running both.
 *
 * The second assertion proves less than it looks: it proves the string appears,
 * not that it is used. It is a tripwire for a rename, not a proof of agreement.
 */

import { describe, expect, test } from "bun:test";

import {
  isAnonymousSubject,
  isRelayUsageEntry,
  MAX_BYTES_PER_ENTRY,
  MAX_ENTRIES_PER_BATCH,
  formatBytes,
  usagePercent,
  usageState,
  type RelayUsage,
} from "./usage";

const REPORTER_RS = new URL("../../../relay/src/reporter.rs", import.meta.url).pathname;

/** A batch exactly as apps/relay/src/reporter.rs encodes one. */
const RELAY_BATCH = {
  entries: [
    { subject: "u1", bytesUp: 120, bytesDown: 340 },
    {
      subject: "anon:11111111-2222-3333-4444-555555555555",
      bytesUp: 1,
      bytesDown: 2,
    },
  ],
};

describe("the batch the relay actually sends", () => {
  test("every entry passes the validator", () => {
    for (const entry of RELAY_BATCH.entries) {
      expect(isRelayUsageEntry(entry)).toBe(true);
    }
  });

  test("the anonymous entry is recognised and will be dropped", () => {
    expect(isAnonymousSubject(RELAY_BATCH.entries[1].subject)).toBe(true);
    expect(isAnonymousSubject(RELAY_BATCH.entries[0].subject)).toBe(false);
  });

  test("the relay still spells the field names this validator reads", async () => {
    const source = await Bun.file(REPORTER_RS).text();
    for (const field of ["subject", "bytesUp", "bytesDown", "entries"]) {
      expect(source, `apps/relay/src/reporter.rs no longer mentions "${field}"`).toContain(
        `"${field}"`,
      );
    }
  });

  test("the batch ceiling matches the relay's chunk size", async () => {
    const source = await Bun.file(REPORTER_RS).text();
    const declared = source.match(/MAX_ENTRIES_PER_BATCH: usize = (\d+)/);
    expect(declared).not.toBeNull();
    // If the relay ever chunks larger than this route accepts, every batch
    // comes back 413 and the bytes are discarded rather than retried.
    expect(Number(declared![1])).toBeLessThanOrEqual(MAX_ENTRIES_PER_BATCH);
  });
});

describe("what the validator refuses", () => {
  test("anything that is not a well-formed entry", () => {
    expect(isRelayUsageEntry(null)).toBe(false);
    expect(isRelayUsageEntry("u1")).toBe(false);
    expect(isRelayUsageEntry({ subject: "u1", bytesUp: 1 })).toBe(false);
    expect(isRelayUsageEntry({ subject: "", bytesUp: 1, bytesDown: 1 })).toBe(false);
  });

  test("numbers that cannot be traffic", () => {
    // Rejected, never clamped: a clamp records a figure nobody sent into a
    // running total nobody can walk back.
    expect(isRelayUsageEntry({ subject: "u1", bytesUp: -1, bytesDown: 0 })).toBe(false);
    expect(isRelayUsageEntry({ subject: "u1", bytesUp: 1.5, bytesDown: 0 })).toBe(false);
    expect(isRelayUsageEntry({ subject: "u1", bytesUp: NaN, bytesDown: 0 })).toBe(false);
    expect(
      isRelayUsageEntry({ subject: "u1", bytesUp: MAX_BYTES_PER_ENTRY + 1, bytesDown: 0 }),
    ).toBe(false);
  });
});

describe("the meter's derivations", () => {
  const usage = (bytesTotal: number, allowanceBytes = 1_000_000_000): RelayUsage => ({
    period: "2026-08",
    resetsAt: "2026-09-01T00:00:00.000Z",
    bytesUp: bytesTotal,
    bytesDown: 0,
    bytesTotal,
    allowanceBytes,
    tier: "Free",
    reportingConfigured: true,
    updatedAt: null,
  });

  test("warns before it refuses, and refuses at the cap", () => {
    expect(usageState(usage(0))).toBe("ok");
    expect(usageState(usage(799_999_999))).toBe("ok");
    expect(usageState(usage(800_000_000))).toBe("approaching");
    // The boundary is the same one /api/relay-token mints on: at the allowance
    // exactly, the next connection is already refused.
    expect(usageState(usage(1_000_000_000))).toBe("over");
    expect(usageState(usage(9_000_000_000))).toBe("over");
  });

  test("the bar never claims a remainder that is gone", () => {
    expect(usagePercent(usage(9_000_000_000))).toBe(100);
  });

  test("decimal units, so the meter and the cap cannot disagree by 7%", () => {
    expect(formatBytes(1_000_000_000)).toBe("1 GB");
    expect(formatBytes(5_000_000_000)).toBe("5 GB");
    expect(formatBytes(512)).toBe("512 B");
  });
});
