import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// N10-194 (1.2.10 row 68, AC-B1005, B10-05). The export guard counts a production reader of an export by name: any
// identifier with the same name in another tracked file. A common name such as `slot` is therefore always "read",
// even when nothing imports it. Since 1.2.10 the guard also collects import bindings (`import { A }`,
// `import { A as B }`, `import type { A }`, `export { A } from`, `ns.A` / `ns["A"]` after `import * as ns`, the
// self-namespace form `export * as Ns` + `import { Ns }` + `Ns.A`, and destructured dynamic imports) and reports, in
// `nameOnly` (N10-115), unmarked exports whose production readers are by name only. A file whose dynamic import or
// require has another shape keeps name matching. Report-only in 1.2.10 (C19 D-1): `unexplained`, `stale` and the
// exit code do not change. Run from this folder: `bun test ./rel1210-b1005-binding-readers.test.ts`.
//
// Probe word: `slot` (about 100 production files hold a local `slot`; none binds it). Not `name`: it is a real binding
// at HEAD (`Model.name` after `import * as Model` in packages/tui reads util/model.ts `name`), and without module
// resolution that binds every export called `name`. Not `key`: production files that keep name matching (dynamic
// import of another shape, e.g. packages/app/src/app.tsx) hold it, and `ServerConnection.key` is a self-namespace read.

const repo = path.resolve(import.meta.dir, "../..")

type Guard = typeof import("./check-exports")
type Result = ReturnType<Guard["checkExports"]>
type Entry = { file: string; line: number; name: string; prodReaders?: number }
const guard = () => import("./check-exports")

/** The `nameOnly` entries of a result; fails (red at BASE) when the member is absent. */
function nameOnlyOf(r: Result): Entry[] {
  const list = (r as Result & { nameOnly?: Entry[] }).nameOnly
  expect(Array.isArray(list)).toBe(true)
  return list!
}
const keys = (list: Entry[]) => list.map((e) => `${e.file} ${e.name}`)

// The probe export goes into a temp copy of the guard script itself (a tracked production file); readers go into a
// temp copy of another production script (or a test file). The working tree is never edited.
const word = "slot"
const host = "script/swarm/check-exports.ts"
const reader = "script/swarm/check-i18n.ts"
const testFile = "script/swarm/sign-checksums.test.ts"
const probe = `export const ${word} = 1`
const hit = `${host} ${word}`
const read = (file: string) => readFileSync(path.join(repo, file), "utf8")

/** Run the guard with `host` + probe and, for each `[file, prefix]`, that file with the prefix prepended. */
async function runWith(readers: readonly [string, string][]): Promise<Result> {
  const g = await guard()
  const dir = mkdtempSync(path.join(os.tmpdir(), "b1005-"))
  const before = [host, ...readers.map(([f]) => f)].map(read)
  try {
    const replace: Record<string, string> = { [host]: path.join(dir, "0.ts") }
    writeFileSync(replace[host], `${before[0]}\n${probe}\n`)
    readers.forEach(([file, prefix], i) => {
      replace[file] = path.join(dir, `${i + 1}${path.basename(file)}`)
      writeFileSync(replace[file], `${prefix}${before[i + 1]}`)
    })
    return g.checkExports({ repo, baseline: g.loadBaseline(repo), replace })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    // The working tree was never edited.
    expect([host, ...readers.map(([f]) => f)].map(read)).toEqual(before)
  }
}

describe("AC-B1005", () => {
  test("an unused exported `slot` is still counted read by name (not unexplained) and is reported in nameOnly", async () => {
    const r = await runWith([])
    // D-1: name readers still count, so the export is not unexplained and the exit code does not move.
    expect(r.unexplained.map((u) => `${u.file} ${u.name}`)).toEqual([])
    const entry = nameOnlyOf(r).filter((e) => `${e.file} ${e.name}` === hit)
    expect(entry.length).toBe(1)
    // Many production files hold a local `slot`: the case B10-05 is about.
    expect(entry[0].prodReaders ?? 0).toBeGreaterThan(10)
  }, 120_000)

  const bindings: readonly [string, string][] = [
    ["import { A }", `import { ${word} } from "./check-exports"\nexport const b1005Reader = ${word}\n`],
    ["import { A as B }", `import { ${word} as b1005Alias } from "./check-exports"\nexport const b1005Reader = b1005Alias\n`],
    ["import type { A }", `import type { ${word} } from "./check-exports"\nexport type B1005Reader = typeof ${word}\n`],
    ["export { A } from", `export { ${word} } from "./check-exports"\n`],
    ["ns.A after import * as ns", `import * as b1005Ns from "./check-exports"\nexport const b1005Reader = b1005Ns.${word}\n`],
    ['ns["A"] after import * as ns', `import * as b1005Ns from "./check-exports"\nexport const b1005Reader = b1005Ns["${word}"]\n`],
    ["type ns.A after import * as ns", `import type * as b1005Ns from "./check-exports"\nexport type B1005Reader = typeof b1005Ns.${word}\n`],
    [
      "export * as Ns + import { Ns } + Ns.A",
      `export * as B1005Self from "./check-exports"\nimport { B1005Self } from "./check-i18n"\nexport const b1005Reader = B1005Self.${word}\n`,
    ],
    ["const { A } = await import()", `export const b1005Lazy = async () => {\n  const { ${word} } = await import("./check-exports")\n  return ${word}\n}\n`],
    ["const { A } = require()", `const { ${word}: b1005Req } = require("./check-exports")\nexport const b1005Reader = b1005Req\n`],
    ["import x = require(); x.A", `import b1005Eq = require("./check-exports")\nexport const b1005Reader = b1005Eq.${word}\n`],
    ["dynamic import of another shape keeps name matching", `export const b1005Lazy = () => import("./check-exports").then((m) => m.${word})\n`],
  ]

  for (const [label, prefix] of bindings) {
    test(`a production reader by binding (${label}) takes the export out of nameOnly`, async () => {
      const r = await runWith([[reader, prefix]])
      expect(keys(nameOnlyOf(r))).not.toContain(hit)
      expect(r.unexplained.filter((u) => u.file === host)).toEqual([])
    }, 120_000)
  }

  test("a binding in a test file does not count: the export stays nameOnly", async () => {
    // Test files are readers, never production readers (unchanged rule); a test import is not a production binding.
    const r = await runWith([[testFile, `import { ${word} } from "./check-exports"\nvoid ${word}\n`]])
    expect(keys(nameOnlyOf(r))).toContain(hit)
  }, 120_000)

  test("a dynamic import whose shape does not name the read keeps name matching only for a file holding the word", async () => {
    // script/version.ts holds no `slot`: keeping name matching there does not bind it.
    const lazy = `export const b1005Lazy = () => import("./swarm/check-exports").then((m) => m)\n`
    expect(read("script/version.ts")).not.toMatch(new RegExp(`\\b${word}\\b`))
    const r = await runWith([["script/version.ts", lazy]])
    expect(keys(nameOnlyOf(r))).toContain(hit)
  }, 120_000)

  test("tree: unexplained [] and stale [] (report-only: nameOnly never fails the guard); entries are well formed", async () => {
    const g = await guard()
    const baseline = g.loadBaseline(repo)
    const r = g.checkExports({ repo, baseline })
    expect(r.unexplained.map((u) => `${u.file}:${u.line} ${u.name}`)).toEqual([])
    expect(r.stale.map((s) => `${s.file} ${s.name}`)).toEqual([])
    const tree = keys(nameOnlyOf(r))
    // Count measured by row 68 and recorded in implementation/68_b1005_binding_match.md; not pinned here (B10-12:
    // other rows add exports, and an exact count pin breaks on every legitimate change).
    expect(tree.length).toBeGreaterThan(0)
    expect(new Set(tree).size).toBe(tree.length)
    const listed = new Set(baseline.map((b) => `${b.file} ${b.name}`))
    expect(tree.filter((e) => listed.has(e) || e.startsWith("packages/sdk/js/src/v2/gen/"))).toEqual([])
    expect(nameOnlyOf(r).filter((e) => (e.prodReaders ?? 0) < 1)).toEqual([])
  }, 120_000)
})
