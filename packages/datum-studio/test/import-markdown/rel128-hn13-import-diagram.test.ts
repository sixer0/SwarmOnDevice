// Swarm 1.2.8 row 32 (AC-HN13, N8-331): the Markdown importer maps a `diagram` fence and a `json` fence with
// "type": "diagram" to DiagramV2 blocks (caption and source from the adjacent Gambar:/Sumber: lines), keeps a json
// fence of another type as code with FENCE_KEPT_AS_CODE, keeps an invalid diagram fence as code with
// DIAGRAM_FENCE_INVALID naming the validator messages, and the studio_chapter_import_markdown summary counts what
// was kept as code ("N konstruk dipetakan, M kept as code, ..., 0 dibuang").
// Red at BASE e1f9673772: every fence becomes monoBlock, no warning (markdown.ts code()).
// Fixture: test/fixtures/syn128/hn13_import.md (synthetic).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { importMarkdownChapter } from "../../vendor/src/lib/studio/services/import/markdown"
import type { HttpFetch } from "../../vendor/scripts/studio/_http-client"
import { connect, reply } from "../ported/mcp/mcp-harness"

const FIXTURE = readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", "hn13_import.md"), "utf8")
const types = (blocks: Array<{ type: string }> | undefined) => (blocks ?? []).map((b) => b.type)
const codes = (r: ReturnType<typeof importMarkdownChapter>) => r.report.warnings.map((w) => w.code)

describe("AC-HN13: Markdown import maps diagram fences", () => {
  test("fixture: two diagram blocks, the table json and the plain fence stay monoBlock, nothing dropped", () => {
    const r = importMarkdownChapter(FIXTURE, { chapterKey: "1" })
    expect(types(r.chapter.intro)).toEqual(["paragraph", "diagram", "paragraph", "diagram", "monoBlock", "monoBlock", "paragraph"])
    const [first, second] = (r.chapter.intro ?? []).filter((b) => b.type === "diagram") as Array<Record<string, any>>
    expect(first.caption).toEqual({ text: "Alur sintetis penerimaan barang." })
    expect(first.source).toEqual({ text: "Sumber sintetis uji." })
    expect(first.spec.family).toBe("flow")
    expect(first.spec.nodes.map((n: { id: string }) => n.id)).toEqual(["a", "b", "c"])
    expect(second.caption).toEqual({ text: "Alur sintetis penyimpanan." })
    expect(second.spec.nodes.map((n: { id: string }) => n.id)).toEqual(["p", "q"])
    expect(r.validation).toEqual({ valid: true, issues: [] })
    expect(r.report.dropped).toEqual([])
    // The table json is named; the plain fence keeps its label rule.
    expect(codes(r)).toEqual(["FENCE_KEPT_AS_CODE", "MONOBLOCK_LABEL_DEFAULTED", "NO_SECTIONS"])
    expect(r.report.warnings[0].message).toContain('"type": "table"')
    // The Gambar:/Sumber: lines were consumed by the diagram, not left as paragraphs.
    expect(JSON.stringify(r.chapter)).not.toContain("Gambar:")
  })

  test("a caption that starts with the figure label token stays a diagram and validation reports CAPTION_TOKEN_DUPLICATE", () => {
    const md = FIXTURE.replace('"text": "Alur sintetis penyimpanan."', '"text": "Gambar 2. Alur sintetis penyimpanan."')
    const r = importMarkdownChapter(md, { chapterKey: "1" })
    expect(types(r.chapter.intro).filter((t) => t === "diagram")).toHaveLength(2)
    expect(r.validation.valid).toBe(false)
    expect(r.validation.issues.map((i) => i.checkId)).toContain("CAPTION_TOKEN_DUPLICATE")
  })

  test("an invalid diagram fence stays monoBlock with DIAGRAM_FENCE_INVALID naming the validator messages; its caption lines stay text", () => {
    const md = '# Bab\n\n```diagram\n{"family": "flow", "nodes": "bukan-larik"}\n```\n\nGambar: Alur rusak.\n\nSumber: Sumber sintetis.\n'
    const r = importMarkdownChapter(md, { chapterKey: "1" })
    expect(types(r.chapter.intro)).toEqual(["monoBlock", "paragraph", "paragraph"])
    const w = r.report.warnings.find((x) => x.code === "DIAGRAM_FENCE_INVALID")
    expect(w?.message).toContain("/spec/nodes")
    expect(r.report.dropped).toEqual([])
  })

  test("a diagram fence whose body is not JSON is named DIAGRAM_FENCE_INVALID; a json fence without type is plain code", () => {
    const md = '# Bab\n\n```diagram\nbukan json\n```\n\n```json\n{"a": 1}\n```\n'
    const r = importMarkdownChapter(md, { chapterKey: "1" })
    expect(types(r.chapter.intro)).toEqual(["monoBlock", "monoBlock"])
    expect(codes(r)).toEqual(["DIAGRAM_FENCE_INVALID", "NO_SECTIONS"])
    expect(r.report.warnings[0].message).toContain("not JSON")
  })

  test("studio_chapter_import_markdown summary: mapped, kept as code, 0 dibuang", async () => {
    const result = importMarkdownChapter(FIXTURE, { chapterKey: "1", envelope: { target: { documentId: "cmvdoc0000000000000000d1a" } } })
    const f: HttpFetch = async (url, init) => {
      const u = new URL(url)
      if (`${init.method} ${u.pathname}` !== "POST /api/studio/import/markdown") return reply({ status: 404, body: { code: "ROUTE_NOT_FOUND" } })
      return reply({ status: 200, body: { ...result, dryRun: { ran: true, valid: true, issues: [] } } })
    }
    const { call } = await connect({ fetch: f, env: { STUDIO_AGENT_ID: "cod-row32" } })
    const r = await call("studio_chapter_import_markdown", { documentId: "cmvdoc0000000000000000d1a", chapterKey: "1", markdown: FIXTURE })
    expect(r.data.importSummary).toMatchObject({ valid: true, keptAsCode: 1, droppedCount: 0 })
    expect(r.text).toMatch(/\d+ konstruk dipetakan, 1 kept as code, \d+ peringatan, 0 dibuang/)
    expect(r.text).toContain("FENCE_KEPT_AS_CODE")
  })
})
