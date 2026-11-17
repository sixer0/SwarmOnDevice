// Swarm 1.3.3 row 66 (MC-5, owner decision U20): the row-close gate is honest and can be satisfied.
//
// Rules under test (store/mission/output-gate.ts `rowCloseGate`, the done block of mission-store.ts):
//   R1  a declared output is verified when its file exists, its sha256 matches, it belongs to the document's current
//       revision and its checks passed; lint rules not run for cause `tier` / `not-applicable` do not block; rules the
//       tier requires that could not run do, and the refusal names them (with the staged ones);
//   R2  `labels_verified` false is not a refusal: the row goes `done` and carries `awaitingHumanCheck`;
//   R3  a verified file is not refused for a layout witness the machine did not make;
//   R4  everything else that refused before still refuses, with the facts row 67's detail needs;
//   R5  a row without a declared output behaves as before.
// Real SqliteStudioStore opened with missionGuard: true; plain SQL seeding (see _seed.ts). No port, no render engine.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isStoreError, type StoreErrorCode } from "../../src/store/index.ts"
import { rowCloseGate, rowAwaitingHumanCheckOf, readWitnessFacts } from "../../src/store/mission/output-gate.ts"
import { outputGateFindings } from "../../src/mcp-host/verify/client-findings.ts"
import { readWitnessManifest, VERIFY_WITNESS_SCHEMA } from "../../src/mcp-host/verify/verify-outputs.ts"
import { awaitingHumanCheckOf } from "../../vendor/src/lib/studio/services/render/figures.ts"
import { closeStores, labelFinding, mission, openStore, PASS, seedDocument, seedOutput, seedRecord, type Rec, type Tx } from "./_seed.ts"
import { giveProjectCopy } from "../mc8-deliverable-gate/_project-copy.ts"

const store = await openStore("unit")
const ROOT = store.rootDir
const M = "2026-11-17_row66-unit"
// One row per case; all running.
const ROWS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20"]
await mission(store, M, ROWS)
afterAll(closeStores)

const tx = <R>(fn: (t: Tx) => R) => store.transaction(async (t) => fn(t))
const done = (id: string, note = "checked: outputs rendered and verified") => tx((t) => store.missions.updateRows(t, M, [{ id, status: "done", note }]))
const rowOf = (id: string) => store.missions.get(M)!.mission.rows.find((r) => r.id === id)!
async function refusedWith(label: string, p: Promise<unknown>, code: StoreErrorCode): Promise<Rec> {
  try {
    await p
  } catch (e) {
    if (!isStoreError(e, code)) throw new Error(`${label}: expected ${code}, got ${e instanceof Error ? e.message : String(e)}`)
    const details = ((e as { details?: Rec }).details ?? {}) as Rec
    console.log(`[row66] refused ${label}: ${code} ${JSON.stringify(details)}`)
    return details
  }
  throw new Error(`${label}: expected ${code}, nothing thrown`)
}
const outputsOf = (details: Rec) => (details.deliverables as Rec[]).flatMap((d) => d.outputs as Rec[])
const reasons = (details: Rec) => outputsOf(details).map((o) => `${o.format ?? "-"}:${o.reason}`)

/** A lint report as the render stores it on the revision (`revision.lint_report`). */
function lint(o: { labels?: string[]; notRun?: Rec[]; tier?: string } = {}): Rec {
  return {
    tier: o.tier ?? "TERBIT",
    releaseStatus: "PASS",
    banner: "Lint",
    checks: [
      { checkId: "D01", status: "PASS" },
      ...(o.labels ?? []).flatMap((address) => [
        { checkId: "D09", status: "REPORT", address, detail: `Gambar ${address}: labels_verified bukan true` },
        { checkId: "P1-labels_verified", status: "REPORT", address, detail: `diagram Gambar ${address}: menunggu pemeriksa manusia` },
      ]),
    ],
    ...(o.notRun ? { notRun: o.notRun } : {}),
  }
}
/** A deliverable of row `r` whose three PRIMARY outputs carry the given record each (null = no record). */
async function deliverable(r: string, name: string, o: { lint?: unknown; formats?: string[]; checks?: Parameters<typeof seedRecord>[3] | null; file?: boolean } = {}) {
  const made = await tx((t) => {
    const d = seedDocument(t, { mission: M, docKey: `row-${r}-${name}`, lint: o.lint })
    const outs = (o.formats ?? ["DOCX", "HTML", "PDF"]).map((format) => seedOutput(t, ROOT, d, { format, file: o.file }))
    if (o.checks !== null) for (const out of outs) seedRecord(t, out, d, o.checks ?? PASS)
    return { ...d, outs }
  })
  // 1.3.3 row 70 (MC-8): the project copy a verified render makes, so these row-close tests are not refused for it.
  if (o.file !== false) await giveProjectCopy(store, made.documentId)
  return made
}

describe("R2: labels_verified false closes the row with the marker", () => {
  test("lint reports P1-labels_verified REPORT (row 60), every output verified: done, awaitingHumanCheck set, reply says so", async () => {
    await deliverable("1", "laporan", { lint: lint({ labels: ["2.1.2", "2.2.2"] }) })
    const r = await done("1")
    expect(r.changed).toEqual(["1"])
    const res = r.results[0]!
    expect(res.ok).toBe(true)
    expect(res.awaitingHumanCheck).toEqual({ checks: ["labels_verified"], since: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/), figures: ["2.1.2", "2.2.2"] })
    expect(res.message).toBe("row 1 is done, awaiting human check: a person has not yet checked the figure labels (labels_verified) of 2 figures; only the person clears this, in Mission Control")
    console.log(`[row66] closed with marker: ${JSON.stringify(res)}`)
    const row = rowOf("1")
    expect(row.status).toBe("done")
    expect(row.awaitingHumanCheck).toEqual({ checks: ["labels_verified"], since: res.awaitingHumanCheck!.since })
    // The status event names the marker; the field write is its own row-change event.
    const events = await tx((t) => t.all<{ verb: string; to_status: string | null; detail: string }>("SELECT verb, to_status, detail FROM mission_event WHERE mission_id = ? AND row_id = '1' ORDER BY seq DESC LIMIT 2", [M]))
    expect(events.map((e) => [e.verb, e.to_status, JSON.parse(e.detail)])).toEqual([
      ["row-change", null, { fields: ["awaitingHumanCheck"] }],
      ["row-status", "done", { cause: "update_row", awaitingHumanCheck: ["labels_verified"] }],
    ])
  })

  test("a record of before 1.3.3 (LINT FAIL whose only findings are D09 / P1-labels_verified) closes with the marker too", async () => {
    const held = [{ id: "LINT", status: "FAIL" as const, findings: [labelFinding("2.1.2"), labelFinding("3.1.2"), labelFinding("2.1.2", "P1-labels_verified"), labelFinding("3.1.2", "P1-labels_verified")] }]
    await deliverable("2", "laporan", { checks: held })
    const r = await done("2")
    expect(r.results[0]).toMatchObject({ id: "2", ok: true, awaitingHumanCheck: { checks: ["labels_verified"], figures: ["2.1.2", "3.1.2"] } })
    expect(rowOf("2").awaitingHumanCheck).toMatchObject({ checks: ["labels_verified"] })
    expect(rowOf("2").awaitingHumanCheck!.clearedBy).toBeUndefined()
  })

  test("a label finding beside another lint rule, beside another failing check, or in a cut list is still a refusal", async () => {
    await deliverable("3", "campur", { checks: [{ id: "LINT", status: "FAIL", findings: [labelFinding("2.1.2"), { address: "1.1", code: "LINT_FAIL", detail: "D01: x", label: "D01", page: null }] }] })
    const a = await refusedWith("labels + D01", done("3"), "OUTPUT_UNVERIFIED")
    expect(reasons(a)).toEqual(["DOCX:CHECK_FAILED", "HTML:CHECK_FAILED", "PDF:CHECK_FAILED"])
    expect(rowOf("3").status).toBe("running")
    expect(rowOf("3").awaitingHumanCheck).toBeUndefined()

    await deliverable("4", "campur", { checks: [{ id: "LINT", status: "FAIL", findings: [labelFinding("2.1.2")] }, { id: "OVERLAP_CLIP", status: "FAIL", findings: [{ code: "OVERLAP", page: 3, address: null, label: null, detail: "x" }] }] })
    await refusedWith("labels + OVERLAP_CLIP", done("4"), "OUTPUT_UNVERIFIED")

    await deliverable("5", "terpotong", { checks: [{ id: "LINT", status: "FAIL", findings: [labelFinding("2.1.2")], truncated: 3 }] })
    await refusedWith("label findings with a cut list", done("5"), "OUTPUT_UNVERIFIED")
  })

  test("the awaiting deliverable does not hide a refused one: refused, no marker written", async () => {
    await deliverable("6", "label", { lint: lint({ labels: ["2.1.2"] }) })
    await deliverable("6", "belum", { checks: null })
    const d = await refusedWith("one awaiting + one not checked", done("6"), "OUTPUT_UNVERIFIED")
    expect((d.deliverables as Rec[]).map((x) => x.docKey)).toEqual(["row-6-belum"])
    expect(rowOf("6").awaitingHumanCheck).toBeUndefined()
  })

  test("the local reading of the lint report equals the vendored awaitingHumanCheckOf (row 60 contract)", () => {
    const samples: unknown[] = [
      null,
      [],
      [{ checkId: "P1-labels_verified", status: "REPORT" }],
      [{ checkId: "P1-labels_verified", status: "NOT_RUN" }],
      [{ checkId: "P1-labels_verified", status: "PASS" }],
      [{ checkId: "D09", status: "REPORT" }],
      [{ checkId: "D01", status: "FAIL" }, { checkId: "P1-labels_verified", status: "REPORT", address: "2.1.2" }],
    ]
    for (const s of samples) expect(rowAwaitingHumanCheckOf(s).checks).toEqual(awaitingHumanCheckOf(s as never))
  })
})

describe("an agent call cannot clear the marker", () => {
  test("set, add, patch field, reopen and close again: the marker stays, with the same `since`", async () => {
    const before = rowOf("1").awaitingHumanCheck!
    for (const value of [null, undefined, { checks: ["labels_verified"], since: before.since, clearedBy: "U1", clearedAt: before.since }]) {
      if (value === undefined) continue
      await refusedWith("set awaitingHumanCheck", tx((t) => store.missions.updateRows(t, M, [{ id: "1", set: { awaitingHumanCheck: value } as never }])), "FIELD_READ_ONLY")
    }
    await refusedWith("patch-level awaitingHumanCheck", tx((t) => store.missions.updateRows(t, M, [{ id: "1", awaitingHumanCheck: null } as never])), "SCHEMA_INVALID")
    await refusedWith("patch-level clearedBy", tx((t) => store.missions.updateRows(t, M, [{ id: "1", clearedBy: "U1" } as never])), "SCHEMA_INVALID")
    expect(rowOf("1").awaitingHumanCheck).toEqual(before)
    // Reopen (needs a decision) and close again: the document still reports the label check, the marker is kept as it was.
    await tx((t) => store.missions.recordDecision(t, M, { id: "C1", by: "controller", date: "2026-11-17", text: "reopen row 1" }))
    await tx((t) => store.missions.updateRows(t, M, [{ id: "1", status: "running", decision: "C1" }]))
    expect(rowOf("1").awaitingHumanCheck).toEqual(before)
    const again = await done("1")
    expect(again.results[0]!.awaitingHumanCheck!.since).toBe(before.since)
    expect(rowOf("1").awaitingHumanCheck).toEqual(before)
  })

  test("a marker cleared by the person (U decision) is not raised again unless the document still reports the check", async () => {
    // Row 62's path writes clearedBy through the host setter; here the store setter stands in for it.
    await deliverable("7", "bersih", { lint: lint() })
    const since = "2026-11-17T01:00:00.000Z"
    await tx((t) => store.missions.setAwaitingHumanCheck(t, M, "7", { checks: ["labels_verified"], since, clearedBy: "U1", clearedAt: "2026-11-17T02:00:00.000Z" }))
    const r = await done("7")
    expect(r.results[0]!.awaitingHumanCheck).toBeUndefined()
    expect(rowOf("7").awaitingHumanCheck).toEqual({ checks: ["labels_verified"], since, clearedBy: "U1", clearedAt: "2026-11-17T02:00:00.000Z" })
  })
})

describe("R3: no layout witness is demanded of a verified file", () => {
  test("a verified DOCX alone (no PDF, no HTML) closes; the reply notes that no layout file was made", async () => {
    const d = await deliverable("8", "docx", { formats: ["DOCX"] })
    // The strict "Final" of the panel still says NO_LAYOUT_WITNESS; the close gate does not refuse for it.
    expect((await store.revisionVerification(d.documentId, "latest")).reasons).toEqual(["NO_LAYOUT_WITNESS"])
    const r = await done("8")
    expect(r.results[0]).toEqual({ id: "8", ok: true, closed: [{ docKey: "row-8-docx", documentId: d.documentId, revisionNo: 1, layoutWitness: false }] })
    expect(rowOf("8").status).toBe("done")
    expect(rowOf("8").awaitingHumanCheck).toBeUndefined()
  })

  test("figure pages without a witness image are information, not a refusal", async () => {
    const d = await deliverable("9", "saksi")
    const html = d.outs[1]!
    const dir = join(ROOT, "verify", html.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "p003.png"), "png")
    writeFileSync(join(dir, "witness.json"), JSON.stringify({ $schema: VERIFY_WITNESS_SCHEMA, documentId: d.documentId, revisionNo: 1, htmlOutputId: html.id, dpi: 150, basis: "snapshot", pages: [{ page: 3, png: join(dir, "p003.png"), figures: ["Gambar 2.1"] }, { page: 5, png: join(dir, "p005.png"), figures: ["Gambar 2.2"] }], missing: [9], unplaced: ["Gambar 4.1"], reason: null }))
    // Same reading as the host's reader (row 58): page 5 has no file, page 9 was never imaged.
    expect(readWitnessFacts(ROOT, html.id)).toEqual({ htmlOutputId: html.id, missing: readWitnessManifest(ROOT, html.id)!.missing, unplaced: ["Gambar 4.1"] })
    const r = await done("9")
    expect(r.results[0]).toEqual({ id: "9", ok: true, closed: [{ docKey: "row-9-saksi", documentId: d.documentId, revisionNo: 1, layoutWitness: true, witnessMissingPages: [5, 9] }] })
  })
})

describe("R1: lint rules that did not run", () => {
  const TIER = { id: "C-90", kind: "rule", reason: "tidak berlaku pada tier TERBIT; berlaku pada SERAH", cause: "tier" }
  const NA = { id: "B-12", kind: "rule", reason: "aturan bahasa Indonesia pada dokumen EN", cause: "not-applicable" }
  const STAGED = { id: "C-35", kind: "rule", reason: "pemindai belum terdaftar", cause: "staged" }
  const HUMAN = { id: "H-01", kind: "rule", reason: "pemeriksaan manusia; tidak dijalankan mesin", cause: "human" }
  const COULD = { id: "DATUM-37", kind: "rule", reason: "modul render tidak dijalankan: tidak ada masukan render", cause: "could-not-run" }
  const MODULE = { id: "render", kind: "module", reason: "tidak ada masukan render", cause: "could-not-run" }

  test("rules not run for cause tier / not-applicable do not block", async () => {
    await deliverable("10", "tier", { lint: lint({ notRun: [TIER, NA] }) })
    expect((await done("10")).results[0]).toEqual({ id: "10", ok: true })
  })

  test("a rule the tier requires that could not run blocks; the refusal names it and the staged ones, not the tier ones", async () => {
    await deliverable("11", "parsial", { lint: lint({ notRun: [MODULE, TIER, NA, HUMAN, STAGED, COULD] }), checks: [{ id: "LINT", status: "UNKNOWN", reason: "LINT_PARTIAL" }] })
    const d = await refusedWith("LINT_PARTIAL", done("11"), "OUTPUT_UNVERIFIED")
    expect(reasons(d)).toEqual(["DOCX:CHECK_UNKNOWN", "HTML:CHECK_UNKNOWN", "PDF:CHECK_UNKNOWN"])
    const del = (d.deliverables as Rec[])[0]!
    // The gate hands row 67's builder the entries it lists (could-not-run, staged, human); tier / not-applicable are left out.
    expect(del.lintNotRun).toEqual([MODULE, HUMAN, STAGED, COULD])
    const shaped = outputGateFindings(d as never) as unknown as { details: { deliverables: Rec[]; fix: string[] } }
    const out = (shaped.details.deliverables[0]!.outputs as Rec[])[0]!
    expect(out.verified).toBe(false)
    expect((out.missing as Rec[])[0]).toMatchObject({ kind: "lint-not-run", rules: ["C-35", "DATUM-37"], modules: ["render"], listed: true, fix: "studio_render" })
    console.log(`[row66] LINT_PARTIAL through row 67's detail: ${JSON.stringify(out)}`)
    expect(rowOf("11").status).toBe("running")
  })

  test("a lint report of before row 64 (no notRun list): still refused, and nothing is embedded (the detail then says the ids are not listed)", async () => {
    await deliverable("12", "lama", { lint: lint(), checks: [{ id: "LINT", status: "UNKNOWN", reason: "LINT_PARTIAL" }] })
    const d = await refusedWith("LINT_PARTIAL, no list", done("12"), "OUTPUT_UNVERIFIED")
    expect((d.deliverables as Rec[])[0]!.lintNotRun).toBeUndefined()
  })

  test("staged rules alone (no scanner exists) do not block a file whose lint passed", async () => {
    // Decision recorded in implementation/66: every report of a tier lists its staged rules; refusing for them would
    // make the gate impossible to satisfy. They are named in a refusal that exists for another cause (test above).
    await deliverable("13", "staged", { lint: lint({ notRun: [STAGED, HUMAN] }) })
    expect((await done("13")).results[0]).toEqual({ id: "13", ok: true })
  })
})

describe("R4: everything else still refuses", () => {
  test("no output of the current revision: NOT_RENDERED (an output of an older revision does not count)", async () => {
    await tx((t) => {
      const d = seedDocument(t, { mission: M, docKey: "row-14-lama", revs: 2 })
      const old = t.get<{ id: string }>("SELECT id FROM revision WHERE document_id = ? AND revision_no = 1", [d.documentId])!
      const out = seedOutput(t, ROOT, { documentId: d.documentId, revisionId: old.id }, { format: "PDF" })
      seedRecord(t, out, { revisionId: old.id }, PASS)
    })
    const d = await refusedWith("older revision only", done("14"), "OUTPUT_UNVERIFIED")
    expect(reasons(d)).toEqual(["-:NOT_RENDERED"])
    expect((d.deliverables as Rec[])[0]).toMatchObject({ revisionNo: 2, final: false })
  })

  test("not checked, stale sha256, a failing check, an unknown check: each refused with its reason and stored checks", async () => {
    await tx((t) => {
      const d = seedDocument(t, { mission: M, docKey: "row-15-aneka" })
      const [docx, html, pdf, svg] = ["DOCX", "HTML", "PDF", "SVG"].map((format) => seedOutput(t, ROOT, d, { format, role: format === "SVG" ? "FIGURE" : "PRIMARY", figureLabel: format === "SVG" ? "Gambar 1" : null }))
      void docx // no record: NOT_CHECKED
      seedRecord(t, html!, d, PASS, { sha: "f".repeat(64) }) // record of other bytes: STALE
      seedRecord(t, pdf!, d, [{ id: "LINT", status: "PASS" }, { id: "OVERLAP_CLIP", status: "FAIL", findings: [{ code: "OVERLAP", page: 2, address: null, label: null, detail: "x" }] }])
      seedRecord(t, svg!, d, [{ id: "FIGURE_FIT", status: "UNKNOWN", reason: "BRIDGE_UNAVAILABLE" }])
    })
    const d = await refusedWith("four reasons", done("15"), "OUTPUT_UNVERIFIED")
    expect(reasons(d).sort()).toEqual(["DOCX:NOT_CHECKED", "HTML:STALE", "PDF:CHECK_FAILED", "SVG:CHECK_UNKNOWN"])
    const pdf = outputsOf(d).find((o) => o.format === "PDF")!
    expect((pdf.checks as Rec[]).map((c) => `${c.id}:${c.status}`)).toEqual(["OVERLAP_CLIP:FAIL"])
    // No document-level NO_LAYOUT_WITNESS entry any more: it is not a condition of closing.
    expect(outputsOf(d).some((o) => o.reason === "NO_LAYOUT_WITNESS")).toBe(false)
  })

  test("a verified record whose file is no longer on disk: refused as a missing file", async () => {
    const d = await deliverable("16", "hilang")
    rmSync(join(ROOT, d.outs[2]!.relPath))
    const det = await refusedWith("file gone", done("16"), "OUTPUT_UNVERIFIED")
    expect(outputsOf(det)).toEqual([{ outputId: d.outs[2]!.id, format: "PDF", state: "unverified", reason: "NOT_RENDERED", fileMissing: true }])
    const shaped = outputGateFindings(det as never) as unknown as { details: { deliverables: Rec[] } }
    expect(((shaped.details.deliverables[0]!.outputs as Rec[])[0]!.missing as Rec[])[0]).toMatchObject({ kind: "file-missing", fix: "studio_render" })
  })

  test("the refusal of a deliverable carries the witness facts and the pending human check for row 67's detail", async () => {
    const d = await tx((t) => {
      const doc = seedDocument(t, { mission: M, docKey: "row-17-fakta", lint: lint({ labels: ["2.1.2"] }) })
      const html = seedOutput(t, ROOT, doc, { format: "HTML" })
      seedRecord(t, html, doc, [{ id: "OVERLAP_CLIP", status: "UNKNOWN", reason: "BRIDGE_UNAVAILABLE" }])
      return { ...doc, html }
    })
    const dir = join(ROOT, "verify", d.html.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "witness.json"), JSON.stringify({ $schema: VERIFY_WITNESS_SCHEMA, documentId: d.documentId, revisionNo: 1, htmlOutputId: d.html.id, dpi: 150, basis: "snapshot", pages: [], missing: [4, 7], unplaced: [], reason: "BUDGET_EXCEEDED" }))
    const det = await refusedWith("facts embedded", done("17"), "OUTPUT_UNVERIFIED")
    expect((det.deliverables as Rec[])[0]).toMatchObject({ docKey: "row-17-fakta", awaitingHumanCheck: ["labels_verified"], witness: { htmlOutputId: d.html.id, missing: [4, 7], unplaced: [] } })
    const shaped = outputGateFindings(det as never) as unknown as { details: { deliverables: Rec[] } }
    expect(shaped.details.deliverables[0]!.witness).toMatchObject({ missingPages: [4, 7] })
  })

  test("rowCloseGate is a read: it lists the same refusal without writing", () => {
    const g = rowCloseGate(store.missions["host"].reader(), M, "15", "agentWorkReport", { storeRoot: ROOT })
    expect(g.total).toBe(1)
    expect(g.deliverables[0]!.docKey).toBe("row-15-aneka")
    expect(g.awaitingHumanCheck).toEqual([])
  })
})

describe("R5: a row without a declared output keeps today's behaviour", () => {
  test("running -> done needs the note; with it the row closes, without marker or close notes", async () => {
    const d = await refusedWith("no note", tx((t) => store.missions.updateRows(t, M, [{ id: "18", status: "done" }])), "SCHEMA_INVALID")
    expect(d).toMatchObject({ row: "18", field: "note", from: "running", to: "done" })
    expect((await done("18", "checked by hand: file list in the note")).results[0]).toEqual({ id: "18", ok: true })
    expect(rowOf("18").awaitingHumanCheck).toBeUndefined()
  })

  test("work reports and archived documents under the row are not deliverables", async () => {
    await tx((t) => {
      seedDocument(t, { mission: M, docKey: "row-19-laporan-kerja", contractKind: "agentWorkReport" })
      const a = seedDocument(t, { mission: M, docKey: "row-19-arsip" })
      t.run("UPDATE document SET archived = 1 WHERE id = ?", [a.documentId])
    })
    expect((await done("19")).results[0]).toEqual({ id: "19", ok: true })
  })
})

describe("gate off (store opened without missionGuard)", () => {
  test("no check, no marker: the legacy switch is unchanged", async () => {
    const off = await openStore("off", false)
    const MO = "2026-11-17_row66-off"
    await mission(off, MO, ["1"])
    await off.transaction(async (t) => {
      const d = seedDocument(t, { mission: MO, docKey: "row-1-x", lint: lint({ labels: ["2.1.2"] }) })
      seedOutput(t, off.rootDir, d, { format: "DOCX" })
    })
    const r = await off.transaction(async (t) => off.missions.updateRows(t, MO, [{ id: "1", status: "done", note: "n" }]))
    expect(r.results[0]).toEqual({ id: "1", ok: true })
    expect(off.missions.get(MO)!.mission.rows[0]!.awaitingHumanCheck).toBeUndefined()
  })
})
