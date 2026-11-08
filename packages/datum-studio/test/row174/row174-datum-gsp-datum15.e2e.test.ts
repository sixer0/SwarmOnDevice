// Row 174 (C218 F146b-5): the built-in template datum-gsp always failed DATUM-15 (body measure 165.9 mm, agent finding
// F-01 of run 146b), so an agent had to switch to datum-laporan. Measured here in the REAL render bridge (the repo's
// Electron binary, row 157 harness, fixture HOME, --use-mock-keychain, dead proxy) as the render does it:
// assembleHtml -> measureLayout(html) -> lintRenderedWith(limits from the template params), on the row 143a case 05
// material, with the built-in templates resolved by the template service exactly as a document gets them.
// OPT-IN: runs only with ROW174_E2E=1 (launches Electron; command sandbox off: Unix socket).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import path from "node:path"
import { realBridgeRunnable, startRealBridge, type RealBridge } from "../verify-gate-e2e/real-bridge"

const E2E = process.env.ROW174_E2E === "1" && realBridgeRunnable
const e2e = E2E ? describe : describe.skip
const ROOT = process.env.ROW174_ROOT ?? "/private/tmp/claude-501/row174"
const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const PLAIN = [
  "Pemantauan iklim ruang simpan dilakukan tiap sepuluh menit pada setiap titik sensor, lalu dirata-ratakan per jam untuk register harian. Nilai di luar ambang memicu peringatan kepada petugas jaga dan dicatat bersama waktu, titik, dan nilai terukur agar penelusuran dapat diulang oleh pemeriksa.",
  "Kalibrasi sensor dilakukan setahun sekali terhadap alat acuan tertelusur. Sertifikat kalibrasi disimpan bersama register perangkat, dan sensor yang menyimpang lebih dari batas toleransi diganti sebelum masa operasi berikutnya dimulai, sehingga data tetap sebanding dari tahun ke tahun.",
]

e2e("F146b-5: DATUM-15 on datum-gsp (real Chromium measure)", () => {
  let bridge: RealBridge | undefined
  let store: any
  let host: typeof import("../../src/store-bridge/index.ts")
  let templates: typeof import("../../vendor/src/lib/studio/services/templates")
  beforeAll(async () => {
    mkdirSync(ROOT, { recursive: true })
    const work = realpathSync(mkdtempSync(path.join(ROOT, "e2e-")))
    process.env.STUDIO_WORKSPACE_ROOT = path.join(work, "store")
    process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
    bridge = await startRealBridge(path.join(work, "bridge"), path.join(ROOT, "home-bridge"))
    process.env.DATUM_RENDER_SOCKET = bridge.info.DATUM_RENDER_SOCKET
    process.env.DATUM_RENDER_TOKEN = bridge.info.DATUM_RENDER_TOKEN
    host = await import("../../src/store-bridge/index.ts")
    store = await host.openHostStore(path.join(work, "store"), { release: "1.2.1", logFile: path.join(work, "logs", "store.jsonl") })
    templates = await import("../../vendor/src/lib/studio/services/templates")
    templates.configureTemplateSource({ templatesDir: path.join(PKG, "templates"), assetRepoRoot: VENDOR, release: "1.2.1" })
  }, 120_000)
  afterAll(async () => {
    templates?.configureTemplateSource(null)
    if (store) await host.closeHostStore(store)
    const { closeBrowser } = await import("../../vendor/src/lib/studio/engine/browser/index")
    await closeBrowser?.()
    const st = await bridge?.stop()
    console.log(`[row174] bridge stop ${JSON.stringify({ windowsAfter: st?.result?.windowsAfter ?? null, error: st?.result?.error ?? null })}`)
    const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
    resetStudioEnvCache()
  }, 30_000)

  async function measure(slug: string) {
    const K = await import("../engine-rev-a/row143a/_kit")
    const R = await import("../ported/renderers/_kit")
    const { assembleHtml } = await import("../../vendor/src/lib/studio/engine/html/assemble")
    const { measureLayout } = await import("../../vendor/src/lib/studio/engine/browser/index")
    const { lintRenderedWith, renderLintLimitsFromParams } = await import("../../vendor/src/lib/studio/engine/lint/render/index")
    const tpl = await templates.resolveTemplate(slug)
    // Case 05 plus two running paragraphs WITHOUT rail notes (the run 146b document: most paragraphs carry no chip).
    const doc = K.loadCase("case05.json")
    const blocks = doc.sections.content.chapters[0].sections[0].blocks as unknown[]
    blocks.splice(1, 0, ...PLAIN.map((text) => ({ type: "paragraph", text })))
    const html = await assembleHtml(R.makeCtx(K.compose(doc), tpl).ctx, { preview: false })
    const metrics = await measureLayout(html)
    const d15 = lintRenderedWith({ html, svgs: [], metrics }, renderLintLimitsFromParams(tpl.params)).find((i) => i.checkId === "DATUM-15")
    const body = metrics.elements.filter((e: any) => e.kind === "text" && e.label === "st-p" && !["cover", "controlSheet", "toc"].includes(e.unit ?? ""))
    const facts = {
      reserveColumn: tpl.params["render.rail.reserveColumn"] ?? null,
      k2: html.includes("st-rail-k2"),
      bodyMeasureMm: body.map((e: any) => Math.round(e.measureMm * 10) / 10),
      d15: d15 ? { status: d15.status, detail: d15.detail } : null,
    }
    console.log(`[row174] ${slug} ${JSON.stringify(facts)}`)
    return facts
  }

  test("datum-gsp: body set at the text column with the rail reserved -> DATUM-15 PASS", async () => {
    const r = await measure("datum-gsp")
    expect(r.d15?.status).toBe("PASS")
    for (const mm of r.bodyMeasureMm) expect(mm).toBeLessThan(150)
  }, 120_000)

  test("control: datum-laporan (the profile the agent switched to) stays PASS", async () => {
    const r = await measure("datum-laporan")
    expect(r.d15?.status).toBe("PASS")
  }, 120_000)
})
