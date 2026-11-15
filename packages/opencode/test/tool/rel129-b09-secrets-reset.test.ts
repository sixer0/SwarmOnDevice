// AC-B09 (N9-126): `Secrets.learn` keeps what it learned for the whole process. `resetForTests` (N9-066) lets a test
// file forget it, and nothing outside the tests may call it (S9-11 grep pin).
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Secrets } from "../../src/tool/secrets"

// Synthetic, used by this file only (C74): no other test teaches or prints these.
const TAUGHT = "synthetic-b09-zz9q7m"
const ENV_NAME = "SWARM_B09_RESET_TOKEN"
const ENV_VALUE = "Zr9Kq2Lm7Xb4Vt8Nw6"

describe("AC-B09 Secrets.resetForTests", () => {
  test("(a) forgets learned values; a secret-looking environment value is still hidden", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "b09-"))
    process.env[ENV_NAME] = ENV_VALUE
    try {
      Secrets.learn(`K=${TAUGHT}`)
      expect(Secrets.scrubText(`echo ${TAUGHT}`)).toBe("echo [hidden:K]")
      expect(Secrets.scrub(`echo ${TAUGHT} ${ENV_VALUE}`, root)).toBe(`echo [hidden:K] [hidden:${ENV_NAME}]`)

      Secrets.resetForTests()

      expect(Secrets.scrubText(`echo ${TAUGHT}`)).toBe(`echo ${TAUGHT}`)
      // `known()` was cached for this root before the reset; the version bump makes it read the environment again.
      expect(Secrets.scrub(`echo ${TAUGHT} ${ENV_VALUE}`, root)).toBe(`echo ${TAUGHT} [hidden:${ENV_NAME}]`)
    } finally {
      delete process.env[ENV_NAME]
      Secrets.resetForTests()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // S9-11: every `packages/*/**/*.{ts,tsx,js,mjs,cjs}` outside node_modules, dist, test, test-browser and `*.test.*`.
  // Row 49 also skips `out`: it is build output (packages/desktop/.gitignore `out/`), and the desktop main bundle copies
  // opencode's secrets.ts into packages/desktop/out/main/chunks, so a fresh desktop build would add a second, non-source
  // copy of the definition. The pin checks that no tracked file sits under an `out` folder, so no source escapes it.
  test("(b) the only occurrence outside the tests is the marked definition", () => {
    const repo = path.resolve(import.meta.dir, "../../../..")
    const packages = path.join(repo, "packages")
    const SKIP = new Set(["node_modules", "dist", "test", "test-browser", "out"])
    const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!SKIP.has(entry.name)) walk(full)
          continue
        }
        if (entry.isFile() && SOURCE.test(entry.name) && !entry.name.includes(".test.")) files.push(full)
      }
    }
    for (const entry of readdirSync(packages, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIP.has(entry.name)) walk(path.join(packages, entry.name))
    }
    expect(files.length).toBeGreaterThan(1000)

    const tracked = Bun.spawnSync(["git", "ls-files", "-z", "packages"], { cwd: repo })
    expect(tracked.exitCode).toBe(0)
    const underOut = tracked.stdout
      .toString()
      .split("\0")
      .filter((file) => file.split("/").includes("out"))
    expect(underOut).toEqual([])

    const hits: { file: string; line: number; text: string; previous: string }[] = []
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      if (!text.includes("resetForTests")) continue
      const lines = text.split("\n")
      lines.forEach((line, index) => {
        if (line.includes("resetForTests"))
          hits.push({ file: path.relative(repo, file), line: index + 1, text: line, previous: lines[index - 1] ?? "" })
      })
    }
    expect(hits.map((hit) => `${hit.file}:${hit.line}`)).toHaveLength(1)
    expect(hits[0].file).toBe(path.join("packages", "opencode", "src", "tool", "secrets.ts"))
    expect(hits[0].text.startsWith("export function resetForTests(")).toBe(true)
    expect(hits[0].previous).toBe("/** @internal test seam */")
  })
})
