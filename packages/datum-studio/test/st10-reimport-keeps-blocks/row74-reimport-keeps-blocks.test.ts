// Swarm 1.3.3 row 74 (ST-10, C-04 / P-07): re-importing a chapter keeps its chart, diagram and image blocks, or is
// refused with the list of blocks that would be lost. Nothing is dropped silently, nothing is kept in a guessed place.
//
// Finding pinned by the first test: `mergeSubmission` replaces the whole chapter (`chapters[idx] = next`), so every
// block the submission does not carry is gone from the merged document; Markdown cannot carry a chart at all.
// Rule under test:
//   keep    a paragraph that is only `[[keep:<pid>]]` puts the old figure block at exactly that place (merge.ts);
//   refuse  a chapter submission that would lose a figure block is refused on the submit path with
//           PID_CONFLICT (422) reason FIGURE_BLOCKS_WOULD_BE_LOST and the list {id, kind, caption} (overwrite.ts);
//   remove  a paragraph that is only `[[remove:<pid>]]` removes the block on purpose.
// No DB: the seams are `mergeSubmission`, `findLostFigureBlocks`, `assertNoFigureBlocksLost`, and
// `assertNoPatchedOverwrite` with a transaction that fails the test if it is read.
import { describe, expect, test } from "bun:test"
import type { ChapterV2, StudioDocV2Resolved } from "../../vendor/src/lib/studio/contract"
import { STUDIO_ERROR_HTTP, StudioEngineError } from "../../vendor/src/lib/studio/contract/errors"
import { importMarkdownChapter } from "../../vendor/src/lib/studio/services/import/markdown"
import {
  FIGURE_LOSS_REASON,
  assertNoFigureBlocksLost,
  assertNoPatchedOverwrite,
  changedChapterPids,
  findLostFigureBlocks,
  intactFigurePids,
} from "../../vendor/src/lib/studio/services/submit/overwrite"
import { e1, merge } from "../ported/structure/_kit"

type S = Record<string, any>
const t = (text: string) => ({ text })
const source = () => ({ text: "Perhitungan uji row 74", provenance: ["HITUNG"] })
const CHART = { type: "chart", code: "P-02", data: { shape: "categorical", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }] }, caption: t("Beban daya per lokasi."), source: source() }
const DIAGRAM = { type: "diagram", spec: { family: "flow", nodes: [{ id: "a", label: "Deteksi" }, { id: "b", label: "Eskalasi" }], edges: [{ from: "a", to: "b" }] }, caption: t("Alur eskalasi kejadian."), source: source() }
const IMAGE = { type: "image", asset: `sha256:${"a".repeat(64)}`, caption: t("Denah ruang kendali."), source: source() }

/** Chapter 2 of E1 with: paragraph, chart, paragraph, diagram, image (one section). */
function baseDoc(): StudioDocV2Resolved {
  const d = e1()
  d.sections.content.chapters[1] = {
    key: "2",
    title: t("Perhitungan"),
    sections: [{ title: t("Daya"), blocks: [{ type: "paragraph", text: "Paragraf awal." }, CHART, { type: "paragraph", text: "Paragraf tengah." }, DIAGRAM, IMAGE] }],
  }
  return merge(d).doc
}
const chapter2 = (doc: StudioDocV2Resolved): ChapterV2 => ((doc.sections as S).content.chapters as ChapterV2[]).find((c) => c.key === "2")!
const blocks = (doc: StudioDocV2Resolved) => chapter2(doc).sections[0].blocks as S[]
const pidOf = (doc: StudioDocV2Resolved, type: string) => blocks(doc).find((b) => b.type === type)!.id as string
const MD_HEAD = "# Perhitungan\n\n## Daya\n\n"
/** A re-import: the real importer output, submitted as the chapter of an existing document. */
const reimport = (current: StudioDocV2Resolved, markdown: string) => {
  const r = importMarkdownChapter(markdown, { chapterKey: "2" })
  expect(r.validation.valid).toBe(true)
  return merge({ $schema: "studio.chapter/v2", target: { documentId: "d1" }, chapter: r.chapter }, current, { seed: "row74" })
}
const refusal = (fn: () => unknown): StudioEngineError => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(StudioEngineError)
    return e as StudioEngineError
  }
  throw new Error("expected a refusal, the call returned")
}

describe("row 74 finding: what mergeSubmission does with a re-import", () => {
  test("the merged chapter holds only what the Markdown carried: chart, diagram and image are gone", () => {
    const current = baseDoc()
    expect(blocks(current).map((b) => b.type)).toEqual(["paragraph", "chart", "paragraph", "diagram", "image"])
    const m = reimport(current, `${MD_HEAD}Paragraf awal.\n\nParagraf tengah.\n`)
    expect(m.changed).toBe(true)
    expect(blocks(m.doc).map((b) => b.type)).toEqual(["paragraph", "paragraph"])
    // mergeSubmission itself never refuses: PATCH (R16) goes through it and deletes blocks on purpose.
    expect(m.removedFigurePids).toEqual([])
  })
})

describe("row 74 refuse-with-list", () => {
  test("a re-import without the figures is refused; the list names each block by id, kind and caption", () => {
    const current = baseDoc()
    const m = reimport(current, `${MD_HEAD}Paragraf awal.\n\nParagraf tengah.\n`)
    const lost = findLostFigureBlocks(current, m)
    expect(lost).toEqual([
      { id: pidOf(current, "chart"), kind: "chart", caption: "Beban daya per lokasi.", chapterKey: "2", address: null },
      { id: pidOf(current, "diagram"), kind: "diagram", caption: "Alur eskalasi kejadian.", chapterKey: "2", address: null },
      { id: pidOf(current, "image"), kind: "image", caption: "Denah ruang kendali.", chapterKey: "2", address: null },
    ])
    const e = refusal(() => assertNoFigureBlocksLost({ current, merged: m, latestRevisionNo: 7, documentId: "d1" }))
    console.log(`[row74] refusal: ${e.code} ${e.message}`)
    expect(e.code).toBe("PID_CONFLICT")
    expect(STUDIO_ERROR_HTTP[e.code]).toBe(422)
    const d = e.details as S
    expect(d.reason).toBe(FIGURE_LOSS_REASON)
    expect(d.reason).toBe("FIGURE_BLOCKS_WOULD_BE_LOST")
    expect(d.scope).toBe("chapter:2")
    expect(d.lostBlocks).toEqual(lost)
    expect(d.keep).toEqual(lost.map((b) => `[[keep:${b.id}]]`))
    expect(d.remove).toEqual(lost.map((b) => `[[remove:${b.id}]]`))
    for (const b of lost) {
      expect(e.message).toContain(b.id)
      expect(e.message).toContain(b.caption)
    }
    expect(e.message).toContain(`[[keep:${lost[0].id}]]`)
    expect(e.message).toContain(`[[remove:${lost[0].id}]]`)
    expect(e.message).not.toContain("<") // the MCP tool escapes "<" in server text
    // Every marker of the refusal is ready to paste: sending the keep lines back keeps all three.
    const fixed = reimport(current, `${MD_HEAD}Paragraf awal.\n\n${(d.keep as string[]).join("\n\n")}\n`)
    expect(findLostFigureBlocks(current, fixed)).toEqual([])
    expect(d.forwardToController).toContain("3 grafik, diagram, atau gambar")
  })

  test("an unchanged neighbouring paragraph is not an anchor: the same text without the figures is still refused", () => {
    const current = baseDoc()
    // Both neighbours of the chart are byte-identical; the importer still has no place for it that is not a guess.
    const m = reimport(current, `${MD_HEAD}Paragraf awal.\n\nParagraf tengah.\n`)
    expect(findLostFigureBlocks(current, m).map((b) => b.kind)).toEqual(["chart", "diagram", "image"])
    expect(JSON.stringify(m.doc)).not.toContain("Beban daya per lokasi.")
  })

  test("the submit guard refuses before any store read and whatever the base: baseRevisionNo = latest does not allow the loss", async () => {
    const current = baseDoc()
    const m = reimport(current, `${MD_HEAD}Paragraf awal.\n`)
    const untouched = new Proxy({}, { get: (_, k) => () => { throw new Error(`store read ${String(k)} before the figure check`) } })
    const input = { documentId: "d1", latestRevisionNo: 7, baseRevisionNo: 7, current, merged: m, prevRows: { chapters: [], subsections: [], blocks: [] }, isRepeatableSlot: () => true }
    const e = await assertNoPatchedOverwrite(untouched as never, input as never).then(() => null, (x) => x)
    expect(e).toBeInstanceOf(StudioEngineError)
    expect((e as StudioEngineError).code).toBe("PID_CONFLICT")
    expect(((e as StudioEngineError).details as S).reason).toBe("FIGURE_BLOCKS_WOULD_BE_LOST")
    expect(((e as StudioEngineError).details as S).baseRevisionNo).toBe(7)
  })

  test("the address of each lost block comes from the revision rows when they are given", () => {
    const current = baseDoc()
    const m = reimport(current, `${MD_HEAD}Paragraf awal.\n`)
    const chart = pidOf(current, "chart")
    const rows = { chapters: [], subsections: [], blocks: [{ pid: chart, address: "2.1.2" }] }
    const e = refusal(() => assertNoFigureBlocksLost({ current, merged: m, latestRevisionNo: 7, prevRows: rows as never }))
    expect((e.details as S).lostBlocks[0]).toMatchObject({ id: chart, address: "2.1.2" })
    expect(e.message).toContain(`${chart} chart 2.1.2 "Beban daya per lokasi."`)
  })

  test("when one of two diagrams is dropped, the list names the one whose content is gone, not its neighbour", () => {
    const d = e1()
    const second = { ...DIAGRAM, caption: t("Lembar lanjutan pembumian."), spec: { ...DIAGRAM.spec, nodes: [{ id: "x", label: "Elektroda" }, { id: "y", label: "Batang" }], edges: [{ from: "x", to: "y" }] } }
    d.sections.content.chapters[1].sections[0].blocks = [{ type: "paragraph", text: "Awal." }, DIAGRAM, second]
    const current = merge(d).doc
    const [, first] = blocks(current)
    // The second diagram moves to the first one's index and inherits its pid by position (§10 rule 3).
    const m = merge({ $schema: "studio.chapter/v2", target: { documentId: "d1" }, chapter: { key: "2", title: t("Temuan Utama"), sections: [{ title: t("Transformator Daya"), blocks: [{ type: "paragraph", text: "Awal." }, second] }] } }, current, { seed: "row74" })
    expect(findLostFigureBlocks(current, m)).toEqual([{ id: first.id, kind: "diagram", caption: "Alur eskalasi kejadian.", chapterKey: "2", address: null }])
  })
})

describe("row 74 keep", () => {
  test("[[keep:<pid>]] puts each block at the place of its marker, with the same pid and content", () => {
    const current = baseDoc()
    const [chart, diagram, image] = ["chart", "diagram", "image"].map((k) => pidOf(current, k))
    const before = Object.fromEntries(blocks(current).filter((b) => b.type !== "paragraph").map((b) => [b.id, b]))
    // New text before and between the figures; the diagram now comes before the chart.
    const md = `${MD_HEAD}Paragraf baru di depan.\n\nParagraf awal ditulis ulang.\n\n[[keep:${diagram}]]\n\nParagraf tengah.\n\n[[keep:${chart}]]\n\n[[keep:${image}]]\n\nParagraf penutup.\n`
    const m = reimport(current, md)
    expect(blocks(m.doc).map((b) => b.type)).toEqual(["paragraph", "paragraph", "diagram", "paragraph", "chart", "image", "paragraph"])
    expect(blocks(m.doc)[2]).toEqual(before[diagram])
    expect(blocks(m.doc)[4]).toEqual(before[chart])
    expect(blocks(m.doc)[5]).toEqual(before[image])
    expect(JSON.stringify(m.doc)).not.toContain("[[keep:")
    expect(findLostFigureBlocks(current, m)).toEqual([])
    expect(() => assertNoFigureBlocksLost({ current, merged: m, latestRevisionNo: 7 })).not.toThrow()
    // Every pid is still unique and no other block took a figure's pid.
    const ids = blocks(m.doc).map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("the same Markdown with markers sent twice is unchanged the second time (idempotent)", () => {
    const current = baseDoc()
    const md = `${MD_HEAD}Paragraf awal.\n\n[[keep:${pidOf(current, "chart")}]]\n\nParagraf tengah.\n\n[[keep:${pidOf(current, "diagram")}]]\n\n[[keep:${pidOf(current, "image")}]]\n`
    const first = reimport(current, md)
    expect(first.changed).toBe(false) // identical to the stored chapter once the markers are resolved
    const moved = reimport(current, `${MD_HEAD}Paragraf awal.\n\nSisipan.\n\n[[keep:${pidOf(current, "chart")}]]\n\nParagraf tengah.\n\n[[keep:${pidOf(current, "diagram")}]]\n\n[[keep:${pidOf(current, "image")}]]\n`)
    expect(moved.changed).toBe(true)
    expect(reimport(moved.doc, `${MD_HEAD}Paragraf awal.\n\nSisipan.\n\n[[keep:${pidOf(current, "chart")}]]\n\nParagraf tengah.\n\n[[keep:${pidOf(current, "diagram")}]]\n\n[[keep:${pidOf(current, "image")}]]\n`).changed).toBe(false)
  })

  test("keeping one of three refuses with the two that are still missing", () => {
    const current = baseDoc()
    const m = reimport(current, `${MD_HEAD}Paragraf awal.\n\n[[keep:${pidOf(current, "chart")}]]\n`)
    expect(findLostFigureBlocks(current, m).map((b) => b.id)).toEqual([pidOf(current, "diagram"), pidOf(current, "image")])
  })

  test("a figure the submission carries itself is kept: identical content at another place, or the same caption with revised content", () => {
    const current = baseDoc()
    const revised = { ...CHART, data: { shape: "categorical", points: [{ label: "a", value: 5 }] } }
    const sub = { $schema: "studio.chapter/v2", target: { documentId: "d1" }, chapter: { key: "2", title: t("Perhitungan"), sections: [{ title: t("Daya"), blocks: [IMAGE, { type: "paragraph", text: "Satu." }, { type: "paragraph", text: "Dua." }, { type: "paragraph", text: "Tiga." }, DIAGRAM, { type: "paragraph", text: "Empat." }, revised] }] } }
    const m = merge(sub, current, { seed: "row74" })
    expect(findLostFigureBlocks(current, m)).toEqual([])
  })

  test("a kept figure that only moved is not a changed pid for the PATCH overwrite rule", () => {
    const current = baseDoc()
    const chart = pidOf(current, "chart")
    const m = reimport(current, `${MD_HEAD}Paragraf awal.\n\nSisipan.\n\n[[keep:${chart}]]\n\nParagraf tengah.\n\n[[keep:${pidOf(current, "diagram")}]]\n\n[[keep:${pidOf(current, "image")}]]\n`)
    expect(changedChapterPids(current, m.doc, new Set(["2"])).has(chart)).toBe(true) // its index moved
    expect(intactFigurePids(current, m.doc, new Set(["2"]))).toEqual(new Set([chart, pidOf(current, "diagram"), pidOf(current, "image")]))
  })

  test("a marker inside a sentence is plain text, not a marker", () => {
    const current = baseDoc()
    const chart = pidOf(current, "chart")
    const m = reimport(current, `${MD_HEAD}Lihat [[keep:${chart}]] di bawah.\n`)
    expect(blocks(m.doc).map((b) => b.type)).toEqual(["paragraph"])
    expect(findLostFigureBlocks(current, m).map((b) => b.id)).toContain(chart)
  })

  test("a marker that names no figure block of the chapter is refused with the valid pids", () => {
    const current = baseDoc()
    const paragraph = blocks(current)[0].id as string
    for (const pid of ["p-tidakada00", paragraph]) {
      const e = refusal(() => reimport(current, `${MD_HEAD}Awal.\n\n[[keep:${pid}]]\n`))
      expect(e.code).toBe("PID_NOT_FOUND")
      expect((e.details as S).figurePids).toEqual([pidOf(current, "chart"), pidOf(current, "diagram"), pidOf(current, "image")])
      expect((e.details as S).pointer).toBe("/chapter/sections/0/blocks/1")
      expect(e.message).toContain(`[[keep:${pid}]]`)
    }
  })

  test("one block named by two markers is refused", () => {
    const current = baseDoc()
    const chart = pidOf(current, "chart")
    expect(refusal(() => reimport(current, `${MD_HEAD}[[keep:${chart}]]\n\n[[keep:${chart}]]\n`)).code).toBe("PID_CONFLICT")
    expect(refusal(() => reimport(current, `${MD_HEAD}[[keep:${chart}]]\n\n[[remove:${chart}]]\n`)).code).toBe("PID_CONFLICT")
  })
})

describe("row 74 deliberate removal", () => {
  test("[[remove:<pid>]] removes that block on purpose; the others still have to be kept or removed", () => {
    const current = baseDoc()
    const [chart, diagram, image] = ["chart", "diagram", "image"].map((k) => pidOf(current, k))
    const m = reimport(current, `${MD_HEAD}Paragraf awal.\n\n[[remove:${chart}]]\n\n[[keep:${diagram}]]\n\n[[keep:${image}]]\n`)
    expect(blocks(m.doc).map((b) => b.type)).toEqual(["paragraph", "diagram", "image"])
    expect(m.removedFigurePids).toEqual([chart])
    expect(JSON.stringify(m.doc)).not.toContain("[[remove:")
    expect(JSON.stringify(m.doc)).not.toContain("Beban daya per lokasi.")
    expect(findLostFigureBlocks(current, m)).toEqual([])
    expect(() => assertNoFigureBlocksLost({ current, merged: m, latestRevisionNo: 7 })).not.toThrow()

    const partial = reimport(current, `${MD_HEAD}Paragraf awal.\n\n[[remove:${chart}]]\n`)
    expect(findLostFigureBlocks(current, partial).map((b) => b.id)).toEqual([diagram, image])
  })

  test("a chapter without figure blocks, and a submission to another chapter, are never refused", () => {
    const current = baseDoc()
    const other = merge({ $schema: "studio.chapter/v2", target: { documentId: "d1" }, chapter: { key: "1", title: t("Lingkup Survei"), sections: [{ title: t("Tujuan"), blocks: [{ type: "paragraph", text: "Ditulis ulang." }] }] } }, current, { seed: "row74" })
    expect(other.scopes).toEqual(["chapter:1"])
    expect(findLostFigureBlocks(current, other)).toEqual([])
    expect(blocks(other.doc).map((b) => b.type)).toEqual(["paragraph", "chart", "paragraph", "diagram", "image"])
  })
})
