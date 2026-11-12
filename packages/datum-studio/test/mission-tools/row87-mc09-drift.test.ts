// Row 87 (1.2.6, MC-09 data, decision U5 alternative A; register N-066): studio_mission_get returns derived.drift:
// the rows added after approval with the decision id that justified each (count + rows), plus the rows dropped after
// approval with their decision id (dropped). Computed from mission_event after the approve event; empty when none.
// Rows added while the mission was still a draft are never drift.
// No server, no port: the store is opened on a temp folder; the tool is called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

const BASE = process.env.ROW87_TEST_DIR ?? path.join(tmpdir(), "row87-mc09-test")
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
const dec = (id: string, text: string) => ({ id, by: "user", date: "2026-11-12", text })
const session = { sessionId: "mcp-87", agentId: "swarm", fileRoot: "/private/tmp/claude-501/row87" }

async function approvedMission(id: string) {
  await store.transaction(async (t) => M.create(t, { id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", project: { dir: "/private/tmp/claude-501/row87" }, rows: [row("1"), row("2")], decisions: [dec("U1", "User approves the blueprint")] } as never))
  // added while still a draft: part of the approved blueprint, never drift
  await store.transaction(async (t) => M.updateRows(t, id, [{ id: "1a", add: row("1a") } as never]))
  await store.transaction(async (t) => M.approve(t, id, "U1"))
}

describe("row 87 MC-09: drift in studio_mission_get", () => {
  test("store: an approved mission without changes has an empty drift", async () => {
    const MI = "2026-11-12_mc09-none"
    await approvedMission(MI)
    const d = M.get(MI)!.derived as S
    expect(d.drift).toEqual({ count: 0, rows: [], dropped: [] })
  })

  test("store: a draft mission has an empty drift", async () => {
    const MI = "2026-11-12_mc09-draft"
    await store.transaction(async (t) => M.create(t, { id: MI, title: "Draft", type: "feature-release", owner: "master-controller", project: { dir: "/private/tmp/claude-501/row87" }, rows: [row("1")], decisions: [dec("U1", "x")] } as never))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "2", add: row("2") } as never]))
    expect((M.get(MI)!.derived as S).drift).toEqual({ count: 0, rows: [], dropped: [] })
  })

  test("store: rows added after approval are listed with their decision ids; dropped rows too", async () => {
    const MI = "2026-11-12_mc09-added"
    await approvedMission(MI)
    await store.transaction(async (t) => M.recordDecision(t, MI, dec("U2", "Add row 3: missing migration") as never))
    await store.transaction(async (t) => M.recordDecision(t, MI, dec("U3", "Add row 4: per-row decision") as never))
    await store.transaction(async (t) => M.recordDecision(t, MI, dec("U4", "Drop row 2: merged into row 1") as never))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "3", add: row("3") } as never], { decision: "U2" }))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "4", add: { ...row("4"), decision: "U3" } } as never]))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "2", status: "dropped", note: "merged into row 1" } as never], { decision: "U4" }))
    const d = (M.get(MI)!.derived as S).drift
    expect(d.count).toBe(2)
    expect(d.rows.map((r: S) => [r.row, r.decision])).toEqual([
      ["3", "U2"],
      ["4", "U3"],
    ])
    for (const r of d.rows) expect(typeof r.timeCreated).toBe("string")
    expect(d.dropped.map((r: S) => [r.row, r.decision])).toEqual([["2", "U4"]])
    expect(typeof d.dropped[0].timeDropped).toBe("string")
    // the draft-time row 1a and the blueprint rows 1, 2 are not "added after approval"
    expect(d.rows.map((r: S) => r.row)).not.toContain("1a")
  })

  test("tool: studio_mission_get returns derived.drift and names it in the text", async () => {
    const MI = "2026-11-12_mc09-tool"
    await approvedMission(MI)
    await store.transaction(async (t) => M.recordDecision(t, MI, dec("U2", "Add row 5") as never))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "5", add: row("5") } as never], { decision: "U2" }))
    const tool = missionTools(store, { log: () => {} }).find((t) => t.name === "studio_mission_get")! as S
    const res = (await tool.call({ mission: MI }, session)) as S
    expect(res.isError).not.toBe(true)
    const data = res.structuredContent?.data ?? res.structuredContent
    expect(data.derived.drift.count).toBe(1)
    expect(data.derived.drift.rows[0]).toMatchObject({ row: "5", decision: "U2" })
    const text = JSON.stringify(res.content)
    expect(text).toContain("drift: 1 row added after approval (5 by U2)")
  })
})
