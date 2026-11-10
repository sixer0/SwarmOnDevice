import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SETUP_COMPONENT_IDS, SETUP_STATE_MAX_BYTES, readHealthySetupComponents } from "./setup-runner"
import { SETUP_TOOLS_OFFERED_RELEASE } from "./store-keys"

const values = new Map<string, unknown>()
mock.module("./store", () => ({
  getStore: () => ({
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => values.set(key, value),
  }),
}))
mock.module("./logging", () => ({ write: () => {} }))
mock.module("electron", () => ({ app: { getPath: () => tmpdir() } }))

const onboarding = await import("./onboarding")

let home = ""

function writeState(components: Record<string, unknown>) {
  mkdirSync(join(home, ".swarm", "setup"), { recursive: true })
  writeFileSync(join(home, ".swarm", "setup", "state.json"), JSON.stringify({ version: 1, components }))
}

function allHealthy() {
  return Object.fromEntries(SETUP_COMPONENT_IDS.map((id) => [id, { state: "healthy" }]))
}

beforeEach(() => {
  values.clear()
  home = mkdtempSync(join(tmpdir(), "swarm-offer-"))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("setup tools offer", () => {
  test("is pending in 1.2.5 when it was never offered", () => {
    expect(onboarding.SWARM_RELEASE).toBe("1.2.5")
    expect(onboarding.isSetupToolsOfferPending(home)).toBe(true)
  })

  test("is pending when it was offered only in an earlier release", () => {
    values.set(SETUP_TOOLS_OFFERED_RELEASE, "1.0.0")
    writeState({ ...allHealthy(), firecrawl: { state: "failed" } })
    expect(onboarding.isSetupToolsOfferPending(home)).toBe(true)
  })

  test("is not pending once offered in this release, even with nothing installed", () => {
    onboarding.markSetupToolsOffered()
    expect(values.get(SETUP_TOOLS_OFFERED_RELEASE)).toBe("1.2.5")
    expect(onboarding.isSetupToolsOfferPending(home)).toBe(false)
  })

  test("is not pending when all seven components are healthy", () => {
    writeState(allHealthy())
    expect(readHealthySetupComponents(home)).toEqual([...SETUP_COMPONENT_IDS])
    expect(onboarding.isSetupToolsOfferPending(home)).toBe(false)
    expect(values.has(SETUP_TOOLS_OFFERED_RELEASE)).toBe(false)
  })

  test("is pending when six of seven are healthy", () => {
    writeState({ ...allHealthy(), searxng: { state: "skipped" } })
    expect(readHealthySetupComponents(home)).not.toContain("searxng")
    expect(onboarding.isSetupToolsOfferPending(home)).toBe(true)
  })
})

// The reader lives in setup-runner.ts (senior 1); these cases check it through the offer rule onboarding uses.
describe("readHealthySetupComponents", () => {
  test("returns nothing for a missing, malformed or oversized state file", () => {
    expect(readHealthySetupComponents(home)).toEqual([])
    mkdirSync(join(home, ".swarm", "setup"), { recursive: true })
    const file = join(home, ".swarm", "setup", "state.json")
    writeFileSync(file, "{not json")
    expect(readHealthySetupComponents(home)).toEqual([])
    writeFileSync(file, JSON.stringify({ components: "healthy" }))
    expect(readHealthySetupComponents(home)).toEqual([])
    const big = JSON.stringify({ components: allHealthy(), pad: "x".repeat(SETUP_STATE_MAX_BYTES) })
    writeFileSync(file, big)
    expect(readHealthySetupComponents(home)).toEqual([])
  })

  test("returns nothing when state.json is a directory", () => {
    mkdirSync(join(home, ".swarm", "setup", "state.json"), { recursive: true })
    expect(readHealthySetupComponents(home)).toEqual([])
  })

  test("drops ids outside the register and keeps register order", () => {
    writeState({ firecrawl: { state: "healthy" }, extra: { state: "healthy" }, runtime: { state: "healthy" } })
    expect(readHealthySetupComponents(home)).toEqual(["runtime", "firecrawl"])
  })
})

describe("register drift", () => {
  test("release matches the builder SwarmRelease", async () => {
    const builder = await import("../../electron-builder.config")
    expect(onboarding.SWARM_RELEASE).toBe(builder.SWARM_RELEASE)
  })

  // The id drift test guards the one desktop copy, in setup-runner.test.ts.
})

describe("one reader (senior 1)", () => {
  test("F7 holds for the offer too: an inherited state is not healthy", () => {
    writeState({ ...allHealthy(), rtk: {} })
    const proto = Object.prototype as Record<string, unknown>
    try {
      proto.state = "healthy"
      expect(onboarding.isSetupToolsOfferPending(home)).toBe(true)
    } finally {
      delete proto.state
    }
  })
})
