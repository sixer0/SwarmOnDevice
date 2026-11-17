import { describe, expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

// Row 31 (SK-1, KL-4, Q1): gsp-diagram-standard rides in Resources beside datum-house-style, never inside app.asar.
type Entry = { from: string; to: string; filter?: string[] }

async function load(target: string) {
  const previous = process.env.SWARM_BUILD_TARGET
  process.env.SWARM_BUILD_TARGET = target
  const module = await import(`../electron-builder.config.ts?row31=${target}`)
  if (previous === undefined) delete process.env.SWARM_BUILD_TARGET
  if (previous !== undefined) process.env.SWARM_BUILD_TARGET = previous
  return module.default as Configuration
}

describe("row 31 gsp-diagram-standard resources mapping", () => {
  for (const target of ["darwin-arm64", "linux-x64", "win32-x64"]) {
    test(`${target}: whole folder maps to Resources/gsp-diagram-standard like datum-house-style, minus the script tests`, async () => {
      const config = await load(target)
      const items = config.extraResources as Entry[]
      const house = items.find((item) => item.to === "datum-house-style")!
      const entry = items.find((item) => item.to === "gsp-diagram-standard")
      expect(entry).toBeDefined()
      expect(entry!.from).toBe("datum/gsp-diagram-standard")
      expect(entry!.filter).toEqual([...house.filter!, "!scripts/test_*.py", "!scripts/testdata{,/**}"])
      expect(items.indexOf(entry!)).toBe(items.indexOf(house) + 1)
    })

    test(`${target}: no files pattern reaches the folder (outside app.asar)`, async () => {
      const config = await load(target)
      expect(JSON.stringify(config.files ?? [])).not.toContain("gsp-diagram-standard")
    })
  }
})
