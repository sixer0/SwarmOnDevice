// Swarm 1.3.3 row 74 (ST-10): the figure-loss rule on the real write path. Real host over a temp store
// (test/retrieval/scenario.ts startHost; binds an ephemeral port, so it needs the command sandbox off).
// A chart is added to a chapter by PATCH (R16 insertAfter), as on 2026-11-17; then the chapter is re-imported
// from Markdown with studio_chapter_import_markdown, always with baseRevisionNo = the latest revision.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { startHost, type Host } from "../retrieval/scenario.ts"

type S = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const MISSION = "2026-11-17_row74"
const CHANGE = (what: string) => ({ what, why: "uji impor ulang row 74", impact: "tidak ada" })
const CHART = { type: "chart", code: "P-02", data: { shape: "categorical", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }] }, caption: { text: "Beban daya per lokasi." }, source: { text: "Perhitungan uji row 74." } }

let h: Host
beforeAll(async () => {
  const work = realpathSync(mkdtempSync(path.join(tmpdir(), "row74-")))
  mkdirSync(path.join(work, "datum-studio"), { recursive: true })
  h = await startHost({ phase: "row74", pkg: PKG, storeRoot: path.join(work, "datum-studio"), work } as never, () => {})
}, 120_000)
afterAll(async () => {
  await h?.stop()
})

const revOf = (id: string) => Number(h.sql<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [id])[0]!.n)
const imp = (id: string, markdown: string) => h.call("studio_chapter_import_markdown", { documentId: id, chapterKey: "1", markdown, submit: true, change: CHANGE("impor bab 1"), baseRevisionNo: revOf(id) })
const say = (label: string, r: S) => console.log(`[row74 host] ${label}: ok=${r.ok} code=${r.code ?? "-"} rev=${r.revisionNo ?? "-"} ${String(r._text).slice(0, 1400).replace(/\n/g, " / ")}`)

async function blocksOf(id: string): Promise<S[]> {
  const content = (await h.call("studio_document_get", { documentId: id, view: "content" })).content
  const out: S[] = []
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk)
    if (x === null || typeof x !== "object") return
    const o = x as S
    if (typeof o.type === "string" && typeof o.id === "string" && ["paragraph", "chart"].includes(o.type)) out.push(o)
    Object.values(o).forEach(walk)
  }
  walk(content)
  return out
}

/** A document whose chapter 1 holds: paragraph, chart (added by PATCH), paragraph. Returns the chart pid. */
async function docWithChart(docKey: string): Promise<{ id: string; chart: string }> {
  const c = await h.call("studio_document_create", { template: "datum-nota", mission: MISSION, docKey, title: `Nota uji ${docKey}` })
  expect(c.ok, c._text).not.toBe(false)
  const id = String(c.documentId)
  const first = await imp(id, "# Perhitungan\n\nParagraf awal bab.\n\nParagraf akhir bab.\n")
  expect(first.ok === true, first._text).toBe(true)
  const anchor = (await blocksOf(id)).find((b) => JSON.stringify(b).includes("Paragraf awal bab."))!
  const p = await h.local("PATCH", `/api/studio/documents/${id}/paragraphs/${anchor.id}`, { op: "insertAfter", baseRevisionNo: revOf(id), block: CHART, change: CHANGE("sisip grafik"), agentId: "cod-row74" })
  expect(p.status, JSON.stringify(p.body).slice(0, 400)).toBe(200)
  const chart = (await blocksOf(id)).find((b) => b.type === "chart")!
  expect(chart.caption).toEqual(CHART.caption)
  return { id, chart: String(chart.id) }
}

describe("row 74: chapter re-import on the real host", () => {
  test("refuse-with-list: a re-import without the chart writes nothing and names the block", async () => {
    const { id, chart } = await docWithChart("r74-refuse")
    const n = revOf(id)
    const r = await imp(id, "# Perhitungan\n\nParagraf awal bab ditulis ulang.\n\nParagraf akhir bab.\n")
    say("refused", r)
    expect(r.ok).toBe(false)
    expect(String(r._text)).toContain("FIGURE_BLOCKS_WOULD_BE_LOST")
    expect(String(r._text)).toContain(chart)
    expect(String(r._text)).toContain("Beban daya per lokasi.")
    expect(String(r._text)).toContain(`[[keep:${chart}]]`)
    expect(String(r._text)).toContain(`[[remove:${chart}]]`)
    expect(String(r._text)).not.toContain("diubah pihak lain") // not the SCOPE_CONFLICT headline: nobody else wrote
    expect(r.code).toBe("CHAPTER_INVALID") // the importer's own "fix the Markdown" refusal, found by its dry run
    expect(revOf(id)).toBe(n)
    expect((await blocksOf(id)).map((b) => b.type)).toEqual(["paragraph", "chart", "paragraph"])
  }, 120_000)

  test("keep: [[keep:<pid>]] keeps the chart at the marker, same pid and content, in a new revision", async () => {
    const { id, chart } = await docWithChart("r74-keep")
    const n = revOf(id)
    const before = (await blocksOf(id)).find((b) => b.id === chart)
    const r = await imp(id, `# Perhitungan\n\nParagraf awal bab ditulis ulang.\n\nParagraf sisipan.\n\nParagraf akhir bab.\n\n[[keep:${chart}]]\n`)
    say("kept", r)
    expect(r.ok === true, r._text).toBe(true)
    expect(revOf(id)).toBe(n + 1)
    const after = await blocksOf(id)
    expect(after.map((b) => b.type)).toEqual(["paragraph", "paragraph", "paragraph", "chart"])
    expect(after[3]).toEqual(before!)
    expect(JSON.stringify(after)).not.toContain("[[keep:")
  }, 120_000)

  test("deliberate removal: [[remove:<pid>]] removes the chart in a new revision", async () => {
    const { id, chart } = await docWithChart("r74-remove")
    const n = revOf(id)
    const r = await imp(id, `# Perhitungan\n\nParagraf awal bab.\n\n[[remove:${chart}]]\n\nParagraf akhir bab.\n`)
    say("removed", r)
    expect(r.ok === true, r._text).toBe(true)
    expect(revOf(id)).toBe(n + 1)
    const after = await blocksOf(id)
    expect(after.map((b) => b.type)).toEqual(["paragraph", "paragraph"])
    expect(JSON.stringify(after)).not.toContain("[[remove:")
  }, 120_000)
})
