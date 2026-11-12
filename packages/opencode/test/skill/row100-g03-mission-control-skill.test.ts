// 1.2.6 row 100 (G-03, OFF-01, W-08 mission-control part, S-03b rule): the built-in skill mission-control is written
// against the fixed Mission Control (rows 79-89, 100a) and carries the delegation rules of S-03 (rows 42, 43).
// - GUIDE pins: the fixed behaviour is named with the store's own wording (ROW_RUNNING_DONE_RULE, the per-patch result
//   shape of the guide), the delegation codes equal the task tool's constants, the mission store is the one decision
//   source and the docs file its export, and no 1.2.5 workaround or off-repo skill text is left (OFF-01).
// - Shape test: every `studio_mission_* {json}` call the skill quotes, plus the create example, is run in document order
//   against a real store on a temp folder through the host's mission tools. None may be refused.
// datum-studio sources are imported read-only; non-literal specifiers keep the opencode typecheck out of that package.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Skill } from "../../src/skill"

const TEXT = Skill.MISSION_CONTROL_SKILL_CONTENT
const flat = TEXT.replace(/\s+/g, " ")

type S = Record<string, any>
const STUDIO = path.join(import.meta.dir, "../../../datum-studio/src")
const load = (rel: string): Promise<S> => import(path.join(STUDIO, rel))

/** Every `studio_mission_* {json}` call in the text, in order (one call per line or inline in prose). */
function calls(): Array<{ tool: string; args: S }> {
  const out: Array<{ tool: string; args: S }> = []
  for (const m of TEXT.matchAll(/(studio_mission_[a-z_]+) (\{[^\n]*?\})(?=[.\s;]|$)/g)) out.push({ tool: m[1], args: JSON.parse(m[2]) })
  return out
}

describe("row 100 G-03: mission-control names the fixed behaviour", () => {
  test("running -> done is one call with a note, in the store's own words; no two-step close", async () => {
    const store = await load("store/mission/mission-store.ts")
    expect(flat).toContain(store.ROW_RUNNING_DONE_RULE)
    const done = calls().filter((c) => c.tool === "studio_mission_update_row").flatMap((c) => c.args.rows ?? [])
    expect(done.some((p: S) => p.status === "done" && typeof p.note === "string")).toBe(true)
    expect(done.some((p: S) => p.status === "needs-review")).toBe(false)
    expect(flat).not.toMatch(/two calls|running -> done does not exist|running -> needs-review -> done|then \{status:"done"\}/i)
  })

  test("per-patch results, rows[].decision, noteSaved, unchanged: true, drift and the decisions register are named", async () => {
    const guide = await load("mcp-host/mission/mission-guide.ts")
    expect(flat).toContain(guide.ROW_PATCH_RESULT_SHAPE)
    for (const phrase of ["rows[].decision", "noteSaved: true", "unchanged: true", "derived.drift", "decisions {count, ids}", "MISSION_ROWS_OPEN"])
      expect(flat.includes(phrase) ? phrase : `missing ${phrase}`).toBe(phrase)
    expect(flat).toContain("Notes are never held back by dependencies")
  })

  test("autonomous self-approval quotes the top-level autonomous field", () => {
    const rec = calls().find((c) => c.tool === "studio_mission_record_decision" && c.args.autonomous === true)
    expect(rec?.args.decision).toMatchObject({ by: "controller" })
    expect(rec?.args.decision.autonomous).toBeUndefined()
    expect(flat).toContain("autonomous goes at the top level or inside decision; both are stored the same")
  })
})

describe("row 100 S-03b: delegation rules", () => {
  test("expected_outputs, SUBAGENT_OUTPUT_MISSING -> row blocked, SUBAGENT_NO_RESULT, with the tool's own texts", async () => {
    // Dynamic: the constants are rows 42/43's; at the red base they are absent and the pins fail as assertions.
    const texts: S = await import("../../src/permission/autonomy-texts")
    expect(typeof texts.SUBAGENT_OUTPUT_MISSING).toBe("string")
    expect(flat).toContain("expected_outputs")
    expect(flat).toContain(`"${texts.SUBAGENT_OUTPUT_MISSING} <paths>" (SUBAGENT_OUTPUT_MISSING)`)
    expect(flat).toContain(`"${texts.SUBAGENT_NO_RESULT}" (SUBAGENT_NO_RESULT)`)
    expect(flat).toMatch(/SUBAGENT_OUTPUT_MISSING\): mark the row blocked/)
  })

  test("subagent Studio access follows S-02: reads allowed, row writes ask, answer_decision denied", () => {
    expect(flat).toContain("planner and document-writer may read missions")
    expect(flat).toContain("studio_mission_update_row included, ask the person first")
    expect(flat).toContain("studio_mission_answer_decision is denied to every agent")
  })
})

describe("row 100 W-08: one decision source", () => {
  test("decisions live in the mission store; decisions.md is its export", () => {
    expect(flat).toContain("Decisions live in the mission store: it is the one decision record.")
    expect(flat).toContain("docs/<mission>/decisions/decisions.md is an export of that register (studio_mission_export), never a second place to write decisions.")
  })
})

// Fix row FX-10 (gate 04 F10): the structural fields that need a decision after approval are the store's own list
// (mission-store.ts STRUCTURAL_FIELDS), ownership included.
describe("FX-10 F10: structural fields after approval", () => {
  test("the skill lists exactly STRUCTURAL_FIELDS, in the store's order", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(path.join(STUDIO, "store", "mission", "mission-store.ts"), "utf8")
    const list = /const STRUCTURAL_FIELDS = \[([^\]]+)\] as const/.exec(src)![1].match(/"([a-z]+)"/g)!.map((s) => s.slice(1, -1))
    expect(list).toContain("ownership")
    expect(flat).toContain(`changing a structural field (${list.join(", ")})`)
  })
})

describe("row 100 OFF-01: no off-repo skill name, dated build fact or project text", () => {
  test("grep finds none", () => {
    expect(TEXT).not.toMatch(/studio-mission-ops|swarm-tools-1\.19|measured \d{4}|datum-studio 1\.\d|since \*\*1\.\d|on this machine/i)
    expect(TEXT).not.toMatch(/~\/\.config|~\/\.local|\.sqlite|dump_verification|studio-besar|swarm\.jsonc/)
    expect(TEXT).not.toMatch(/freezes the whole chain|omit it and approve answers|is \*\*per decision\*\*/)
  })
})

// The shape test: the skill's calls, run in order against the store. A mission A follows the person-approval path; the
// autonomous pair (record_decision with autonomous, approve with a C id) runs on a copy B in an autonomous session.
describe("row 100 G-03 shape test: every quoted call runs against the store", () => {
  const RUN = mkdtempSync(path.join(process.env.ROW100_TEST_DIR ?? tmpdir(), "row100-g03-"))
  const PROJECT = path.join(RUN, "project")
  mkdirSync(PROJECT, { recursive: true })
  let opened: S | undefined
  afterAll(async () => {
    await opened?.close()
    rmSync(RUN, { recursive: true, force: true })
  })

  test("no call is refused; results are all ok; close returns the decision register", async () => {
    const { SqliteStudioStore } = await load("store/index.ts")
    const { missionTools } = await load("mcp-host/mission/mission-tools.ts")
    const { missionDocsExporter } = await load("mcp-host/mission/export/exporter.ts")
    let tick = 1_800_000_000_000
    const store = new SqliteStudioStore()
    await store.open(path.join(RUN, "store"), { release: "1.2.6", log: () => {}, agentClock: () => ++tick })
    opened = store
    const tools = missionTools(store, { log: () => {}, exporter: missionDocsExporter }) as S[]
    const session = { sessionId: "mcp-row100", agentId: "swarm", fileRoot: PROJECT, autonomousMode: true }
    const call = async (tool: string, args: S) => {
      const res = (await tools.find((t) => t.name === tool)!.call(args, session)) as S
      const text = res.content?.[0]?.text ?? ""
      expect(res.isError ? `${tool} refused: ${text}` : "ok").toBe("ok")
      return (res.structuredContent?.data ?? res.structuredContent) as S
    }

    const create = JSON.parse(TEXT.match(/```json\n([\s\S]*?)```/)![1]) as S
    const A = create.mission.id as string
    const B = `${A}-autonomous`
    await call("studio_mission_create", create)
    await call("studio_mission_create", { mission: create.mission })
    await call("studio_mission_create", { mission: { ...create.mission, id: B } })

    const quoted = calls()
    expect(quoted.length).toBeGreaterThanOrEqual(12)
    const ran: string[] = []
    let closed: S | undefined
    for (const { tool, args } of quoted) {
      if (tool === "studio_mission_answer_decision") continue // named, never called by the agent
      // The autonomous pair and the pause example run on B, so A keeps the person-approval path and closes running.
      const auto = args.autonomous === true || args.decision?.autonomous === true || (tool === "studio_mission_approve" && /^C/.test(args.decision)) || args.to === "paused"
      const target = auto ? B : A
      if (tool === "studio_mission_update_row" && args.rows?.some((p: S) => p.retire)) {
        // A retire needs a real superseded draft; its shape is checked by the schema test in mission-control-skill.test.ts.
        continue
      }
      if (tool === "studio_mission_approve" && !auto) {
        // The person answers the request in Mission Control (the agent never does): simulate that answer.
        const req = quoted.find((c) => c.tool === "studio_mission_request_decision")!.args.request
        await call("studio_mission_answer_decision", { mission: A, request: req.id, option: req.recommended, by: "user", decisionId: args.decision, date: "2026-11-12", text: "Approved" })
      }
      if (tool === "studio_mission_set_status" && args.to === "done") {
        // Finish whatever rows the examples left open, with the same one-call done shape, before the quoted close.
        for (const r of (await call("studio_mission_get", { mission: A, include: ["rows"] })).mission.rows as S[]) {
          if (r.status === "pending") await call("studio_mission_update_row", { mission: A, rows: [{ id: r.id, status: "running" }] })
          if (r.status !== "done" && r.status !== "dropped") await call("studio_mission_update_row", { mission: A, rows: [{ id: r.id, status: "done", note: "check: example run, result in the test log" }] })
        }
      }
      const data = await call(tool, { ...args, mission: target })
      ran.push(tool)
      if (tool === "studio_mission_update_row") for (const r of data.results ?? []) expect(r).toMatchObject({ ok: true })
      if (tool === "studio_mission_set_status" && args.to === "done") closed = data
    }
    for (const t of ["studio_mission_request_decision", "studio_mission_approve", "studio_mission_record_decision", "studio_mission_set_status", "studio_mission_update_row", "studio_mission_get", "studio_mission_record_finding", "studio_mission_export"])
      expect(ran.includes(t) ? t : `not run ${t}`).toBe(t)
    const register = (await call("studio_mission_get", { mission: A, include: ["decisions"] })).mission.decisions.map((d: S) => d.id)
    expect(closed?.decisions).toEqual({ count: register.length, ids: register })
    const drift = (await call("studio_mission_get", { mission: A })).derived.drift
    expect(drift.count).toBeGreaterThanOrEqual(1)
  })
})
