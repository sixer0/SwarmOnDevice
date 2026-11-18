// Swarm 1.3.3 row 63 (ST-9 item 2, owner decision U20): a document with a figure whose labels no person has checked
// prints the marker "label belum diperiksa manusia" on its control sheet and a draft status; with every figure checked
// the control sheet is byte-identical to the one taken before the change (baseline_all_checked.json).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { controlSheetOf, type Variant } from "./_fixture"

type J = Record<string, any>
const BASELINE = JSON.parse(readFileSync(path.join(import.meta.dir, "baseline_all_checked.json"), "utf8")) as Record<string, J>
const bytes = (v: unknown) => JSON.stringify(v, null, 1)
const MARKER_ID = "label belum diperiksa manusia"
const MARKER_EN = "labels not yet checked by a person"
const methodText = (cs: J): string => {
  const m = cs.data.methodStatement
  return m === undefined ? "" : "text" in m ? m.text : m.runs.map((r: J) => r.t ?? "").join("")
}
const allText = (cs: J): string => JSON.stringify(cs)

describe("control sheet, all figures checked: byte-identical to the baseline", () => {
  const cases: Array<[string, Variant]> = [
    ["checked_with_method", { flags: [true, true], methodStatement: true }],
    ["checked_no_method", { flags: [true], methodStatement: false }],
    ["no_figure", { flags: [], methodStatement: true }],
    ["checked_en", { flags: [true], methodStatement: true, language: "EN" }],
  ]
  for (const [key, v] of cases) {
    test(key, () => {
      const out = controlSheetOf(v)
      expect(bytes(out)).toBe(bytes(BASELINE[key]))
      expect(allText(out)).not.toContain(MARKER_ID)
      expect(allText(out)).not.toContain(MARKER_EN)
    })
  }
})

describe("control sheet with unchecked figures", () => {
  test("one unchecked figure: marker once, count, status draft, author text kept first", () => {
    const cs = controlSheetOf({ flags: [true, false], methodStatement: true })
    const text = methodText(cs)
    expect(text).toBe("Pengukuran langsung di lapangan. Status: draf. label belum diperiksa manusia (1 gambar).")
    expect(allText(cs).split(MARKER_ID).length - 1).toBe(1)
  })
  // Row 150 (coordinator follow-up): without an author's method statement the remark follows the template's method
  // statement (the one the renderers print on a TERBIT/SERAH sheet), never takes its place.
  test("absent flag counts as unchecked; the count is the number of figures; the template method text stays first", () => {
    const cs = controlSheetOf({ flags: [undefined, false, true], methodStatement: false })
    const text = methodText(cs)
    expect(text).toBe("Dokumen ini diperiksa melalui rantai verifikasi tiga lapis: V1 baca baris per baris; V2 eksekusi; V3 render dan periksa. Objek dan hasil setiap lapis tercatat pada tabel rantai verifikasi. Status: draf. label belum diperiksa manusia (2 gambar).")
    expect(text.indexOf("Dokumen ini diperiksa")).toBe(0)
    expect(text.indexOf("Dokumen ini diperiksa")).toBeLessThan(text.indexOf(MARKER_ID))
  })
  test("English document: English method text, then the English marker and status", () => {
    const cs = controlSheetOf({ flags: [false], methodStatement: false, language: "EN" })
    expect(methodText(cs)).toBe("This document is checked through a three-layer verification chain: V1 baca baris per baris; V2 eksekusi; V3 render dan periksa. The object and result of each layer are recorded in the verification chain table. Status: draft. labels not yet checked by a person (1 figure).")
  })
  test("row 150: author's method text and remark are both present, the method text first", () => {
    const text = methodText(controlSheetOf({ flags: [false], methodStatement: true }))
    expect(text).toContain("Pengukuran langsung di lapangan.")
    expect(text).toContain(MARKER_ID)
    expect(text.indexOf("Pengukuran langsung di lapangan.")).toBeLessThan(text.indexOf(MARKER_ID))
  })
  test("everything else on the sheet is untouched (only methodStatement differs from the all-checked sheet)", () => {
    const base = controlSheetOf({ flags: [true], methodStatement: true })
    const draft = controlSheetOf({ flags: [false], methodStatement: true })
    const strip = (c: J) => ({ ...c, data: { ...c.data, methodStatement: undefined } })
    expect(bytes(strip(draft))).toBe(bytes(strip(base)))
  })
})

describe("manual column form: the STATUS cell of the latest revision prints the draft", () => {
  test("Draf for the latest row when figures are unchecked, Berlaku otherwise", async () => {
    const { controlSheetFront } = await import("../../vendor/src/lib/studio/services/compose/front")
    const slot = { label: "Lembar Kendali" } as never
    const ctx = { glyphs: { ok: true } as never, params: { "controlSheet.columns.form": "manual" }, classification: "" } as never
    const payload = { type: "controlSheet", revisionHistory: [{ rev: "A", date: "2026-10-23", what: "Terbit", by: "Tim" }] } as never
    const statusOf = (n: number) => JSON.stringify(((controlSheetFront(payload, slot, ctx, undefined, n) as J).data.revisionHistory as J).rows.at(-1))
    expect(statusOf(1)).toContain("Draf")
    expect(statusOf(0)).toContain("Berlaku")
  })
})
