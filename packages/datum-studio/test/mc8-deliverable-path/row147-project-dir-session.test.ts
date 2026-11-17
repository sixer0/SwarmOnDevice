// Swarm 1.3.3 row 147 (security review M1, senior review S4).
//
// M1: studio_mission_create keeps a mission's project folder to the calling session's folder (HostToolSession.fileRoot,
// the caller's directory the host resolved at session open) or a folder inside it. An explicit project.dir outside is
// refused PATH_OUTSIDE_ROOT with the folder named, nothing is stored, and the refusal is logged.
// S4: the update_row description names every done gate within the 450-character cap.
// No server, no port: the store is opened on a temp folder; tools are called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

const BASE = process.env.ROW147_TEST_DIR ?? path.join(process.env.TMPDIR ?? tmpdir(), "row147-project-dir")
mkdirSync(BASE, { recursive: true })
const RUN = realpathSync(mkdtempSync(path.join(BASE, "run-")))
let tick = 1_800_000_000_000
const store = new SqliteStudioStore()
await store.open(path.join(RUN, "store"), { release: "1.3.3", log: () => {}, agentClock: () => ++tick })
afterAll(() => store.close())

type S = Record<string, any>
const SESSION_DIR = path.join(RUN, "session-project")
const OUTSIDE = path.join(RUN, "another-project")
for (const d of [path.join(SESSION_DIR, "sub"), OUTSIDE]) mkdirSync(d, { recursive: true })
symlinkSync(OUTSIDE, path.join(SESSION_DIR, "escape"))
const session = { sessionId: "mcp-row147", agentId: "swarm", fileRoot: SESSION_DIR }
const logged: S[] = []
const tools = missionTools(store, { log: (level, source, message, context) => void logged.push({ level, source, message, ...context }) })
const tool = (name: string) => tools.find((t) => t.name === name)! as S
const row = { id: "1", phase: "implementation", kind: "implementation", title: "Row one", agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: "implementation/1.md", verification: "tests pass" }
let n = 0
async function create(project?: unknown): Promise<{ id: string; sc: S; text: string }> {
  const id = `2026-11-18_row147-p${++n}`
  const r = (await tool("studio_mission_create").call({ mission: { id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", rows: [row], ...(project !== undefined ? { project } : {}) } }, session)) as S
  return { id, sc: (r.structuredContent ?? {}) as S, text: (r.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n") }
}
const stored = (id: string) => store.missions.get(id)?.mission.project?.dir

describe("M1: project.dir at studio_mission_create", () => {
  test("no project.dir: the session folder is used (row 181 default, unchanged)", async () => {
    const r = await create()
    expect(r.sc.ok).not.toBe(false)
    expect(stored(r.id)).toBe(SESSION_DIR)
  })

  test("the session folder itself and a folder inside it are accepted", async () => {
    for (const dir of [SESSION_DIR, path.join(SESSION_DIR, "sub"), path.join(SESSION_DIR, "not-made-yet")]) {
      const r = await create({ dir })
      expect(r.sc.ok, dir).not.toBe(false)
      expect(stored(r.id)).toBe(dir)
    }
  })

  test("a folder outside the session folder: PATH_OUTSIDE_ROOT naming the folder; no mission stored; logged as warn", async () => {
    for (const dir of [OUTSIDE, `${SESSION_DIR}-sibling`, path.join(SESSION_DIR, "escape"), path.join(SESSION_DIR, "escape", "inner"), "/"]) {
      logged.length = 0
      const r = await create({ dir })
      console.log(`[row147] ${dir}: ${r.sc.code} ${r.text.split("\n")[0]}`)
      expect(r.sc).toMatchObject({ ok: false, code: "PATH_OUTSIDE_ROOT" })
      expect(r.text).toContain(dir)
      expect(store.missions.get(r.id)).toBeFalsy()
      expect(logged).toContainEqual(expect.objectContaining({ level: "warn", source: "datum-studio-host.mission.studio_mission_create", projectDir: dir, sessionFolder: SESSION_DIR }))
    }
  })
})

describe("S4: the update_row description names the 1.3.3 gates", () => {
  test("OUTPUT_UNVERIFIED, DELIVERABLE_NOT_IN_PROJECT, KNOWLEDGE_NOT_CONSULTED, knowledgeReason and the marker close, within 450 characters", () => {
    const d = String(tool("studio_mission_update_row").description)
    console.log(`[row147] update_row description ${d.length} characters`)
    for (const s of ["done still passes the output gate (OUTPUT_UNVERIFIED)", "DELIVERABLE_NOT_IN_PROJECT (needs-review too)", "KNOWLEDGE_NOT_CONSULTED (or knowledgeReason)", "labels awaiting a person close with a marker", "is never executed", "running -> done needs a note"]) expect(d).toContain(s)
    expect(d).toMatch(/\{id, [^}]*decision\?/)
    expect(d.length).toBeLessThanOrEqual(450)
  })
})
