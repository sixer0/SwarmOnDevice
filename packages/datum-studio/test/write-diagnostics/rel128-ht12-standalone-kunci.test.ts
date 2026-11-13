// Swarm 1.2.8 row 34c (H-T12, AC-HT12, N8-337; PROBE): a stand-alone apparatus figure with a key and a source reports
// KUNCI, SUMBER and the furniture height, both in the preview route payload (`standalone.furniture`) and in the
// studio_figure_preview {standalone:true} tool text (`perabot:` line). 1.2.7 row 36b already pins the line
// (rel127-t12-furniture.test.ts:77), so this probe is expected green at BASE: a green BASE run closes the item as
// VERIFIED-by-new-test (C-decision), a red one becomes a new coder row.
// Synthetic fixture syn127/t12_standalone_key_source.json (row 20): 2 edge kinds (KUNCI drawn), SUMBER wraps at 128 mm.
// What runs for real: compose mapBlock, the preview route render and the engine, and the MCP tool over the in-memory
// harness with a mocked Studio HTTP that returns the route's real figure. No network, no browser, no store.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { HttpFetch } from "../../vendor/scripts/studio/_http-client"
import { connect, memNodeFs, reply, ROOT } from "../ported/mcp/mcp-harness"

const PKG = path.resolve(import.meta.dir, "..", "..")
const fig = await import(path.join(PKG, "src", "mcp-host", "local-api", "routes", "figure-preview-figure.ts"))
const compose = await import(path.join(PKG, "vendor", "src", "lib", "studio", "services", "compose", "index.ts"))

const FX = JSON.parse(readFileSync(path.join(PKG, "test", "fixtures", "syn127", "t12_standalone_key_source.json"), "utf8"))
const PID = "fig-diagram-ht12"
const DOC = "cmvdoc0000000000000r34c12"
const PREVIEW_PATH = `/api/studio/documents/${DOC}/figures/preview`

function composed() {
  const content = compose.mapBlock(structuredClone(FX.block), PID, { glyphs: compose.glyphSet(undefined), params: {}, classification: "BIASA", artifactLabel: FX.figureLabel })
  return { blockId: PID, pid: PID, address: "1.1.1", ordinal: 0, unitKey: "", type: FX.block.type, content, textPlain: "", contentSha256: "", artifactLabel: FX.figureLabel }
}
const standaloneFigure = () => fig.renderFigure(composed(), { params: {} } as any, { inline: false, withSvg: true, lang: "ID", standalone: true } as any)
const textsOf = (svg: string) => (svg.match(/<text\b[^>]*>[\s\S]*?<\/text>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, ""))

function mock(figure: Record<string, unknown>): HttpFetch {
  return async (url, init) => {
    if (`${init.method} ${new URL(url).pathname}` !== `POST ${PREVIEW_PATH}`) return reply({ status: 404, body: { code: "ROUTE_NOT_FOUND" } })
    return reply({ status: 200, body: { documentId: DOC, revisionNo: 2, currentRevisionNo: 2, rendered: true, figure } })
  }
}

describe("AC-HT12 probe: KUNCI, SUMBER and height of a stand-alone apparatus figure", () => {
  test("route payload: standalone.furniture has keyLines >= 1, sourceLines >= 1 and heightMm > 0; the SVG draws KUNCI and SUMBER", async () => {
    const r = await standaloneFigure()
    const t = textsOf(r.svg)
    expect(t.some((x) => x.startsWith("KUNCI"))).toBe(true)
    expect(t.some((x) => x.startsWith("SUMBER"))).toBe(true)
    const fu = r.standalone?.furniture
    console.log(`row34c HT12 route furniture: ${JSON.stringify(fu)}`)
    expect(fu).toBeDefined()
    expect(fu.keyLines).toBeGreaterThanOrEqual(1)
    expect(fu.sourceLines).toBeGreaterThanOrEqual(1)
    expect(fu.heightMm).toBeGreaterThan(0)
  })

  test("tool text: studio_figure_preview {standalone:true} prints KUNCI, SUMBER and tinggi … mm with the route's numbers", async () => {
    const figure = await standaloneFigure()
    const fu = figure.standalone.furniture
    const { call } = await connect({ fetch: mock(figure), env: { STUDIO_AGENT_ID: "cod-row34c" }, nfs: memNodeFs().nfs })
    const r = await call("studio_figure_preview", { documentId: DOC, pid: PID, standalone: true, downloadDir: path.join(ROOT, "gambar") })
    expect(r.isError).toBeFalsy()
    const line = r.text.split("\n").find((l: string) => l.includes("perabot:"))
    console.log(`row34c HT12 tool line: ${JSON.stringify(line)}`)
    expect(line).toBeDefined()
    expect(line).toContain(`KUNCI ${fu.keyLines} baris`)
    expect(line).toContain(`SUMBER ${fu.sourceLines} baris`)
    expect(line).toContain(`tinggi ${Math.round(fu.heightMm * 10) / 10} mm`)
  })
})
