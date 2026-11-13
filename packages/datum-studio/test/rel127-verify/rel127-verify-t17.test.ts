// Swarm 1.2.7 row 45b (N7-114, CHAR-VERIFY): regression test committed from the row 9 host probe
// ($T/test/probes/datum-studio/probe9_host.test.ts "T-17"). Must pass at BASE 04067a9d02 and at HEAD; no code change
// for this item. Synthetic inputs only: filler words written here, no fixture file is read.
// AC-T17 (01_specs §4): a live overwrite on the real filesystem through studio_file_verify {downloadDir, overwrite}:
// overwrite OK twice, two backups in <dir>/.bak/, no top-level .bak-* file, backupResidue 1 then 2 in the text.
// (studio_mission_export answers EXPORT_NOT_AVAILABLE in this harness; its .bak/ path is pinned by
// test/mission-tools/row89-w16-decisions-close.test.ts.)
// Runs through the REAL Studio host (AccSession of test/acceptance/session_115.acc.ts, bridge:false, mission guard on).
// Needs the command sandbox off (loopback listen):
//   cd packages/datum-studio && bun test ./test/rel127-verify/rel127-verify-t17.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AccSession, okCall, type S } from "../acceptance/session_115.acc"

const WORK = realpathSync(mkdtempSync(path.join(tmpdir(), "r127v-t17-")))
const s = new AccSession(WORK, { mission: "2026-11-13_r127v-t17" })

beforeAll(async () => {
  await s.start({ bridge: false })
  await s.openMission(["T17"])
}, 120_000)
afterAll(async () => {
  await s.stop()
  rmSync(WORK, { recursive: true, force: true })
}, 60_000)

describe("rel127 VERIFY T-17: live overwrite keeps backups in .bak/", () => {
  test("two overwrites: OK twice, .bak/ entries 2, top-level .bak-* 0, backupResidue 1 then 2", async () => {
    const cr = await s.call("studio_document_create", { template: "datum-nota", mission: s.mission, docKey: "r127v-t17", title: "Dokumen uji T-17", detail: true })
    expect(okCall(cr)).toBe(true)
    const id = String(cr.document?.id ?? cr.documentId)
    const sub = await s.call("studio_chapter_submit", { submission: { $schema: "studio.chapter/v2", target: { documentId: id }, chapter: { key: "1", title: { text: "Uraian uji" }, sections: [{ title: { text: "Bagian uji" }, blocks: [{ type: "paragraph", text: "Paragraf pembuka uji untuk unduhan." }] }] } }, detail: true })
    expect(okCall(sub)).toBe(true)
    const rr = await s.call("studio_render", { documentId: id, scope: "chapter", key: "1", formats: ["html"] })
    const out = ((rr.outputs ?? []) as S[]).find((o) => String(o.format).toUpperCase() === "HTML")
    expect(out?.id).toBeTruthy()

    const a = path.join(s.project, "t17a")
    const b = path.join(s.project, "t17b")
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    const first = await s.call("studio_file_verify", { fileId: out!.id, downloadDir: a })
    expect(okCall(first)).toBe(true)
    const name = readdirSync(a).find((n) => !n.startsWith("."))
    expect(name).toBeTruthy()

    const res: S[] = []
    for (let i = 1; i <= 2; i++) {
      writeFileSync(path.join(b, name!), `isi lama ${i}\n`)
      res.push(await s.call("studio_file_verify", { fileId: out!.id, downloadDir: b, overwrite: true }))
    }
    expect(res.map(okCall)).toEqual([true, true])
    expect(res.map((r) => /backupResidue (\d+)/.exec(String(r._text))?.[1] ?? null)).toEqual(["1", "2"])
    expect(readdirSync(b).filter((n) => n.includes(".bak-"))).toEqual([])
    expect(existsSync(path.join(b, ".bak"))).toBe(true)
    expect(readdirSync(path.join(b, ".bak")).length).toBe(2)
  }, 180_000)
})
