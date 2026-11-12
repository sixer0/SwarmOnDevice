// Row 84 (1.2.6, MC-06, decision U5 alternative A): studio_mission_set_status to the mission's current status is a
// no-op: it returns ok with unchanged: true and writes no mission_event and no mission_snapshot. Other invalid moves
// (paused -> done, running -> draft, set_status to approved) stay refused STATUS_TRANSITION.
// No server, no port: the store is opened on a temp folder; the tool is called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

const BASE = process.env.ROW84_TEST_DIR ?? path.join(tmpdir(), "row84-mc06-test")
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
const session = { sessionId: "mcp-84", agentId: "swarm", fileRoot: "/private/tmp/claude-501/row84" }

async function missionAt(id: string, status: "running" | "paused") {
  await store.transaction(async (t) => M.create(t, { id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", project: { dir: "/private/tmp/claude-501/row84" }, rows: [row("1")], decisions: [U1] } as never))
  await store.transaction(async (t) => M.approve(t, id, "U1"))
  await store.transaction(async (t) => M.setStatus(t, id, "running"))
  if (status === "paused") await store.transaction(async (t) => M.setStatus(t, id, "paused", { note: "owner pause" }))
}
const counts = (mission: string) => ({ events: M.listEvents(mission).length, snapshots: M.listSnapshots(mission).length })
async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return undefined
  } catch (e) {
    return (e as { code?: string }).code
  }
}

describe("row 84 MC-06: set_status to the current status is unchanged", () => {
  test("store: paused -> paused returns unchanged true, no event, no snapshot", async () => {
    const MI = "2026-11-12_mc06-paused"
    await missionAt(MI, "paused")
    const before = counts(MI)
    const r = (await store.transaction(async (t) => M.setStatus(t, MI, "paused", { note: "pause again" }))) as S
    expect(r.unchanged).toBe(true)
    expect([r.from, r.to]).toEqual(["paused", "paused"])
    expect(r.snapshotId).toBeUndefined()
    expect(counts(MI)).toEqual(before)
    expect(M.get(MI)!.mission.status).toBe("paused")
  })

  test("store: running -> running returns unchanged true, no event, no snapshot", async () => {
    const MI = "2026-11-12_mc06-running"
    await missionAt(MI, "running")
    const before = counts(MI)
    const r = (await store.transaction(async (t) => M.setStatus(t, MI, "running"))) as S
    expect(r.unchanged).toBe(true)
    expect(counts(MI)).toEqual(before)
  })

  test("tool: studio_mission_set_status paused -> paused is ok with unchanged true and writes nothing", async () => {
    const MI = "2026-11-12_mc06-tool"
    await missionAt(MI, "paused")
    const before = counts(MI)
    const tool = missionTools(store, { log: () => {} }).find((t) => t.name === "studio_mission_set_status")! as S
    const res = (await tool.call({ mission: MI, to: "paused" }, session)) as S
    const text = JSON.stringify(res)
    expect(text).not.toContain("STATUS_TRANSITION")
    expect(res.isError).not.toBe(true)
    expect(res.structuredContent?.unchanged ?? res.structuredContent?.data?.unchanged).toBe(true)
    expect(counts(MI)).toEqual(before)
  })

  test("CHAR-MC06-other: other invalid moves stay refused STATUS_TRANSITION", async () => {
    const MI = "2026-11-12_mc06-other"
    await missionAt(MI, "paused")
    const before = counts(MI)
    expect(await codeOf(store.transaction(async (t) => M.setStatus(t, MI, "done")))).toBe("STATUS_TRANSITION")
    expect(await codeOf(store.transaction(async (t) => M.setStatus(t, MI, "draft" as never)))).toBe("STATUS_TRANSITION")
    expect(await codeOf(store.transaction(async (t) => M.setStatus(t, MI, "approved" as never)))).toBe("STATUS_TRANSITION")
    expect(counts(MI)).toEqual(before)
    // A real change still writes one event and one snapshot.
    await store.transaction(async (t) => M.setStatus(t, MI, "running"))
    const after = counts(MI)
    expect([after.events - before.events, after.snapshots - before.snapshots]).toEqual([1, 1])
  })
})
