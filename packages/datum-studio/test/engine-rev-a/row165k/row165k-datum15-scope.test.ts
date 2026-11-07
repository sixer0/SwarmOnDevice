// Row 165K (C199 ruling 2): Studio LINT DATUM-15 (body measure 66-80 characters per line) counts only the running
// body text of interior units. Text blocks in the cover, control sheet (lembar kendali) and contents (toc) units are
// not counted. The measure script tags every text block with the enclosing unit's `data-unit` kind; the real-Chromium
// proof is test/verify-gate-e2e/row165j-datum15-e2e.test.ts (opt-in ROW165J_E2E=1).
import { describe, expect, test } from "bun:test"
import { MEASURE_SCRIPT } from "../../../vendor/src/lib/studio/engine/browser/measure"
import { lintRenderedWith, RENDER_LINT_DEFAULTS } from "../../../vendor/src/lib/studio/engine/lint/render/index"

type Txt = { unit?: string; cpl: number; lines: number; address?: string }

function text(t: Txt) {
  return {
    kind: "text",
    tag: "p",
    label: "st-p",
    page: 1,
    xMm: 20,
    yMm: 40,
    widthMm: 128,
    heightMm: 4 * t.lines,
    fontSizePt: 9.5,
    measureMm: 128,
    lineCount: t.lines,
    charCount: Math.round(t.cpl * t.lines),
    charsPerLine: t.cpl,
    ...(t.unit !== undefined ? { unit: t.unit } : {}),
    ...(t.address !== undefined ? { address: t.address } : {}),
  }
}

function d15(texts: Txt[]) {
  const page = { kind: "page", page: 1, xMm: 0, yMm: 0, widthMm: 210, heightMm: 297 }
  const metrics = { pageCount: 1, elements: [page, ...texts.map(text)] } as never
  const out = lintRenderedWith({ html: "<html></html>", svgs: [], metrics }, RENDER_LINT_DEFAULTS).find((i) => i.checkId === "DATUM-15")
  if (!out) throw new Error("no DATUM-15 issue")
  return out
}

describe("row165K DATUM-15 scope: interior units only", () => {
  test("measure script tags each text block with the enclosing data-unit kind", () => {
    expect(MEASURE_SCRIPT).toContain("up(el, '[data-unit]')")
    expect(MEASURE_SCRIPT).toContain("tb.unit =")
  })

  test("(a) a long interior paragraph at a too-wide measure still FAILS", () => {
    const r = d15([
      { unit: "chapter", cpl: 92.3, lines: 9, address: "1.1.1" },
      { unit: "controlSheet", cpl: 72, lines: 3, address: "F:controlSheet/3" },
    ])
    expect(r.status).toBe("FAIL")
    expect(r.detail).toContain("rata-rata 92.3")
    expect(r.detail).toContain("1 paragraf badan")
    expect(r.detail).toContain("1.1.1")
    expect(r.detail).not.toContain("F:controlSheet")
  })

  test("(a') interior units of kind section / appendix and unit-less HTML are still counted", () => {
    expect(d15([{ unit: "appendix", cpl: 95, lines: 4 }]).status).toBe("FAIL")
    expect(d15([{ unit: "section", cpl: 95, lines: 4 }]).status).toBe("FAIL")
    expect(d15([{ cpl: 95, lines: 4 }]).status).toBe("FAIL")
  })

  test("(b) front-matter text alone is not counted (cover, control sheet, contents)", () => {
    const r = d15([
      { unit: "cover", cpl: 95, lines: 3 },
      { unit: "controlSheet", cpl: 80.5, lines: 3, address: "F:controlSheet/3" },
      { unit: "toc", cpl: 120, lines: 6 },
    ])
    expect(r.status).toBe("NOT_RUN")
    expect(r.detail).toContain("sampul, lembar kendali dan daftar isi tidak dihitung")
  })

  test("(b') front-matter text does not shift the interior average (B-FIX shape: 80.5 method + 78.1 chapter)", () => {
    const r = d15([
      { unit: "controlSheet", cpl: 80.5, lines: 3, address: "F:controlSheet/3" },
      { unit: "chapter", cpl: 78.1, lines: 4, address: "1.0.1" },
    ])
    expect(r.status).toBe("PASS")
    expect(r.detail).toContain("rata-rata 78.1")
    expect(r.detail).toContain("1 paragraf badan")
  })
})
