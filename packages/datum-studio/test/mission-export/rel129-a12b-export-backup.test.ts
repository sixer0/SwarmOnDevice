// Swarm 1.2.9 row 38 (AC-A12b, N9-114; spec 01a AT-A12b; register N9-061): studio_mission_export reports
// backupRemoved per written file (the count writeFileGuarded's retention removed, BACKUP_KEEP = 5) and names the sum
// in its text next to backupResidue, as the other tools that keep backups in <dir>/.bak/ do.
// No server, no port: the store is opened on a temp folder; the tool is called through missionTools() (row 89 style).
// Inputs are synthetic (syn129 rule): an empty mission made here, a fake exporter, six seeded backup files.
//
// Red at BASE (d4282fcfd8): the per-file backupRemoved field is absent and the text has no "backupRemoved".
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

const BASE = process.env.REL129_A12B_DIR ?? path.join(tmpdir(), "rel129-a12b")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(path.join(BASE, "bun-"))
const PROJECT = path.join(RUN, "project")
mkdirSync(PROJECT, { recursive: true })
let tick = 1_800_000_000_000
const store = new SqliteStudioStore()
await store.open(path.join(RUN, "store"), { release: "1.2.9", log: () => {}, agentClock: () => ++tick })
afterAll(async () => {
  await store.close()
})

type S = Record<string, any>
const MI = "2026-11-14_syn129-a12b"
let version = 0
const exporter = async ({ files }: { files: readonly string[] }) =>
  files.map((f) => ({ path: f === "status" ? "status_tasks.md" : `x/${f}.md`, markdown: `# syn129 ${f} v${++version}\n` }))
let clock = Date.UTC(2026, 10, 14, 9, 0, 0)
const tools = missionTools(store, { log: () => {}, exporter: exporter as never, now: () => (clock += 1000) })
const exp = tools.find((t) => t.name === "studio_mission_export")! as S
const session = { sessionId: "mcp-a12b", agentId: "swarm", fileRoot: PROJECT }
const data = (res: S) => res.structuredContent?.data ?? res.structuredContent
const row = { id: "1", phase: "implementation", kind: "implementation", title: "Row 1", agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: "implementation/1.md", verification: "tests pass" }

describe("rel129 A12b: studio_mission_export reports backupRemoved", () => {
  test("two overwrites over six prior backups of one file: per-file backupRemoved >= 1, the text names the sum", async () => {
    await store.transaction(async (tx) => store.missions.create(tx, { id: MI, title: "syn129 a12b", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row], decisions: [{ id: "U1", by: "user", date: "2026-11-14", text: "approve" }] } as never))
    const first = (await exp.call({ mission: MI, files: ["status", "decisions"], write: true }, session)) as S
    expect(first.isError).not.toBe(true)
    const dir = path.join(PROJECT, "docs", MI)
    // six older backups of status_tasks.md only (synthetic bytes); decisions has none
    const bak = path.join(dir, ".bak")
    mkdirSync(bak, { recursive: true })
    for (let i = 0; i < 6; i++) writeFileSync(path.join(bak, `status_tasks.md.bak-20260101T00000${i}Z`), `# syn129 old ${i}\n`)

    const removedSums: number[] = []
    for (const expected of [{ status: 2, decisions: 0 }, { status: 1, decisions: 0 }]) {
      const res = (await exp.call({ mission: MI, files: ["status", "decisions"], write: true, overwrite: true }, session)) as S
      expect(res.isError).not.toBe(true)
      const files = data(res).files as S[]
      const status = files.find((f) => f.path.endsWith("status_tasks.md"))!
      const decisions = files.find((f) => f.path.endsWith("decisions.md"))!
      expect(status.backupRemoved).toBe(expected.status)
      expect(status.backupRemoved).toBeGreaterThanOrEqual(1)
      expect(status.backupResidue).toBe(5)
      expect(decisions.backupRemoved).toBe(expected.decisions)
      const sum = files.reduce((n, f) => n + f.backupRemoved, 0)
      removedSums.push(sum)
      expect(res.content[0].text).toContain(`backupRemoved ${sum}`)
      expect(res.content[0].text).toContain(`backupResidue ${status.backupResidue + decisions.backupResidue}`)
    }
    expect(removedSums).toEqual([2, 1])
    // retention left exactly five backups of status_tasks.md
    expect(readdirSync(bak).filter((n) => n.startsWith("status_tasks.md.bak-")).length).toBe(5)
  })

  test("a write without overwrite carries backupRemoved 0 per file and no backup note", async () => {
    const MI2 = "2026-11-14_syn129-a12b-new"
    await store.transaction(async (tx) => store.missions.create(tx, { id: MI2, title: "syn129 a12b new", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row], decisions: [{ id: "U1", by: "user", date: "2026-11-14", text: "approve" }] } as never))
    const res = (await exp.call({ mission: MI2, files: ["status"], write: true }, session)) as S
    expect(res.isError).not.toBe(true)
    expect(data(res).files[0].backupRemoved).toBe(0)
    expect(res.content[0].text).not.toContain("backupRemoved")
  })
})
