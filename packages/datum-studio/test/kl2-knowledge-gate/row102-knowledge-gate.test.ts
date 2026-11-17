// 1.3.3 row 102 (spec KL-2 item 2, owner decision U19): a row with a non-empty `knowledge` list goes `done` only when
// one of its domain files was read while the row was running (a read recorded since the row's latest move to
// `running`), or when the agent sends a one-line `knowledgeReason` (stored as `knowledge.reason`). Otherwise
// KNOWLEDGE_NOT_CONSULTED. Order in the done gate: output check (row 66), deliverable copy (row 70), knowledge last.
// No server, no port: temp stores (row 66 seed helper for the output-gate order case).
import { afterAll, describe, expect, test } from "bun:test"
import { isStoreError, type StoreErrorCode } from "../../src/store/index.ts"
import type { RowKnowledge } from "../../src/store/mission/index.ts"
import { closeStores, mission, openStore, seedDocument } from "../mc5-row-close-gate/_seed.ts"

afterAll(closeStores)

const FO = "04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md"
const NET = "04_KNOWLEDGE-CARDS/NETWORKING/REF-NET-001.md"
const KNOWLEDGE: RowKnowledge = {
  domains: [
    { domain: "FIBER-OPTIC", firstFile: FO, consulted: [] },
    { domain: "NETWORKING", firstFile: NET, consulted: [] },
  ],
}

const store = await openStore("row102", false)
const M = store.missions
let n = 0
/** A fresh approved mission whose rows "1" (with knowledge) and "2" (none) are running. */
async function fresh(): Promise<string> {
  const id = `2026-11-17_row102-${++n}`
  await mission(store, id, ["1", "2"])
  await store.transaction(async (t) => M.setRowKnowledge(t, id, "1", KNOWLEDGE))
  return id
}
const patch = (id: string, p: Record<string, unknown>) => store.transaction(async (t) => M.updateRows(t, id, [{ id: "1", ...p } as never]))
const done = (id: string, extra: Record<string, unknown> = {}) => patch(id, { status: "done", note: "tests pass", ...extra })
const read = (id: string, path: string, domain?: string) => store.transaction(async (t) => M.markKnowledgeConsulted(t, id, "1", { path, ...(domain ? { domain } : {}) }))
const rowOf = (id: string, r = "1") => M.get(id)!.mission.rows.find((x) => x.id === r)!

async function refused(p: Promise<unknown>, code: StoreErrorCode): Promise<{ message: string; details: Record<string, unknown> }> {
  try {
    await p
  } catch (e) {
    if (!isStoreError(e, code)) throw new Error(`expected ${code}, got ${e instanceof Error ? e.message : String(e)}`)
    return { message: (e as Error).message, details: (e as { details?: Record<string, unknown> }).details ?? {} }
  }
  throw new Error(`expected ${code}, nothing thrown`)
}

describe("row 102: KNOWLEDGE_NOT_CONSULTED at done", () => {
  test("refused without a read; the refusal names domains, first files, one read call and one reason call", async () => {
    const id = await fresh()
    const r = await refused(done(id), "KNOWLEDGE_NOT_CONSULTED")
    expect(r.details).toEqual({ mission: id, row: "1", domains: [{ domain: "FIBER-OPTIC", firstFile: FO }, { domain: "NETWORKING", firstFile: NET }] })
    // row 151 (S2): the read call carries the name the agent calls it by, like the create/start replies
    // row 151: the calls in words (never `tool_name {json}`, MC-1/MC-3), with the real values
    expect(r.message).toContain(`Read one: call the tool datum-studio_studio_library_read with path "${FO}", mission "${id}", row "1", then retry done.`)
    expect(r.message).toContain(`call the tool datum-studio_studio_mission_update_row with mission "${id}" and one row patch: id "1", status "done", note`)
    expect(r.message).toContain("knowledgeReason (one line")
    expect(r.message).not.toMatch(/[a-z_]+ \{"/)
    expect(r.message).toContain("FIBER-OPTIC -> " + FO)
    expect(rowOf(id).status).toBe("running")
    console.log(`[row102] refusal: ${r.message}`)
  })

  test("passes after a recorded read of any domain file (the second domain's first file)", async () => {
    const id = await fresh()
    expect((await read(id, NET)).marked).toBe(true)
    const r = await done(id)
    expect(r.results[0]).toEqual({ id: "1", ok: true })
    expect(rowOf(id).status).toBe("done")
  })

  test("passes after a read of another file of a domain (domain named)", async () => {
    const id = await fresh()
    expect((await read(id, "04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-007.md", "FIBER-OPTIC")).marked).toBe(true)
    expect((await done(id)).results[0]).toEqual({ id: "1", ok: true })
  })

  test("passes with a valid one-line reason, stored on the row and in the mission record", async () => {
    const id = await fresh()
    const reason = "row only renames headings; no technical content is written"
    expect((await done(id, { knowledgeReason: reason })).results[0]).toEqual({ id: "1", ok: true })
    expect(rowOf(id).status).toBe("done")
    expect(rowOf(id).knowledge).toEqual({ ...KNOWLEDGE, reason })
    expect(M.rowContract(id, "1").knowledge!.reason).toBe(reason)
  })

  test("a reason sent alone (no status) is stored and lets the next done pass", async () => {
    const id = await fresh()
    await patch(id, { knowledgeReason: "the library has no card for this vendor protocol" })
    expect(rowOf(id).knowledge!.reason).toBe("the library has no card for this vendor protocol")
    expect((await done(id)).results[0]).toEqual({ id: "1", ok: true })
  })

  test("a refused done does not keep the reason of another refused part of the patch", async () => {
    const id = await fresh()
    // running -> done without a note is refused before the gate; the reason in the same patch is rolled back with it.
    await refused(patch(id, { status: "done", knowledgeReason: "x" }), "SCHEMA_INVALID")
    expect(rowOf(id).knowledge!.reason).toBeUndefined()
  })

  test("empty knowledge (non-technical row) is never refused; a reason there is accepted and stores nothing", async () => {
    const id = await fresh()
    const r = await store.transaction(async (t) => M.updateRows(t, id, [{ id: "2", status: "done", note: "ok", knowledgeReason: "nothing to read" } as never]))
    expect(r.results[0]).toEqual({ id: "2", ok: true })
    expect(rowOf(id, "2").knowledge).toBeUndefined()
  })

  test("a read recorded in an earlier running period does not count; reading again after the restart does", async () => {
    const id = await fresh()
    expect((await read(id, FO)).marked).toBe(true)
    await patch(id, { status: "blocked", note: "waiting for the survey" })
    expect((await read(id, FO)).reason).toBe("row-not-running")
    await patch(id, { status: "running" })
    // The old mark is still listed (row 101 keeps marks) but it was recorded before this running period.
    expect(rowOf(id).knowledge!.domains[0]!.consulted).toEqual([FO])
    await refused(done(id), "KNOWLEDGE_NOT_CONSULTED")
    // The same file read again in the new period is recorded (an event, the list is unchanged) and counts.
    expect(await read(id, FO)).toEqual({ marked: true, domains: ["FIBER-OPTIC"] })
    expect(rowOf(id).knowledge!.domains[0]!.consulted).toEqual([FO])
    expect(await read(id, FO)).toEqual({ marked: false, domains: [], reason: "already-marked" })
    expect((await done(id)).results[0]).toEqual({ id: "1", ok: true })
  })

  test("a read while running counts through needs-review -> done", async () => {
    const id = await fresh()
    await read(id, FO)
    await patch(id, { status: "needs-review" })
    expect((await patch(id, { status: "done", note: "reviewed" })).results[0]).toEqual({ id: "1", ok: true })
  })

  test("a reopened done row (done -> running with a decision) must read again or give a reason", async () => {
    const id = await fresh()
    await read(id, FO)
    await done(id)
    await store.transaction(async (t) => M.recordDecision(t, id, { id: "U2", by: "user", date: "2026-11-17", text: "reopen row 1" } as never, { attested: true }))
    await patch(id, { status: "running", decision: "U2" })
    await refused(done(id), "KNOWLEDGE_NOT_CONSULTED")
    expect((await done(id, { knowledgeReason: "same content as the first close; the card was read then" })).results[0]).toMatchObject({ ok: true })
  })

  test("invalid reasons are refused: multi-line, whitespace-only, empty, too long, not a string", async () => {
    const id = await fresh()
    for (const bad of ["two\nlines", "   ", "\t", "", "x".repeat(301), 42]) {
      const r = await refused(done(id, { knowledgeReason: bad }), "SCHEMA_INVALID")
      expect(r.details).toMatchObject({ row: "1", field: "knowledgeReason" })
    }
    expect(rowOf(id).status).toBe("running")
    expect((await done(id, { knowledgeReason: "x".repeat(300) })).results[0]).toMatchObject({ ok: true })
  })
})

describe("row 102: order in the done gate", () => {
  test("output check (row 66) runs before the knowledge check", async () => {
    const guarded = await openStore("row102-guarded", true)
    const id = "2026-11-17_row102-order"
    await mission(guarded, id, ["1"])
    await guarded.transaction(async (t) => {
      guarded.missions.setRowKnowledge(t, id, "1", KNOWLEDGE)
      seedDocument(t, { mission: id, docKey: "row-1-laporan" })
    })
    await refused(guarded.transaction(async (t) => guarded.missions.updateRows(t, id, [{ id: "1", status: "done", note: "x" }])), "OUTPUT_UNVERIFIED")
  })
})
