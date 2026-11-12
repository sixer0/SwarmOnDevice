// Swarm 1.2.6 row 29 (T-13, N-031/N-032, E-14): OVERLAP_CLIP measures a document too large for one measure in page
// batches and reports `coverage` instead of UNKNOWN MEASURE_TRUNCATED for the whole document.
// Red at BASE e363918a69: one measure of the whole document, truncated, UNKNOWN for every page and no coverage.
// The two page scripts are injected fakes (`OverlapClipDeps`): a fake measure that truncates above an element cap
// and a fake overlap script that truncates above a box cap, both deterministic functions of the HTML they receive.
// The document is the row 24 synthetic large document (fixtures/anon126/t13_k1.ts, >= 217 pages) laid out as Studio
// flow units (`section.st-unit`, each starting on a new page, V/engine/html/assemble/index.ts:15-16).
import { describe, expect, it } from "bun:test"
import { bigDocChapters, type BigDocChapter } from "../fixtures/anon126/t13_k1"
import * as overlapClip from "../../src/mcp-host/verify/overlap-clip"
import { runOverlapClip, type OverlapCheckPageCall } from "../../src/mcp-host/verify/overlap-clip"
import type { MeasuredLayout, MeasureOptions } from "../../vendor/src/lib/studio/engine/browser/index"

// Namespace reads, so the file loads at BASE (where these names do not exist) and fails on behaviour, not on import.
const MEASURE_BATCH_PAGES = (overlapClip as Record<string, unknown>).MEASURE_BATCH_PAGES as number
const pageSlices = (overlapClip as Record<string, unknown>).pageSlices as typeof import("../../src/mcp-host/verify/overlap-clip").pageSlices

const A4 = { pageWidthMm: 210, pageHeightMm: 297 }
const WORDS_PER_PAGE = 450
/** Fake caps standing for measure's 20000 elements and the overlap script's 5000 boxes, scaled to the fake counts. */
const MEASURE_CAP = 1000
const BOX_CAP = 1200

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Markdown of the generator as Studio-like flow HTML: one unit per chapter, addressed blocks. */
function chapterHtml(c: BigDocChapter, ci: number): string {
  const out: string[] = [`<section class="st-unit" data-unit data-unit-key="ch${ci + 1}"><h1>${esc(c.title)}</h1>`]
  let rows: string[] = []
  const flush = () => {
    if (rows.length) out.push(`<table class="st-table" data-address="${ci + 1}/t${out.length}">${rows.join("")}</table>`)
    rows = []
  }
  for (const line of c.markdown.split("\n")) {
    if (line.startsWith("| ---")) continue
    if (line.startsWith("|")) {
      rows.push(`<tr>${line.split("|").slice(1, -1).map((x) => `<td>${esc(x.trim())}</td>`).join("")}</tr>`)
      continue
    }
    flush()
    if (line.startsWith("## ")) out.push(`<h2 data-address="${ci + 1}/h${out.length}">${esc(line.slice(3))}</h2>`)
    else if (line.trim()) out.push(`<p data-address="${ci + 1}/p${out.length}">${esc(line)}</p>`)
  }
  flush()
  out.push("</section>")
  return out.join("\n")
}

function docHtml(chapters: BigDocChapter[]): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\"><style>@page{size:A4;margin:20mm}.st-unit{break-before:page}</style></head><body>",
    ...chapters.map(chapterHtml),
    "</body></html>",
  ].join("\n")
}

/** Units of an HTML piece: words and block elements per `section.st-unit` (a split unit counts its own part). */
function units(html: string): Array<{ words: number; elements: number; key: string }> {
  const body = html.slice(html.indexOf("<body>"))
  return body
    .split(/<section class="st-unit"/)
    .slice(1)
    .map((u) => {
      const text = u.replace(/<[^>]*>/g, " ")
      return {
        words: text.match(/\p{L}+/gu)?.length ?? 0,
        elements: (u.match(/<(p|h1|h2|tr)\b/g) ?? []).length,
        key: /data-unit-key="([^"]+)"/.exec(u)?.[1] ?? "?",
      }
    })
}

const pagesOf = (html: string) => units(html).reduce((a, u) => a + Math.max(1, Math.ceil(u.words / WORDS_PER_PAGE)), 0)
const elementsOf = (html: string) => units(html).reduce((a, u) => a + u.elements, 0)

interface Fakes {
  measure: (html: string, o: MeasureOptions) => Promise<MeasuredLayout>
  checkPage: (call: OverlapCheckPageCall) => Promise<unknown>
  calls: { measure: number; overlap: number }
}

/** Flow-document fakes: pageCount from the print count (words), truncation above the caps; `denseKey` doubles a unit. */
function fakes(o: { denseKey?: string; boxCap?: number } = {}): Fakes {
  const calls = { measure: 0, overlap: 0 }
  const weight = (html: string) => elementsOf(html) + (o.denseKey ? units(html).filter((u) => u.key === o.denseKey).reduce((a, u) => a + u.elements * 20, 0) : 0)
  return {
    calls,
    measure: async (html) => {
      calls.measure++
      const n = weight(html)
      return {
        paged: false,
        pageCount: pagesOf(html),
        pageCountSource: "print",
        truncated: n > MEASURE_CAP,
        elements: [{ kind: "document", xMm: 0, yMm: 0, widthMm: 210, heightMm: 297 * pagesOf(html), colors: [], overflow: false }],
        blockedRequests: 0,
        viewportWidthPx: 794,
        media: "screen",
      } as unknown as MeasuredLayout
    },
    checkPage: async (call) => {
      calls.overlap++
      const n = weight(call.html)
      return {
        paged: false,
        pageCount: 0,
        truncated: n > (o.boxCap ?? BOX_CAP),
        marginsUnreadable: false,
        contentHeightMm: 257,
        boxes: Math.min(n, o.boxCap ?? BOX_CAP),
        scanned: n,
        findingsTotal: 0,
        findings: [],
        viewportPx: 794,
        layoutWidthPx: 794,
      }
    },
  }
}

const CHAPTERS = bigDocChapters()
const BIG = docHtml(CHAPTERS)
const TOTAL = pagesOf(BIG)

describe("1.2.6 row 29 T-13: OVERLAP_CLIP in page batches", () => {
  it("the synthetic document has at least 217 pages and is too large for one measure", () => {
    expect(TOTAL).toBeGreaterThanOrEqual(217)
    expect(elementsOf(BIG)).toBeGreaterThan(MEASURE_CAP)
    expect(MEASURE_BATCH_PAGES).toBe(20)
  })

  it("measures every page in batches: coverage all pages, PASS instead of UNKNOWN MEASURE_TRUNCATED", async () => {
    const f = fakes()
    const r = await runOverlapClip({ format: "HTML", html: BIG, ...A4 }, f)
    const cov = (r.check as { coverage?: { measuredPages: number; totalPages: number } }).coverage
    expect(cov).toEqual({ measuredPages: TOTAL, totalPages: TOTAL })
    expect(cov!.measuredPages / cov!.totalPages).toBeGreaterThanOrEqual(0.9)
    expect(r.check).toMatchObject({ id: "OVERLAP_CLIP", status: "PASS", reason: null })
    // Whole document once, then about TOTAL / MEASURE_BATCH_PAGES batches.
    expect(f.calls.measure).toBeGreaterThanOrEqual(1 + Math.ceil(TOTAL / MEASURE_BATCH_PAGES))
    expect(f.calls.measure).toBe(f.calls.overlap)
    // The whole document's layout still feeds PAGE_COUNT / FIGURE_FIT (row 150).
    expect(r.layout).toMatchObject({ metrics: { pageCount: TOTAL, truncated: true } })
  })

  it("a batch that still truncates is split once more; pages left unmeasured keep MEASURE_TRUNCATED (E-14), >= 90 % measured", async () => {
    // Chapter 7 is 21x as dense: its batch truncates, its halves truncate too, so its pages stay unmeasured.
    const f = fakes({ denseKey: "ch7" })
    const r = await runOverlapClip({ format: "HTML", html: BIG, ...A4 }, f)
    const cov = (r.check as { coverage?: { measuredPages: number; totalPages: number } }).coverage!
    const ch7 = pagesOf(docHtml([CHAPTERS[6]]))
    expect(cov.totalPages).toBe(TOTAL)
    expect(cov.measuredPages).toBeLessThan(TOTAL)
    expect(cov.measuredPages).toBeGreaterThanOrEqual(TOTAL - 2 * ch7 - 2 * MEASURE_BATCH_PAGES)
    expect(cov.measuredPages / cov.totalPages).toBeGreaterThanOrEqual(0.9)
    expect(r.check).toMatchObject({ status: "UNKNOWN", reason: "MEASURE_TRUNCATED" })
  })

  it("a single dense unit is split at its own children once", async () => {
    // Every unit fits alone except at a tight cap: the batch of one unit splits into two halves of its blocks.
    const one = docHtml([CHAPTERS[0], CHAPTERS[1]])
    const perUnit = units(one)[0].elements
    const f = fakes({ boxCap: Math.ceil(perUnit * 0.75) })
    const r = await runOverlapClip({ format: "HTML", html: one, ...A4 }, f)
    const cov = (r.check as { coverage?: { measuredPages: number; totalPages: number } }).coverage!
    expect(cov.totalPages).toBe(pagesOf(one))
    expect(cov.measuredPages).toBe(cov.totalPages)
    expect(r.check.status).toBe("PASS")
  })

  it("findings of every batch are merged; sheet pages are offset to the document", async () => {
    const sheet = (k: number) => `<section class="page" data-page><div class="body"><p data-address="s${k}/p1">x</p></div></section>`
    const html = `<!doctype html><html><head></head><body>${Array.from({ length: 60 }, (_, k) => sheet(k + 1)).join("\n")}</body></html>`
    const sheetsIn = (h: string) => (h.match(/<section class="page"/g) ?? []).length
    const sheetEls = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "page", page: i + 1, xMm: 0, yMm: i * 297, widthMm: 210, heightMm: 297, colors: ["#101418"], label: "page", overflow: false }))
    const firstIn = (h: string) => Number(/data-address="s(\d+)\/p1"/.exec(h)?.[1] ?? 0)
    const r = await runOverlapClip(
      { format: "HTML", html, ...A4 },
      {
        measure: async (h) =>
          ({ paged: true, pageCount: sheetsIn(h), pageCountSource: "elements", truncated: sheetsIn(h) > 25, elements: sheetEls(sheetsIn(h)) }) as unknown as MeasuredLayout,
        checkPage: async (call) => {
          const n = sheetsIn(call.html)
          // One overlap on document sheet 47, reported by the script on the sheet's place within the piece it saw.
          const at = 47 - firstIn(call.html) + 1
          const findings = at >= 1 && at <= n ? [{ code: "OVERLAP", page: at, address: "s47/p1", label: "x", kind: "text", address2: "s47/p2", label2: "y", kind2: "text", areaMm2: 4 }] : []
          return { paged: true, pageCount: n, truncated: n > 25, marginsUnreadable: false, contentHeightMm: 257, boxes: n, scanned: n, findingsTotal: findings.length, findings, viewportPx: 794, layoutWidthPx: 794 }
        },
      },
    )
    expect(r.check.status).toBe("FAIL")
    expect(r.check.findings).toEqual([expect.objectContaining({ code: "OVERLAP", page: 47, address: "s47/p1" })])
    expect((r.check as { coverage?: unknown }).coverage).toEqual({ measuredPages: 60, totalPages: 60 })
  })

  it("pageSlices keeps the document byte for byte and refuses what it cannot split", () => {
    const s = pageSlices(BIG)!
    expect(s.batch.segs.length).toBe(CHAPTERS.length)
    expect(s.head + s.batch.segs.map((g) => BIG.slice(g.start, g.end)).join("") + s.tail).toBe(BIG)
    expect(pageSlices("<html><body><div class=\"page\"><p>a</p></div></body></html>")).toBeNull()
    expect(pageSlices("<html><body><div><p>a</div></body></html>")).toBeNull()
    expect(pageSlices("no markup")).toBeNull()
  })
})
