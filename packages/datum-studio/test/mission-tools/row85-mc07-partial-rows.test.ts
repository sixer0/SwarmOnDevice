// Row 85 (1.2.6, MC-07, register N-061, decision U5): a row job processes each patch on its own. Valid patches apply,
// an invalid patch is reported in `results` ({id, ok, code?, message?}) and the others are not rolled back.
// Mechanism: one SQLite SAVEPOINT per patch inside the job's BEGIN IMMEDIATE (StoreTx.run accepts it).
// A job in which no patch applies still fails with the first patch's code (single-patch refusals are unchanged).
// No server, no port: the store is opened on a temp folder and the tool is called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { isStoreError, SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

const BASE = process.env.ROW85_TEST_DIR ?? path.join(tmpdir(), "row85-mc07-test")
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
const row = (id: string) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const U1 = { id: "U1", by: "user", date: "2026-11-12", text: "User approves the blueprint" }

async function approvedMission(id: string) {
  await store.transaction(async (t) => M.create(t, { id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", project: { dir: "/private/tmp/claude-501/row85" }, rows: [row("1"), row("2"), row("3")], decisions: [U1] } as never))
  await store.transaction(async (t) => M.approve(t, id, "U1"))
}
const rowOf = (mission: string, id: string) => M.get(mission)!.mission.rows!.find((r: S) => r.id === id) as S

describe("row 85 MC-07: per-patch results, valid patches applied", () => {
  test("store: patch 2 invalid (pending -> done), patches 1 and 3 applied, patch 2's code in results", async () => {
    const MI = "2026-11-12_mc07-store"
    await approvedMission(MI)
    const r = (await store.transaction(async (t) =>
      M.updateRows(t, MI, [
        { id: "1", note: "first note" },
        { id: "2", status: "done" },
        { id: "3", status: "running" },
      ]),
    )) as S
    console.log(`[row85] store results: ${JSON.stringify(r.results)}`)
    expect(r.results).toEqual([
      { id: "1", ok: true },
      { id: "2", ok: false, code: "STATUS_TRANSITION", message: expect.any(String) },
      { id: "3", ok: true },
    ])
    expect(r.changed).toEqual(["1", "3"])
    expect(rowOf(MI, "1").note).toBe("first note")
    expect(rowOf(MI, "2").status).toBe("pending")
    expect(rowOf(MI, "3").status).toBe("running")
  })

  test("store: a job in which no patch applies still fails with the first patch's code", async () => {
    const MI = "2026-11-12_mc07-none"
    await approvedMission(MI)
    let caught: unknown
    try {
      await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "2", status: "done" }]))
    } catch (e) {
      caught = e
    }
    expect(isStoreError(caught, "STATUS_TRANSITION")).toBe(true)
    expect(rowOf(MI, "2").status).toBe("pending")
  })

  test("tool: studio_mission_update_row returns results and applies patches 1 and 3", async () => {
    const MI = "2026-11-12_mc07-tool"
    await approvedMission(MI)
    const tools = missionTools(store, { log: () => {} })
    const upd = tools.find((t) => t.name === "studio_mission_update_row")!
    const session = { sessionId: "mcp-85", agentId: "swarm", fileRoot: "/private/tmp/claude-501/row85" }
    const res = await upd.call({ mission: MI, rows: [{ id: "1", note: "tool note" }, { id: "2", status: "done" }, { id: "3", status: "running" }] }, session)
    const out = res.structuredContent as S
    const text = (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n")
    console.log(`[row85] tool results: ${JSON.stringify(out.results)}`)
    expect(out.ok).toBe(true)
    expect(out.results.map((x: S) => [x.id, x.ok, x.code ?? null])).toEqual([
      ["1", true, null],
      ["2", false, "STATUS_TRANSITION"],
      ["3", true, null],
    ])
    expect(rowOf(MI, "1").note).toBe("tool note")
    expect(rowOf(MI, "3").status).toBe("running")
    expect(text).toContain("refused 2 STATUS_TRANSITION")
  })

  test("tool: a refused patch's checkpoint is not recorded; an applied patch's checkpoint is", async () => {
    const MI = "2026-11-12_mc07-checkpoint"
    await approvedMission(MI)
    const tools = missionTools(store, { log: () => {} })
    const upd = tools.find((t) => t.name === "studio_mission_update_row")!
    const session = { sessionId: "mcp-85", agentId: "swarm", fileRoot: "/private/tmp/claude-501/row85" }
    const out = (await upd.call({ mission: MI, rows: [{ id: "1", status: "running", checkpoint: { n: 1, m: 3 } }, { id: "2", status: "done", checkpoint: { n: 1, m: 3 } }] }, session)).structuredContent as S
    expect(out.ok).toBe(true)
    expect(out.checkpoints.map((c: S) => c.row)).toEqual(["1"])
  })
})
