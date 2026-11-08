// Row 183 (decision L36): Mission Control also lists the missions linked (mission_session) to the current session or
// any of its child (subagent) sessions, in addition to the directory rule of row 181. Here:
// - the store: list({projectDir, linkedSessions}) is the UNION of the directory matches and the linked missions
//   (deduplicated, newest first, same take); linkedSessions alone lists the linked ones; an empty refs list changes
//   nothing; the link's client must match; the existing `session` filter stays an AND filter;
// - the tool: studio_mission_list takes `sessions` (refs of the caller's client, at most 50, schema-checked).
// No server, no port: the store is opened on a temp folder and the tools are called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

const BASE = process.env.ROW183_TEST_DIR ?? path.join(tmpdir(), "row183-list-sessions-test")
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
const mission = (id: string, dir: string, over: S = {}) => ({ id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", project: { dir }, rows: [row("1")], ...over })
const create = (id: string, dir: string, over: S = {}) => store.transaction(async (t) => M.create(t, mission(id, dir, over) as never))
const link = (ref: string, client = "swarm") => ({ sessions: [{ client, ref, role: "controller" }] })

// The user's run (2026-11-08): both sessions in /Users/gsp-budi/Documents/Research.
const SESSION_DIR = "/Users/gsp-budi/Documents/Research"
const MAIN_SES = "ses_e46061bebffe0123456789AbCd"
const CHILD_SES = "ses_e46039e30ffe0123456789AbCd"
const OTHER_SES = "ses_e40000000000aaaaaaaaaaaaaa"

// Created oldest first (the clock ticks per write), so "newest first" is the reverse of this order.
await create("2026-11-08_in-dir", `${SESSION_DIR}/sub`)
await create("2026-11-08_child-elsewhere", "/elsewhere/one", link(CHILD_SES))
await create("2026-11-08_main-elsewhere", "/elsewhere/two", link(MAIN_SES))
await create("2026-11-08_both", SESSION_DIR, link(CHILD_SES))
await create("2026-11-08_other-session", "/elsewhere/three", link(OTHER_SES))
await create("2026-11-08_claude-link", "/elsewhere/four", link(CHILD_SES, "claude"))
await create("2026-11-08_unrelated", "/elsewhere/five")

const linked = (refs: string[]) => ({ client: "swarm" as const, refs })
const ids = (f: S) => M.list(f as never).items.map((i) => i.id)

describe("row 183: the store lists the union of the directory rule and the linked sessions", () => {
  test("live shape: directory matches plus missions linked to the main or a child session, deduplicated, newest first", () => {
    expect(ids({ projectDir: SESSION_DIR, linkedSessions: linked([MAIN_SES, CHILD_SES]) })).toEqual([
      "2026-11-08_both",
      "2026-11-08_main-elsewhere",
      "2026-11-08_child-elsewhere",
      "2026-11-08_in-dir",
    ])
  })

  test("the take applies to the union", () => {
    expect(ids({ projectDir: SESSION_DIR, linkedSessions: linked([MAIN_SES, CHILD_SES]), take: 2 })).toEqual(["2026-11-08_both", "2026-11-08_main-elsewhere"])
  })

  test("linkedSessions alone lists only the linked missions; the client must match", () => {
    expect(ids({ linkedSessions: linked([CHILD_SES]) })).toEqual(["2026-11-08_both", "2026-11-08_child-elsewhere"])
    expect(ids({ linkedSessions: { client: "claude", refs: [CHILD_SES] } })).toEqual(["2026-11-08_claude-link"])
  })

  test("an empty refs list changes nothing (directory rule only); no filter at all still lists everything", () => {
    expect(ids({ projectDir: SESSION_DIR, linkedSessions: linked([]) })).toEqual(["2026-11-08_both", "2026-11-08_in-dir"])
    expect(ids({ linkedSessions: linked([]) })).toHaveLength(7)
  })

  test("other filters still apply to the union (status, the AND session filter)", () => {
    expect(ids({ projectDir: SESSION_DIR, linkedSessions: linked([MAIN_SES, CHILD_SES]), status: ["running"] })).toEqual([])
    expect(ids({ projectDir: SESSION_DIR, linkedSessions: linked([MAIN_SES, CHILD_SES]), session: { client: "swarm", ref: MAIN_SES } })).toEqual(["2026-11-08_main-elsewhere"])
  })
})

describe("row 183: studio_mission_list takes sessions", () => {
  const tools = missionTools(store, { log: () => {} })
  const listTool = tools.find((t) => t.name === "studio_mission_list")!
  const session = { sessionId: "mcp-183", agentId: "swarm", fileRoot: SESSION_DIR }
  const call = async (args: S) => (await listTool.call(args, session)).structuredContent as S

  test("projectDir + sessions: the union, refs of the caller's client", async () => {
    const r = await call({ projectDir: SESSION_DIR, sessions: [MAIN_SES, CHILD_SES], take: 20 })
    expect(r.ok).toBe(true)
    expect(r.items.map((i: S) => i.id)).toEqual(["2026-11-08_both", "2026-11-08_main-elsewhere", "2026-11-08_child-elsewhere", "2026-11-08_in-dir"])
  })

  test("without sessions the answer is unchanged (row 181 directory rule only)", async () => {
    const r = await call({ projectDir: SESSION_DIR })
    expect(r.items.map((i: S) => i.id)).toEqual(["2026-11-08_both", "2026-11-08_in-dir"])
  })

  test("the schema refuses more than 50 refs, an empty ref, a non-string ref and duplicates", async () => {
    const many = Array.from({ length: 51 }, (_, i) => `ses_${String(i).padStart(26, "0")}`)
    for (const sessions of [many, [""], [42], [MAIN_SES, MAIN_SES]]) {
      const r = await call({ projectDir: SESSION_DIR, sessions })
      expect(r.ok).toBe(false)
      expect(r.code).toBe("SCHEMA_INVALID")
    }
    const fifty = await call({ projectDir: SESSION_DIR, sessions: many.slice(0, 50) })
    expect(fifty.ok).toBe(true)
  })
})
