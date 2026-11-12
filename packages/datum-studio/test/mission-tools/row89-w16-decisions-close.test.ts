// Row 89 (1.2.6, W-16 option A per C6 / R13; T-17 mission export hunk):
// - studio_mission_set_status to done returns the decision register, decisions {count, ids}, equal to the store's
//   decisions of the mission (N-068). Closing is NOT refused for missing exports (no new refusal path).
// - studio_mission_export with overwrite: true puts the backup in <dir>/.bak/ (N-055), never at the export top level,
//   and returns / prints the residue count backupResidue (N-057).
// - studio_mission_update_row's description lists the per-patch decision? field (row 81 follow-up).
// No server, no port: the store is opened on a temp folder; tools are called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

const BASE = process.env.ROW89_TEST_DIR ?? path.join(tmpdir(), "row89-w16-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(path.join(BASE, "bun-"))
const PROJECT = path.join(RUN, "project")
mkdirSync(PROJECT, { recursive: true })
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
const session = { sessionId: "mcp-89", agentId: "swarm", fileRoot: PROJECT }
let exportCalls = 0
const exporter = async ({ mission, files }: { mission: string; files: readonly string[] }) =>
  files.map((f) => ({ path: f === "status" ? "status_tasks.md" : `decisions/${f}.md`, markdown: `# ${f} of ${mission} (${++exportCalls})\n` }))
const tools = missionTools(store, { log: () => {}, exporter: exporter as never })
const tool = (name: string) => tools.find((t) => t.name === name)! as S
const data = (res: S) => res.structuredContent?.data ?? res.structuredContent

/** A running mission with one row, approved under U1. */
async function runningMission(id: string) {
  await store.transaction(async (t) => M.create(t, { id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1")], decisions: [U1] } as never))
  await store.transaction(async (t) => M.approve(t, id, "U1"))
  await store.transaction(async (t) => M.setStatus(t, id, "running"))
}

describe("row 89 W-16: set_status done returns the decision register", () => {
  test("done returns decisions {count, ids} equal to the store register, and the text names them", async () => {
    const MI = "2026-11-12_w16-done"
    await runningMission(MI)
    await store.transaction(async (t) => M.recordDecision(t, MI, { id: "C1", by: "controller", date: "2026-11-12", text: "Keep the UI simple" } as never))
    await store.transaction(async (t) => M.recordDecision(t, MI, { id: "C2", by: "controller", date: "2026-11-12", text: "Mission store is the decision source", rows: ["1"] } as never))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "running" } as never]))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "done", note: "done in one step" } as never]))
    const res = (await tool("studio_mission_set_status").call({ mission: MI, to: "done" }, session)) as S
    expect(res.isError).not.toBe(true)
    const d = data(res)
    const stored = (M.get(MI)!.mission.decisions ?? []).map((x) => x.id)
    expect(stored).toEqual(["U1", "C1", "C2"])
    expect(d.decisions).toEqual({ count: 3, ids: stored })
    expect(res.content[0].text).toContain("decisions 3: U1, C1, C2")
    expect(M.get(MI)!.mission.status).toBe("done")
  })

  test("closing is not refused: done without any export succeeds (option A, no new refusal path)", async () => {
    const MI = "2026-11-12_w16-noexport"
    await runningMission(MI)
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "dropped", note: "not needed" } as never], { decision: "U1" }))
    const res = (await tool("studio_mission_set_status").call({ mission: MI, to: "done" }, session)) as S
    expect(res.isError).not.toBe(true)
    expect(data(res).decisions).toEqual({ count: 1, ids: ["U1"] })
    expect(exportCalls).toBe(0)
  })

  test("other targets carry no decisions field", async () => {
    const MI = "2026-11-12_w16-paused"
    await runningMission(MI)
    const res = (await tool("studio_mission_set_status").call({ mission: MI, to: "paused", note: "owner pause" }, session)) as S
    expect(res.isError).not.toBe(true)
    expect(data(res).decisions).toBeUndefined()
  })
})

describe("row 89 T-17: mission export backups sit in <dir>/.bak/ with backupResidue", () => {
  test("overwrite twice: no .bak file at the export top level, two backups in .bak/, residue printed", async () => {
    const MI = "2026-11-12_t17-export"
    await runningMission(MI)
    const exp = tool("studio_mission_export")
    const first = (await exp.call({ mission: MI, files: ["status"], write: true }, session)) as S
    expect(first.isError).not.toBe(true)
    const dir = path.join(PROJECT, "docs", MI)
    for (let i = 1; i <= 2; i++) {
      const res = (await exp.call({ mission: MI, files: ["status"], write: true, overwrite: true }, session)) as S
      expect(res.isError).not.toBe(true)
      const f = data(res).files[0]
      expect(f.backupResidue).toBe(i)
      expect(f.backup).toMatch(new RegExp(`^docs/${MI}/\\.bak/status_tasks\\.md\\.bak-\\d{8}T\\d{6}Z(-\\d+)?$`))
      expect(res.content[0].text).toContain(`backupResidue ${i}`)
    }
    expect(readdirSync(dir).filter((n) => n.includes(".bak-"))).toEqual([])
    expect(existsSync(path.join(dir, ".bak"))).toBe(true)
    expect(readdirSync(path.join(dir, ".bak")).filter((n) => n.startsWith("status_tasks.md.bak-")).length).toBe(2)
  })

  test("the export description and FILE_EXISTS text name the .bak/ folder", async () => {
    expect(tool("studio_mission_export").description).toContain(".bak/")
    const MI = "2026-11-12_t17-exists"
    await runningMission(MI)
    const exp = tool("studio_mission_export")
    await exp.call({ mission: MI, files: ["decisions"], write: true }, session)
    const again = (await exp.call({ mission: MI, files: ["decisions"], write: true }, session)) as S
    expect(again.isError).toBe(true)
    expect(JSON.stringify(again)).toContain("FILE_EXISTS")
    expect(JSON.stringify(again)).toContain(".bak/")
  })
})

describe("row 89 (row 81 follow-up): update_row description lists decision?", () => {
  test("the patch field list names decision?", () => {
    expect(tool("studio_mission_update_row").description).toMatch(/\{id, [^}]*decision\?/)
  })
})
