import { describe, expect, test } from "bun:test";

import { encodeQr, formatBits, maskAt, QrTooLongError } from "./qr";

/**
 * What these tests can and cannot establish.
 *
 * There is no scanner in this environment and no reference encoder to diff
 * against, so "it scans" is not testable here. What is testable is everything
 * between the input string and the matrix, and that is what is checked:
 *
 *  - The BCH format strings are compared against the table printed in
 *    ISO/IEC 18004. That table is an external source of truth, and it is the
 *    only one available to this file.
 *  - The Reed-Solomon remainder is checked against the *definition* of the code
 *    rather than against the encoder: a valid codeword evaluates to zero at the
 *    first `n` powers of the field's generator. That syndrome check is written
 *    independently below and would fail on a wrong divisor polynomial, a wrong
 *    field, or a division that dropped a term.
 *  - The matrix is decoded back to the original string, through the mask read
 *    out of the format area, the zigzag placement and the block interleave.
 *
 * The gap, stated because it is real: the decoder below shares the encoder's
 * understanding of *where* the function patterns sit. A placement mistake both
 * halves make identically would round-trip cleanly and still not scan. The
 * structural assertions in the last block narrow that — finder patterns, timing
 * rows, the always-dark module and the module count are checked against the
 * standard's coordinates directly — but they do not close it.
 */

/* --------------------------------------------------------- format strings */

/**
 * Table C.1 of ISO/IEC 18004, the eight entries for error correction level M.
 * Copied from the standard, not produced by this implementation.
 */
const PUBLISHED_FORMAT_STRINGS_M = [
  "101010000010010",
  "101000100100101",
  "101111001111100",
  "101101101001011",
  "100010111111001",
  "100000011001110",
  "100111110010111",
  "100101010100000",
];

describe("format information", () => {
  test("matches the table published in the standard", () => {
    for (let mask = 0; mask < 8; mask++) {
      const bits = formatBits(mask).toString(2).padStart(15, "0");
      expect(bits).toBe(PUBLISHED_FORMAT_STRINGS_M[mask]);
    }
  });

  test("every pair differs in at least three bits", () => {
    // The BCH(15,5) code has minimum distance 7; three is a weak floor that
    // nonetheless fails immediately if the parity loop is wrong.
    for (let a = 0; a < 8; a++) {
      for (let b = a + 1; b < 8; b++) {
        const diff = formatBits(a) ^ formatBits(b);
        expect(diff.toString(2).replace(/0/g, "").length).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

/* ------------------------------------------------------ Reed-Solomon check */

const EXP: number[] = [];
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP.push(x);
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
}

/** Schoolbook multiply in GF(256), written without the encoder's log tables. */
function mul(a: number, b: number): number {
  let result = 0;
  for (let i = 0; i < 8; i++) {
    if ((b >> i) & 1) result ^= a << i;
  }
  for (let i = 14; i >= 8; i--) {
    if ((result >> i) & 1) result ^= 0x11d << (i - 8);
  }
  return result & 0xff;
}

/**
 * A block is a valid Reed-Solomon codeword when it evaluates to zero at r^0 …
 * r^(n-1). This is the definition, so it is an independent check on the
 * encoder's divisor polynomial and its division loop.
 */
function syndromesAreZero(block: number[], eccLen: number): boolean {
  for (let i = 0; i < eccLen; i++) {
    let sum = 0;
    for (const coefficient of block) sum = mul(sum, EXP[i]) ^ coefficient;
    if (sum !== 0) return false;
  }
  return true;
}

/* ---------------------------------------------------------------- decoding */

const ECC_PER_BLOCK_M = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

function rawCodewords(version: number): number {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    modules -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) modules -= 36;
  }
  return Math.floor(modules / 8);
}

function alignmentCentres(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** Which modules carry no data, per the standard's layout. */
function functionMap(version: number, size: number): boolean[][] {
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (r: number, c: number) => {
    if (r >= 0 && r < size && c >= 0 && c < size) fixed[r][c] = true;
  };

  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [cr, cc] of [
    [3, 3],
    [3, size - 4],
    [size - 4, 3],
  ]) {
    for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) mark(cr + dr, cc + dc);
  }
  const centres = alignmentCentres(version, size);
  for (let i = 0; i < centres.length; i++) {
    for (let j = 0; j < centres.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === centres.length - 1) ||
        (i === centres.length - 1 && j === 0);
      if (corner) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(centres[i] + dr, centres[j] + dc);
    }
  }
  // Format areas, both copies, and the always-dark module.
  for (let i = 0; i < 9; i++) {
    mark(i, 8);
    mark(8, i);
  }
  for (let i = 0; i < 8; i++) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(b, a);
      mark(a, b);
    }
  }
  return fixed;
}

/** Reads a matrix back to the string it was built from. Throws if it cannot. */
function decodeQr(code: ReturnType<typeof encodeQr>): string {
  const { size, version, modules } = code;

  // The mask lives in the first copy of the format string.
  let raw = 0;
  for (let i = 0; i <= 5; i++) raw |= (modules[i][8] ? 1 : 0) << i;
  raw |= (modules[7][8] ? 1 : 0) << 6;
  raw |= (modules[8][8] ? 1 : 0) << 7;
  raw |= (modules[8][7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i++) raw |= (modules[8][14 - i] ? 1 : 0) << i;
  const descriptor = (raw ^ 0x5412) >>> 10;
  expect(descriptor >> 3).toBe(0b00); // level M, or this is not our code
  const mask = descriptor & 7;

  const fixed = functionMap(version, size);
  const total = rawCodewords(version);
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (fixed[row][col] || bits.length >= total * 8) continue;
        const dark = modules[row][col] !== maskAt(mask, row, col);
        bits.push(dark ? 1 : 0);
      }
    }
  }

  const interleaved: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    interleaved.push(byte);
  }

  // Undo the interleave: rebuild each block, then check its syndromes.
  const numBlocks = BLOCKS_M[version - 1];
  const eccLen = ECC_PER_BLOCK_M[version - 1];
  const shortLen = Math.floor(total / numBlocks);
  const numShort = numBlocks - (total % numBlocks);
  const blocks: number[][] = Array.from({ length: numBlocks }, () => []);
  let cursor = 0;
  for (let i = 0; i < shortLen + 1; i++) {
    for (let j = 0; j < numBlocks; j++) {
      // Short blocks carry a placeholder at this index so the encoder's
      // column-major read stays rectangular; it is not in the stream.
      if (i === shortLen - eccLen && j < numShort) continue;
      blocks[j].push(interleaved[cursor++]);
    }
  }
  for (const block of blocks) {
    if (!syndromesAreZero(block, eccLen)) throw new Error("block is not a valid RS codeword");
  }

  const data: number[] = [];
  for (const block of blocks) data.push(...block.slice(0, block.length - eccLen));

  let bit = 0;
  const take = (width: number) => {
    let value = 0;
    for (let i = 0; i < width; i++, bit++) {
      value = (value << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    return value;
  };
  expect(take(4)).toBe(0b0100); // byte mode
  const length = take(version < 10 ? 8 : 16);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = take(8);
  return new TextDecoder().decode(bytes);
}

/* ------------------------------------------------------------------ tests */

describe("encodeQr", () => {
  const cases = [
    "a",
    "otpauth://totp/webxterm:ada@example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEH&issuer=webxterm",
    "otpauth://totp/webxterm:a-really-quite-long-address@some-organisation.example?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=webxterm",
    "x".repeat(1),
    "x".repeat(14), // the exact capacity of version 1
    "x".repeat(15), // one over, so version 2
    "x".repeat(106),
    "x".repeat(107), // crosses into version 7, where version information appears
    "x".repeat(213), // the exact capacity of version 10
  ];

  for (const value of cases) {
    test(`round-trips ${value.length} bytes`, () => {
      expect(decodeQr(encodeQr(value))).toBe(value);
    });
  }

  test("multi-byte characters are counted in bytes, not characters", () => {
    const value = "webxterm — ünïcode ✓";
    expect(decodeQr(encodeQr(value))).toBe(value);
  });

  test("picks the smallest version that fits", () => {
    expect(encodeQr("x".repeat(14)).version).toBe(1);
    expect(encodeQr("x".repeat(15)).version).toBe(2);
    expect(encodeQr("x".repeat(213)).version).toBe(10);
  });

  test("refuses rather than truncating", () => {
    // A truncated QR scans perfectly and enrols an authenticator whose codes
    // never match. Throwing is the only acceptable answer.
    expect(() => encodeQr("x".repeat(214))).toThrow(QrTooLongError);
  });
});

describe("matrix structure", () => {
  const code = encodeQr("otpauth://totp/webxterm:ada@example.com?secret=JBSWY3DPEHPK3PXP");
  const { size, modules } = code;

  test("is square and sized to its version", () => {
    expect(size).toBe(code.version * 4 + 17);
    expect(modules.length).toBe(size);
    for (const row of modules) expect(row.length).toBe(size);
  });

  test("has three finder patterns with their separators", () => {
    for (const [cr, cc] of [
      [3, 3],
      [3, size - 4],
      [size - 4, 3],
    ]) {
      for (let dr = -4; dr <= 4; dr++) {
        for (let dc = -4; dc <= 4; dc++) {
          const r = cr + dr;
          const c = cc + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          expect(modules[r][c]).toBe(ring !== 2 && ring !== 4);
        }
      }
    }
  });

  test("has alternating timing patterns between the finders", () => {
    for (let i = 8; i < size - 8; i++) {
      expect(modules[6][i]).toBe(i % 2 === 0);
      expect(modules[i][6]).toBe(i % 2 === 0);
    }
  });

  test("has the module that is always dark", () => {
    expect(modules[size - 8][8]).toBe(true);
  });
});
