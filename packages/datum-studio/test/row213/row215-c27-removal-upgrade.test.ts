// Row 215 (1.2.5): C-27 ("Kata per kalimat", param P11-27 threshold.wordsPerSentenceAvg) was removed entirely.
// Removing the param changes every built-in's folded payload (resolvedParams, paramsSha256), so all 16 built-ins were
// bumped (version-lock.json, catalog versionNo). Same pattern as row 213: a store pinned by 1.2.4 (v1 / v2 content)
// opens on the 1.2.5 templates with no manual step.
//
// What is real: a temp SqliteStudioStore (bun:sqlite), the vendored template service and the folded built-ins.
// Stand-in: the 1.2.4 payload. The 1.2.4 vendored fold is gone from the tree, so the pinned 1.2.4 rows are rebuilt by
// pinning through the 1.2.4 catalog (versionNo 1/2, byte copy from git in fixtures/1.2.4) and then restoring (trigger lifted on the temp DB) the one
// thing 1.2.4 folded that 1.2.5 does not: threshold.wordsPerSentenceAvg in resolved_params.
//
// Finding recorded here (not what the brief expected): StudioStore.pinBuiltinVersion compares only definition_sha256
// (studio-store.ts:1103). The 1.2.5 definitions are byte-identical to 1.2.4, so an UNBUMPED 1.2.5 build does not throw
// TEMPLATE_VERSION_CONFLICT; it silently keeps serving the stale 1.2.4 payload. The bump is what makes the new payload
// reach the store, and the lock guard (row213-version-lock.test.ts) is what forces it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHostStore, openHostStore, type SqliteStudioStore } from "../../src/store-bridge/index.ts"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const FIXTURES = path.join(import.meta.dir, "fixtures")
const base = process.env.ROW213_TEST_DIR ?? tmpdir()
mkdirSync(base, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(base, "row215-")))
mkdirSync(path.join(WORK, "logs"), { recursive: true })
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
const KEY = "threshold.wordsPerSentenceAvg"

let templates: typeof import("../../vendor/src/lib/studio/services/templates")

function templatesDir(name: string, fixture?: string): string {
  const dir = path.join(WORK, `templates-${name}`)
  cpSync(TEMPLATES, dir, { recursive: true })
  if (fixture) for (const f of readdirSync(path.join(FIXTURES, fixture))) copyFileSync(path.join(FIXTURES, fixture, f), path.join(dir, f))
  return dir
}
async function openAs(root: string, release: string, dir: string): Promise<{ store: SqliteStudioStore; error: unknown }> {
  const store = await openHostStore(root, { release, logFile: path.join(WORK, "logs", `${release}-${path.basename(path.dirname(root))}.jsonl`) })
  templates.configureTemplateSource({ templatesDir: dir, assetRepoRoot: VENDOR, release })
  let error: unknown = null
  try {
    await templates.ensureBuiltinTemplates()
  } catch (e) {
    error = e
  }
  return { store, error }
}
type Row = { slug: string; version_no: number; resolved_params: string }
const rows = (store: SqliteStudioStore) =>
  store.transaction(async (tx) =>
    tx.all<Row>("SELECT t.slug, v.version_no, v.resolved_params FROM template_version v JOIN template t ON t.id = v.template_id WHERE t.origin = 'builtin' ORDER BY t.slug, v.version_no"),
  )
const latest = (all: Row[]) => {
  const m = new Map<string, Row>()
  for (const r of all) m.set(r.slug, r)
  return m
}
const codeOf = (e: unknown): string | undefined => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined)

beforeAll(async () => {
  templates = await import("../../vendor/src/lib/studio/services/templates")
})
afterAll(() => {
  templates.configureTemplateSource(null)
})

/** A store as 1.2.4 left it: every built-in pinned at the 1.2.4 versionNo, resolved_params carrying the C-27 threshold. */
async function storeAs124(root: string): Promise<void> {
  const s = await openAs(root, "1.2.4", templatesDir("124", "1.2.4"))
  expect(codeOf(s.error) ?? null).toBeNull()
  await s.store.transaction(async (tx) => {
    // Stand-in on a temp DB only: versions are immutable (trigger), so lift the trigger to write the 1.2.4 payload.
    tx.run("DROP TRIGGER template_version_immutable")
    for (const r of tx.all<{ id: string; resolved_params: string }>("SELECT id, resolved_params FROM template_version")) {
      const p = JSON.parse(r.resolved_params) as Record<string, unknown>
      p[KEY] = [18, 32]
      tx.run("UPDATE template_version SET resolved_params = ? WHERE id = ?", [JSON.stringify(p), r.id])
    }
  })
  const all = await rows(s.store)
  expect(all.length).toBe(16)
  expect(all.every((r) => JSON.parse(r.resolved_params)[KEY] !== undefined)).toBe(true)
  await closeHostStore(s.store)
}

describe("row 215: C-27 removal, built-in version bump", () => {
  test("a store pinned by 1.2.4: an unbumped build keeps the stale C-27 payload (no throw), the bumped 1.2.5 recovers it", async () => {
    const root = path.join(WORK, "u", "datum-studio")
    await storeAs124(root)
    const peek = await openHostStore(root, { release: "1.2.4", logFile: path.join(WORK, "logs", "peek.jsonl") })
    const before = latest(await rows(peek))
    await closeHostStore(peek)

    // Unbumped 1.2.5: new vendor, the 1.2.4 catalog (same versionNos, same definitions).
    const unbumped = await openAs(root, "1.2.5", templatesDir("unbumped", "1.2.4"))
    expect(codeOf(unbumped.error) ?? null).toBeNull()
    const stale = latest(await rows(unbumped.store))
    for (const [slug, r] of stale) {
      expect({ slug, v: r.version_no }).toEqual({ slug, v: before.get(slug)!.version_no })
      expect(JSON.parse(r.resolved_params)[KEY]).toEqual([18, 32])
    }
    await closeHostStore(unbumped.store)

    // Bumped 1.2.5: every built-in gets a new version with the new payload; the old versions stay as pinned.
    // The 1.2.5 catalog (fixtures/1.2.5): 1.2.6 bumped every built-in once more (row 110), so the current catalog is +2.
    const bumped = await openAs(root, "1.2.5", templatesDir("bumped", "1.2.5"))
    try {
      expect(codeOf(bumped.error) ?? null).toBeNull()
      const all = await rows(bumped.store)
      expect(all.length).toBe(32)
      for (const [slug, r] of latest(all)) {
        expect({ slug, v: r.version_no }).toEqual({ slug, v: before.get(slug)!.version_no + 1 })
        expect(Object.keys(JSON.parse(r.resolved_params))).not.toContain(KEY)
      }
      for (const r of all.filter((x) => x.version_no === before.get(x.slug)!.version_no)) expect(JSON.parse(r.resolved_params)[KEY]).toEqual([18, 32])
    } finally {
      await closeHostStore(bumped.store)
    }
  }, 300_000)

  test("no built-in carries the removed parameter any more", async () => {
    const root = path.join(WORK, "fresh", "datum-studio")
    const s = await openAs(root, "1.2.5", TEMPLATES)
    try {
      expect(codeOf(s.error) ?? null).toBeNull()
      for (const r of await rows(s.store)) expect(Object.keys(JSON.parse(r.resolved_params))).not.toContain(KEY)
    } finally {
      await closeHostStore(s.store)
    }
  }, 120_000)
})
