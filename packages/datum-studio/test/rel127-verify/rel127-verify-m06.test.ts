// Swarm 1.2.7 row 45b (N7-114, CHAR-VERIFY): regression test committed from the row 9 host probe
// ($T/test/probes/datum-studio/probe9_host.test.ts "M-06"). Must pass at BASE 04067a9d02 and at HEAD; no code change
// for this item. Synthetic inputs only: filler words written here, no fixture file is read.
// AC-M06 (01_specs §4): a studio_edit find/replace on a figure caption applies (applied true, change honoured, no
// ARG_IGNORED); the studio_edit description names figure captions; a find on a diagram node label gives
// TEXT_NOT_FOUND (node labels are not claimed by the description).
// Runs through the REAL Studio host (AccSession of test/acceptance/session_115.acc.ts, bridge:false, mission guard on).
// Needs the command sandbox off (loopback listen):
//   cd packages/datum-studio && bun test ./test/rel127-verify/rel127-verify-m06.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AccSession, okCall, type S } from "../acceptance/session_115.acc"

const WORK = realpathSync(mkdtempSync(path.join(tmpdir(), "r127v-m06-")))
const s = new AccSession(WORK, { mission: "2026-11-13_r127v-m06" })
const CH = (what: string) => ({ what, why: "uji regresi M-06", impact: "dokumen uji sintetis" })
const chapterSub = (documentId: string, blocks: unknown[]) => ({ $schema: "studio.chapter/v2", target: { documentId }, chapter: { key: "1", title: { text: "Uraian uji" }, sections: [{ title: { text: "Bagian uji" }, blocks }] } })
const diagram = (caption: string) => ({
  type: "diagram",
  spec: { family: "flow", labels_verified: true, nodes: [{ id: "a", label: "Gudang utama", class: { col: 0, row: 0 } }, { id: "b", label: "Pemeriksaan mutu", class: { col: 0, row: 1 } }, { id: "c", label: "Rak simpan", class: { col: 0, row: 2 } }], edges: [{ from: "a", to: "b", kind: "data", label: "kirim" }, { from: "b", to: "c", kind: "data", label: "lolos" }] },
  caption: { text: caption },
  source: { text: "Uji sintetis." },
})

beforeAll(async () => {
  await s.start({ bridge: false })
  await s.openMission(["M06"])
}, 120_000)
afterAll(async () => {
  await s.stop()
  rmSync(WORK, { recursive: true, force: true })
}, 60_000)

describe("rel127 VERIFY M-06: studio_edit reaches figure captions", () => {
  test("caption find/replace applies with the change; node label gives TEXT_NOT_FOUND; the description names captions", async () => {
    const cr = await s.call("studio_document_create", { template: "datum-nota", mission: s.mission, docKey: "r127v-m06", title: "Dokumen uji M-06", detail: true })
    expect(okCall(cr)).toBe(true)
    const id = String(cr.document?.id ?? cr.documentId)
    const sub = await s.call("studio_chapter_submit", { submission: chapterSub(id, [{ type: "paragraph", text: "Paragraf pembuka uji untuk sunting." }, diagram("Alur penerimaan barang gudang utama.")]), detail: true })
    expect(okCall(sub)).toBe(true)

    const cap = await s.call("studio_edit", { documentId: id, edits: [{ find: "Alur penerimaan barang", replace: "Alur pemeriksaan barang" }], change: CH("caption figur") })
    expect(okCall(cap)).toBe(true)
    const warn = JSON.stringify([...((cap.warnings ?? []) as S[]), ...((cap.data?.warnings ?? []) as S[])])
    expect(warn.includes("ARG_IGNORED")).toBe(false)
    const after = JSON.stringify(await s.call("studio_document_get", { documentId: id, detail: true }))
    expect(after.includes("Alur pemeriksaan barang")).toBe(true)
    expect(after.includes("Alur penerimaan barang")).toBe(false)

    const node = await s.call("studio_edit", { documentId: id, edits: [{ find: "Pemeriksaan mutu", replace: "Uji mutu" }], change: CH("label simpul") })
    expect(JSON.stringify(node).includes("TEXT_NOT_FOUND")).toBe(true)

    const tools = await s.client.listTools()
    const desc = String(tools.tools.find((t) => t.name === "studio_edit")?.description ?? "")
    expect(desc).toContain("caption/sumber figur")
  }, 120_000)
})
