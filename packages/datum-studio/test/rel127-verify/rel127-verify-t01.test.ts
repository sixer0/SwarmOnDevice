// Swarm 1.2.7 row 45b (N7-114, CHAR-VERIFY): regression test committed from the row 9 host probe
// ($T/test/probes/datum-studio/probe9_host.test.ts "T-01"). Must pass at BASE 04067a9d02 and at HEAD; no code change
// for this item. Synthetic inputs only: filler words written here, no fixture file is read.
// AC-T01 (01_specs §4): chapter submit and studio_figure_revise with a token-led caption ("Gambar 3.2 ...",
// "Figure 1.1 ...") give CAPTION_TOKEN_DUPLICATE; the token-free caption gives OK.
// Runs through the REAL Studio host (AccSession of test/acceptance/session_115.acc.ts, bridge:false, mission guard on).
// Needs the command sandbox off (loopback listen):
//   cd packages/datum-studio && bun test ./test/rel127-verify/rel127-verify-t01.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AccSession, checkIdsIn, errCode, okCall, type S } from "../acceptance/session_115.acc"

const WORK = realpathSync(mkdtempSync(path.join(tmpdir(), "r127v-t01-")))
const s = new AccSession(WORK, { mission: "2026-11-13_r127v-t01" })
const CH = { what: "caption uji", why: "uji regresi T-01", impact: "dokumen uji sintetis" }
const chapterSub = (documentId: string, blocks: unknown[]) => ({ $schema: "studio.chapter/v2", target: { documentId }, chapter: { key: "1", title: { text: "Uraian uji" }, sections: [{ title: { text: "Bagian uji" }, blocks }] } })
const diagram = (caption: string) => ({
  type: "diagram",
  spec: { family: "flow", labels_verified: true, nodes: [{ id: "a", label: "Gudang utama", class: { col: 0, row: 0 } }, { id: "b", label: "Pemeriksaan mutu", class: { col: 0, row: 1 } }, { id: "c", label: "Rak simpan", class: { col: 0, row: 2 } }], edges: [{ from: "a", to: "b", kind: "data", label: "kirim" }, { from: "b", to: "c", kind: "data", label: "lolos" }] },
  caption: { text: caption },
  source: { text: "Uji sintetis." },
})
const PARA = { type: "paragraph", text: "Paragraf pembuka uji." }
const refused = (r: S, id: string) => checkIdsIn(r).includes(id) || String(r._text).includes(id)

beforeAll(async () => {
  await s.start({ bridge: false })
  await s.openMission(["T01"])
}, 120_000)
afterAll(async () => {
  await s.stop()
  rmSync(WORK, { recursive: true, force: true })
}, 60_000)

describe("rel127 VERIFY T-01: caption token refused at chapter submit and at figure_revise", () => {
  test("token-led caption: chapter submit and figure_revise give CAPTION_TOKEN_DUPLICATE; token-free caption is OK", async () => {
    const cr = await s.call("studio_document_create", { template: "datum-nota", mission: s.mission, docKey: "r127v-t01", title: "Dokumen uji T-01", detail: true })
    expect(okCall(cr)).toBe(true)
    const id = String(cr.document?.id ?? cr.documentId)

    const bad = await s.call("studio_chapter_submit", { submission: chapterSub(id, [PARA, diagram("Gambar 3.2 Alur penerimaan barang gudang.")]), detail: true })
    expect(okCall(bad)).toBe(false)
    expect(refused(bad, "CAPTION_TOKEN_DUPLICATE")).toBe(true)

    const ok = await s.call("studio_chapter_submit", { submission: chapterSub(id, [PARA, diagram("Alur penerimaan barang gudang.")]), detail: true })
    expect(errCode(ok)).toBe("OK")

    const rev = await s.call("studio_figure_revise", { documentId: id, address: "Gambar 1.1", patch: { caption: "Figure 1.1 Alur penerimaan barang gudang." }, change: CH, preview: false })
    expect(okCall(rev)).toBe(false)
    expect(refused(rev, "CAPTION_TOKEN_DUPLICATE")).toBe(true)
  }, 120_000)
})
