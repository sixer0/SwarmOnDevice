// Swarm 1.3.3 row 66 (MC-5): the 13 OUTPUT_UNVERIFIED close refusals of 2026-11-17 (research/05 R7) replayed through
// the NEW gate: project 1 row 8 (8 calls), u1 row 4 (2), u3 row 2 (3).
//
// Input: row 67's fixtures (../mc5-output-unverified-detail/fixtures, reduced copy of R7 with synthetic mission ids and
// synthetic row notes, row 146): the refused calls with
// the gate's details of that moment (`rincian`), and the stored verification record of each output they name.
// Rebuild, per refusal, in a real store (missionGuard on): the mission row, each listed deliverable (same docKey,
// document id and revision number), each listed output (same id and format; role and sha256 from its stored record)
// and its verification record of that moment: the stored record when it predates the refusal and agrees with the
// refused reason, else (2 outputs in refusals 4-6, record overwritten later) UNKNOWN checks taken from the stored
// refusal text, as row 67's replay does. Then the SAME call (status done, the note of that day) runs through
// `MissionStore.updateRows`, and a refusal goes through the real reply shaping (`refusal`, row 67's detail).
// Not in the extract, so not rebuilt and not verifiable: the revisions' lint reports (no `notRun` existed that day),
// the witness lists, outputs that were already verified (a refusal lists only the others), the files themselves
// (a 10-byte stand-in is written per output so the presence check has something to see).
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { isStoreError } from "../../src/store/index.ts"
import { refusal } from "../../src/mcp-host/mission/tool-result"
import { closeStores, mission, openStore, seedDocument, seedOutput, seedRecord, type Rec } from "./_seed.ts"
import { giveProjectCopy } from "../mc8-deliverable-gate/_project-copy.ts"

const FIX = join(import.meta.dir, "..", "mc5-output-unverified-detail", "fixtures")
const lines = (f: string) => readFileSync(join(FIX, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec)
const records = new Map(lines("r7_output_verification_subset.jsonl").map((r) => [r.output_file_id as string, r]))
const P1 = "2026-11-17_replay-project-1"
const U1 = "2026-11-17_replay-u1"
const U3 = "2026-11-17_replay-u3"

const store = await openStore("replay")
afterAll(closeStores)

/** The check entries the stored refusal text printed for one output (row 67's rebuild). */
function storedEntries(error: string, outputId: string): Rec[] | null {
  const all = error.split("\n")
  const at = all.findIndex((l) => new RegExp(` ${outputId}: (\\d+) check entr(y|ies)$`).test(l))
  if (at < 0) return null
  const n = Number(/: (\d+) check entr/.exec(all[at]!)![1])
  return all.slice(at + 1, at + 1 + n).map((l) => JSON.parse(l) as Rec)
}

interface Outcome { n: number; mission: string; row: string; time: string; closed: boolean; result?: Rec; rowAfter?: Rec; text?: string; details?: Rec; notRebuilt: string[]; fromText: string[] }
const outcomes: Outcome[] = []
let n = 0
for (const r of lines("r7_close_refusals_OUTPUT_UNVERIFIED.jsonl")) {
  n++
  const error = r.error as string
  const stored = JSON.parse(/rincian: (\{.*?\})\n(?:periksa|next)/s.exec(error)![1]!) as Rec
  const call = (r.arguments as { rows: Array<{ id: string; note?: string; status: string }> }).rows[0]!
  const rowId = stored.row as string
  // One mission per replayed call (the day's mission id plus the call number), so every call starts from that moment.
  const M = `${stored.mission as string}-r${String(n).padStart(2, "0")}`
  await mission(store, M, [rowId])
  const notRebuilt: string[] = []
  const fromText: string[] = []
  await store.transaction(async (t) => {
    for (const d of stored.deliverables as Rec[]) {
      const doc = seedDocument(t, { mission: M, docKey: d.docKey as string, id: `${d.documentId as string}r${String(n).padStart(2, "0")}`, revisionNo: Number(d.revisionNo), tier: "TERBIT" })
      for (const o of d.outputs as Rec[]) {
        if (o.outputId === null) continue // document-level entry (NOT_RENDERED / NO_LAYOUT_WITNESS): derived, nothing to seed
        const rec = records.get(o.outputId as string)
        const report = rec ? (JSON.parse(rec.report as string) as Rec) : null
        const id = `${o.outputId as string}r${String(n).padStart(2, "0")}`
        const out = seedOutput(t, store.rootDir, doc, { id, format: o.format as string, role: (report?.role as "PRIMARY" | "FIGURE" | undefined) ?? "PRIMARY", figureLabel: (report?.figureLabel as string | null | undefined) ?? null, sha: (rec?.output_sha256 as string | undefined) ?? undefined })
        if (o.reason === "NOT_CHECKED") continue
        const agrees = rec && Number(rec.time_verified) <= Number(r.time_ms) && (o.reason === "CHECK_FAILED" ? Number(rec.fail_count) > 0 : Number(rec.fail_count) === 0 && Number(rec.unknown_count) > 0)
        if (agrees) {
          seedRecord(t, out, doc, rec!.report as string, { state: "unverified", fail: Number(rec!.fail_count), unknown: Number(rec!.unknown_count), attempt: Number(rec!.attempt), time: Number(rec!.time_verified) })
          continue
        }
        const printed = storedEntries(error, o.outputId as string)
        if (o.reason === "CHECK_UNKNOWN" && printed && printed.length > 0 && printed.every((e) => e.verdict === "UNKNOWN")) {
          seedRecord(t, out, doc, printed.map((e) => ({ id: e.check as string, status: "UNKNOWN" as const, reason: e.rule as string })))
          fromText.push(o.outputId as string)
        } else notRebuilt.push(o.outputId as string)
      }
    }
  })
  // 1.3.3 row 70 (MC-8): give each seeded document that has outputs the project copy a verified render makes, so the
  // replay still measures row 66's output gate and not the project-copy gate added after that day.
  for (const d of stored.deliverables as Rec[]) {
    if ((d.outputs as Rec[]).some((o) => o.outputId !== null)) await giveProjectCopy(store, `${d.documentId as string}r${String(n).padStart(2, "0")}`)
  }
  const base = { n, mission: stored.mission as string, row: rowId, time: r.time_local as string, notRebuilt, fromText }
  try {
    const res = await store.transaction(async (t) => store.missions.updateRows(t, M, [{ id: rowId, status: "done", note: call.note }]))
    outcomes.push({ ...base, closed: true, result: res.results[0] as unknown as Rec, rowAfter: store.missions.get(M)!.mission.rows[0] as unknown as Rec })
  } catch (e) {
    if (!isStoreError(e, "OUTPUT_UNVERIFIED")) throw e
    const err = e as { message: string; details: Rec }
    const shaped = refusal("studio_mission_update_row", "OUTPUT_UNVERIFIED", err.message.replace(/^OUTPUT_UNVERIFIED: /, ""), err.details)
    outcomes.push({ ...base, closed: false, text: (shaped.content as Array<{ text: string }>)[0]!.text, details: (shaped.structuredContent as { error: { details: Rec } }).error.details })
  }
}
const of = (mission: string, row: string) => outcomes.filter((o) => o.mission === mission && o.row === row)
const outputsOf = (o: Outcome) => (o.details!.deliverables as Rec[]).flatMap((d) => (d.outputs as Rec[]).map((x) => ({ docKey: d.docKey as string, ...x }) as Rec))
const kinds = (o: Rec) => (o.missing as Rec[]).map((m) => m.kind)
/** Replay ids carry the call number as a suffix; print them as the day's ids. */
const dayIds = (s: string) => s.replace(/\b(c[a-z0-9]{24})r\d\d\b/g, "$1").replace(/(2026-11-17_[a-z0-9-]+?)-r\d\d\b/g, "$1")

describe("row 66 replay R7 through the new gate", () => {
  test("13 calls, three cases, every record rebuilt", () => {
    expect(outcomes).toHaveLength(13)
    expect([of(P1, "8").length, of(U1, "4").length, of(U3, "2").length]).toEqual([8, 2, 3])
    expect(outcomes.flatMap((o) => o.notRebuilt)).toEqual([])
    expect(outcomes.map((o) => o.fromText.length)).toEqual([0, 0, 0, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0])
    console.log(`[row66 replay] outcome per call: ${outcomes.map((o) => `${o.n}:${o.closed ? "closed" : "refused"}`).join(" ")}`)
  })

  test("u1 row 4: both calls now close, with the marker (labels_verified, the four figures)", () => {
    for (const o of of(U1, "4")) {
      expect(o.closed).toBe(true)
      expect(o.result).toMatchObject({ id: "4", ok: true, awaitingHumanCheck: { checks: ["labels_verified"], figures: ["2.1.2", "2.2.2", "3.1.2", "3.2.2"] } })
      expect(o.rowAfter).toMatchObject({ status: "done", awaitingHumanCheck: { checks: ["labels_verified"] } })
      expect((o.rowAfter!.awaitingHumanCheck as Rec).clearedBy).toBeUndefined()
      expect(o.result!.closed).toBeUndefined() // verified PDF and HTML exist: nothing to note about the layout file
    }
    const last = of(U1, "4")[1]!
    console.log(`[row66 replay] u1 row 4, call 2/2 (${last.time}): CLOSED ${JSON.stringify(last.result)}\n  row after: status ${last.rowAfter!.status}, awaitingHumanCheck ${JSON.stringify(last.rowAfter!.awaitingHumanCheck)}`)
  })

  test("u3 row 2: all three calls now close, with the marker", () => {
    for (const o of of(U3, "2")) {
      expect(o.closed).toBe(true)
      expect(o.result).toMatchObject({ id: "2", ok: true, awaitingHumanCheck: { checks: ["labels_verified"] } })
      expect(String(o.result!.message)).toContain("row 2 is done, awaiting human check")
      expect(o.rowAfter).toMatchObject({ status: "done", awaitingHumanCheck: { checks: ["labels_verified"] } })
    }
    const last = of(U3, "2")[2]!
    console.log(`[row66 replay] u3 row 2, call 3/3 (${last.time}): CLOSED ${JSON.stringify(last.result)}\n  row after: status ${last.rowAfter!.status}, awaitingHumanCheck ${JSON.stringify(last.rowAfter!.awaitingHumanCheck)}`)
  })

  test("project 1 row 8: all eight calls are still refused, each with a cause an agent can act on", () => {
    const c = of(P1, "8")
    for (const o of c) {
      expect(o.closed).toBe(false)
      // Every listed output names at least one thing to do and one tool; no layout-witness demand is left.
      for (const out of outputsOf(o)) {
        expect(out.verified).toBe(false)
        expect((out.missing as Rec[]).length).toBeGreaterThan(0)
        for (const m of out.missing as Rec[]) expect(String(m.fix)).toMatch(/^studio_[a-z_]+$/)
        expect(out.reason).not.toBe("NO_LAYOUT_WITNESS")
        expect(kinds(out)).not.toContain("no-layout-witness")
      }
      expect((o.details!.fix as string[]).length).toBeGreaterThan(0)
      for (const d of o.details!.deliverables as Rec[]) expect(d.agentFixable).toBe(true)
    }
    expect(outputsOf(c[0]!).map(kinds)).toEqual([["file-missing"]]) // nothing rendered
    expect(outputsOf(c[1]!).map(kinds)).toEqual([["not-checked"]]) // DOCX never verified
    expect(outputsOf(c[2]!).map((o) => (o.missing as Rec[])[0])).toEqual([
      { kind: "lint-failed", rules: ["D01"], fix: "studio_edit" },
      { kind: "lint-failed", rules: ["D01"], fix: "studio_edit" },
    ])
    for (const o of c.slice(3)) {
      const withFile = outputsOf(o).filter((x) => x.reason === "CHECK_UNKNOWN")
      expect(withFile.length).toBeGreaterThan(0)
      // The lint reports of that day carry no notRun list (not in the extract): the ids cannot be named here.
      for (const x of withFile) expect((x.missing as Rec[])[0]).toMatchObject({ kind: "lint-not-run", listed: false, fix: "studio_document_status" })
    }
    for (const i of [0, 1, 2, 7]) console.log(`[row66 replay] project 1 row 8, call ${i + 1}/8 (${c[i]!.time}): REFUSED\n${dayIds(c[i]!.text!)}`)
  })
})
