// Row 151b: pure helpers of the pagePng op (page-images.ts). The Electron side is test/datum-render-electron/row151b-*.
import { describe, expect, test } from "bun:test"
import {
  MAX_PAGE_IMAGES,
  PAGE_LAYOUT_SCRIPT,
  PAGE_PNG_DPI,
  pageFileName,
  pageLayoutExpression,
  parsePageSize,
  pngSize,
  readLayout,
  selectPages,
} from "./page-images"

describe("parsePageSize (CSS @page size)", () => {
  test("keywords, with and without orientation", () => {
    expect(parsePageSize("A4")).toEqual({ wMm: 210, hMm: 297 })
    expect(parsePageSize("a5")).toEqual({ wMm: 148, hMm: 210 })
    expect(parsePageSize("A5 portrait")).toEqual({ wMm: 148, hMm: 210 })
    expect(parsePageSize("A4 landscape")).toEqual({ wMm: 297, hMm: 210 })
    expect(parsePageSize("landscape A3")).toEqual({ wMm: 420, hMm: 297 })
    expect(parsePageSize("letter")).toEqual({ wMm: 215.9, hMm: 279.4 })
    expect(parsePageSize("landscape")).toEqual({ wMm: 297, hMm: 210 })
    expect(parsePageSize("portrait")).toEqual({ wMm: 210, hMm: 297 })
  })

  test("lengths in mm, cm, in, pt, px; one length is a square page", () => {
    expect(parsePageSize("148mm 210mm")).toEqual({ wMm: 148, hMm: 210 })
    expect(parsePageSize("21cm 29.7cm")).toEqual({ wMm: 210, hMm: 297 })
    expect(parsePageSize("8.5in 11in")).toEqual({ wMm: 215.9, hMm: 279.4 })
    expect(parsePageSize("595.28pt 841.89pt")).toEqual({ wMm: 210.002, hMm: 297 })
    expect(parsePageSize("96px")).toEqual({ wMm: 25.4, hMm: 25.4 })
  })

  test("auto, unknown, malformed and oversize values give null (the fallback size is used)", () => {
    for (const v of [null, undefined, "", "auto", "A9", "10em 10em", "10mm 10mm 10mm", "portrait landscape", "200mm landscape", "-1mm 2mm", "6000mm 10mm"]) {
      expect(parsePageSize(v as string)).toBeNull()
    }
  })
})

describe("page selection, file names, PNG size, layout validation", () => {
  test("default is the first 12 pages; requested pages are sorted, deduplicated and bounded by the page count", () => {
    expect(PAGE_PNG_DPI).toBe(150)
    expect(MAX_PAGE_IMAGES).toBe(12)
    expect(selectPages(3, null)).toEqual([1, 2, 3])
    expect(selectPages(40, undefined)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(selectPages(5, [5, 2, 9, 2])).toEqual([2, 5])
    expect(selectPages(5, [])).toEqual([1, 2, 3, 4, 5])
  })

  test("witness-pNNN.png names (1.2.7 N-5 INTENT)", () => {
    expect(pageFileName(1)).toBe("witness-p001.png")
    expect(pageFileName(42)).toBe("witness-p042.png")
    expect(pageFileName(1234)).toBe("witness-p1234.png")
  })

  test("pngSize reads IHDR and refuses other bytes", () => {
    const b = Buffer.alloc(24)
    b.writeUInt32BE(0x89504e47, 0)
    b.writeUInt32BE(0x0d0a1a0a, 4)
    b.write("IHDR", 12, "latin1")
    b.writeUInt32BE(1239, 16)
    b.writeUInt32BE(1753, 20)
    expect(pngSize(b)).toEqual({ width: 1239, height: 1753 })
    expect(() => pngSize(Buffer.from("%PDF-1.4 not a png at all"))).toThrow("not a PNG")
  })

  test("readLayout accepts the script shape and refuses anything else (the document is untrusted)", () => {
    expect(readLayout({ layout: "flow", pageCount: 2, rects: [{ x: 0, y: 0, w: 10, h: 20 }, { x: 0, y: 20, w: 10, h: 20 }] })).toEqual({
      layout: "flow",
      pageCount: 2,
      rects: [{ x: 0, y: 0, w: 10, h: 20 }, { x: 0, y: 20, w: 10, h: 20 }],
    })
    for (const bad of [
      null,
      "x",
      { layout: "grid", pageCount: 1, rects: [] },
      { layout: "paged", pageCount: 0, rects: [] },
      { layout: "paged", pageCount: 1.5, rects: [] },
      { layout: "paged", pageCount: 1 },
      { layout: "paged", pageCount: 1, rects: [{ x: "0", y: 0, w: 1, h: 1 }] },
      { layout: "paged", pageCount: 1, rects: [{ x: 0, y: 0, w: Infinity, h: 1 }] },
    ]) {
      expect(() => readLayout(bad)).toThrow()
    }
  })
})

describe("the fixed page script", () => {
  test("is a plain function text with no transpiler helper, fetch, navigation or storage access", () => {
    expect(PAGE_LAYOUT_SCRIPT.startsWith("(function (o) {")).toBe(true)
    expect(PAGE_LAYOUT_SCRIPT.endsWith("})")).toBe(true)
    for (const word of ["__name", "fetch", "XMLHttpRequest", "location", "localStorage", "import(", "eval(", "Function("]) {
      expect(PAGE_LAYOUT_SCRIPT).not.toContain(word)
    }
    // Syntax check only (never run here): the text compiles as one expression.
    expect(() => new Function(`return ${PAGE_LAYOUT_SCRIPT}`)).not.toThrow()
  })

  test("the evaluated expression applies the script to a JSON argument", () => {
    expect(pageLayoutExpression({ phase: "size" })).toBe(`${PAGE_LAYOUT_SCRIPT}({"phase":"size"})`)
    expect(pageLayoutExpression({ phase: "layout", wMm: 210, hMm: 297, maxRects: 2000 }).endsWith(
      `({"phase":"layout","wMm":210,"hMm":297,"maxRects":2000})`,
    )).toBe(true)
  })
})

// Row 151c (DEFECT-157-1): flow pages at the @page content box, drawn on whole pages in the @page colour.
import { backgroundRgb, composePage, decodePngRgb, encodePngRgb, flowApproximation, marginMm, pageBackground, parseMargins, readSizeInfo } from "./page-images"

describe("row 151c: flow page helpers", () => {
  test("margins: lengths in mm, 0, and unreadable values", () => {
    expect(parseMargins({ top: "25.9997mm", right: "20.0025mm", bottom: "24.0065mm", left: "24.0065mm" })).toEqual({ top: 26, right: 20.003, bottom: 24.007, left: 24.007 })
    expect(parseMargins({ top: "0", right: "0px", bottom: "1in", left: "10pt" })).toEqual({ top: 0, right: 0, bottom: 25.4, left: 3.528 })
    expect(parseMargins(null)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    expect(parseMargins({ top: "auto", right: "0", bottom: "0", left: "0" })).toBeNull()
    expect(marginMm("10%")).toBeNull()
  })

  test("page colour: hex or rgb only, transparent and anything else is white", () => {
    expect(pageBackground("#FCFCFB")).toBe("#FCFCFB")
    expect(pageBackground("rgb(252, 252, 251)")).toBe("rgb(252, 252, 251)")
    expect(pageBackground("rgba(0, 0, 0, 0)")).toBe("#ffffff")
    expect(pageBackground("rgb(255, 255, 0)")).toBe("rgb(255, 255, 0)")
    expect(pageBackground("red;}</style><script>")).toBe("#ffffff")
    expect(pageBackground(null)).toBe("#ffffff")
  })

  test("page colour as RGB bytes", () => {
    expect(backgroundRgb("#FCFCFB")).toEqual([252, 252, 251])
    expect(backgroundRgb("#abc")).toEqual([170, 187, 204])
    expect(backgroundRgb("rgb(1, 2, 3)")).toEqual([1, 2, 3])
    expect(backgroundRgb("transparent")).toEqual([255, 255, 255])
  })

  test("PNG codec round trip and page composition: exact pixels, margins in the page colour, crop at the edge", () => {
    const content = { width: 3, height: 2, rgb: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 40, 50, 60, 70, 80, 90]) }
    const back = decodePngRgb(encodePngRgb(content))
    expect(back.width).toBe(3)
    expect([...back.rgb]).toEqual([...content.rgb])
    const page = decodePngRgb(composePage({ width: 5, height: 4, bg: [252, 252, 251], content, left: 3, top: 1 }))
    const px = (x: number, y: number) => [...page.rgb.subarray((y * 5 + x) * 3, (y * 5 + x) * 3 + 3)]
    expect(px(0, 0)).toEqual([252, 252, 251])
    expect(px(3, 1)).toEqual([255, 0, 0])
    expect(px(4, 2)).toEqual([40, 50, 60])
    expect(px(4, 3)).toEqual([252, 252, 251])
    expect(pngSize(composePage({ width: 5, height: 4, bg: [0, 0, 0], content, left: 0, top: 0 }))).toEqual({ width: 5, height: 4 })
  })

  test("size info is validated and the approximation note names what is not drawn", () => {
    const i = readSizeInfo({ size: "210mm 297mm", margins: { top: "1mm", right: "1mm", bottom: "1mm", left: "1mm" }, background: "#fff", marginBoxes: true, namedPages: false, paged: false })
    expect(i.paged).toBe(false)
    expect(readSizeInfo(null)).toEqual({ size: null, margins: null, background: null, marginBoxes: false, namedPages: false, paged: false })
    expect(flowApproximation(i, true)).toBe("pages cut by the bridge's line-break estimate, not by the printer; running header and footer not drawn")
    expect(flowApproximation({ marginBoxes: false, namedPages: true }, false)).toContain("page margins unreadable, drawn as 0")
  })

  test("the layout script has the flowcut phase and returns margins/background from the size phase", () => {
    expect(PAGE_LAYOUT_SCRIPT).toContain("o.phase === 'flowcut'")
    expect(PAGE_LAYOUT_SCRIPT).toContain("margins: margins, background: canvas || background")
    expect(() => new Function(`return ${PAGE_LAYOUT_SCRIPT}`)).not.toThrow()
    expect(pageLayoutExpression({ phase: "flowcut", hMm: 247, maxRects: 100 })).toContain('{"phase":"flowcut","hMm":247,"maxRects":100}')
  })
})
