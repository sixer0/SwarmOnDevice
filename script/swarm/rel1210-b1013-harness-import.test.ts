import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// N10-203 (1.2.10 row 77, AC-B1013, B10-13, S10-40). Before 1.2.10 the export guard never looked at what production
// modules import, so a production file could import a browser-test fixture or a test harness and ship it. Since row 77
// the guard resolves every import specifier (static imports and re-exports, `import x = require()`, and `import("…")`
// / `require("…")` with a string-literal argument) to a tracked file, relative or through a package's `@/` alias, and
// lists in `harnessImports` (N10-117) every production file that imports a harness: a file `readsAsTest` accepts, a
// basename starting `test-harness`, a `*.mock.*` / `*.fake.*` / `*.stub.*` file, or a file under `mocks/`,
// `__mocks__/`, `fakes/` or `stubs/`. Files of `packages/storybook/` are neither importers nor reported. Any entry
// fails the guard (exit 1). Specifiers that resolve to no tracked file, and non-literal dynamic ones, are counted on one
// line, never guessed. Run from this folder: `bun test ./rel1210-b1013-harness-import.test.ts`.

const repo = path.resolve(import.meta.dir, "../..")

type Guard = typeof import("./check-exports")
type Result = ReturnType<Guard["checkExports"]>
type Hit = { file: string; specifier: string }
const guard = () => import("./check-exports")

/** The `harnessImports` entries of a result; fails (red at BASE) when the member is absent. */
function harnessOf(r: Result): Hit[] {
  const list = (r as Result & { harnessImports?: Hit[] }).harnessImports
  expect(Array.isArray(list)).toBe(true)
  return list!
}

/** Run the guard on the tree with `file` replaced by a temp copy that has `extra` appended. Never edits the tree. */
async function withAppended(file: string, extra: string): Promise<Result> {
  const g = await guard()
  const original = readFileSync(path.join(repo, file), "utf8")
  const dir = mkdtempSync(path.join(os.tmpdir(), "b1013-"))
  try {
    const copy = path.join(dir, path.basename(file))
    writeFileSync(copy, `${original}\n${extra}\n`)
    return g.checkExports({ repo, baseline: g.loadBaseline(repo), replace: { [file]: copy } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    expect(readFileSync(path.join(repo, file), "utf8")).toBe(original)
  }
}

describe("AC-B1013 production modules must not import a test harness", () => {
  test("(1) a production copy importing ./mission-hq.fixture gives one harnessImports entry", async () => {
    const file = "packages/app/src/pages/session/swarm/mission-hq.tsx"
    const r = await withAppended(file, 'import "./mission-hq.fixture"')
    expect(harnessOf(r)).toEqual([{ file, specifier: "./mission-hq.fixture" }])
  }, 120_000)

  test("(2) S10-40: a literal dynamic import of ../../store/test-harness.node.ts gives one entry", async () => {
    const file = "packages/datum-studio/src/mcp-host/verify/static-checks.ts"
    const r = await withAppended(
      file,
      'export async function b1013Probe() {\n  return await import("../../store/test-harness.node.ts")\n}',
    )
    expect(harnessOf(r)).toEqual([{ file, specifier: "../../store/test-harness.node.ts" }])
  }, 120_000)

  test("(3) the tree imports no harness from production and the guard stays 0/0", async () => {
    const g = await guard()
    const r = g.checkExports({ repo, baseline: g.loadBaseline(repo) })
    expect(harnessOf(r)).toEqual([])
    expect(r.unexplained).toEqual([])
    expect(r.stale).toEqual([])
  }, 120_000)

  test("(3b) C92: the httpapi-exercise launcher exception covers exactly that file and that specifier", async () => {
    const launcher = "packages/opencode/script/httpapi-exercise.ts"
    const target = "../test/server/httpapi-exercise/index"
    expect(readFileSync(path.join(repo, launcher), "utf8")).toContain(`await import("${target}")`)
    // The same launcher importing the same harness folder by another specifier still fails.
    const other = await withAppended(launcher, 'await import("../test/server/httpapi-exercise/index.ts")')
    expect(harnessOf(other)).toEqual([{ file: launcher, specifier: "../test/server/httpapi-exercise/index.ts" }])
    // Another script importing the excepted target with the excepted specifier text still fails.
    const script = "packages/opencode/script/time.ts"
    const copy = await withAppended(script, `await import("${target}")`)
    expect(harnessOf(copy)).toEqual([{ file: script, specifier: target }])
  }, 120_000)

  test("(4) CLI: the harness set, literal dynamic imports, @/ alias, unresolved count, storybook and test importers", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "b1013-repo-"))
    try {
      const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: dir, encoding: "utf8" })
      const put = (rel: string, text: string) => {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
        writeFileSync(path.join(dir, rel), text)
      }
      expect(run("git", ["init", "-q"]).status).toBe(0)
      mkdirSync(path.join(dir, "script/swarm"), { recursive: true })
      copyFileSync(path.join(repo, "script/swarm/check-exports.ts"), path.join(dir, "script/swarm/check-exports.ts"))
      symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"))
      put("script/swarm/check-exports.baseline.json", `${JSON.stringify({ note: "fixture", entries: [] }, null, 2)}\n`)
      // Harnesses (side effect only, so the export scan has nothing to say about them).
      for (const h of [
        "src/a.fixture.ts",
        "src/b.render.ts",
        "src/test-browser/c.ts",
        "src/helpers/test-harness-db.ts",
        "src/d.mock.ts",
        "src/e.fake.ts",
        "src/f.stub.ts",
        "src/mocks/g.ts",
        "src/__mocks__/h.ts",
        "src/fakes/i/index.ts",
        "src/stubs/j.js",
        "packages/app/src/view.fixture.ts",
      ])
        put(h, "void 0\n")
      put("src/ok.ts", "void 0\n")
      put("src/data.json", "{}\n")
      put("packages/app/tsconfig.json", '{\n  // comments allowed\n  "compilerOptions": { "paths": { "@/*": ["./src/*"] } }\n}\n')
      put(
        "src/prod.ts",
        [
          'import "./a.fixture"',
          'import "./b.render"',
          'import "./test-browser/c"',
          'import "./helpers/test-harness-db"',
          'export * from "./d.mock"',
          'import e = require("./e.fake")',
          "void e",
          'const f = require("./f.stub.ts")',
          "void f",
          "async function lazy(p: string) {",
          '  await import("./mocks/g")',
          "  await import(`./__mocks__/h`)",
          '  void import("./fakes/i")',
          '  await import("./stubs/j.js")',
          "  await import(p)",
          "}",
          "void lazy",
          'import "./ok"',
          'import "./data.json"',
          'import "./missing"',
          'import "./untracked.fixture"',
          'import "solid-js"',
          "",
        ].join("\n"),
      )
      put("packages/app/src/view.ts", 'import "@/view.fixture"\n')
      put("src/untracked.fixture.ts", "void 0\n")
      // Not importers: test files, harnesses themselves, storybook.
      put("src/p.test.ts", 'import "./a.fixture"\n')
      put("src/test-browser/q.ts", 'import "../a.fixture"\n')
      put("src/r.render.ts", 'import "./mocks/g"\n')
      put("packages/storybook/s.tsx", 'import "../../src/mocks/g"\nimport "./mocks/t"\n')
      put("packages/storybook/mocks/t.ts", "void 0\n")
      const tracked = [
        "src",
        "packages/app/tsconfig.json",
        "packages/app/src",
        "packages/storybook",
        ":(exclude)src/untracked.fixture.ts",
      ]
      expect(run("git", ["add", "--", ...tracked]).status).toBe(0)

      const json = run(process.execPath, ["script/swarm/check-exports.ts", "--json"])
      const parsed = JSON.parse(json.stdout) as Result & { harnessImports?: Hit[] }
      expect(parsed.unexplained).toEqual([])
      expect(parsed.harnessImports).toEqual([
        { file: "packages/app/src/view.ts", specifier: "@/view.fixture" },
        { file: "src/prod.ts", specifier: "./__mocks__/h" },
        { file: "src/prod.ts", specifier: "./a.fixture" },
        { file: "src/prod.ts", specifier: "./b.render" },
        { file: "src/prod.ts", specifier: "./d.mock" },
        { file: "src/prod.ts", specifier: "./e.fake" },
        { file: "src/prod.ts", specifier: "./f.stub.ts" },
        { file: "src/prod.ts", specifier: "./fakes/i" },
        { file: "src/prod.ts", specifier: "./helpers/test-harness-db" },
        { file: "src/prod.ts", specifier: "./mocks/g" },
        { file: "src/prod.ts", specifier: "./stubs/j.js" },
        { file: "src/prod.ts", specifier: "./test-browser/c" },
      ])
      expect(json.status).toBe(1)

      const text = run(process.execPath, ["script/swarm/check-exports.ts"])
      const lines = text.stdout.split("\n")
      expect(lines.filter((l) => l.startsWith("production file imports a harness "))).toEqual(
        parsed.harnessImports!.map((h) => `production file imports a harness ${h.file} -> ${h.specifier}`),
      )
      // ./missing, ./untracked.fixture (not in `git ls-files`) and the non-literal import(p); bare packages are not
      // repo paths and are not counted.
      expect(lines).toContain("import specifiers not resolved 3 (not checked)")
      expect(text.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
