// 1.3.3 row 17 (MC-4 items 2-3, register section 2): SCHEMA_INVALID and STATUS_TRANSITION refusals carry
// `error.corrected` {arguments, changed} when the correction is certain, else `error.fields` [{field, allowed}].
// Nothing is applied server-side and no content (title, note, reason, decision id) is ever written for the agent.
// No server, no port: pure functions plus the real tool argument validation (validateArgs).
import { describe, expect, test } from "bun:test"
import { validateArgs } from "../../src/mcp-host/mission/mission-tools.ts"
import { correctionFor, localIssues } from "../../src/mcp-host/mission/next-call.ts"
import { errorResult, MissionToolError, refusal } from "../../src/mcp-host/mission/tool-result.ts"

type S = Record<string, any>
const MI = "2026-11-17_row17"
const INPUT = (tool: string, issues: S[]) => ({ def: `${tool} input`, issues })
const extra = (name: string, pointer = "/") => ({ pointer, keyword: "additionalProperties", message: `must NOT have additional properties: "${name}"` })
const fix = (tool: string, code: string, message: string, details: S, args: S) => correctionFor(tool, code, message, details, args)
/** A corrected payload must itself pass: the tool's own argument check and the record checks, both empty. */
function passes(tool: string, c: S | undefined): S {
  expect(c).toBeDefined()
  expect(typeof c!.changed).toBe("string")
  expect(c!.changed.length).toBeGreaterThan(0)
  expect(c!.changed.length).toBeLessThanOrEqual(300)
  expect(() => validateArgs(tool, structuredClone(c!.arguments))).not.toThrow()
  expect(localIssues(tool, c!.arguments)).toEqual([])
  return c!.arguments
}
const OPTIONS = [
  { id: "a", label: "A", consequence: "one" },
  { id: "b", label: "B", consequence: "two" },
]
const FINDING = { id: "F1", severity: "medium", title: "t", sourceRow: "3", ownerRow: "3", status: "open" }

describe("row 17: SCHEMA_INVALID with a certain correction", () => {
  const RD = "studio_mission_request_decision"
  test("blockingRows outside request (a JSON string) moves into request as an array", () => {
    const args = { mission: MI, blockingRows: '["10"]', request: { id: "D-2", question: "q", options: OPTIONS } }
    const c = fix(RD, "SCHEMA_INVALID", "arguments do not match the tool input schema", INPUT(RD, [extra("blockingRows")]), args)
    const a = passes(RD, c.corrected)
    expect(a).toEqual({ mission: MI, request: { id: "D-2", question: "q", options: OPTIONS, blockingRows: ["10"] } })
    expect(c.corrected!.changed).toContain("blockingRows")
    expect(c.fields).toBeUndefined()
    // the arguments that were sent are not touched
    expect(args.blockingRows).toBe('["10"]')
  })

  test("a snake_case copy of a field that request already holds with the same value is dropped; a different value is not certain", () => {
    const req = { id: "D-1", question: "q", options: OPTIONS, blockingRows: ["1", "2"] }
    const c = fix(RD, "SCHEMA_INVALID", "m", INPUT(RD, [extra("blocking_rows")]), { mission: MI, blocking_rows: '["1", "2"]', request: req })
    expect(passes(RD, c.corrected)).toEqual({ mission: MI, request: req })
    const d = fix(RD, "SCHEMA_INVALID", "m", INPUT(RD, [extra("blocking_rows")]), { mission: MI, blocking_rows: '["3"]', request: req })
    expect(d.corrected).toBeUndefined()
    expect(d.fields).toEqual([{ field: "/blocking_rows", allowed: expect.stringContaining("not a field") }])
  })

  test("a topic that is not one of the two reserved values is dropped; a near spelling is replaced", () => {
    const details = { at: "decision request", issues: [{ path: "/topic", keyword: "c57", message: "project-placement or project-tidy" }] }
    const c = fix(RD, "SCHEMA_INVALID", "decision request is malformed", details, { mission: MI, request: { id: "D-1", question: "q", options: OPTIONS, topic: "persetujuan blueprint" } })
    expect(passes(RD, c.corrected).request.topic).toBeUndefined()
    expect(c.corrected!.changed).toContain("topic")
    const tidy = [
      { id: "approve", label: "A", consequence: "one" },
      { id: "decline", label: "B", consequence: "two" },
    ]
    const n = fix(RD, "SCHEMA_INVALID", "decision request is malformed", details, { mission: MI, request: { id: "D-1", question: "q", options: tidy, topic: "project_tidy", proposal: [{ mission: MI, group: null }] } })
    expect(passes(RD, n.corrected).request.topic).toBe("project-tidy")
  })

  test("context: line breaks are folded when the text then fits; a longer text is never cut (field list with the limit)", () => {
    const details = { at: "decision request", issues: [{ path: "/context", keyword: "c57", message: "one line, 1-300 characters" }] }
    const c = fix(RD, "SCHEMA_INVALID", "decision request is malformed", details, { mission: MI, request: { id: "D-1", question: "q", options: OPTIONS, context: "baris satu\n  baris dua" } })
    expect(passes(RD, c.corrected).request.context).toBe("baris satu baris dua")
    const long = "x".repeat(301)
    const d = fix(RD, "SCHEMA_INVALID", "decision request is malformed", details, { mission: MI, request: { id: "D-1", question: "q", options: OPTIONS, context: long } })
    expect(d.corrected).toBeUndefined()
    expect(d.fields).toEqual([{ field: "/request/context", allowed: "one line, 1-300 characters (sent: 301)" }])
  })

  const UR = "studio_mission_update_row"
  test("update_row: a top-level note moves into the only row patch; with two patches it is not certain", () => {
    const c = fix(UR, "SCHEMA_INVALID", "m", INPUT(UR, [extra("note")]), { mission: MI, note: "cek: 5 lulus", rows: [{ id: "1", status: "done" }] })
    expect(passes(UR, c.corrected)).toEqual({ mission: MI, rows: [{ id: "1", status: "done", note: "cek: 5 lulus" }] })
    const d = fix(UR, "SCHEMA_INVALID", "m", INPUT(UR, [extra("note")]), { mission: MI, note: "n", rows: [{ id: "1", status: "done" }, { id: "2", status: "running" }] })
    expect(d.corrected).toBeUndefined()
    expect(d.fields![0].field).toBe("/note")
    expect(d.fields![0].allowed).toContain("mission, rows, messages")
  })

  test("update_row: rows sent as a JSON string is parsed; a row field outside set moves into set; checkpoint.id becomes the patch id", () => {
    const rows = [{ id: "3", status: "running" }]
    const c = fix(UR, "SCHEMA_INVALID", "m", INPUT(UR, [{ pointer: "/rows", keyword: "type", message: "must be array" }]), { mission: MI, rows: JSON.stringify(rows) })
    expect(passes(UR, c.corrected).rows).toEqual(rows)
    const s = fix(UR, "SCHEMA_INVALID", "m", INPUT(UR, [extra("deps", "/rows/0")]), { mission: MI, rows: [{ id: "4", decision: "C2", deps: ["3:B"] }] })
    expect(passes(UR, s.corrected).rows).toEqual([{ id: "4", decision: "C2", set: { deps: ["3:B"] } }])
    const k = fix(UR, "SCHEMA_INVALID", "m", INPUT(UR, [{ pointer: "/rows/0", keyword: "required", message: "must have required property 'id'" }, extra("id", "/rows/0/checkpoint")]), { mission: MI, rows: [{ checkpoint: { n: 1, m: 4, id: "2" } }] })
    expect(passes(UR, k.corrected).rows).toEqual([{ checkpoint: { n: 1, m: 4 }, id: "2" }])
  })

  test("update_row: the same status twice for one row in one call keeps the first only", () => {
    const c = fix(UR, "SCHEMA_INVALID", "m", INPUT(UR, [{ pointer: "/rows/1", keyword: "required", message: "must have required property 'id'" }]), { mission: MI, rows: [{ id: "2", status: "running" }, { checkpoint: { n: 1, m: 4, id: "2" }, status: "running" }] })
    expect(passes(UR, c.corrected).rows).toEqual([{ id: "2", status: "running" }, { checkpoint: { n: 1, m: 4 }, id: "2" }])
  })

  test("update_row: a lock name in upper case is folded to lower case (every lock of the call)", () => {
    const c = fix(UR, "SCHEMA_INVALID", "resource must match ^[a-z0-9][a-z0-9._/-]{0,79}$", { resource: "INTENT-DOC" }, { mission: MI, rows: [{ id: "1", status: "running", acquire: ["INTENT-DOC"] }, { id: "2", status: "running", acquire: ["EKAS-READ"] }] })
    expect(passes(UR, c.corrected).rows.map((r: S) => r.acquire)).toEqual([["intent-doc"], ["ekas-read"]])
    const d = fix(UR, "SCHEMA_INVALID", "resource must match ^[a-z0-9][a-z0-9._/-]{0,79}$", { resource: "kunci utama" }, { mission: MI, rows: [{ id: "1", acquire: ["kunci utama"] }] })
    expect(d.corrected).toBeUndefined()
    expect(d.fields).toEqual([{ field: "/rows/0/acquire/0", allowed: "resource must match ^[a-z0-9][a-z0-9._/-]{0,79}$" }])
  })

  test("a row added with `tier` beside the agent whose default tier it is: tier is dropped (the server default gives it)", () => {
    const add = { id: "23", title: "Grafik", agent: "document-writer", phase: "draft", tier: "worker" }
    const c = fix(UR, "SCHEMA_INVALID", "row 23 does not match", { def: "Row", at: "row 23", issues: [{ path: "/", keyword: "additionalProperties", message: 'must NOT have additional properties: "tier"' }] }, { mission: MI, rows: [{ id: "23", add }] })
    expect(passes(UR, c.corrected).rows[0].add).toEqual({ id: "23", title: "Grafik", agent: "document-writer", phase: "draft" })
    // a tier that needs a reason the agent did not give is not written for it
    const d = fix(UR, "SCHEMA_INVALID", "row 23 does not match", { def: "Row", at: "row 23", issues: [{ path: "/", keyword: "additionalProperties", message: 'must NOT have additional properties: "tier"' }] }, { mission: MI, rows: [{ id: "23", add: { ...add, agent: "planner" } }] })
    expect(d.corrected).toBeUndefined()
    expect(d.fields).toEqual([{ field: "/rows/0/add/tier", allowed: expect.stringContaining("not a field") }])
  })

  const RF = "studio_mission_record_finding"
  test("finding: an empty or null decision on an open finding is dropped; on an accepted finding no id is invented", () => {
    for (const decision of ["", null]) {
      const c = fix(RF, "SCHEMA_INVALID", "finding F1 does not match", { def: "Finding", at: "finding F1", issues: [{ path: "/decision", keyword: "pattern", message: "must match pattern" }] }, { mission: MI, finding: { ...FINDING, decision } })
      expect(passes(RF, c.corrected).finding).toEqual(FINDING)
    }
    const d = fix(RF, "SCHEMA_INVALID", "finding F1 does not match", { def: "Finding", at: "finding F1", issues: [{ path: "/", keyword: "required", message: "must have required property 'decision'" }] }, { mission: MI, finding: { ...FINDING, status: "accepted" } })
    expect(d.corrected).toBeUndefined()
    expect(d.fields).toEqual([{ field: "/finding/decision", allowed: "required" }])
  })

  test("enum: one nearest legal spelling is used; no near value gives the legal values", () => {
    const issue = (v: string) => ({ def: "Finding", at: "finding F1", issues: [{ path: "/severity", keyword: "enum", message: "must be equal to one of the allowed values: critical, high, medium, low, info" }], v })
    const c = fix(RF, "SCHEMA_INVALID", "m", issue("Hihg"), { mission: MI, finding: { ...FINDING, severity: "Hihg" } })
    expect(passes(RF, c.corrected).finding.severity).toBe("high")
    const d = fix(RF, "SCHEMA_INVALID", "m", issue("major"), { mission: MI, finding: { ...FINDING, severity: "major" } })
    expect(d.corrected).toBeUndefined()
    expect(d.fields).toEqual([{ field: "/finding/severity", allowed: ["critical", "high", "medium", "low", "info"] }])
  })

  test("a damaged argument name that holds the object as text is restored", () => {
    const key = `finding\n${JSON.stringify(FINDING)}\n</parameter`
    const c = fix(RF, "SCHEMA_INVALID", "m", INPUT(RF, [{ pointer: "/", keyword: "required", message: "must have required property 'finding'" }, extra(key)]), { [key]: "", mission: MI })
    expect(passes(RF, c.corrected)).toEqual({ mission: MI, finding: FINDING })
  })

  test("studio_mission_get: an include value that is no section is dropped; nothing is left empty", () => {
    const G = "studio_mission_get"
    const LEGAL = ["rows", "decisions", "findings", "locks", "reports", "events", "snapshots", "requests", "checkpoints", "messages", "deliverables"]
    const issue = (i: number) => INPUT(G, [{ pointer: `/include/${i}`, keyword: "enum", message: `must be equal to one of the allowed values: ${LEGAL.join(", ")}` }])
    const c = fix(G, "SCHEMA_INVALID", "m", issue(1), { mission: MI, include: ["rows", "sessions"] })
    expect(passes(G, c.corrected)).toEqual({ mission: MI, include: ["rows"] })
    const d = fix(G, "SCHEMA_INVALID", "m", issue(0), { mission: MI, include: ["sessions"] })
    expect(d.corrected).toBeUndefined()
    expect(d.fields).toEqual([{ field: "/include/0", allowed: LEGAL }])
  })

  test("not certain: checkpoint n above m, a message to its own sender, a user decision with a controller id", () => {
    const cp = fix(UR, "SCHEMA_INVALID", "checkpoint is malformed", { at: "checkpoint", issues: [{ path: "/n", keyword: "c57", message: "integer 0..m" }] }, { mission: MI, rows: [{ id: "1", note: "n" }, { id: "19", checkpoint: { n: 7, m: 6 } }] })
    expect(cp.corrected).toBeUndefined()
    expect(cp.fields).toEqual([{ field: "/rows/1/checkpoint/n", allowed: "integer 0..m" }])
    const msg = fix(UR, "SCHEMA_INVALID", "message is malformed", { at: "message", issues: [{ path: "/to", keyword: "c57", message: "must differ from `from`" }] }, { mission: MI, messages: [{ from: "controller", to: "controller", kind: "report", text: "t" }] })
    expect(msg.corrected).toBeUndefined()
    expect(msg.fields).toEqual([{ field: "/messages/0/to", allowed: ["agent", "owner"] }])
    const dec = fix("studio_mission_record_decision", "SCHEMA_INVALID", "m", { def: "Decision", issues: [{ pointer: "/decision/id", keyword: "pattern", message: 'must match pattern "^U"' }] }, { mission: MI, decision: { id: "C13", by: "user", date: "2026-11-17", text: "t" } })
    expect(dec.corrected).toBeUndefined()
    expect(dec.fields).toEqual([{ field: "/decision/id", allowed: 'must match pattern "^U"' }])
  })

  test("at most 10 fields", () => {
    const issues = Array.from({ length: 14 }, (_x, i) => extra(`x${i}`))
    const c = fix(UR, "SCHEMA_INVALID", "m", INPUT(UR, issues), { mission: MI, rows: [{ id: "1", note: "n" }, { id: "2", note: "n" }], ...Object.fromEntries(issues.map((_x, i) => [`x${i}`, 1])) })
    expect(c.corrected).toBeUndefined()
    expect(c.fields).toHaveLength(10)
  })
})

describe("row 17: STATUS_TRANSITION", () => {
  const UR = "studio_mission_update_row"
  const T = (row: string, from: string | null, to: string, allowed: string[]) => ({ row, from, to, allowed })
  test("pending -> done with a note: the one missing step (running) is put before it", () => {
    const c = fix(UR, "STATUS_TRANSITION", "row 12 pending -> done is not allowed", T("12", "pending", "done", ["running", "blocked", "dropped"]), { mission: MI, rows: [{ id: "12", note: "tinjauan selesai", status: "done" }, { id: "13", status: "running" }] })
    expect(passes(UR, c.corrected).rows).toEqual([{ id: "12", status: "running" }, { id: "12", note: "tinjauan selesai", status: "done" }, { id: "13", status: "running" }])
    expect(c.corrected!.changed).toContain("running")
  })

  test("blocked -> done with a note goes through running; without a note no note is written for the agent", () => {
    const c = fix(UR, "STATUS_TRANSITION", "m", T("26", "blocked", "done", ["running", "dropped"]), { mission: MI, rows: [{ id: "26", status: "done", note: "gerbang mata lulus" }] })
    expect(passes(UR, c.corrected).rows.map((r: S) => r.status)).toEqual(["running", "done"])
    const d = fix(UR, "STATUS_TRANSITION", "m", T("26", "pending", "done", ["running", "blocked", "dropped"]), { mission: MI, rows: [{ id: "26", status: "done" }] })
    expect(d.corrected).toBeUndefined()
    expect(d.fields).toEqual([
      { field: "/rows/0/status", allowed: ["running", "blocked", "dropped"] },
      { field: "/rows/0/note", allowed: expect.stringContaining("the check") },
    ])
  })

  test("a row already in the status: the status is taken out and the note stays; an empty patch gives no corrected", () => {
    const c = fix(UR, "STATUS_TRANSITION", "m", T("3", "running", "running", ["needs-review", "blocked", "done"]), { mission: MI, rows: [{ id: "3", note: "mulai", status: "running" }] })
    expect(passes(UR, c.corrected).rows).toEqual([{ id: "3", note: "mulai" }])
    const d = fix(UR, "STATUS_TRANSITION", "m", T("3", "running", "running", ["needs-review", "blocked", "done"]), { mission: MI, rows: [{ id: "3", status: "running" }] })
    expect(d.corrected).toBeUndefined()
    expect(d.fields).toEqual([{ field: "/rows/0/status", allowed: ["needs-review", "blocked", "done"] }])
  })

  test("a row added as running is added pending and started by a second patch", () => {
    const add = { id: "27", title: "Uji", agent: "document-writer", status: "running" }
    const c = fix(UR, "STATUS_TRANSITION", "rows are added pending or dropped", T("27", null, "running", ["pending", "dropped"]), { mission: MI, decision: "C14", rows: [{ id: "27", add }] })
    expect(passes(UR, c.corrected).rows).toEqual([
      { id: "27", add: { ...add, status: "pending" } },
      { id: "27", status: "running" },
    ])
  })

  test("no single step: the legal targets are listed (pending -> needs-review has one, running -> dropped needs a noted block)", () => {
    const c = fix(UR, "STATUS_TRANSITION", "m", T("1", "running", "dropped", ["needs-review", "blocked", "done"]), { mission: MI, rows: [{ id: "1", status: "dropped", note: "n" }] })
    expect(c.corrected).toBeUndefined()
    expect(c.fields).toEqual([{ field: "/rows/0/status", allowed: ["needs-review", "blocked", "done"] }])
  })

  test("set_status: approved -> done gets its one step; draft -> running has none in this tool", () => {
    const SS = "studio_mission_set_status"
    const c = fix(SS, "STATUS_TRANSITION", "mission approved -> done is not allowed", { from: "approved", to: "done", allowed: ["running", "paused", "cancelled"] }, { mission: MI, to: "done" })
    expect(passes(SS, c.corrected)).toEqual({ mission: MI, to: "running" })
    expect(c.corrected!.changed).toContain("done")
    const d = fix(SS, "STATUS_TRANSITION", "mission draft -> running is not allowed", { from: "draft", to: "running", allowed: ["approved", "cancelled"] }, { mission: MI, to: "running" })
    expect(d.corrected).toBeUndefined()
    expect(d.fields).toEqual([{ field: "/to", allowed: ["approved", "cancelled"] }])
  })
})

describe("row 17: running -> done without note", () => {
  const RULE = "running -> done needs a note (the check and its result); needs-review is optional"
  test("one refusal: the message names the field, fields points at it, next shows one example call; no note is written", () => {
    const args = { mission: MI, rows: [{ id: "1", status: "running" }, { id: "2", status: "done" }] }
    const r = refusal("studio_mission_update_row", "SCHEMA_INVALID", RULE, { row: "2", field: "note", from: "running", to: "done" }, args)
    const s = r.structuredContent as S
    expect(s.error.message).toContain("note")
    expect(s.error.message).toContain("row 2")
    expect(s.error.message).toContain(RULE)
    expect(s.error.corrected).toBeUndefined()
    expect(s.error.fields).toEqual([{ field: "/rows/1/note", allowed: expect.stringContaining("the check") }])
    expect(s.error.next).toContain(`call the tool datum-studio_studio_mission_update_row with mission "${MI}", and in rows one entry with id "2", status "done", note "<the check you ran and its result>"`)
    expect(s.error.next).not.toMatch(/[a-z_]+ \{"?/)
    expect(s.next).toBe(s.error.next)
    const text = (r.content[0] as S).text as string
    expect(text.split("\n").map((l) => l.split(":")[0])).toEqual(["ditolak SCHEMA_INVALID", "rincian", "fields", "next"])
  })

  test("without the arguments (a caller that does not pass them) the field is still named", () => {
    const s = refusal("studio_mission_update_row", "SCHEMA_INVALID", RULE, { row: "2", field: "note", from: "running", to: "done" }).structuredContent as S
    expect(s.error.fields).toEqual([{ field: "/rows/*/note", allowed: expect.stringContaining("the check") }])
    expect(s.error.next).toContain('id "2", status "done", note "')
  })
})

describe("row 17: the reply", () => {
  test("corrected sits inside error and in the text between rincian and next; other codes are untouched", () => {
    const args = { mission: MI, note: "cek", rows: [{ id: "1", status: "done" }] }
    const r = errorResult("studio_mission_update_row", new MissionToolError("SCHEMA_INVALID", "arguments do not match the tool input schema", INPUT("studio_mission_update_row", [extra("note")])), () => {}, {}, args)
    const s = r.structuredContent as S
    expect(r.isError).toBe(true)
    expect(Object.keys(s.error.corrected)).toEqual(["arguments", "changed"])
    expect(s.corrected).toBeUndefined()
    const lines = ((r.content[0] as S).text as string).split("\n")
    expect(lines.map((l) => l.split(":")[0])).toEqual(["ditolak SCHEMA_INVALID", "rincian", "corrected", "next"])
    expect(JSON.parse(lines[2].slice("corrected: ".length))).toEqual(s.error.corrected)
    const other = refusal("studio_mission_update_row", "DEP_NOT_DONE", "m", { row: "1" }, args).structuredContent as S
    expect(other.error.corrected).toBeUndefined()
    expect(other.error.fields).toBeUndefined()
  })

  test("nothing certain and nothing to name: the reply is as before", () => {
    const s = refusal("studio_mission_update_row", "SCHEMA_INVALID", "a dependency is listed twice", { mission: MI, row: "1", dep: "2" }, { mission: MI, rows: [{ id: "1", set: { deps: ["2:B", "2:C"] } }] }).structuredContent as S
    expect(s.error.corrected).toBeUndefined()
    expect(s.error.fields).toBeUndefined()
  })
})
