// Row 181 (decision L32): Mission Control listed 0 missions in a real session because the agent stored
// project.dir = <session dir>/gsp-situational-awareness-system while the app lists by projectDir = <session dir>, and
// the store matched the directory by exact equality. Here:
// (1) the store's projectDir filter matches the directory itself or a folder inside it (separator boundary,
//     normalised; '/a/b' never matches '/a/bc'; a stored dir with '..' or '.' segments never matches by prefix);
//     the live shape: a subfolder project dir, the mission linked to a CHILD (subagent) session only;
// (3) studio_mission_create without project.dir defaults it to the calling session's directory (fileRoot).
// No server, no port: the store is opened on a temp folder and the tools are called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { projectDirScope } from "../../src/store/mission/mission-store.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

const BASE = process.env.ROW181_TEST_DIR ?? path.join(tmpdir(), "row181-project-scope-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(path.join(BASE, "bun-"))
let tick = 1_800_000_000_000
const clock = () => ++tick

const store = new SqliteStudioStore()
await store.open(path.join(RUN, "store"), { release: "1.2.0", log: () => {}, agentClock: clock })
afterAll(async () => {
  await store.close()
})
const M = store.missions

type S = Record<string, any>
const row = (id: string) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const mission = (id: string, dir: string | undefined, over: S = {}) => ({ id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", ...(dir === undefined ? {} : { project: { dir } }), rows: [row("1")], ...over })
const create = (id: string, dir: string, over: S = {}) => store.transaction(async (t) => M.create(t, mission(id, dir, over) as never))
const ids = (projectDir: string) => M.list({ projectDir }).items.map((i) => i.id).sort()

// The user's run (2026-11-08): session directory, mission project dir, main and child (@general) session ids.
// Row 185 (S186-01): the prefix rule needs a folder at least 4 segments deep, so the boundary fixtures live under A.
const A = "/srv/w"
const SESSION_DIR = "/Users/gsp-budi/Documents/Research"
const LIVE_DIR = `${SESSION_DIR}/gsp-situational-awareness-system`
const MAIN_SES = "ses_e46061bebffe0123456789AbCd"
const CHILD_SES = "ses_e46039e30ffe0123456789AbCd"

await create("2026-11-08_live-sub", LIVE_DIR, { sessions: [{ client: "swarm", ref: CHILD_SES, role: "controller" }] })
await create("2026-11-08_exact", `${A}/a/b`)
await create("2026-11-08_trailing", `${A}/a/b/`)
await create("2026-11-08_inside", `${A}/a/b/c/d`)
await create("2026-11-08_sibling", `${A}/a/bc`)
await create("2026-11-08_sibling-sub", `${A}/a/bc/d`)
await create("2026-11-08_parent", `${A}/a`)
await create("2026-11-08_dotdot", `${A}/a/b/../../etc`)
await create("2026-11-08_dotdot-end", `${A}/a/b/..`)
await create("2026-11-08_dot", `${A}/a/b/./x`)

describe("row 181 (1): projectDir matches the directory or a folder inside it", () => {
  test("live shape: a mission in a subfolder of the session directory, linked only to a child session, is listed for the session directory", () => {
    expect(ids(SESSION_DIR)).toEqual(["2026-11-08_live-sub"])
    expect(ids(LIVE_DIR)).toEqual(["2026-11-08_live-sub"])
    // the session link is the child's, not the main session's (why the listing must not rely on the main session)
    expect(M.list({ session: { client: "swarm", ref: MAIN_SES } }).items).toEqual([])
    expect(M.list({ session: { client: "swarm", ref: CHILD_SES } }).items.map((i) => i.id)).toEqual(["2026-11-08_live-sub"])
  })

  test("separator boundary: /a/b lists itself, its trailing-slash form and folders inside it, never /a/bc or /a", () => {
    expect(ids(`${A}/a/b`)).toEqual(["2026-11-08_exact", "2026-11-08_inside", "2026-11-08_trailing"])
    expect(ids(`${A}/a/b/`)).toEqual(["2026-11-08_exact", "2026-11-08_inside", "2026-11-08_trailing"])
    expect(ids(`${A}/a/bc`)).toEqual(["2026-11-08_sibling", "2026-11-08_sibling-sub"])
    expect(ids(`${A}/a/b/c`)).toEqual(["2026-11-08_inside"])
    expect(ids(`${A}/a/b/c/d/e`)).toEqual([])
  })

  test("traversal: stored '..' or '.' segments never match by prefix; the asked directory is normalised", () => {
    for (const dir of [`${A}/a/b`, `${A}/a`]) {
      const got = ids(dir)
      expect(got).not.toContain("2026-11-08_dotdot")
      expect(got).not.toContain("2026-11-08_dotdot-end")
      expect(got).not.toContain("2026-11-08_dot")
    }
    expect(ids(`${A}/a/x/../b`)).toEqual(ids(`${A}/a/b`))
    expect(ids(`${A}/a/b/c/..`)).toEqual(ids(`${A}/a/b`))
    // an exact (verbatim) match of the stored text still lists it, as before row 181
    expect(ids(`${A}/a/b/../../etc`)).toEqual(["2026-11-08_dotdot"])
    expect(projectDirScope(`${A}/a/b/`)).toEqual({ exact: `${A}/a/b`, prefix: `${A}/a/b/` })
  })
})

describe("row 185 (S186-01): a broad session folder matches exactly, never by prefix", () => {
  const HOME = "/Users/someone"
  test("projectDirScope: '/', the home folder and shallow folders have no prefix; a 4-segment folder has one", () => {
    expect(projectDirScope("/", HOME)).toEqual({ exact: "/", prefix: null })
    expect(projectDirScope(`${HOME}/`, HOME)).toEqual({ exact: HOME, prefix: null })
    expect(projectDirScope(`${HOME}/Documents`, HOME)).toEqual({ exact: `${HOME}/Documents`, prefix: null })
    expect(projectDirScope("/Users/gsp-budi/Documents/Research", HOME)).toEqual({ exact: "/Users/gsp-budi/Documents/Research", prefix: "/Users/gsp-budi/Documents/Research/" })
    // the home folder and its direct children are exact only even when the home folder is deep
    expect(projectDirScope("/home/deep/user/me", "/home/deep/user/me").prefix).toBeNull()
    expect(projectDirScope("/home/deep/user/me/Documents", "/home/deep/user/me").prefix).toBeNull()
    expect(projectDirScope("/home/deep/user/me/Documents/Research", "/home/deep/user/me").prefix).toBe("/home/deep/user/me/Documents/Research/")
  })

  test("store list: '/', the home folder and ~/Documents list only missions stored at exactly that folder", async () => {
    const home = (await import("node:os")).homedir()
    // '/' itself cannot be stored (schema minLength 2), so '/' lists nothing; before row 185 it listed every mission
    await create("2026-11-08_at-home", home)
    await create("2026-11-08_at-docs", `${home}/Documents`)
    await create("2026-11-08_below-docs", `${home}/Documents/ProjZ`)
    expect(ids("/")).toEqual([])
    expect(ids(home)).toEqual(["2026-11-08_at-home"])
    expect(ids(`${home}/Documents`)).toEqual(["2026-11-08_at-docs"])
    expect(ids(`${home}/Documents/ProjZ`)).toEqual(["2026-11-08_below-docs"])
    // a 4-segment session folder keeps the row 181 subfolder rule
    expect(ids(SESSION_DIR)).toContain("2026-11-08_live-sub")
  })
})

describe("row 181 (3): studio_mission_create defaults project.dir to the session directory", () => {
  const tools = missionTools(store, { log: () => {} })
  const createTool = tools.find((t) => t.name === "studio_mission_create")!
  const session = { sessionId: "mcp-181", agentId: "swarm", fileRoot: SESSION_DIR }
  const call = async (args: S) => (await createTool.call(args, session)).structuredContent as S

  test("no project: project.dir = the session's fileRoot; listed for the session directory", async () => {
    const r = await call({ mission: mission("2026-11-08_default-dir", undefined) })
    expect(r.ok).toBe(true)
    expect(M.get("2026-11-08_default-dir")!.mission.project).toEqual({ dir: SESSION_DIR })
    expect(ids(SESSION_DIR)).toContain("2026-11-08_default-dir")
  })

  test("project without dir keeps its other fields; a given dir is kept unchanged", async () => {
    expect((await call({ mission: mission("2026-11-08_no-dir", undefined, { project: { swarmProjectId: "prj-181" } }) })).ok).toBe(true)
    expect(M.get("2026-11-08_no-dir")!.mission.project).toEqual({ dir: SESSION_DIR, swarmProjectId: "prj-181" })
    expect((await call({ mission: mission("2026-11-08_given-dir", "/elsewhere/proj") })).ok).toBe(true)
    expect(M.get("2026-11-08_given-dir")!.mission.project).toEqual({ dir: "/elsewhere/proj" })
  })
})
