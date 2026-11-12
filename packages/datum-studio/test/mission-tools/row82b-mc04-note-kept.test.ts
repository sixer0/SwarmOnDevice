// Row 82b (1.2.6, MC-04 remainder, follow-up of row 82): a single patch {status: "running", note} on a row whose
// build (B) dependency is not done is refused for DEP_NOT_DONE, but its note is stored (notes are never gated by
// dependencies). The patch result is {id, ok: false, code: "DEP_NOT_DONE", noteSaved: true}; the status is unchanged.
// Other refusal codes keep row 85's behaviour (patch rolled back whole, note not stored).
// No server, no port: the store is opened on a temp folder; tools are called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

const BASE = process.env.ROW82B_TEST_DIR ?? path.join(tmpdir(), "row82b-mc04-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(path.join(BASE, "bun-"))
let tick = 1_800_000_000_000
const clock = () => ++tick

const store = new SqliteStudioStore()
await store.open(path.join(RUN, "store"), { release: "1.2.6", log: () => {}, agentClock: clock })
afterAll(async () => {
  await store.close()
})
const M = store.missions

type S = Record<string, any>
const row = (id: string, deps: string[] = []) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps, size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const U1 = { id: "U1", by: "user", date: "2026-11-12", text: "User approves the blueprint" }

// Row 1 has no deps; row 2 depends on row 1 by build (B), so row 2 is dep-blocked while row 1 is not done.
async function approvedMission(id: string) {
  await store.transaction(async (t) => M.create(t, { id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", project: { dir: "/private/tmp/claude-501/row82b" }, rows: [row("1"), row("2", ["1:B"])], decisions: [U1] } as never))
  await store.transaction(async (t) => M.approve(t, id, "U1"))
}
const rowOf = (mission: string, id: string) => M.get(mission)!.mission.rows!.find((r: S) => r.id === id) as S
const session = { sessionId: "mcp-82b", agentId: "swarm", fileRoot: "/private/tmp/claude-501/row82b" }
const updateRow = () => missionTools(store, { log: () => {} }).find((t) => t.name === "studio_mission_update_row")!

describe("row 82b MC-04: a note survives a status move refused for DEP_NOT_DONE", () => {
  test("store: {status: running, note} on a dep-blocked row keeps the note, refuses the status", async () => {
    const MI = "2026-11-12_mc04b-store"
    await approvedMission(MI)
    const r = (await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "2", status: "running", note: "waiting on row 1" }]))) as S
    console.log(`[row82b] store results: ${JSON.stringify(r.results)}`)
    expect(r.results).toEqual([{ id: "2", ok: false, code: "DEP_NOT_DONE", message: expect.any(String), noteSaved: true }])
    expect(rowOf(MI, "2").note).toBe("waiting on row 1")
    expect(rowOf(MI, "2").status).toBe("pending")
  })

  test("tool: studio_mission_update_row reports DEP_NOT_DONE with noteSaved and stores the note", async () => {
    const MI = "2026-11-12_mc04b-tool"
    await approvedMission(MI)
    const res = await updateRow().call({ mission: MI, rows: [{ id: "2", status: "running", note: "tool note" }] }, session)
    const out = res.structuredContent as S
    console.log(`[row82b] tool isError=${res.isError} ok=${out?.ok} results=${JSON.stringify(out?.results)}`)
    expect(res.isError).not.toBe(true)
    expect(out.results).toEqual([{ id: "2", ok: false, code: "DEP_NOT_DONE", message: expect.any(String), noteSaved: true }])
    expect(JSON.stringify(res.content)).toContain("note saved")
    expect(rowOf(MI, "2").note).toBe("tool note")
    expect(rowOf(MI, "2").status).toBe("pending")
  })

  test("kept: a status refusal with another code (STATUS_TRANSITION) still drops the note and throws", async () => {
    const MI = "2026-11-12_mc04b-other"
    await approvedMission(MI)
    let code: string | undefined
    try {
      await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "done", note: "should not stay" }]))
    } catch (e) {
      code = (e as { code?: string }).code
    }
    expect(code).toBe("STATUS_TRANSITION")
    expect(rowOf(MI, "1").note ?? null).toBeNull()
    expect(rowOf(MI, "1").status).toBe("pending")
  })

  test("kept: a status-only patch on a dep-blocked row still throws DEP_NOT_DONE (nothing to keep)", async () => {
    const MI = "2026-11-12_mc04b-nonote"
    await approvedMission(MI)
    let code: string | undefined
    try {
      await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "2", status: "running" }]))
    } catch (e) {
      code = (e as { code?: string }).code
    }
    expect(code).toBe("DEP_NOT_DONE")
  })
})
