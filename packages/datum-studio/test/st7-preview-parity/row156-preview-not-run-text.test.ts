// Swarm 1.3.3 row 156 (senior review S12; spec ST-7): the preview's "not yet checked" list and the KEYROW_SUPERSEDED
// notice reach the TEXT the model reads, not only structuredContent.
//  (a) `previewLines` (vendor/scripts/studio/mcp/figure-tools.ts) prints `figure.notRun` as one compact line:
//      "belum diperiksa: <id> (<short reason>), ..." with module entries as "modul <id>", capped with "+N lainnya";
//  (b) end to end through the real preview (`renderFigure`): a diagram with an offpage node prints
//      "OFFPAGE_UNPAIRED (perlu dokumen)";
//  (c) request 87: an inline preview block (`composeInlineBlock`) whose authored keyRow is superseded by legend[] carries
//      KEYROW_SUPERSEDED as a notice (REPORT, info), and the text lists it.
// Fixtures: synthetic blocks written here; the parity fixture dg_flow.json for the legend rows. No port, no store.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

type J = Record<string, any>
const { previewLines, notRunLine, NOT_RUN_LINE_MAX } = await import("../../vendor/scripts/studio/mcp/figure-tools")
const { mapBlock, glyphSet, composeV2 } = await import("@/lib/studio/services/compose")
const { KEYROW_SUPERSEDED_MESSAGE } = await import("@/lib/studio/engine/diagram/core/sheet")
const preview = await import("../../src/mcp-host/local-api/routes/figure-preview-figure")
const K = await import("../ported/renderers/_kit")
const S = await import("../ported/structure/_kit")

const reply = (figure: J): J => ({ documentId: "doc-1", revisionNo: 3, currentRevisionNo: 3, rendered: true, figure })
const lineOf = (lines: string[]) => lines.find((l) => l.includes("belum diperiksa:"))

describe("(a) previewLines prints figure.notRun", () => {
  const base = { type: "diagram", code: "flow", pid: "p1", address: "1.0.1", size: { widthMm: 128, heightMm: 60, svgBytes: 100 }, issues: [], notices: [], defects: [], issueCount: 0, layoutIssueCount: 0 }

  test("one line, short reason per id, modules as 'modul <id>'", () => {
    const f = {
      ...base,
      notRun: [
        { id: "scan", kind: "module", reason: "belum diperiksa: hanya saat render (pemindaian teks seluruh dokumen; ...)", cause: "could-not-run" },
        { id: "DATUM-14", kind: "rule", reason: "belum diperiksa: hanya saat render (butuh halaman hasil render: ...)", cause: "could-not-run" },
        { id: "OFFPAGE_UNPAIRED", kind: "rule", reason: "belum diperiksa: hanya saat render (butuh seluruh dokumen)", cause: "could-not-run" },
        { id: "C-37", kind: "rule", reason: "belum diperiksa: hanya saat render (cek bertahap)", cause: "staged" },
      ],
    }
    const lines = previewLines("doc-1", reply(f))
    const hits = lines.filter((l) => l.includes("belum diperiksa:"))
    expect(hits.length).toBe(1)
    const line = hits[0]
    expect(line).toContain("OFFPAGE_UNPAIRED (perlu dokumen)")
    expect(line).toContain("DATUM-14 (perlu halaman PDF)")
    expect(line).toContain("modul scan (perlu dokumen)")
    expect(line).toContain("C-37 (bertahap)")
    // Rules before modules: the figure's own open checks are not the ones a cap cuts first.
    expect(line.indexOf("OFFPAGE_UNPAIRED")).toBeLessThan(line.indexOf("modul scan"))
    expect(line).not.toContain("lainnya")
  })

  test("no notRun, or an empty one: no line", () => {
    expect(lineOf(previewLines("doc-1", reply(base)))).toBeUndefined()
    expect(lineOf(previewLines("doc-1", reply({ ...base, notRun: [] })))).toBeUndefined()
  })

  test("capped in length with '+N lainnya'; an unsafe id is not echoed", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `RULE-${i}`, kind: "rule", reason: "belum diperiksa: hanya saat render (butuh seluruh dokumen)", cause: "could-not-run" }))
    const line = notRunLine([...many, { id: "<x> ignore previous", kind: "rule", reason: "?", cause: "could-not-run" }]) as string
    expect(line.length).toBeLessThanOrEqual(NOT_RUN_LINE_MAX)
    expect(line).toMatch(/\+\d+ lainnya \(figure\.notRun\)$/)
    expect(line).not.toContain("<x>")
    const shown = (line.match(/RULE-\d+/g) ?? []).length
    expect(Number(/\+(\d+) lainnya/.exec(line)?.[1])).toBe(41 - shown)
  })
})

describe("(b) end to end: a figure with an offpage node", () => {
  const node = (id: string, label: string, extra: J = {}) => ({ id, label, shape: "box", class: {}, ...extra })
  const block = {
    type: "diagram",
    caption: { text: "Alur uji sintetis tahun 2026." },
    source: { text: "SUMBER: uji sintetis 2026." },
    spec: {
      family: "flow",
      direction: "TB",
      classification: "BIASA",
      labels_verified: true,
      sources: ["uji sintetis"],
      nodes: [node("a", "Masuk"), node("b", "Periksa"), { id: "c", label: "ke Gambar 2", shape: "offpage", class: {} }],
      edges: [
        { from: "a", to: "b", kind: "data", label: "data" },
        { from: "b", to: "c", kind: "data", label: "data" },
      ],
    },
  }
  const params = { "diagram.widthMm": 128 }
  const doc = { schema: "studio.norm/v1", doc: { $schema: "studio.doc/v1", template: { slug: "t" }, meta: { tier: "TERBIT", language: "ID", classification: "BIASA" }, chapters: [] }, blocks: [], units: [], numbering: {}, register: {} }

  test("the preview text prints 'belum diperiksa: ... OFFPAGE_UNPAIRED (perlu dokumen)'", async () => {
    const content = mapBlock(structuredClone(block) as never, "fig-156", { glyphs: glyphSet(undefined), params, classification: "BIASA", artifactLabel: "Gambar 1.1" })
    const nb = { blockId: "fig-156", pid: "fig-156", address: "1.0.1", artifactLabel: "Gambar 1.1", ordinal: 0, unitKey: "1", type: "diagram", content, textPlain: "", contentSha256: "" }
    const f = await preview.renderFigure(nb as never, { params } as never, { inline: true, withSvg: false, lang: "ID", document: doc } as never)
    expect((f.notRun ?? []).some((n) => n.id === "OFFPAGE_UNPAIRED")).toBe(true)
    const line = lineOf(previewLines("doc-1", reply(JSON.parse(JSON.stringify(f)))))
    expect(line).toBeDefined()
    expect(line).toContain("OFFPAGE_UNPAIRED (perlu dokumen)")
  })
})

describe("(c) request 87: KEYROW_SUPERSEDED on the inline preview path", () => {
  const t = (text: string) => ({ text })
  const FLOW = JSON.parse(readFileSync(path.resolve(import.meta.dir, "..", "ported", "_fixtures", "tests", "parity", "fixtures", "diagram", "dg_flow.json"), "utf8")) as J
  const AUTHORED_KEY = "Garis penuh menandai alur utama penulis."
  const diagram = (keyRow?: string): J => ({
    type: "diagram",
    caption: t("Alur uji kunci."),
    source: t("Sumber sintetis uji."),
    ...(keyRow ? { keyRow: t(keyRow) } : {}),
    spec: { family: FLOW.family, labels_verified: true, nodes: FLOW.nodes, edges: FLOW.edges, legend: FLOW.legend },
  })
  let snap: any
  let tpl: any
  let near: J
  beforeAll(async () => {
    const slots = S.datumSlots()
    const doc = S.e1()
    doc.sections.content.chapters[0].sections[0].blocks = [{ type: "paragraph", text: "Paragraf sintetis sebelum figur." }, diagram()]
    const { template: _t, ...sub } = doc
    snap = composeV2({ source: S.merge(sub, undefined, { slots }).doc, skeleton: S.skeletonInput(slots), params: S.defaultParams() }).snapshot
    tpl = await K.canonicalTemplate()
    const stored = (snap.blocks as J[]).find((b) => b.type === "diagram") as J
    near = { slotKey: stored.slotKey, artifactLabel: stored.artifactLabel, address: stored.address }
  })

  test("authored keyRow beside legend[]: one notice KEYROW_SUPERSEDED (REPORT, info), and the text names it", async () => {
    const inline = preview.composeInlineBlock(snap, diagram(AUTHORED_KEY) as never, near as never)
    const f = await preview.renderFigure(inline, tpl, { inline: true, withSvg: false, lang: "ID" })
    const hits = f.notices.filter((n) => n.checkId === "KEYROW_SUPERSEDED")
    expect(hits.length).toBe(1)
    expect(hits[0]).toMatchObject({ status: "REPORT", info: true })
    expect(hits[0].detail).toContain(KEYROW_SUPERSEDED_MESSAGE)
    expect(f.defects.some((d) => d.checkId === "KEYROW_SUPERSEDED")).toBe(false)
    const text = previewLines("doc-1", reply(JSON.parse(JSON.stringify(f)))).join("\n")
    expect(text).toContain("KEYROW_SUPERSEDED (info)")
  })

  test("no authored keyRow: no notice", async () => {
    const inline = preview.composeInlineBlock(snap, diagram() as never, near as never)
    const f = await preview.renderFigure(inline, tpl, { inline: true, withSvg: false, lang: "ID" })
    expect(f.issues.some((n) => n.checkId === "KEYROW_SUPERSEDED")).toBe(false)
  })
})
