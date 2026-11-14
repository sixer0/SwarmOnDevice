// Row 68c (gate 68 F3, C52 ruling 1, N9-282): `setRehomeDecisionForTests` is a test seam of the re-home route handler.
// Pin: one marked definition, no production importer, and every test that sets it resets it after each test.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const NAME = "setRehomeDecisionForTests"
const repo = path.resolve(import.meta.dir, "../../../..")
const packages = path.join(repo, "packages")
// Same scope as the B09 pin (D-49-1): `out` is build output, `dist` too; test folders are the allowed importers.
const SKIP_PROD = new Set(["node_modules", "dist", "out", "test", "test-browser"])
const SKIP_ALL = new Set(["node_modules", "dist", "out"])
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/

const collect = (skip: Set<string>) => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full)
        continue
      }
      if (entry.isFile() && SOURCE.test(entry.name)) files.push(full)
    }
  }
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (entry.isDirectory() && !skip.has(entry.name)) walk(path.join(packages, entry.name))
  }
  return files
}
const rel = (file: string) => path.relative(repo, file)

describe("N9-282 setRehomeDecisionForTests seam", () => {
  test("production code: exactly one marked definition, no other mention", () => {
    const files = collect(SKIP_PROD).filter((file) => !path.basename(file).includes(".test."))
    expect(files.length).toBeGreaterThan(1000)
    const hits: { file: string; index: number; lines: string[] }[] = []
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      if (!text.includes(NAME)) continue
      const lines = text.split("\n")
      lines.forEach((line, index) => {
        if (line.includes(NAME)) hits.push({ file: rel(file), index, lines })
      })
    }
    expect(hits.map((hit) => hit.file)).toEqual([
      path.join("packages", "opencode", "src", "server", "routes", "instance", "httpapi", "handlers", "project.ts"),
    ])
    const { index, lines } = hits[0]
    expect(lines[index].startsWith(`export function ${NAME}(`)).toBe(true)
    // The doc block directly above carries the marker (a single block: stacked blocks hide all but the last).
    let start = index - 1
    expect(lines[start].trim()).toBe("*/")
    while (start >= 0 && !lines[start].trim().startsWith("/**")) start--
    const doc = lines.slice(start, index).join("\n")
    expect(doc).toContain("@internal test seam")
    expect((doc.match(/\/\*\*/g) ?? []).length).toBe(1)
  })

  test("only test files use it, and each resets it in afterEach/afterAll", () => {
    const tests = collect(SKIP_ALL).filter((file) => {
      const parts = rel(file).split(path.sep)
      return path.basename(file).includes(".test.") || parts.includes("test") || parts.includes("test-browser")
    })
    const users = tests.filter((file) => file !== import.meta.path && readFileSync(file, "utf8").includes(NAME))
    expect(users.length).toBeGreaterThanOrEqual(5)
    for (const file of users) {
      const lines = readFileSync(file, "utf8").split("\n")
      const resets = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /setRehomeDecisionForTests\(undefined\)/.test(line))
      expect(resets.length, `${rel(file)} never resets the seam`).toBeGreaterThan(0)
      // Some reset sits in an afterEach/afterAll callback: the nearest block opener above it is that hook.
      const inHook = resets.some(({ index }) => {
        for (let i = index - 1; i >= 0; i--) {
          const m = /^\s*(afterEach|afterAll|beforeEach|beforeAll|test|it|describe)\(/.exec(lines[i])
          if (m) return m[1] === "afterEach" || m[1] === "afterAll"
        }
        return false
      })
      expect(inHook, `${rel(file)} resets the seam outside afterEach/afterAll`).toBe(true)
    }
  })
})
