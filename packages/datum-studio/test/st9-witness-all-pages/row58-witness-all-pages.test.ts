/**
 * Patch 1.3.3 row 58 (ST-9 item 1): a witness image for EVERY page that carries a figure or chart, no cap of 12.
 *
 * What is exercised: the page selection (`figurePages`), the batching and the witness list of `verifyOutputs`, and
 * `readWitnessManifest`. What is NOT: the real rasteriser. The bridge (Electron) is absent here, so the page imager
 * and the measure are injected; the fake imager enforces the bridge's own limit of 12 pages per request
 * (desktop datum-render/protocol.ts:181) and writes a small file per page.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FidelityExpectation } from "../../src/mcp-host/verify/fidelity"
import type { LayoutInput } from "../../src/mcp-host/verify/static-checks"
import {
  choosePages,
  figurePages,
  readWitnessManifest,
  VERIFY_MAX_PAGE_IMAGES,
  VERIFY_PAGE_IMAGE_BATCH,
  VERIFY_WITNESS_DPI,
  VERIFY_WITNESS_MANIFEST,
  verifyOutputs,
  type PageImager,
  type VerifyJobInput,
} from "../../src/mcp-host/verify/verify-outputs"

const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "row58-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

type El = { kind: string; page?: number; label?: string; address?: string; xMm: number; yMm: number; widthMm: number; heightMm: number }
const box = { xMm: 20, yMm: 30, widthMm: 100, heightMm: 60 }
const pageEl = (n: number): El => ({ kind: "page", page: n, xMm: 0, yMm: 0, widthMm: 210, heightMm: 297 })
const textEl = (n: number): El => ({ kind: "text", page: n, label: "p", ...box })
const figEl = (n: number, label: string, address?: string): El => ({ kind: "figure", page: n, label, ...(address ? { address } : {}), ...box })
const imgEl = (n: number, address: string): El => ({ kind: "image", page: n, label: "st-img", address, ...box })

function layoutOf(pageCount: number, extra: El[], o: { paged?: boolean; truncated?: boolean } = {}): LayoutInput {
  const elements: El[] = []
  for (let n = 1; n <= pageCount; n++) elements.push(pageEl(n), textEl(n))
  elements.push(...extra)
  return { metrics: { pageCount, paged: o.paged ?? true, pageCountSource: "elements", truncated: o.truncated ?? false, elements } } as unknown as LayoutInput
}

function expectation(blocks: Array<{ type: string; blockId: string; address: string; artifactLabel?: string }>): FidelityExpectation {
  return { language: "ID", blocks: blocks.map((b, i) => ({ ...b, content: {}, ordinal: i })) }
}

describe("row 58: figurePages (which pages carry a figure or chart)", () => {
  test("a 20-page document with 9 figures on 9 pages gives exactly those 9 pages", () => {
    const pages = [2, 4, 5, 8, 11, 13, 16, 18, 20]
    const types = ["chart", "diagram", "symbolSheet"]
    const blocks = pages.map((_, i) => ({ type: types[i % 3]!, blockId: `b${i}`, address: `bab-1/blok-${i}`, artifactLabel: `Gambar ${i + 1}` }))
    // A logo svg on the cover and an unrelated icon: not figure blocks, so not figure pages.
    const els = [figEl(1, "logo"), figEl(7, "svg"), ...pages.map((p, i) => figEl(p, `Gambar ${i + 1}`, `bab-1/blok-${i}`))]
    const sel = figurePages(layoutOf(20, els), expectation([...blocks, { type: "paragraph", blockId: "t1", address: "bab-1/blok-99" }]))
    expect(sel.basis).toBe("snapshot")
    expect(sel.pages.map((p) => p.page)).toEqual(pages)
    expect(sel.pages[0]).toEqual({ page: 2, figures: ["Gambar 1"] })
    expect(sel.unplaced).toEqual([])
    expect(sel.reason).toBeNull()
  })

  test("40 figure pages are all selected: nothing is cut at 12", () => {
    const blocks = Array.from({ length: 40 }, (_, i) => ({ type: "chart", blockId: `c${i}`, address: `bab-2/blok-${i}`, artifactLabel: `Grafik ${i + 1}` }))
    const els = blocks.map((b, i) => figEl(i + 5, b.artifactLabel, b.address))
    const sel = figurePages(layoutOf(48, els), expectation(blocks))
    expect(sel.pages).toHaveLength(40)
    expect(sel.pages.length).toBeGreaterThan(VERIFY_MAX_PAGE_IMAGES)
    expect(sel.pages.map((p) => p.page)).toEqual(Array.from({ length: 40 }, (_, i) => i + 5))
  })

  test("two figures on one page give one page with both labels; a raster image block is found by its address", () => {
    const blocks = [
      { type: "chart", blockId: "c1", address: "a/1", artifactLabel: "Grafik 1" },
      { type: "diagram", blockId: "d1", address: "a/2", artifactLabel: "Gambar 1" },
      { type: "image", blockId: "i1", address: "a/3", artifactLabel: "Gambar 2" },
    ]
    const sel = figurePages(layoutOf(6, [figEl(3, "Grafik 1"), figEl(3, "Gambar 1"), imgEl(5, "a/3")]), expectation(blocks))
    expect(sel.pages).toEqual([
      { page: 3, figures: ["Grafik 1", "Gambar 1"] },
      { page: 5, figures: ["Gambar 2"] },
    ])
  })

  test("a figure block that is on no page is named in unplaced; the block id also matches the label", () => {
    const blocks = [
      { type: "chart", blockId: "c1", address: "a/1" },
      { type: "chart", blockId: "c2", address: "a/2", artifactLabel: "Grafik 2" },
    ]
    const sel = figurePages(layoutOf(4, [figEl(2, "c1")]), expectation(blocks))
    expect(sel.pages).toEqual([{ page: 2, figures: ["c1"] }])
    expect(sel.unplaced).toEqual(["Grafik 2"])
  })

  test("no snapshot, or figure blocks that match nothing: every svg and img page (markup); no figure block: none", () => {
    const els = [figEl(1, "logo"), figEl(4, "x"), imgEl(9, "a/9")]
    const noSnap = figurePages(layoutOf(10, els), null)
    expect(noSnap.basis).toBe("markup")
    expect(noSnap.pages.map((p) => p.page)).toEqual([1, 4, 9])
    const noMatch = figurePages(layoutOf(10, els), expectation([{ type: "chart", blockId: "zz", address: "q/1", artifactLabel: "Grafik 1" }]))
    expect(noMatch.basis).toBe("markup")
    expect(noMatch.pages.map((p) => p.page)).toEqual([1, 4, 9])
    const noFigure = figurePages(layoutOf(10, els), expectation([{ type: "paragraph", blockId: "t", address: "q/2" }]))
    expect(noFigure).toEqual({ pages: [], basis: "snapshot", unplaced: [], reason: null })
  })

  test("not known: flow layout, no metrics; truncated measure says so; out-of-range pages are ignored", () => {
    expect(figurePages(layoutOf(5, [figEl(2, "x")], { paged: false }), null)).toEqual({ pages: [], basis: "none", unplaced: [], reason: "flow layout: the measure gives no page per figure" })
    expect(figurePages(null, null).basis).toBe("none")
    expect(figurePages({ unknown: "BUDGET_EXCEEDED" } as LayoutInput, null).reason).toBe("page count not measured")
    const t = figurePages(layoutOf(5, [figEl(2, "x"), figEl(9, "y"), figEl(0, "z")], { truncated: true }), null)
    expect(t.pages.map((p) => p.page)).toEqual([2])
    expect(t.reason).toBe("measure truncated: figure pages may be incomplete")
  })
})

// ── verifyOutputs with the measure and the page imager injected ─────────────────────────────────────────────

interface Call {
  pages: number[]
  dpi: number | undefined
}

/** Fake bridge imager: refuses more than 12 pages per request like the real bridge, writes one small file per page. */
function fakeImager(pageCount: number, o: { hangFromCall?: number; throwFromCall?: number; skip?: number[] } = {}) {
  const calls: Call[] = []
  let active = 0
  let peak = 0
  const imager: PageImager = async (req) => {
    calls.push({ pages: [...(req.pages ?? [])], dpi: req.dpi })
    if (!req.pages || req.pages.length === 0 || req.pages.length > 12) throw new Error("pages must list 1..12 page numbers")
    if (o.throwFromCall !== undefined && calls.length >= o.throwFromCall) throw new Error("bridge gone")
    if (o.hangFromCall !== undefined && calls.length >= o.hangFromCall) await new Promise(() => undefined)
    active++
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 1))
    const pages = req.pages
      .filter((n) => n <= pageCount && !(o.skip ?? []).includes(n))
      .map((n) => {
        const png = join(req.dstDir, `p${String(n).padStart(3, "0")}.png`)
        writeFileSync(png, `png ${n}`)
        return { n, png, width: 1239, height: 1753, sha256: "0".repeat(64) }
      })
    active--
    return { layout: "paged" as const, pageCount, pageSizeMm: { wMm: 210, hMm: 297 }, pageSizeSource: "css" as const, dpi: req.dpi ?? 150, pages }
  }
  return { imager, calls, peak: () => peak }
}

function job(id: string, pageCount: number): VerifyJobInput {
  const dir = join(root, id)
  const html = `<html><body>${Array.from({ length: pageCount }, () => '<section class="page"><p>x</p></section>').join("")}</body></html>`
  const bytes = new TextEncoder().encode(html)
  return {
    documentId: `doc-${id}`,
    revisionNo: 3,
    renderJobId: null,
    scope: "DOCUMENT",
    draft: false,
    formatsAdded: [],
    tier: null,
    lintReport: null,
    completeness: null,
    completenessReport: null,
    snapshot: null,
    outputs: [{ id: `html-${id}`, format: "HTML", role: "PRIMARY", figureLabel: null, sha256: "a".repeat(64), lintVerdict: null, bytes, absPath: join(dir, "doc.html") }],
    storeRoot: dir,
  }
}

async function run(id: string, pageCount: number, figureOn: number[], im: ReturnType<typeof fakeImager>, budgetMs = 30_000) {
  const layout = layoutOf(pageCount, figureOn.map((p, i) => figEl(p, `Gambar ${i + 1}`)))
  const metrics = (layout as { metrics: unknown }).metrics
  return verifyOutputs(job(id, pageCount), {
    budgetMs,
    pageImages: im.imager,
    overlapDeps: { measure: async () => metrics as never, checkPage: async () => ({}) },
  })
}

describe("row 58: verifyOutputs makes a witness for every figure page", () => {
  test("20 pages, 9 figure pages: 9 witnesses, each an existing PNG at 150 dpi, and the stored list matches", async () => {
    const figs = [2, 4, 5, 8, 11, 13, 16, 18, 20]
    const im = fakeImager(20)
    const r = await run("a20", 20, figs, im)
    expect(r.witness).not.toBeNull()
    const w = r.witness!
    expect(w.pages.map((p) => p.page)).toEqual(figs)
    expect(w.pages).toHaveLength(9)
    expect(w.missing).toEqual([])
    expect(w.dpi).toBe(VERIFY_WITNESS_DPI)
    for (const p of w.pages) {
      expect(existsSync(p.png)).toBe(true)
      expect(p.figures.length).toBe(1)
    }
    expect(im.calls.every((c) => c.dpi === 150 && c.pages.length <= VERIFY_PAGE_IMAGE_BATCH)).toBe(true)
    // Figure pages go first; the general pages of row 151b are still made on top.
    for (const n of figs) expect(im.calls[0]!.pages).toContain(n)
    expect(im.calls[0]!.pages).toHaveLength(12)
    const html = r.report.outputs[0]!
    for (const n of figs) expect(html.pages.find((p) => p.n === n)!.png).toBe(w.pages.find((p) => p.page === n)!.png)
    const stored = readWitnessManifest(join(root, "a20"), "html-a20")!
    expect(stored.pages).toEqual(w.pages)
    expect(stored.documentId).toBe("doc-a20")
    expect(stored.revisionNo).toBe(3)
    expect(JSON.parse(readFileSync(join(root, "a20", "verify", "html-a20", VERIFY_WITNESS_MANIFEST), "utf8")).$schema).toBe("studio.verify.witness/v1")
  })

  test("48 pages, 40 figure pages: 40 witnesses (not 12), in requests of at most 12 pages, one at a time", async () => {
    const figs = Array.from({ length: 40 }, (_, i) => i + 5)
    const im = fakeImager(48)
    const r = await run("b48", 48, figs, im)
    const w = r.witness!
    expect(w.pages).toHaveLength(40)
    expect(w.pages.map((p) => p.page)).toEqual(figs)
    expect(w.missing).toEqual([])
    expect(im.calls.length).toBeGreaterThanOrEqual(4)
    expect(Math.max(...im.calls.map((c) => c.pages.length))).toBeLessThanOrEqual(12)
    expect(im.peak()).toBe(1)
    expect(r.pageImages.made).toBeGreaterThanOrEqual(40)
    expect(r.pageImages.reason).toBeNull()
    expect(r.report.bridgeJobs).toBeGreaterThanOrEqual(im.calls.length)
  })

  test("no figure: the same pages as before this row (choosePages), one request, an empty witness list", async () => {
    const im = fakeImager(40)
    const r = await run("c40", 40, [], im)
    expect(im.calls).toHaveLength(1)
    expect(im.calls[0]!.pages).toEqual(choosePages(40, []))
    expect(im.calls[0]!.pages).toHaveLength(12)
    expect(r.witness!.pages).toEqual([])
    expect(r.witness!.missing).toEqual([])
    expect(r.pageImages.note).toContain("not imaged (at most 12 images per render)")
  })

  test("the budget runs out in the second request: witnesses made so far stay, the rest are named as missing", async () => {
    const figs = Array.from({ length: 30 }, (_, i) => i + 1)
    const im = fakeImager(30, { hangFromCall: 2 })
    const r = await run("d30", 30, figs, im, 400)
    const w = r.witness!
    expect(w.pages.map((p) => p.page)).toEqual(figs.slice(0, 12))
    expect(w.missing).toEqual(figs.slice(12))
    expect(w.reason).toBe("BUDGET_EXCEEDED")
    expect(r.pageImages.made).toBe(12)
    expect(r.pageImages.note).toContain("have no witness image (BUDGET_EXCEEDED)")
    expect(im.calls).toHaveLength(2)
    expect(readWitnessManifest(join(root, "d30"), "html-d30")!.missing).toEqual(figs.slice(12))
  })

  test("the bridge fails on the first request: no image, the reason is given, every figure page is missing", async () => {
    const im = fakeImager(10, { throwFromCall: 1 })
    const r = await run("e10", 10, [3, 7], im)
    expect(r.pageImages.made).toBe(0)
    expect(typeof r.pageImages.reason).toBe("string")
    expect(r.witness!.pages).toEqual([])
    expect(r.witness!.missing).toEqual([3, 7])
  })

  test("a figure page the bridge returns no image for is missing, not silently dropped", async () => {
    const im = fakeImager(10, { skip: [7] })
    const r = await run("f10", 10, [3, 7], im)
    expect(r.witness!.pages.map((p) => p.page)).toEqual([3])
    expect(r.witness!.missing).toEqual([7])
    expect(r.pageImages.note).toContain("figure pages 7 have no witness image (the bridge returned no image)")
  })

  test("page images off: no witness list", async () => {
    const r = await verifyOutputs(job("g5", 5), { pageImages: null, overlapDeps: { measure: async () => (layoutOf(5, []) as { metrics: unknown }).metrics as never, checkPage: async () => ({}) } })
    expect(r.witness).toBeNull()
    expect(r.pageImages.reason).toBe("page images are off")
  })
})

describe("row 58: readWitnessManifest (seam of row 59)", () => {
  test("a deleted image moves to missing; a bad id or an absent list gives null", async () => {
    const im = fakeImager(8)
    const r = await run("h8", 8, [2, 6], im)
    unlinkSync(r.witness!.pages[1]!.png)
    const w = readWitnessManifest(join(root, "h8"), "html-h8")!
    expect(w.pages.map((p) => p.page)).toEqual([2])
    expect(w.missing).toEqual([6])
    expect(readWitnessManifest(join(root, "h8"), "../html-h8")).toBeNull()
    expect(readWitnessManifest(join(root, "h8"), "nothing")).toBeNull()
  })

  test("a stored path pointing elsewhere is not followed: only the file name inside the folder counts", async () => {
    const im = fakeImager(4)
    await run("i4", 4, [2], im)
    const f = join(root, "i4", "verify", "html-i4", VERIFY_WITNESS_MANIFEST)
    const j = JSON.parse(readFileSync(f, "utf8"))
    j.pages[0].png = "/etc/passwd"
    writeFileSync(f, JSON.stringify(j))
    const w = readWitnessManifest(join(root, "i4"), "html-i4")!
    expect(w.pages).toEqual([])
    expect(w.missing).toEqual([2])
  })
})
