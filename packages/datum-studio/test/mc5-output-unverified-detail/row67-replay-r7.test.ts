// Swarm 1.3.3 row 67 (MC-5): replay of the 13 OUTPUT_UNVERIFIED close refusals of 2026-11-17 (research/05 R7).
//
// Input (fixtures/, reduced copy of research/replay/R7_studio_store_rows; row 146 / M2: mission ids replaced by synthetic
// ids, home paths by /home/user/project/..., session and part ids dropped, the agents' row notes replaced by a synthetic
// line; gate details, output ids, times and verification reports are unchanged, so every count below still holds):
//   - r7_close_refusals_OUTPUT_UNVERIFIED.jsonl: the 13 refused calls; the gate's details of that moment are the
//     `rincian` JSON of each stored error text (deliverables, outputs, reason per output);
//   - r7_output_verification_subset.jsonl: the stored verification record of each output the refusals name.
// Rebuild: for a CHECK_FAILED / CHECK_UNKNOWN output the gate attaches `notPassingChecks(record.report)`
// (output-gate.ts rowDeliverablesNotFinal); the same is done here from the stored record, and only when that record
// was written before the refusal and its counts agree with the refused reason. Where the record was overwritten by a
// later verification attempt (2 outputs, in 3 refusals of project 1 row 8), the checks of that moment are taken from
// the stored refusal text itself, and only when every printed entry of that output is UNKNOWN: an UNKNOWN check is
// exactly one entry `{check, rule = reason}` and is never cut (row 206 AC-3), so the rebuild is exact. Anything else
// would be listed as not rebuilt (none is). Then the real refusal shaping
// (tool-result.ts `refusal`) runs. Not in the extract: the revisions' lint reports (`notRun` did not exist that day)
// and witness lists; the replay therefore passes NO facts, and a LINT_PARTIAL output must say the ids are not known.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { refusal } from "../../src/mcp-host/mission/tool-result"
import { notPassingChecks } from "../../src/store/mission/output-gate"

type Rec = Record<string, unknown>
const FIX = join(import.meta.dir, "fixtures")
const lines = (f: string) => readFileSync(join(FIX, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec)
const records = new Map(lines("r7_output_verification_subset.jsonl").map((r) => [r.output_file_id as string, r]))
const P1 = "2026-11-17_replay-project-1"
const U1 = "2026-11-17_replay-u1"
const U3 = "2026-11-17_replay-u3"

interface Replayed { mission: string; row: string; time: string; text: string; details: Rec; notRebuilt: string[]; fromText: string[] }
/** The check entries the stored refusal text printed for one output; null when the text has no head line for it or cut some. */
function storedEntries(error: string, outputId: string): Rec[] | null {
  const all = error.split("\n")
  const at = all.findIndex((l) => new RegExp(` ${outputId}: (\\d+) check entr(y|ies)$`).test(l))
  if (at < 0) return null
  const n = Number(/: (\d+) check entr/.exec(all[at]!)![1])
  return all.slice(at + 1, at + 1 + n).map((l) => JSON.parse(l) as Rec)
}
const replayed: Replayed[] = lines("r7_close_refusals_OUTPUT_UNVERIFIED.jsonl").map((r) => {
  const error = r.error as string
  const m = /^ditolak OUTPUT_UNVERIFIED: (.*)\nrincian: (\{.*\})\n(?:periksa|next)/s.exec(error)!
  const stored = JSON.parse(/rincian: (\{.*?\})\n(?:periksa|next)/s.exec(error)![1]!) as Rec
  const notRebuilt: string[] = []
  const fromText: string[] = []
  for (const d of stored.deliverables as Rec[]) {
    for (const o of d.outputs as Rec[]) {
      if (o.reason !== "CHECK_FAILED" && o.reason !== "CHECK_UNKNOWN") continue
      const rec = records.get(o.outputId as string)
      const agrees = rec && Number(rec.time_verified) <= Number(r.time_ms) && (o.reason === "CHECK_FAILED" ? Number(rec.fail_count) > 0 : Number(rec.fail_count) === 0 && Number(rec.unknown_count) > 0)
      if (agrees) {
        o.checks = notPassingChecks(rec!.report)
        continue
      }
      const printed = storedEntries(error, o.outputId as string)
      if (o.reason === "CHECK_UNKNOWN" && printed && printed.length > 0 && printed.every((e) => e.verdict === "UNKNOWN")) {
        o.checks = printed.map((e) => ({ id: e.check, status: "UNKNOWN", reason: e.rule, findings: [], truncated: 0 }))
        fromText.push(o.outputId as string)
      } else notRebuilt.push(o.outputId as string)
    }
  }
  const res = refusal("studio_mission_update_row", "OUTPUT_UNVERIFIED", m[1]!.split("\n")[0]!, stored)
  const s = res.structuredContent as { error: { details: Rec } }
  return { mission: stored.mission as string, row: stored.row as string, time: r.time_local as string, text: (res.content as Array<{ text: string }>)[0]!.text, details: s.error.details, notRebuilt, fromText }
})
const of = (mission: string, row: string) => replayed.filter((r) => r.mission === mission && r.row === row)
const outputsOf = (r: Replayed) => (r.details.deliverables as Rec[]).flatMap((d) => (d.outputs as Rec[]).map((o) => ({ docKey: d.docKey as string, ...o }) as Rec))
const kinds = (o: Rec) => (o.missing as Rec[]).map((m) => m.kind)

describe("row 67 replay R7: the 13 close refusals of the test day", () => {
  test("13 refusals, three cases: project 1 row 8 = 8, u1 row 4 = 2, u3 row 2 = 3; every stored record usable", () => {
    expect(replayed).toHaveLength(13)
    expect(of(P1, "8")).toHaveLength(8)
    expect(of(U1, "4")).toHaveLength(2)
    expect(of(U3, "2")).toHaveLength(3)
    expect(replayed.flatMap((r) => r.notRebuilt)).toEqual([])
    // Rebuilt from the stored refusal text (record overwritten by attempt 2 at 12:03:41): DOCX and HTML of rev 104, refusals 4-6.
    expect(replayed.map((r) => r.fromText.length)).toEqual([0, 0, 0, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0])
  })
  test("every output of every refusal says verified false and carries missing[]; every missing item names one tool", () => {
    for (const r of replayed) {
      for (const o of outputsOf(r)) {
        expect(o.verified).toBe(false)
        expect(Array.isArray(o.missing)).toBe(true)
        for (const m of o.missing as Rec[]) expect(String(m.fix)).toMatch(/^studio_[a-z_]+$/)
        // Nothing unexplained: an output has an agent-fixable reason or a human one.
        expect((o.missing as Rec[]).length + ((o.info as Rec[] | undefined)?.length ?? 0)).toBeGreaterThan(0)
      }
    }
  })
  test("project 1 row 8: not rendered, then not checked, then lint D01, then lint rules not run (ids not in the extract)", () => {
    const c = of(P1, "8")
    expect(outputsOf(c[0]!).map(kinds)).toEqual([["file-missing"]])
    expect(outputsOf(c[1]!).map(kinds)).toEqual([["no-layout-witness"], ["not-checked"]])
    const third = outputsOf(c[2]!)
    expect(third.map(kinds)).toEqual([["no-layout-witness"], ["lint-failed"], ["lint-failed"]])
    expect((third[1]!.missing as Rec[])[0]).toEqual({ kind: "lint-failed", rules: ["D01"], fix: "studio_edit" })
    expect((third[0]!.missing as Rec[])[0]).toEqual({ kind: "no-layout-witness", because: [third[1]!.outputId, third[2]!.outputId], fix: "studio_edit" })
    for (const r of c.slice(3)) {
      const withFile = outputsOf(r).filter((o) => o.outputId !== null)
      expect(withFile.length).toBeGreaterThan(0)
      for (const o of withFile) expect(o.missing).toEqual([{ kind: "lint-not-run", listed: false, fix: "studio_document_status" }])
      expect(r.details.fix).toContain("studio_document_status")
    }
    const last = c[7]!
    expect((last.details.deliverables as Rec[])[0]!.agentFixable).toBe(true)
    console.log(`[row67 replay] project 1 row 8, refusal 8/8 (${last.time}):\n${last.text}`)
    console.log(`[row67 replay] project 1 row 8, refusal 3/8 (${c[2]!.time}), rincian line:\n${c[2]!.text.split("\n")[1]}`)
  })
  test("u1 row 4: only the person's label check stands between the files and verified; shown as information", () => {
    for (const r of of(U1, "4")) {
      const outs = outputsOf(r)
      expect(outs.map((o) => o.format)).toEqual([null, "DOCX", "HTML", "PDF"])
      for (const o of outs.slice(1)) {
        expect(o.missing).toEqual([])
        expect(o.info).toEqual([{ kind: "awaiting-human-check", checks: ["labels_verified"], rules: ["D09", "P1-labels_verified"] }])
      }
      // The layout witness follows the PDF / HTML: held by the person's check only, so it is information too.
      expect(outs[0]).toMatchObject({ missing: [], info: [{ kind: "awaiting-human-check", checks: ["labels_verified"] }] })
      expect((r.details.deliverables as Rec[])[0]!.agentFixable).toBe(false)
      expect(r.details.fix).toBeUndefined()
      expect(r.text).toContain("info awaiting-human-check labels_verified; rules D09,P1-labels_verified: a person checks the diagram labels")
      expect(r.text).not.toContain("kurang")
    }
    const last = of(U1, "4")[1]!
    console.log(`[row67 replay] u1 row 4, refusal 2/2 (${last.time}):\n${last.text}`)
  })
  test("u3 row 2: same: labels_verified only, no lint rule for the agent to fix", () => {
    for (const r of of(U3, "2")) {
      const outs = outputsOf(r).filter((o) => String(o.docKey) === "row-2-u3")
      expect(outs.map((o) => o.format)).toEqual([null, "DOCX", "HTML", "PDF"])
      for (const o of outs.slice(1)) {
        expect(o.missing).toEqual([])
        expect(o.info).toEqual([{ kind: "awaiting-human-check", checks: ["labels_verified"], rules: ["D09", "P1-labels_verified"] }])
      }
      expect(outs[0]).toMatchObject({ missing: [], info: [{ kind: "awaiting-human-check", checks: ["labels_verified"] }] })
      const d = (r.details.deliverables as Rec[]).find((x) => x.docKey === "row-2-u3")!
      expect(d.agentFixable).toBe(false)
    }
    const last = of(U3, "2")[2]!
    expect(last.details.fix).toBeUndefined()
    expect(last.text).not.toContain("kurang")
    console.log(`[row67 replay] u3 row 2, refusal 3/3 (${last.time}):\n${last.text}`)
  })
})
