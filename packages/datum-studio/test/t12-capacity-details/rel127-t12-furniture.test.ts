// Swarm 1.2.7 row 36b (T-12, AC-T12, N7-103): a stand-alone figure reports its apparatus furniture explicitly.
// The engine report carries `DiagramBuildReport.furniture` (N7-138: KUNCI lines, SUMBER lines, furniture height in mm,
// only for apparatus "figure"), the preview route copies it to `standalone.furniture` (N7-068), and the
// studio_figure_preview text (row 39, figure-tools.ts) prints `perabot: KUNCI {k} baris, SUMBER {s} baris, tinggi {h} mm`.
// Red at 04067a9d02: `standalone` has only {id,title,fileName}; the text has only `gambar mandiri disimpan`.
// CHAR: the non-standalone preview has no furniture and its SVG is byte-identical (sha pinned at 04067a9d02).
// Synthetic fixture syn127/t12_standalone_key_source.json (row 20): 2 edge kinds (KUNCI drawn), SUMBER wraps to 2
// lines at 128 mm. What runs for real: compose mapBlock, the preview route render, the engine, and the MCP tool over
// the in-memory harness with a mocked Studio HTTP that returns the route's real figure. No network, no browser.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { HttpFetch } from "../../vendor/scripts/studio/_http-client"
import { connect, memNodeFs, reply, ROOT } from "../ported/mcp/mcp-harness"

const PKG = path.resolve(import.meta.dir, "..", "..")
const fig = await import(path.join(PKG, "src", "mcp-host", "local-api", "routes", "figure-preview-figure.ts"))
const compose = await import(path.join(PKG, "vendor", "src", "lib", "studio", "services", "compose", "index.ts"))

const FX = JSON.parse(readFileSync(path.join(PKG, "test", "fixtures", "syn127", "t12_standalone_key_source.json"), "utf8"))
const PID = "fig-diagram-t12"
const TPL = { params: {} } as any

function composed() {
  const content = compose.mapBlock(structuredClone(FX.block), PID, { glyphs: compose.glyphSet(undefined), params: {}, classification: "BIASA", artifactLabel: FX.figureLabel })
  return { blockId: PID, pid: PID, address: "1.1.1", ordinal: 0, unitKey: "", type: FX.block.type, content, textPlain: "", contentSha256: "", artifactLabel: FX.figureLabel }
}
const textsOf = (svg: string) => (svg.match(/<text\b[^>]*>[\s\S]*?<\/text>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, ""))
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")

/**
 * sha256 of the non-standalone fixture SVG at 04067a9d02 (CHAR: unchanged by row 36b).
 * Swarm 1.2.8 row 57 (AC-HARW INTENT, C10 OP13-5 / C12 OP-18-2): the arrowhead markers are drawn in mm; only the
 * <marker> elements changed (sha256 without markers 453c4e3964b3f222... before and after). Before: 697ef5aeb49ef04f...
 */
const PAGE_SVG_SHA_BASE = "55cefcc94e4abc2c43fff00ee61670fb2458a8506c43bbc3047835c52bd195d0"

describe("T-12 route: standalone.furniture from DiagramBuildReport.furniture (N7-068, N7-138)", () => {
  test("standalone:true reports keyLines >= 1, sourceLines 2, heightMm > 0, matching the SVG", async () => {
    const r = await fig.renderFigure(composed(), TPL, { inline: false, withSvg: true, lang: "ID", standalone: true } as any)
    const t = textsOf(r.svg)
    // the fixture really draws the key and wraps SUMBER
    expect(t.some((x) => x.startsWith("KUNCI"))).toBe(true)
    expect(t.some((x) => x.startsWith("SUMBER"))).toBe(true)
    expect(r.standalone).toBeDefined()
    expect(r.standalone.id).toBe("1.1")
    const fu = r.standalone.furniture
    expect(fu).toBeDefined()
    expect(Object.keys(fu).sort()).toEqual(["heightMm", "keyLines", "sourceLines"])
    expect(fu.keyLines).toBeGreaterThanOrEqual(1)
    expect(fu.sourceLines).toBe(2)
    expect(fu.heightMm).toBeGreaterThan(0)
    expect(fu.heightMm).toBeLessThan(r.size.heightMm)
  })

  test("CHAR: the non-standalone preview has no standalone/furniture and its SVG is byte-identical to 04067a9d02", async () => {
    const r = await fig.renderFigure(composed(), TPL, { inline: false, withSvg: true, lang: "ID" })
    expect(r.standalone).toBeUndefined()
    expect(JSON.stringify(r)).not.toContain("furniture")
    expect(sha(r.svg)).toBe(PAGE_SVG_SHA_BASE)
  })
})

// ── MCP tool text (row 39 line, figure-tools.ts) fed by the route's real figure ─────────────────────

const DOC = "cmvdoc0000000000000r36b00"
const AGENT = "cod-row36b"
const PREVIEW_PATH = `/api/studio/documents/${DOC}/figures/preview`

function mock(figure: Record<string, unknown>): HttpFetch {
  return async (url, init) => {
    if (`${init.method} ${new URL(url).pathname}` !== `POST ${PREVIEW_PATH}`) return reply({ status: 404, body: { code: "ROUTE_NOT_FOUND" } })
    return reply({ status: 200, body: { documentId: DOC, revisionNo: 3, currentRevisionNo: 3, rendered: true, figure } })
  }
}

describe("T-12 tool text: perabot line after `gambar mandiri disimpan`", () => {
  test("studio_figure_preview {standalone:true, downloadDir} prints `perabot: KUNCI … SUMBER 2 baris, tinggi … mm`", async () => {
    const figure = await fig.renderFigure(composed(), TPL, { inline: false, withSvg: true, lang: "ID", standalone: true } as any)
    const fs = memNodeFs()
    const { call } = await connect({ fetch: mock(figure), env: { STUDIO_AGENT_ID: AGENT }, nfs: fs.nfs })
    const r = await call("studio_figure_preview", { documentId: DOC, pid: PID, standalone: true, downloadDir: path.join(ROOT, "gambar") })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain("gambar mandiri disimpan")
    expect(r.text).toContain("perabot: KUNCI")
    expect(r.text).toContain("SUMBER 2 baris")
    const line = r.text.split("\n").find((l: string) => l.includes("perabot:"))!
    expect(line).toMatch(/^ {2}perabot: KUNCI [1-9]\d* baris, SUMBER 2 baris, tinggi \d+(\.\d)? mm$/)
    // numbers only: the line sits outside every untrusted block
    expect(r.text.replace(/<data-tak-tepercaya[\s\S]*?<\/data-tak-tepercaya>/g, "")).toContain(line)
  })
})
