// Row 165J (C197 F165H-1): Studio LINT check DATUM-15 (body measure, 66-80 characters per line) on the case 05 and
// B-FIX renders, measured in the REAL render bridge (the repo's Electron 42 binary, row 157 harness, fixture HOME,
// --use-mock-keychain, dead proxy) exactly as the render does it: `measureLayout(html)` (pure/render.ts:457) then the
// render lint (`lintRenderedWith`, limits from the template params). Row 165H found FAIL 82.4 (case 05) and 88.9
// (B-FIX) with the example address F:controlSheet/3, the control-sheet method statement set at 136.9 mm.
// OPT-IN: runs only with ROW165J_E2E=1 (it launches Electron; command sandbox off: Unix socket).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { realBridgeRunnable, startRealBridge, type RealBridge } from "./real-bridge"

const E2E = process.env.ROW165J_E2E === "1" && realBridgeRunnable
const e2e = E2E ? describe : describe.skip
const ROOT = process.env.ROW165J_ROOT ?? "/private/tmp/claude-501/row165J"

e2e("F165H-1: DATUM-15 on case 05 and B-FIX (real Chromium measure)", () => {
  let bridge: RealBridge | undefined
  beforeAll(async () => {
    bridge = await startRealBridge(path.join(ROOT, "bridge-" + Date.now()), path.join(ROOT, "home-bridge"))
    process.env.DATUM_RENDER_SOCKET = bridge.info.DATUM_RENDER_SOCKET
    process.env.DATUM_RENDER_TOKEN = bridge.info.DATUM_RENDER_TOKEN
  }, 90_000)
  afterAll(async () => {
    const { closeBrowser } = await import("../../vendor/src/lib/studio/engine/browser/index")
    await closeBrowser?.()
    const st = await bridge?.stop()
    console.log(`[row165j] bridge stop ${JSON.stringify({ windowsAfter: st?.result?.windowsAfter ?? null, error: st?.result?.error ?? null })}`)
  }, 30_000)

  async function measure(name: "case05.json" | "bfix-datum-kanonik-ID.studio.json") {
    const K = await import("../engine-rev-a/row165a/_kit")
    const { measureLayout } = await import("../../vendor/src/lib/studio/engine/browser/index")
    const { lintRenderedWith, renderLintLimitsFromParams } = await import("../../vendor/src/lib/studio/engine/lint/render/index")
    const tpl = await K.kanonikTemplate()
    const html = await K.renderHtml(K.compose(K.loadCase(name)))
    const metrics = await measureLayout(html)
    const method = metrics.elements.find((e) => e.kind === "text" && e.address === "F:controlSheet/3")
    const d15 = lintRenderedWith({ html, svgs: [], metrics }, renderLintLimitsFromParams(tpl.params)).find((i) => i.checkId === "DATUM-15")
    console.log(`[row165j] ${name} method ${JSON.stringify(method ? { measureMm: method.measureMm, charsPerLine: method.charsPerLine, lineCount: method.lineCount } : null)} DATUM-15 ${JSON.stringify(d15)}`)
    return { method, d15 }
  }

  test("case 05: DATUM-15 PASS; the method statement is set at the body measure (<= 128 mm)", async () => {
    const r = await measure("case05.json")
    expect(r.method?.measureMm).toBeLessThanOrEqual(128.5)
    expect(r.d15?.status).toBe("PASS")
    // Row 165K: only the chapter paragraph is counted (165J: 2 paragraphs, 79.1; the method statement is left out).
    expect(r.d15?.detail ?? "").toContain("1 paragraf badan")
  }, 120_000)

  test("B-FIX: the method statement is set at the body measure (<= 128 mm)", async () => {
    const r = await measure("bfix-datum-kanonik-ID.studio.json")
    expect(r.method?.measureMm).toBeLessThanOrEqual(128.5)
  }, 120_000)

  // Row 165K (C199 ruling 2, closes open point F165J-1): DATUM-15 counts only interior units' running body text. The
  // method statement (80.5 characters per line) sits in the control-sheet unit, is tagged unit "controlSheet" by the
  // real measure script, and no longer decides B-FIX's DATUM-15.
  test("B-FIX: DATUM-15 does not count the control-sheet method statement (row 165K)", async () => {
    const r = await measure("bfix-datum-kanonik-ID.studio.json")
    expect((r.method as { unit?: string } | undefined)?.unit).toBe("controlSheet")
    // B-FIX has no multi-line interior body paragraph, so the check is NOT_RUN with its reason (never PASS, KT-13).
    expect(r.d15?.status).toBe("NOT_RUN")
    expect(r.d15?.detail ?? "").toContain("sampul, lembar kendali dan daftar isi tidak dihitung")
    expect(r.d15?.detail ?? "").not.toContain("F:controlSheet")
  }, 120_000)
})
