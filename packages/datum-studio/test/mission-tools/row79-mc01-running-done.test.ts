// Row 79 (1.2.6, MC-01, decision U5 alternative A): a running row may go straight to done when the patch carries a
// non-empty note (the check and its result). Without a note the move is refused SCHEMA_INVALID naming field "note".
// The output gate (OUTPUT_UNVERIFIED) still applies, other invalid moves (pending -> done) stay STATUS_TRANSITION, and
// the STATUS_TRANSITION hint and the update_row description state the same rule as the store.
// No server, no port: the store is opened on a temp folder; tools are called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openSqlite } from "#sqlite"
import { newId, sha256Hex, SqliteStudioStore } from "../../src/store/index.ts"
import { STORE_DB_FILE } from "../../src/store/paths.ts"
import { ROW_TRANSITIONS } from "../../src/store/mission/mission-store.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"
import { nextCall } from "../../src/mcp-host/mission/next-call.ts"

const BASE = process.env.ROW79_TEST_DIR ?? path.join(tmpdir(), "row79-mc01-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(path.join(BASE, "bun-"))
let tick = 1_800_000_000_000
const clock = () => ++tick

const store = new SqliteStudioStore()
await store.open(path.join(RUN, "store"), { release: "1.2.6", log: () => {}, agentClock: clock })
// Second store with the done gate on (missionGuard: true, as desktop opens it) for the OUTPUT_UNVERIFIED case.
const GATED = path.join(RUN, "gated")
const gated = new SqliteStudioStore()
await gated.open(GATED, { release: "1.2.6", log: () => {}, agentClock: clock, missionGuard: true })
afterAll(async () => {
  await store.close()
  await gated.close()
})
const M = store.missions

type S = Record<string, any>
const row = (id: string) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const U1 = { id: "U1", by: "user", date: "2026-11-12", text: "User approves the blueprint" }

async function runningMission(id: string, st: SqliteStudioStore = store) {
  const M = st.missions
  await st.transaction(async (t) => M.create(t, { id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", project: { dir: "/private/tmp/claude-501/row79" }, rows: [row("1"), row("2")], decisions: [U1] } as never))
  await st.transaction(async (t) => M.approve(t, id, "U1"))
  await st.transaction(async (t) => M.updateRows(t, id, [{ id: "1", status: "running" }]))
}
/** A deliverable bound to row 1 (docKey row-1-report) with one revision and no rendered output: not Final. */
function seedUnrenderedDeliverable(mission: string) {
  const db = openSqlite(path.join(GATED, STORE_DB_FILE))
  const t0 = clock()
  const [tId, vId, dId, rId] = [newId(), newId(), newId(), newId()]
  db.run("INSERT INTO template (id, slug, origin, name, kind, latest_version_no, created_by, time_created, time_updated) VALUES (?, ?, 'user', 'Tpl 79', 'DOCUMENT', 1, 'swarm', ?, ?)", [tId, `user-tpl-79-${tId}`, t0, t0])
  db.run(
    `INSERT INTO template_version (id, template_id, version_no, definition, definition_sha256, overrides, resolved_params, params_sha256, role_formats, section_plan, assets, provenance, change_note, created_by, time_created)
     VALUES (?, ?, 1, '{}', ?, '{}', '{}', ?, '{}', '[]', '[]', '{"origin":"test"}', 'v1', 'swarm', ?)`,
    [vId, tId, sha256Hex("{}"), sha256Hex("{}"), t0],
  )
  db.run(
    "INSERT INTO document (id, doc_number, doc_number_safe, number_source, title, type_code, classification, tier, template_id, current_revision_no, created_by, time_created, time_updated, mission_folder, mission_doc_key) VALUES (?, ?, ?, 'AGENT', 'Dokumen 79', 'KT', 'TERBATAS', 'NOTA', ?, 1, 'swarm', ?, ?, ?, 'row-1-report')",
    [dId, `79/GSP/KT/XI/2026-${dId}`, `79-GSP-KT-XI-2026-${dId}`, tId, t0, t0, mission],
  )
  db.run(
    `INSERT INTO revision (id, document_id, revision_no, parent_revision_no, template_version_id, snapshot, snapshot_sha256, input_sha256, doc_rev, change_what, change_why, change_impact, created_by, time_created)
     VALUES (?, ?, 1, NULL, ?, '{}', ?, ?, 'A', 'w', 'y', 'i', 'swarm', ?)`,
    [rId, dId, vId, "d".repeat(64), "e".repeat(64), t0],
  )
  db.close()
}
const rowOf = (mission: string, id: string) => M.get(mission)!.mission.rows!.find((r: S) => r.id === id) as S
async function codeOf(p: Promise<unknown>): Promise<{ code?: string; details?: S }> {
  try {
    await p
    return {}
  } catch (e) {
    const x = e as { code?: string; details?: S; rincian?: S }
    return { code: x.code, details: x.details ?? x.rincian }
  }
}
const session = { sessionId: "mcp-79", agentId: "swarm", fileRoot: "/private/tmp/claude-501/row79" }

describe("row 79 MC-01: running -> done with a mandatory note", () => {
  test("store rule: ROW_TRANSITIONS.running includes done", () => {
    expect(ROW_TRANSITIONS.running).toContain("done")
  })

  test("store: running -> done with a note applies, note stored, finished time set", async () => {
    const MI = "2026-11-12_mc01-note"
    await runningMission(MI)
    const r = (await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "done", note: "bun test row79 -> 5 pass" }]))) as S
    expect(r.changed).toEqual(["1"])
    const r1 = rowOf(MI, "1")
    expect([r1.status, r1.note]).toEqual(["done", "bun test row79 -> 5 pass"])
    expect(r1.finishedAt).toBeDefined()
  })

  test("store: running -> done without a note is SCHEMA_INVALID naming note; row stays running", async () => {
    const MI = "2026-11-12_mc01-nonote"
    await runningMission(MI)
    const res = await codeOf(store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "done" }])))
    expect(res.code).toBe("SCHEMA_INVALID")
    expect(res.details?.field).toBe("note")
    expect(rowOf(MI, "1").status).toBe("running")
  })

  test("kept: pending -> done is still STATUS_TRANSITION (CHAR-MC06-other)", async () => {
    const MI = "2026-11-12_mc01-pending"
    await runningMission(MI)
    const res = await codeOf(store.transaction(async (t) => M.updateRows(t, MI, [{ id: "2", status: "done", note: "skip" }])))
    expect(res.code).toBe("STATUS_TRANSITION")
    expect(rowOf(MI, "2").status).toBe("pending")
  })

  test("kept: running -> done with a note still passes the output gate (OUTPUT_UNVERIFIED)", async () => {
    const MI = "2026-11-12_mc01-gate"
    await runningMission(MI, gated)
    seedUnrenderedDeliverable(MI)
    const res = await codeOf(gated.transaction(async (t) => gated.missions.updateRows(t, MI, [{ id: "1", status: "done", note: "claims done" }])))
    expect(res.code).toBe("OUTPUT_UNVERIFIED")
    expect(gated.missions.get(MI)!.mission.rows!.find((r: S) => r.id === "1")!.status).toBe("running")
  })

  test("hint and update_row description state the store rule", () => {
    const hint = nextCall("STATUS_TRANSITION")
    expect(hint).toContain("running -> done needs a note")
    const upd = missionTools(store, { log: () => {} }).find((t) => t.name === "studio_mission_update_row")! as S
    const desc = JSON.stringify(upd)
    expect(desc).toContain("running -> done needs a note")
  })

  test("tool: studio_mission_update_row moves running -> done with a note", async () => {
    const MI = "2026-11-12_mc01-tool"
    await runningMission(MI)
    const upd = missionTools(store, { log: () => {} }).find((t) => t.name === "studio_mission_update_row")!
    const res = await upd.call({ mission: MI, rows: [{ id: "1", status: "done", note: "tool check passed" }] }, session)
    expect(res.isError).not.toBe(true)
    expect(rowOf(MI, "1").status).toBe("done")
  })
})
