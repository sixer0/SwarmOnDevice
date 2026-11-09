import { describe, expect, test } from "bun:test"
import { extractPdfText, pdfTextForModel } from "../../src/util/pdf-text"
import { cidPdf, simplePdf } from "../fixture/pdf"

describe("util.pdf-text", () => {
  test("extracts the text of each page of an uncompressed PDF, in order", () => {
    const result = extractPdfText(simplePdf([["Hello (PDF) world", "Second line"], ["Page two text"]]))
    expect(result).toEqual({ ok: true, pageCount: 2, pages: ["Hello (PDF) world\nSecond line", "Page two text"] })
  })

  test("reads Flate-compressed content streams", () => {
    const result = extractPdfText(simplePdf([["Compressed caf\xe9 \x93quoted\x94"]], { compress: true }))
    expect(result).toEqual({ ok: true, pageCount: 1, pages: ["Compressed café “quoted”"] })
  })

  test("maps Identity-H glyph ids through the ToUnicode CMap, with pages in an object stream", () => {
    const result = extractPdfText(cidPdf(["Laporan Akhir", "Ringkasan eksekutif"]))
    expect(result).toEqual({ ok: true, pageCount: 1, pages: ["Laporan Akhir\nRingkasan eksekutif"] })
  })

  test("reports an encrypted PDF instead of returning garbage", () => {
    expect(extractPdfText(simplePdf([["secret"]], { encrypted: true }))).toEqual({ ok: false, reason: "encrypted" })
  })

  test("reports a file that is not a PDF as unreadable and never throws", () => {
    expect(extractPdfText(new TextEncoder().encode("%PDF-1.4\nnot really"))).toEqual({
      ok: false,
      reason: "unreadable",
    })
    expect(extractPdfText(new Uint8Array([0, 1, 2, 3]))).toEqual({ ok: false, reason: "unreadable" })
  })

  test("pdfTextForModel adds page markers and says what was done", () => {
    const text = pdfTextForModel(simplePdf([["One"], ["Two"]]), { filename: "report.pdf", images: true })
    expect(text).toContain(
      '[PDF "report.pdf": this model does not take PDF files, so Swarm extracted the text of its 2 page(s) below.',
    )
    expect(text).toContain("No page images were added")
    expect(text).toContain("--- Page 1 of 2 ---\nOne")
    expect(text).toContain("--- Page 2 of 2 ---\nTwo")
  })

  test("pdfTextForModel omits the image sentence for a text-only model and flags a page-limit cut", () => {
    const text = pdfTextForModel(simplePdf([["A".repeat(50)], ["B".repeat(50)]]), { images: false, maxChars: 80 })
    expect(text).not.toContain("page images")
    expect(text).toContain("Text shown for pages 1-1 only (length limit).")
    expect(text).not.toContain("--- Page 2")
  })

  test("pdfTextForModel flags a PDF with no text layer", () => {
    const text = pdfTextForModel(simplePdf([[]]), { images: true })
    expect(text).toContain("No text layer was found")
    expect(text).toContain("(no text on this page)")
  })

  test("pdfTextForModel explains an encrypted PDF", () => {
    expect(pdfTextForModel(simplePdf([["x"]], { encrypted: true }), { filename: "a.pdf", images: false })).toContain(
      "could not extract its text because it is encrypted",
    )
  })
})
