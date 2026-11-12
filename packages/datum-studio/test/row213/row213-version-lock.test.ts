// Row 213 (1.2.4, decision P15): the guard that a built-in template's content never changes without a version bump.
//
// templates/version-lock.json records every (slug, versionNo, content) a release shipped; content = the definition
// sha256 StudioStore.pinBuiltinVersion compares plus the folded payload sha256 (scripts/builtin-version-lock.ts).
// This suite folds the shipped built-ins with the vendored template service (as the store pins them) and fails when
// one of them differs from the lock under its number. Row 174 (datum-gsp, 1.2.2) and row 205 (datum-kanonik, 1.2.3)
// would each have failed here.
import { describe, expect, test } from "bun:test"
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkVersionLock, readLock, recordBuiltins, shippedBuiltins, versionFor, type VersionLock } from "../../scripts/builtin-version-lock.ts"

const PKG = path.resolve(import.meta.dir, "..", "..")
const TEMPLATES = path.join(PKG, "templates")
const FIXTURES = path.join(import.meta.dir, "fixtures")
const base = process.env.ROW213_TEST_DIR ?? tmpdir()
mkdirSync(base, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(base, "row213-lock-")))
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex")
const clone = (l: VersionLock): VersionLock => JSON.parse(JSON.stringify(l)) as VersionLock

function releaseTemplates(release: string): string {
  const dir = path.join(WORK, `templates-${release}`)
  cpSync(TEMPLATES, dir, { recursive: true })
  for (const f of readdirSync(path.join(FIXTURES, release))) copyFileSync(path.join(FIXTURES, release, f), path.join(dir, f))
  return dir
}

describe("row 213: built-in template version lock", () => {
  test("every shipped built-in matches the lock under its versionNo (content change => version bump)", async () => {
    const builtins = await shippedBuiltins(TEMPLATES)
    expect(builtins.length).toBe(16)
    expect(checkVersionLock(readLock(), builtins)).toEqual([])
  })

  test("the catalog versionNo follows the lock rule, every template is v3 after 1.2.6 (row 72 figure-quota params in every folded payload), the two changed in 1.2.2/1.2.3 are v4", async () => {
    const lock = readLock()
    const catalog = JSON.parse(readFileSync(path.join(TEMPLATES, "catalog.json"), "utf8")) as { templates: Array<{ slug: string; versionNo?: number }> }
    const builtins = await shippedBuiltins(TEMPLATES)
    for (const b of builtins) {
      const entry = catalog.templates.find((t) => t.slug === b.slug)!
      expect({ slug: b.slug, versionNo: entry.versionNo }).toEqual({ slug: b.slug, versionNo: versionFor(lock, b.slug, b.definitionSha256) })
    }
    expect(Object.fromEntries(builtins.filter((b) => b.versionNo !== 3).map((b) => [b.slug, b.versionNo]))).toEqual({ "datum-kanonik": 4, "datum-gsp": 4 })
  })

  test("the lock holds every definition 1.2.0, 1.2.1, 1.2.2, 1.2.3, 1.2.4 and 1.2.5 shipped (history is complete)", async () => {
    const lock = readLock()
    // Definitions only: the folded payload depends on the vendored fold, which 1.2.5 changed (C-27 / P11-27 removed), so an
    // older release's payload can no longer be re-folded here; its locked payload sha was recorded when it was current.
    // 1.2.6 changed the fold again (row 72: P7-37/P7-38 registry defaults), so 1.2.5 is checked the same way.
    for (const release of ["1.2.0", "1.2.2", "1.2.3", "1.2.4", "1.2.5"]) {
      for (const b of await shippedBuiltins(releaseTemplates(release))) {
        const hit = lock.templates[b.slug].find((e) => e.definitionSha256 === b.definitionSha256)
        expect({ release, slug: b.slug, found: hit !== undefined }).toEqual({ release, slug: b.slug, found: true })
      }
    }
  }, 120_000)

  test("a definition edited without a bump fails the guard (the 1.2.3 mistake replayed on datum-nota)", async () => {
    const dir = path.join(WORK, "edited")
    cpSync(TEMPLATES, dir, { recursive: true })
    const file = path.join(dir, "datum-nota.json")
    const def = JSON.parse(readFileSync(file, "utf8")) as { advanced?: Record<string, unknown> }
    def.advanced = { ...def.advanced, "cover.title.maxWidthMm": 140 }
    const text = `${JSON.stringify(def, null, 2)}\n`
    writeFileSync(file, text)
    const catPath = path.join(dir, "catalog.json")
    const cat = JSON.parse(readFileSync(catPath, "utf8")) as { templates: Array<{ slug: string; sha256: string; bytes: number }> }
    const e = cat.templates.find((t) => t.slug === "datum-nota")!
    e.sha256 = sha(text)
    e.bytes = Buffer.byteLength(text)
    writeFileSync(catPath, `${JSON.stringify(cat, null, 2)}\n`)
    const problems = checkVersionLock(readLock(), await shippedBuiltins(dir))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("datum-nota v3: definition changed without a version bump")
    // The export rule gives the edited definition the next number, which --write then records.
    const changed = (await shippedBuiltins(dir)).find((b) => b.slug === "datum-nota")!
    expect(versionFor(readLock(), "datum-nota", changed.definitionSha256)).toBe(4)
  })

  test("a folded payload change under the same number fails; --write moves it to the next number", async () => {
    const builtins = await shippedBuiltins(TEMPLATES)
    const moved = builtins.map((b) => (b.slug === "datum-standar" ? { ...b, payloadSha256: "f".repeat(64) } : b))
    expect(checkVersionLock(readLock(), moved)).toEqual([expect.stringContaining("datum-standar v3: folded payload changed without a version bump")])
    const lock = clone(readLock())
    const r = recordBuiltins(lock, moved, "test")
    expect(r).toEqual({ added: ["datum-standar v4"], rerunExport: ["datum-standar"] })
    expect(versionFor(lock, "datum-standar", builtins.find((b) => b.slug === "datum-standar")!.definitionSha256)).toBe(4)
  })

  test("a retired number is never reused, and a lock that records two contents under one live number is refused", async () => {
    const builtins = await shippedBuiltins(TEMPLATES)
    const back = builtins.map((b) => (b.slug === "datum-kanonik" ? { ...b, versionNo: 1 } : b))
    expect(checkVersionLock(readLock(), back).some((p) => p.startsWith("datum-kanonik v1: retired version number"))).toBe(true)
    const lock = clone(readLock())
    lock.templates["datum-nota"].push({ ...lock.templates["datum-nota"][0], definitionSha256: "0".repeat(64), release: "test" })
    expect(checkVersionLock(lock, builtins)).toContainEqual(expect.stringContaining("datum-nota v1: shipped with 2 contents"))
  })
})
