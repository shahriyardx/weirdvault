import { describe, expect, test } from "bun:test"

import {
  formatRecoveryCode,
  isPlausibleRecoveryCode,
  normaliseRecoveryCode,
  recoveryCodeId,
} from "./recovery"

/**
 * A recovery code is typed by someone who has just lost access to their account
 * and is reading characters off a printout. Every one of these tests is a way
 * that transcription realistically goes wrong; getting any of them wrong turns a
 * working code into "that did not open anything", which is indistinguishable
 * from a genuinely wrong code by design and therefore impossible to debug from
 * the outside.
 *
 * The crypto itself is not tested here — it is WebCrypto and Argon2id doing
 * exactly what they are documented to do. What is tested is the layer between a
 * human and that crypto.
 */

const CODE = "0123456789ABCDEFGHJKMNPQ"

describe("code normalisation", () => {
  test("dashes, spaces and case carry no information", () => {
    for (const typed of [
      CODE,
      CODE.toLowerCase(),
      formatRecoveryCode(CODE),
      formatRecoveryCode(CODE).replace(/-/g, " "),
      `  ${formatRecoveryCode(CODE)}  `,
    ]) {
      expect(normaliseRecoveryCode(typed)).toBe(CODE)
    }
  })

  test("the confusable letters fold onto the digits they are mistaken for", () => {
    // Crockford's alphabet has no I, L, O or U, so any of them in the input is a
    // transcription error with exactly one sensible reading.
    expect(normaliseRecoveryCode("I")).toBe("1")
    expect(normaliseRecoveryCode("l")).toBe("1")
    expect(normaliseRecoveryCode("O")).toBe("0")
    expect(normaliseRecoveryCode("o")).toBe("0")
  })

  test("characters outside the alphabet are dropped, not kept", () => {
    // U is deliberately absent from the alphabet and has no digit to fold onto.
    expect(normaliseRecoveryCode("U")).toBe("")
    expect(normaliseRecoveryCode("!@#$%")).toBe("")
  })

  test("only a full-length code is offered to the server", () => {
    expect(isPlausibleRecoveryCode(formatRecoveryCode(CODE))).toBe(true)
    expect(isPlausibleRecoveryCode(CODE.slice(0, 23))).toBe(false)
    expect(isPlausibleRecoveryCode(`${CODE}A`)).toBe(false)
    expect(isPlausibleRecoveryCode("")).toBe(false)
  })
})

describe("display grouping", () => {
  test("groups of four, and normalising undoes it exactly", () => {
    const shown = formatRecoveryCode(CODE)
    expect(shown).toBe("0123-4567-89AB-CDEF-GHJK-MNPQ")
    expect(normaliseRecoveryCode(shown)).toBe(CODE)
  })
})

describe("envelope selector", () => {
  test("is stable across every spelling of the same code", async () => {
    const canonical = await recoveryCodeId(CODE)
    for (const typed of [
      formatRecoveryCode(CODE),
      CODE.toLowerCase(),
      `${formatRecoveryCode(CODE)} `,
    ]) {
      expect(await recoveryCodeId(typed)).toBe(canonical)
    }
  })

  test("differs for a different code, and is the shape the API validates", async () => {
    const a = await recoveryCodeId(CODE)
    const b = await recoveryCodeId(`${CODE.slice(0, 23)}R`)
    expect(a).not.toBe(b)
    // /api/recovery rejects anything that is not exactly this, and answers a
    // malformed id with a decoy rather than an error.
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })
})
