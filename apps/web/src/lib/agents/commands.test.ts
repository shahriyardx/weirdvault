import { afterEach, describe, expect, test } from "bun:test"
import { verify } from "node:crypto"
import { createPublicKey } from "node:crypto"

import { accountRef, commandMessage, commandPublicKey, signCommand } from "./commands"

/**
 * The signing side of the boundary.
 *
 * The Go verifier pins a signature this module produced
 * (`TestAcceptsACommandTheControlPlaneSigned` in apps/agent/command_test.go).
 * What is checked here is what Go cannot see: that the message is assembled
 * from the right parts in the right order, that a signature is produced at all
 * only when a key is configured, and that the account reference gives nothing
 * away.
 */

const FIXTURE_SEED = "d2VpcmR2YXVsdC1jb21tYW5kLWZpeHR1cmUtc2VlZCE="
const FIXTURE_PUBLIC = "i8F5CETyflP5XizQUQbK63EOJ8qVZr35FOzEzLmy05Y="

const saved = process.env.AGENT_COMMAND_SECRET
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_COMMAND_SECRET
  else process.env.AGENT_COMMAND_SECRET = saved
})

describe("commandMessage", () => {
  test("is the exact text the agent rebuilds", () => {
    // Byte for byte against apps/agent/command.go's signingMessageFor. A
    // mismatch here is a fleet that refuses every command.
    expect(
      commandMessage("agent-fixture", "restart", "bm9uY2UtZml4dHVyZQ==", 1900000000).toString(),
    ).toBe("weirdvault-command-v1\nagent-fixture\nrestart\nbm9uY2UtZml4dHVyZQ==\n1900000000")
  })

  test("is domain-separated and carries the agent id", () => {
    const message = commandMessage("a", "stop", "n", 1).toString()
    expect(message.startsWith("weirdvault-command-v1\n")).toBe(true)
    expect(message.split("\n")[1]).toBe("a")
  })
})

describe("the signing key", () => {
  test("derives the public half the agents are enrolled with", () => {
    process.env.AGENT_COMMAND_SECRET = FIXTURE_SEED
    expect(commandPublicKey()).toBe(FIXTURE_PUBLIC)
  })

  test("is absent when the deployment has not configured one", () => {
    delete process.env.AGENT_COMMAND_SECRET
    expect(commandPublicKey()).toBeNull()
    // And nothing is signed, so no unsigned command can ever be dispatched.
    expect(signCommand("agent-1", "restart")).toBeNull()
  })

  test("refuses a key of the wrong length rather than signing with it", () => {
    process.env.AGENT_COMMAND_SECRET = Buffer.from("too short").toString("base64")
    expect(commandPublicKey()).toBeNull()
    expect(signCommand("agent-1", "restart")).toBeNull()
  })
})

describe("signCommand", () => {
  test("produces a signature the public key verifies", () => {
    process.env.AGENT_COMMAND_SECRET = FIXTURE_SEED

    const signed = signCommand("agent-1", "upgrade")
    if (!signed) throw new Error("expected a signed command")

    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(FIXTURE_PUBLIC, "base64"),
      ]),
      format: "der",
      type: "spki",
    })

    const message = commandMessage("agent-1", signed.command, signed.nonce, signed.expiresAt)
    expect(verify(null, message, publicKey, Buffer.from(signed.signature, "base64"))).toBe(true)
  })

  test("expires within the minute and never repeats a nonce", () => {
    process.env.AGENT_COMMAND_SECRET = FIXTURE_SEED

    const now = Math.floor(Date.now() / 1000)
    const a = signCommand("agent-1", "restart")
    const b = signCommand("agent-1", "restart")

    expect(a?.expiresAt).toBeGreaterThan(now)
    expect((a?.expiresAt ?? 0) - now).toBeLessThanOrEqual(60)
    // A repeated nonce would be refused by the agent as a replay, turning every
    // second command into a failure.
    expect(a?.nonce).not.toBe(b?.nonce)
  })
})

describe("accountRef", () => {
  test("is stable for one account and different for another", () => {
    process.env.AGENT_COMMAND_SECRET = FIXTURE_SEED
    expect(accountRef("user-1")).toBe(accountRef("user-1"))
    expect(accountRef("user-1")).not.toBe(accountRef("user-2"))
  })

  test("does not contain the account id", () => {
    // It is written into a file everyone on a shared machine can read. It should
    // say "not yours" and nothing else.
    process.env.AGENT_COMMAND_SECRET = FIXTURE_SEED
    expect(accountRef("user-1")).not.toContain("user-1")
  })

  test("still works when no signing key is configured", () => {
    // The duplicate-enrolment check should not depend on remote control being
    // turned on.
    delete process.env.AGENT_COMMAND_SECRET
    expect(accountRef("user-1").length).toBeGreaterThan(0)
  })
})
