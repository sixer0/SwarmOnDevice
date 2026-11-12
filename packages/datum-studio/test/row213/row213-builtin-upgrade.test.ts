// Row 213 (1.2.4, decision P15): a store that pinned the built-in templates of an earlier release opens on the
// current templates without TEMPLATE_VERSION_CONFLICT, and every built-in renders.
//
// The regression (installed 1.2.3): row 205 (80bfb47844) changed datum-kanonik (render.rail.reserveColumn) and
// row 174 (0c5a9bb8ef, shipped in 1.2.2) changed datum-gsp the same way, both still as versionNo 1. A store that
// pinned the older content under v1 refused the whole pin transaction (`builtin version changed without a version
// bump`), so studio_template_get / studio_template_preview / studio_render failed on every built-in.
//
// What runs for real: a temp SqliteStudioStore per scenario (bun:sqlite), the vendored template service
// (ensureBuiltinTemplates -> StudioStore.pinBuiltinVersion), getTemplate, and the Swarm sample render (DOCX + HTML).
// The older releases' templates folders are rebuilt from the current folder plus the files that differed
// (test/row213/fixtures/<release>/, byte copies from git: 1.2.0 = 1eb98be8e2 (1.2.1 acaf31e217 is identical),
// 1.2.2 = 9bf7bf2838, 1.2.3 = ae174f84ae); the loader's catalog sha256 check proves every file is that release's.
// Stand-in: only the render bridge transport (Electron does not run under bun), as in row 110e.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHostStore, openHostStore, type SqliteStudioStore } from "../../src/store-bridge/index.ts"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const FIXTURES = path.join(import.meta.dir, "fixtures")
const base = process.env.ROW213_TEST_DIR ?? tmpdir()
mkdirSync(base, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(base, "row213-")))
const TPL_LOG = path.join(WORK, "logs", "templates.jsonl")
mkdirSync(path.dirname(TPL_LOG), { recursive: true })
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")

let templates: typeof import("../../vendor/src/lib/studio/services/templates")
let sampleMod: typeof import("../../vendor/src/lib/studio/services/templates/sample-render")
let runtime: typeof import("../../vendor/src/lib/studio/engine/browser/runtime")

/** A templates folder exactly as `release` shipped it: the current files overlaid with that release's differing files. */
function releaseTemplates(release: "1.2.0" | "1.2.2" | "1.2.3"): string {
  const dir = path.join(WORK, `templates-${release}`)
  cpSync(TEMPLATES, dir, { recursive: true })
  for (const f of readdirSync(path.join(FIXTURES, release))) copyFileSync(path.join(FIXTURES, release, f), path.join(dir, f))
  return dir
}

type Pin = { slug: string; version_no: number; definition_sha256: string }

/** Open the store at `root` as `release` would: configure its templates and pin the built-ins (ensureBuiltinTemplates). */
async function openAs(root: string, release: string, templatesDir: string): Promise<{ store: SqliteStudioStore; error: unknown }> {
  const store = await openHostStore(root, { release, logFile: path.join(WORK, "logs", `store-${path.basename(path.dirname(root))}.jsonl`) })
  templates.configureTemplateSource({ templatesDir, assetRepoRoot: VENDOR, release })
  let error: unknown = null
  try {
    await templates.ensureBuiltinTemplates()
  } catch (e) {
    error = e
  }
  return { store, error }
}

async function pins(store: SqliteStudioStore): Promise<Pin[]> {
  return store.transaction(async (tx) =>
    tx.all<Pin>("SELECT t.slug, v.version_no, v.definition_sha256 FROM template_version v JOIN template t ON t.id = v.template_id WHERE t.origin = 'builtin' ORDER BY t.slug, v.version_no"),
  )
}

const codeOf = (e: unknown): string | undefined => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined)

/**
 * Render the Swarm sample of a builtin from its latest pinned version: DOCX + HTML; HTML only for a contract template
 * (laporan-kerja-agen), whose DOCX refuses a TERBIT render while its required contract slot `record` is empty.
 */
async function renderBuiltin(slug: string, contract: boolean) {
  const d = await templates.getTemplate(slug)
  const side = await sampleMod.sideFromVersion(d.version.id)
  const doc = sampleMod.swarmSampleDocument({ slug, tier: "TERBIT", slots: side.skeleton.skeleton.slots, language: slug.endsWith("-en") ? "EN" : "ID" })
  const out = await sampleMod.renderSample(side, doc, { tier: "TERBIT", formats: contract ? ["HTML"] : ["DOCX", "HTML"], timeoutMs: 60_000, correlationId: `row213-${slug}`, measureLayout: false })
  return { versionNo: d.version.versionNo, valid: out.ingest.valid, status: out.render?.status }
}

const CHANGED = ["datum-gsp", "datum-kanonik"]

beforeAll(async () => {
  templates = await import("../../vendor/src/lib/studio/services/templates")
  templates.setTemplatesLogSink((e) => appendFileSync(TPL_LOG, `${JSON.stringify(e)}\n`))
  sampleMod = await import("../../vendor/src/lib/studio/services/templates/sample-render")
  runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")
  runtime.setRenderBridgeTransport(async (req) => {
    if (req.op === "hello") return { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
    if (req.op === "checkPage") return { ok: true, electron: "42.3.3", script: "studio.measure", result: { paged: true, pageCount: 6, truncated: false, elements: [] } }
    return { ok: false, code: "UNKNOWN_OP", message: String(req.op) }
  })
})

afterAll(() => {
  runtime.setRenderBridgeTransport(null)
  templates.configureTemplateSource(null)
  templates.setTemplatesLogSink(null)
})

/** Upgrade the store at `root` to the current templates; every built-in pins, the changed ones at v2, and all render. */
async function upgradeAndRender(root: string, before: Pin[]) {
  const { store, error } = await openAs(root, "1.2.6", TEMPLATES)
  try {
    expect(codeOf(error) ?? null).toBeNull()
    const after = await pins(store)
    // Nothing pinned earlier is rewritten or dropped (documents keep their version).
    for (const p of before) expect(after).toContainEqual(p)
    const catalog = JSON.parse(await Bun.file(path.join(TEMPLATES, "catalog.json")).text()) as { templates: Array<{ slug: string; isPreset: boolean; contractKind: string | null; versionNo: number }> }
    // 1.2.5 (C-27 removed) bumped every built-in: v2, and v3 for the two that had already moved in 1.2.2/1.2.3.
    // 1.2.6 (row 72 figure-quota params in every folded payload) bumped every built-in again: v3, and v4 for those two.
    for (const e of catalog.templates) {
      const latest = after.filter((p) => p.slug === e.slug).at(-1)!
      expect({ slug: e.slug, v: latest.version_no }).toEqual({ slug: e.slug, v: CHANGED.includes(e.slug) ? 4 : 3 })
      expect(e.versionNo).toBe(latest.version_no)
      expect(latest.definition_sha256).toBe(templates.builtinTemplate(e.slug)!.definitionSha256)
    }
    for (const e of catalog.templates.filter((t) => !t.isPreset)) {
      const r = await renderBuiltin(e.slug, e.contractKind !== null)
      expect({ slug: e.slug, valid: r.valid, status: r.status }).toEqual({ slug: e.slug, valid: true, status: "SUCCEEDED" })
      expect(r.versionNo).toBe(e.versionNo)
    }
    return after
  } finally {
    await closeHostStore(store)
  }
}

describe("row 213: built-in template upgrade across releases", () => {
  test("the user's state: pinned by 1.2.2, refused by 1.2.3 (whole pin rolled back), recovered by 1.2.6 with no manual step", async () => {
    const root = path.join(WORK, "user", "datum-studio")
    const s122 = await openAs(root, "1.2.2", releaseTemplates("1.2.2"))
    expect(codeOf(s122.error) ?? null).toBeNull()
    const before = await pins(s122.store)
    expect(before.filter((p) => CHANGED.includes(p.slug)).map((p) => p.version_no)).toEqual([1, 1])
    // A document made on 1.2.2's datum-kanonik v1 must still resolve after the upgrade.
    const docVersion = (await templates.getTemplate("datum-kanonik")).version.id
    await closeHostStore(s122.store)

    // 1.2.3 as installed: the shipped catalog has no versionNo, so datum-kanonik's new content is v1 again.
    const s123 = await openAs(root, "1.2.3", releaseTemplates("1.2.3"))
    expect(codeOf(s123.error)).toBe("TEMPLATE_VERSION_CONFLICT")
    expect(await pins(s123.store)).toEqual(before) // one transaction: nothing pinned partially
    await closeHostStore(s123.store)

    await upgradeAndRender(root, before)
    const again = await openHostStore(root, { release: "1.2.6", logFile: path.join(WORK, "logs", "store-user-2.jsonl") })
    try {
      const old = await again.transaction(async (tx) => tx.get<{ version_no: number }>("SELECT version_no FROM template_version WHERE id = ?", [docVersion]))
      expect(old?.version_no).toBe(1)
    } finally {
      await closeHostStore(again)
    }
  }, 300_000)

  test("a store pinned by 1.2.0 / 1.2.1 (both templates still at their first content) upgrades", async () => {
    const root = path.join(WORK, "r120", "datum-studio")
    const s = await openAs(root, "1.2.0", releaseTemplates("1.2.0"))
    expect(codeOf(s.error) ?? null).toBeNull()
    const before = await pins(s.store)
    await closeHostStore(s.store)
    await upgradeAndRender(root, before)
  }, 300_000)

  test("a store first opened by 1.2.3 (its content pinned as v1) upgrades: v2 carries the same content", async () => {
    const root = path.join(WORK, "r123", "datum-studio")
    const s = await openAs(root, "1.2.3", releaseTemplates("1.2.3"))
    expect(codeOf(s.error) ?? null).toBeNull()
    const before = await pins(s.store)
    await closeHostStore(s.store)
    await upgradeAndRender(root, before)
  }, 300_000)

  test("a fresh store on the current release pins and renders every built-in", async () => {
    await upgradeAndRender(path.join(WORK, "fresh", "datum-studio"), [])
  }, 300_000)
})
