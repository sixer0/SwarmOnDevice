import { describe, expect, test } from "bun:test"
import type { Configuration } from "electron-builder"
import { SHIPPED_SCRIPTS } from "./stage-library"

// Row 96 (KL-1, C27): the knowledge-library scripts ride in Resources/knowledge-library beside the staged library,
// never inside app.asar, without the script tests, testdata or the repo snapshot of the indexes.
type Entry = { from: string; to: string; filter?: string[] }

async function load(target: string) {
  const previous = process.env.SWARM_BUILD_TARGET
  process.env.SWARM_BUILD_TARGET = target
  const module = await import(`../electron-builder.config.ts?row96=${target}`)
  if (previous === undefined) delete process.env.SWARM_BUILD_TARGET
  if (previous !== undefined) process.env.SWARM_BUILD_TARGET = previous
  return module.default as Configuration
}

describe("row 96 knowledge-library scripts resources mapping", () => {
  for (const target of ["darwin-arm64", "linux-x64", "win32-x64"]) {
    test(`${target}: datum/knowledge-library maps to Resources/knowledge-library right after the staged library`, async () => {
      const config = await load(target)
      const items = config.extraResources as Entry[]
      const house = items.find((item) => item.to === "datum-house-style")!
      const library = items.findIndex((item) => item.from === ".library-stage")
      const entries = items.filter((item) => item.from === "datum/knowledge-library")

      expect(entries).toHaveLength(1)
      expect(entries[0].to).toBe("knowledge-library")
      expect(entries[0].filter).toEqual([
        ...house.filter!,
        "!scripts/test_*.py",
        "!scripts/testdata{,/**}",
        "!scripts/indeks_*",
      ])
      expect(items.indexOf(entries[0])).toBe(library + 1)
      expect(items[library].to).toBe("knowledge-library")
    })

    test(`${target}: no files pattern reaches the folder (outside app.asar)`, async () => {
      const config = await load(target)
      expect(JSON.stringify(config.files ?? [])).not.toContain("knowledge-library")
      const included = (config.files as string[]).filter((pattern) => !pattern.startsWith("!"))
      for (const pattern of included)
        expect(new Bun.Glob(pattern).match("datum/knowledge-library/scripts/build_kl_index.py")).toBe(false)
    })
  }

  test("the filter keeps exactly the scripts the library verify expects", () => {
    const kept = ["scripts/README.md", "scripts/build_kl_index.py"]
    const dropped = [
      "scripts/test_build_kl_index_diagram.py",
      "scripts/testdata/a.json",
      "scripts/indeks_pemicu.json",
      "scripts/indeks_struktur.md",
      "scripts/__pycache__/build_kl_index.cpython-314.pyc",
    ]
    const keeps = (file: string) =>
      new Bun.Glob("**/*").match(file) &&
      !["**/__pycache__/**", "**/*.pyc", "scripts/test_*.py", "scripts/testdata/**", "scripts/indeks_*"].some(
        (pattern) => new Bun.Glob(pattern).match(file),
      )

    expect(kept.filter(keeps)).toEqual(kept)
    expect(dropped.filter(keeps)).toEqual([])
    expect([...SHIPPED_SCRIPTS].toSorted()).toEqual(kept)
  })
})
