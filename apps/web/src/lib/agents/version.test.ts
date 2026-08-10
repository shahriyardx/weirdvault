import { describe, expect, test } from "bun:test"

import { agentNeedsUpdate } from "./version"

/**
 * The badge rule.
 *
 * Each "no" below is a case where the honest answer is silence, and the cost of
 * getting it wrong is the same every time: a user follows instructions that
 * cannot work, watches nothing happen, and stops believing the next thing this
 * screen tells them.
 */
describe("agentNeedsUpdate", () => {
  test("a machine running something else needs an update", () => {
    expect(agentNeedsUpdate("dev", "v1.1.0")).toBe(true)
    expect(agentNeedsUpdate("v1.0.0", "v1.1.0")).toBe(true)
  })

  test("a machine running the published build does not", () => {
    expect(agentNeedsUpdate("v1.1.0", "v1.1.0")).toBe(false)
  })

  test("silence when the machine has not said what it runs", () => {
    // Enrolled before versions were reported on reconnect, so the column holds
    // whatever it was installed with — or nothing at all.
    expect(agentNeedsUpdate(null, "v1.1.0")).toBe(false)
    expect(agentNeedsUpdate(undefined, "v1.1.0")).toBe(false)
    expect(agentNeedsUpdate("", "v1.1.0")).toBe(false)
  })

  test("silence when this deployment publishes nothing", () => {
    expect(agentNeedsUpdate("v1.0.0", null)).toBe(false)
    expect(agentNeedsUpdate("v1.0.0", undefined)).toBe(false)
  })

  test("silence when the published build is the unversioned default", () => {
    // AGENT_VERSION unset publishes "dev", and an agent only replaces itself
    // when the manifest differs from its own version. Offering an update here
    // would be offering one no machine can take: "dev" never differs from
    // "dev", and a machine on a real version that took it would be moving
    // backwards onto an unversioned build.
    expect(agentNeedsUpdate("dev", "dev")).toBe(false)
    expect(agentNeedsUpdate("v1.0.0", "dev")).toBe(false)
  })
})
