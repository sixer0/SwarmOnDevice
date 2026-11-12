// Row 165O (C203, findings F165N-1 and F165N-2 of verification/27_row165n_final_recheck.md): two gate rules.
//   F165N-1: FIDELITY expects the cover document number by the engine's own rule since row 165J (meta.docNumber in the
//            cover control block, `controlRowsWithDocNumber`, the same helper), so a cover slot number that differs
//            from meta is no longer a NUMBER_CHANGED; a number in the output that differs from meta still is.
//   F165N-2: DATUM-15 with no multi-line interior body paragraph on a measured layout is REPORT "tidak berlaku" (not
//            NOT_RUN), so LINT is not UNKNOWN (LINT_PARTIAL) for that reason alone; a failed or truncated measure
//            stays NOT_RUN -> LINT UNKNOWN; a long interior paragraph stays FAIL.
//   C204 item 4 (F-Y3): figure hatch lines (and the other stroke-only lines of the diagram engine) carry fill="none";
//            no painted figure element falls back to the SVG default black fill.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { checkFidelity, coverContentWithDocNumber, fidelityExpectationFromSnapshot } from "../../../src/mcp-host/verify/fidelity"
import { checkLint } from "../../../src/mcp-host/verify/static-checks"
import { lintRenderedWith, RENDER_LINT_DEFAULTS } from "../../../vendor/src/lib/studio/engine/lint/render/index"

const K = await import("../row143a/_kit")

const META_NO = "016/GSP/KT/XI/2026"
const SLOT_NO = "012/GSP/KT/XI/2026"
const findingsOf = (c: { findings: Array<{ code: string; address: string | null; detail: string }> }) => c.findings.map((f) => `${f.code} ${f.address} ${f.detail}`)

/** Case 01 material with meta 016 while the cover control slot keeps the sample number 012 (row 165N case 06). */
async function case06() {
  const doc = JSON.parse(JSON.stringify(K.loadCase("case01.json")))
  expect(doc.meta.docNumber).toBe(SLOT_NO)
  expect(doc.sections.cover.control[0][1].text).toBe(SLOT_NO)
  doc.meta.docNumber = META_NO
  const snap = K.compose(doc)
  return { snap, html: await K.renderHtml(snap), docx: await K.renderDocx(snap) }
}

/** Replace the cover control value cell's number (the cell the engine sets from meta); the other 016 are register/meta. */
function coverNumberAs(html: string, to: string): string {
  // Row 165O item 3 (C204): the number is the first line of the cell (`div.st-control-line`), the classification the second.
  const cell = `data-role="cover.controlValue"><div class="st-control-line">${META_NO}<`
  expect(html.split(cell).length - 1).toBe(1)
  return html.replace(cell, `data-role="cover.controlValue"><div class="st-control-line">${to}<`)
}

function replaceInDocx(docx: Uint8Array, from: string, to: string): Uint8Array {
  const files = unzipSync(docx)
  const xml = strFromU8(files["word/document.xml"])
  expect(xml.split(from).length - 1).toBe(1)
  return zipSync({ ...files, "word/document.xml": strToU8(xml.replace(from, to)) })
}

describe("F165N-1 FIDELITY follows the engine's document-number rule on the cover", () => {
  test("meta 016, cover slot 012: the engine prints 016; FIDELITY PASS on HTML, PDF (same-job HTML) and DOCX", async () => {
    const { snap, html, docx } = await case06()
    expect(html.includes(META_NO)).toBe(true)
    const expected = fidelityExpectationFromSnapshot(snap)
    expect(expected.docNumber).toBe(META_NO)
    for (const [format, source] of [["HTML", html], ["PDF", html], ["DOCX", docx]] as const) {
      const r = checkFidelity({ format, source, expected })
      expect({ format, status: r.status, findings: findingsOf(r) }).toEqual({ format, status: "PASS", findings: [] })
    }
  }, 60_000)

  test("a real number change (output cover number differs from meta) still fails NUMBER_CHANGED at F:cover", async () => {
    const { snap, html, docx } = await case06()
    const expected = fidelityExpectationFromSnapshot(snap)
    const badHtml = coverNumberAs(html, "017/GSP/KT/XI/2026")
    for (const format of ["HTML", "PDF"] as const) {
      const r = checkFidelity({ format, source: badHtml, expected })
      expect(r.status).toBe("FAIL")
      expect(r.findings.some((f) => f.code === "NUMBER_CHANGED" && f.address === "F:cover" && f.detail.includes("016") && f.detail.includes("017"))).toBe(true)
    }
    const d = checkFidelity({ format: "DOCX", source: replaceInDocx(docx, META_NO, "017/GSP/KT/XI/2026"), expected })
    expect(d.status).toBe("FAIL")
    expect(d.findings.some((f) => f.code === "NUMBER_CHANGED" && f.address === "F:cover")).toBe(true)
  }, 60_000)

  test("the cover number printed as the slot (012) while meta is 016 is a NUMBER_CHANGED (pre-165J output)", async () => {
    const { snap, html } = await case06()
    const expected = fidelityExpectationFromSnapshot(snap)
    const old = coverNumberAs(html, SLOT_NO)
    const r = checkFidelity({ format: "HTML", source: old, expected })
    expect(r.status).toBe("FAIL")
    expect(findingsOf(r).some((x) => x.startsWith("NUMBER_CHANGED F:cover"))).toBe(true)
  }, 60_000)

  test("helper: auto data.control and explicit-body control blocks get meta's number; other content unchanged", () => {
    const rows = [[{ text: "Nomor dokumen" }, { text: SLOT_NO }, { text: "Revisi" }, { text: "A" }]]
    const auto = coverContentWithDocNumber({ mode: "auto", data: { titleLines: [{ text: "T" }], control: { type: "controlBlock", rows } } }, META_NO) as any
    expect(auto.data.control.rows[0][1]).toEqual({ text: META_NO })
    expect(auto.data.titleLines).toEqual([{ text: "T" }])
    const explicit = coverContentWithDocNumber({ mode: "explicit", body: [{ type: "paragraph", text: SLOT_NO }, { type: "controlBlock", rows }] }, META_NO) as any
    expect(explicit.body[0]).toEqual({ type: "paragraph", text: SLOT_NO })
    expect(explicit.body[1].rows[0][1]).toEqual({ text: META_NO })
    // No meta number: the cover's own cell is expected, as before 165O.
    // Row 165P consequence edit (C205, CP-05): the block is laid out as the manual's eight fields (as the engine prints
    // it, without engine values), so the result is a new object; the number cell keeps the cover's own number.
    const none = { mode: "auto", data: { control: { type: "controlBlock", rows } } }
    for (const n of [undefined, "  "]) {
      const r = coverContentWithDocNumber(none, n) as any
      expect(r.data.control.rows.length).toBe(4)
      expect(r.data.control.rows[0][1]).toEqual({ text: SLOT_NO })
    }
    // Input not mutated.
    expect(rows[0][1]).toEqual({ text: SLOT_NO })
  })
})

// ── F165N-2 ──────────────────────────────────────────────────────────────────────────────────────────────────

type Txt = { unit?: string; cpl: number; lines: number }
const page = { kind: "page", page: 1, xMm: 0, yMm: 0, widthMm: 210, heightMm: 297 }
const text = (t: Txt) => ({
  kind: "text", tag: "p", label: "st-p", page: 1, xMm: 20, yMm: 40, widthMm: 128, heightMm: 4 * t.lines, fontSizePt: 9.5, measureMm: 128,
  lineCount: t.lines, charCount: Math.round(t.cpl * t.lines), charsPerLine: t.cpl, ...(t.unit !== undefined ? { unit: t.unit } : {}),
})
function d15(elements: unknown[], truncated = false) {
  const metrics = { pageCount: elements.length ? 1 : 0, elements, ...(truncated ? { truncated: true } : {}) } as never
  const out = lintRenderedWith({ html: "<html></html>", svgs: [], metrics }, RENDER_LINT_DEFAULTS).find((i) => i.checkId === "DATUM-15")
  if (!out) throw new Error("no DATUM-15 issue")
  return out
}
/** LINT at TERBIT for a stored report where everything else passes (as 165N d15b.ts). */
function lintWith(d: { checkId: string; status: string; detail?: string }) {
  const report = { tier: "TERBIT", checks: [{ checkId: "DATUM-14", status: "PASS" }, { checkId: "D17", status: "PASS" }, d] }
  return checkLint({ format: "PDF", lintReport: JSON.stringify(report), lintVerdict: "PASS", tier: "TERBIT" })
}

describe("F165N-2 DATUM-15 not applicable is REPORT, not NOT_RUN", () => {
  test("B-FIX shape (measured; only cover / control-sheet method / toc text) -> REPORT 'tidak berlaku'; LINT PASS at TERBIT, not UNKNOWN", () => {
    const r = d15([page, text({ unit: "controlSheet", cpl: 80.5, lines: 3 }), text({ unit: "cover", cpl: 40, lines: 2 }), text({ unit: "toc", cpl: 60, lines: 4 })])
    expect(r.status).toBe("REPORT")
    expect(r.detail).toStartWith("tidak berlaku: tidak ada paragraf badan multi-baris terukur")
    const l = lintWith(r)
    expect({ status: l.status, reason: l.reason }).toEqual({ status: "PASS", reason: null })
  })

  test("measured page, no text at all -> REPORT; LINT PASS", () => {
    const r = d15([page])
    expect(r.status).toBe("REPORT")
    expect(lintWith(r).status).toBe("PASS")
  })

  test("measurement failed (no layout elements) -> NOT_RUN; LINT UNKNOWN LINT_PARTIAL (never PASS)", () => {
    const r = d15([])
    expect(r.status).toBe("NOT_RUN")
    const l = lintWith(r)
    expect({ status: l.status, reason: l.reason }).toEqual({ status: "UNKNOWN", reason: "LINT_PARTIAL" })
  })

  test("truncated measure with no interior paragraph found -> NOT_RUN (the paragraph may be past the cut); LINT UNKNOWN", () => {
    const r = d15([page, text({ unit: "controlSheet", cpl: 80.5, lines: 3 })], true)
    expect(r.status).toBe("NOT_RUN")
    expect(lintWith(r).status).toBe("UNKNOWN")
  })

  test("long interior paragraph (92.3 cpl) -> FAIL; LINT FAIL with LINT_FAIL DATUM-15", () => {
    const r = d15([page, text({ unit: "chapter", cpl: 92.3, lines: 6 })])
    expect(r.status).toBe("FAIL")
    const l = lintWith(r)
    expect(l.status).toBe("FAIL")
    // Row 206 (1.2.3): label = check id, detail = "<id>: <engine message>".
    expect(l.findings.some((f) => f.code === "LINT_FAIL" && f.label === "DATUM-15" && f.detail.startsWith("DATUM-15: rata-rata 92.3"))).toBe(true)
  })

  test("interior paragraph within 66-80 -> PASS; LINT PASS", () => {
    const r = d15([page, text({ unit: "chapter", cpl: 74.6, lines: 6 })])
    expect(r.status).toBe("PASS")
    expect(lintWith(r).status).toBe("PASS")
  })
})

// ── C204 item 4 (F-Y3): no figure element falls back to the SVG default (black) fill ─────────────────────────

const PKG = path.resolve(import.meta.dir, "..", "..", "..")
const ENGINE = path.join(PKG, "vendor", "src", "lib", "studio", "engine")
const build = await import(path.join(ENGINE, "diagram", "build", "index.ts"))
const elk = await import(path.join(ENGINE, "diagram", "elk", "index.ts"))
const CASE04 = JSON.parse(readFileSync(path.join(PKG, "test", "engine-rev-a", "svg", "fixtures", "case04_v2.studio.json"), "utf8"))
/** Elements that are painted with a fill (the SVG default fill is black). */
const PAINTED = new Set(["rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan"])

/** Painted elements with no `fill` on themselves or an ancestor (clipPath/mask children are not painted). */
function defaultFilled(svg: string): string[] {
  const stack: Array<{ tag: string; fill: boolean }> = []
  const out: string[] = []
  for (const m of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
    const [all, close, tag, rest] = m
    if (close) {
      const i = stack.map((s) => s.tag).lastIndexOf(tag)
      if (i >= 0) stack.length = i
      continue
    }
    const own = /\sfill="/.test(rest)
    const unpainted = stack.some((s) => s.tag === "clipPath" || s.tag === "mask")
    if (PAINTED.has(tag) && !own && !stack.some((s) => s.fill) && !unpainted) out.push(all.slice(0, 120))
    if (!/\/\s*$/.test(rest)) stack.push({ tag, fill: own })
  }
  return out
}

describe("C204 item 4: figure SVG elements carry an explicit fill (hatch lines fill none)", () => {
  test("case 04 (both layout paths): no element without an explicit fill; hatch groups fill none; no #000000", async () => {
    for (const r of [build.buildDiagramSvg(structuredClone(CASE04), { release: false }), await elk.buildDiagramSvgAuto(structuredClone(CASE04), { release: false })]) {
      expect(defaultFilled(r.svg)).toEqual([])
      const hatch = [...r.svg.matchAll(/<g [^>]*data-hatch="[^"]*"[^>]*>/g)].map((m) => m[0])
      expect(hatch.length).toBeGreaterThan(0)
      for (const g of hatch) expect(g).toContain('fill="none"')
      expect(r.svg.toLowerCase()).not.toMatch(/#000000\b|#000\b/)
    }
  }, 60_000)

  test("every node shape hatched (stadium, parallelogram, hexagon, cylinder, circle, bus, doubled, shadowed, box)", async () => {
    // One shape per figure (DATUM-35: one symbol dialect per figure); every node accent = hatched. "diamond" is a
    // decision and needs labelled exits (P3), which this material lacks; its hatch path is the same clipped group.
    const shapes = ["stadium", "parallelogram", "hexagon", "cylinder", "circle", "bus", "doubled", "shadowed", "box"]
    const built: string[] = []
    for (const shape of shapes) {
      const s = structuredClone(CASE04)
      s.nodes = s.nodes.map((n: any) => ({ ...n, shape, class: { ...(n.class ?? {}), accent: true } }))
      // A shape the layout refuses on this material (width, P3) is skipped: a validation refusal, not a fill question.
      const r = await elk.buildDiagramSvgAuto(s, { release: false }).catch((e: Error) => (e?.name === "DiagramDefect" ? null : Promise.reject(e)))
      if (!r) continue
      expect({ shape, unfilled: defaultFilled(r.svg) }).toEqual({ shape, unfilled: [] })
      expect(r.svg).toContain("data-hatch=")
      built.push(shape)
    }
    console.log(`[row165o] hatched shapes built: ${built.join(", ")}`)
    expect(built.length).toBeGreaterThanOrEqual(5)
  }, 60_000)

  test("guard: the checker flags a stroke-only line without fill (the 165C hatch shape)", () => {
    expect(defaultFilled('<svg><g stroke="#6B7783" data-hatch="45"><line x1="0" y1="0" x2="1" y2="1"/></g></svg>').length).toBe(1)
    expect(defaultFilled('<svg><clipPath id="c"><rect x="0" y="0" width="1" height="1"/></clipPath></svg>')).toEqual([])
  })
})
