// 1.2.6 row FX-7 item f (M3 N2; follow-up of row 84 / MC-06): studio_mission_set_status to the current status stays a
// no-op that writes nothing, and its text now says that the note / decision / supersededBy given with it was NOT
// recorded (before, a note on paused -> paused was dropped silently).
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

const BASE = path.join(tmpdir(), "fx7-n2-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(path.join(BASE, "bun-"))
let tick = 1_800_000_000_000
const store = new SqliteStudioStore()
await store.open(path.join(RUN, "store"), { release: "1.2.6", log: () => {}, agentClock: () => ++tick })
afterAll(async () => {
  await store.close()
})
const M = store.missions
type S = Record<string, any>
const row = { id: "1", phase: "implementation", kind: "implementation", title: "Row 1", agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: "implementation/1.md", verification: "tests pass" }
const session = { sessionId: "mcp-fx7", agentId: "swarm", fileRoot: "/private/tmp/claude-501/fx7" }

describe("FX-7 f (M3 N2): unchanged set_status names the note it did not record", () => {
  test("paused -> paused with a note: unchanged, nothing written, text says the note was not recorded", async () => {
    const MI = "2026-11-13_fx7-n2"
    await store.transaction(async (t) => M.create(t, { id: MI, title: "Mission", type: "feature-release", owner: "master-controller", project: { dir: "/private/tmp/claude-501/fx7" }, rows: [row], decisions: [{ id: "U1", by: "user", date: "2026-11-13", text: "ok" }] } as never))
    await store.transaction(async (t) => M.approve(t, MI, "U1"))
    await store.transaction(async (t) => M.setStatus(t, MI, "running"))
    await store.transaction(async (t) => M.setStatus(t, MI, "paused", { note: "owner pause" }))
    const events = M.listEvents(MI).length
    const tool = missionTools(store, { log: () => {} }).find((t) => t.name === "studio_mission_set_status")! as S
    const res = (await tool.call({ mission: MI, to: "paused", note: "pause again" }, session)) as S
    const text = JSON.stringify(res)
    expect(text).toContain("unchanged")
    expect(text).toContain("note not recorded")
    expect(M.listEvents(MI).length).toBe(events)
    const plain = (await tool.call({ mission: MI, to: "paused" }, session)) as S
    expect(JSON.stringify(plain)).not.toContain("not recorded")
  })
})
