// Row 207 (1.2.3 patch, defect HB-2): a controlSheet.verificationChain write was accepted (status COMPLETE) but the
// printed columns METODE, OBJEK, HASIL came out empty, and the control-sheet table columns were not addressable by
// studio_edit (TEXT_NOT_FOUND with details.columns: []). Cause: the slot schema documented { layer, role, name, date },
// the manual control sheet of the built-in templates prints Lapis/Metode/Objek/Hasil and compose filled only Lapis;
// studio_edit turned slot entries into plain fields without a column. Fixed: the entry takes method/object/result
// (and the printed column names as aliases, mapped; unknown keys refused with the accepted keys), compose prints
// them (documented role/name/date mapped onto the printed columns), studio_edit addresses slot table columns.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { beforeAll, describe, expect, test } from "bun:test"
import type { NormDocSnapshot, ParamMap, ResolvedTemplate } from "../../vendor/src/lib/studio/contract"
import { assembleDocxDetailed } from "../../vendor/src/lib/studio/engine/docx/assemble"
import { assembleHtml } from "../../vendor/src/lib/studio/engine/html/assemble"
import { composeV2 } from "../../vendor/src/lib/studio/services/compose"
import { normalizeControlSheetKeys, VERIFICATION_ENTRY_KEYS } from "../../vendor/src/lib/studio/contract/schema/v2/verification-entry"
import { applyClientEdits, clientUnits } from "../../vendor/scripts/studio/mcp/write-client-edit"
import { schemaIssues } from "../../src/mcp-host/local-api/routes/r12-r13-submit"
import { withParams } from "../ported/engine-core/fixtures"
import { defaultParams, e1, merge, skeletonInput } from "../ported/structure/_kit"
import { canonicalTemplate, makeCtx, partText, unzip } from "../ported/renderers/_kit"

const MANUAL = { "controlSheet.columns.form": "manual" }
const CHAIN = [
  { layer: "V1", method: "Baca baris per baris", object: "Bab 1-3, 42 tabel", result: "Sesuai, 2 koreksi" },
  { layer: "V2", method: "Eksekusi ulang skrip", object: "Lampiran B", result: "Lulus" },
]

const flat = (s: string) => s.replace(/<w:tab\/>/g, " ").replace(/<\/w:p>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

async function render(tpl: ResolvedTemplate, chain: unknown, params: Record<string, unknown> = MANUAL) {
  const d = e1()
  d.sections.controlSheet.verificationChain = chain
  const r = composeV2({ source: merge(d).doc, skeleton: skeletonInput(), params: { ...defaultParams(), ...params } as ParamMap })
  const t = withParams(tpl, params)
  const snap = r.snapshot as unknown as NormDocSnapshot
  const html = flat(await assembleHtml(makeCtx(snap, t).ctx, { preview: false }))
  const docx = flat(partText(unzip((await assembleDocxDetailed(makeCtx(snap, t).ctx)).bytes), "word/document.xml"))
  const table = (snap as any).doc.front.controlSheet.data.verificationChain
  const cells = table.rows.map((row: any) => row.cells.map((c: any) => c.text))
  return { html, docx, cells }
}

const slotBody = (chain: unknown) => ({
  $schema: "studio.slot/v2",
  target: { documentId: "doc-207" },
  slot: "controlSheet",
  payload: { type: "controlSheet", verificationChain: chain },
})

describe("row 207: schema and key mapping", () => {
  test("method/object/result are valid slot keys (before: refused as unknown properties)", () => {
    expect(schemaIssues("slot", slotBody(CHAIN))).toEqual([])
  })

  test("documented keys still valid", () => {
    expect(schemaIssues("slot", slotBody([{ layer: "1", role: "Penyusun", name: "A. Pratama", date: "2026-11-09" }]))).toEqual([])
  })

  test("printed column names (ID and EN, any case) map to the canonical keys", () => {
    const body = slotBody([
      { Lapis: "V1", Metode: "Baca", OBJEK: "Bab 1", hasil: "Sesuai" },
      { Layer: "V2", Method: "Eksekusi", Object: "Lampiran", Result: "Lulus", Peran: "Pemeriksa", Nama: "B. Santoso", Tanggal: "2026-11-09" },
    ])
    const r = normalizeControlSheetKeys(body)
    expect(r.issues).toEqual([])
    expect(r.mapped.length).toBeGreaterThan(0)
    expect(body.payload.verificationChain).toEqual([
      { layer: "V1", method: "Baca", object: "Bab 1", result: "Sesuai" },
      { layer: "V2", method: "Eksekusi", object: "Lampiran", result: "Lulus", role: "Pemeriksa", name: "B. Santoso", date: "2026-11-09" },
    ])
    expect(schemaIssues("slot", body)).toEqual([])
  })

  test("unknown key refused with a message that lists the accepted keys", () => {
    const body = slotBody([{ layer: "V1", metode: "Baca", temuan: "x" }])
    const r = normalizeControlSheetKeys(body)
    expect(r.issues.length).toBe(1)
    expect(r.issues[0].pointer).toBe("/payload/verificationChain/0/temuan")
    for (const k of [...VERIFICATION_ENTRY_KEYS, "lapis", "metode", "objek", "hasil"]) expect(r.issues[0].message).toContain(k)
  })

  test("the same column given twice with different values is refused", () => {
    const r = normalizeControlSheetKeys(slotBody([{ layer: "V1", method: "A", Metode: "B" }]))
    expect(r.issues.length).toBe(1)
    expect(r.issues[0].message).toContain("method")
  })
})

describe("row 207: write -> render, columns filled (HTML and DOCX)", () => {
  let tpl: ResolvedTemplate
  beforeAll(async () => {
    tpl = await canonicalTemplate()
  })

  test("manual form: METODE, OBJEK, HASIL printed from method/object/result", async () => {
    const out = await render(tpl, CHAIN)
    expect(out.cells).toEqual([
      ["Lapis", "Metode", "Objek", "Hasil"],
      ["V1", "Baca baris per baris", "Bab 1-3, 42 tabel", "Sesuai, 2 koreksi"],
      ["V2", "Eksekusi ulang skrip", "Lampiran B", "Lulus"],
    ])
    for (const [fmt, text] of Object.entries({ html: out.html, docx: out.docx })) {
      for (const s of ["Baca baris per baris", "Bab 1-3, 42 tabel", "Sesuai, 2 koreksi", "Eksekusi ulang skrip", "Lampiran B", "Lulus"]) expect(text, `${fmt}: ${s}`).toContain(s)
    }
  }, 120_000)

  test("manual form, documented keys only: role -> METODE, name (date) -> HASIL, nothing dropped", async () => {
    const out = await render(tpl, [{ layer: "1", role: "Penyusun", name: "A. Pratama" }, { layer: "2", role: "Pemeriksa", name: "B. Santoso", date: "2026-11-09" }])
    expect(out.cells.slice(1, 3)).toEqual([
      ["1", "Penyusun", "", "A. Pratama"],
      ["2", "Pemeriksa", "", "B. Santoso · 2026-11-09"],
    ])
    for (const text of [out.html, out.docx]) for (const s of ["Pemeriksa", "B. Santoso · 2026-11-09"]) expect(text).toContain(s)
  }, 120_000)

  test("machine form with method/object/result: printed in the manual columns (not dropped)", async () => {
    const out = await render(tpl, CHAIN, {})
    expect(out.cells[0]).toEqual(["Lapis", "Metode", "Objek", "Hasil"])
    for (const text of [out.html, out.docx]) expect(text).toContain("Sesuai, 2 koreksi")
  }, 120_000)

  test("machine form, documented keys only: unchanged (Lapis, Peran, Nama, Tanggal)", async () => {
    const out = await render(tpl, [{ layer: "1", role: "Penyusun", name: "A. Pratama" }], {})
    expect(out.cells).toEqual([["Lapis", "Peran", "Nama", "Tanggal"], ["1", "Penyusun", "A. Pratama", ""]])
  }, 120_000)
})

describe("row 207: studio_edit addresses control-sheet table columns", () => {
  const content = () => {
    const d = e1()
    d.sections.controlSheet.verificationChain = [
      { layer: "V1", role: "Penyusun", name: "A. Pratama" },
      { layer: "V2", method: "Eksekusi", object: "Lampiran B", result: "Lulus" },
    ]
    return d as Record<string, any>
  }

  test("cell { row, column: 'Metode' } fills an empty column (before: TEXT_NOT_FOUND, details.columns: [])", () => {
    const c = content()
    const r = applyClientEdits(c, [{ cell: { row: "V1", column: "Metode" }, value: "Baca baris per baris" }], () => undefined)
    expect(r.notApplied).toEqual([])
    expect(c.sections.controlSheet.verificationChain[0]).toEqual({ layer: "V1", role: "Penyusun", name: "A. Pratama", method: "Baca baris per baris" })
    expect(schemaIssues("slot", slotBody(c.sections.controlSheet.verificationChain))).toEqual([])
  })

  test("EN and key column names address the same cell; HASIL edited in place", () => {
    const c = content()
    applyClientEdits(c, [{ cell: { row: "V2", column: "Result" }, value: "Lulus, 1 catatan" }, { cell: { section: "controlSheet", row: "V2", column: "objek" }, value: "Lampiran C" }], () => undefined)
    expect(c.sections.controlSheet.verificationChain[1]).toEqual({ layer: "V2", method: "Eksekusi", object: "Lampiran C", result: "Lulus, 1 catatan" })
  })

  test("units carry the column names; a wrong column lists them in details.columns", () => {
    const c = content()
    const cols = new Set(clientUnits(c).filter((u) => u.scope.kind === "slot" && u.kind === "cell").map((u) => u.column))
    for (const want of ["Metode / Method (method)", "Objek / Object (object)", "Hasil / Result (result)"]) expect(cols.has(want)).toBe(true)
    const r = applyClientEdits(c, [{ cell: { row: "V1", column: "Metode" }, value: "x" }, { cell: { row: "V1", column: "Temuan" }, value: "y" }], () => undefined)
    expect(r.notApplied.length).toBe(1)
    const cand = r.notApplied[0].candidates as { columns?: string[] }
    expect(cand.columns).toContain("Metode / Method (method)")
  })

  test("find/replace still reaches control-sheet names (meta copies replaced together)", () => {
    const c = content()
    applyClientEdits(c, [{ find: "A. Pratama", replace: "A. Pratama, S.T." }], () => undefined)
    expect(c.sections.controlSheet.verificationChain[0].name).toBe("A. Pratama, S.T.")
  })
})
