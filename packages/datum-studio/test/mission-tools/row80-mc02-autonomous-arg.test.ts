// Row 80 (1.2.6, MC-02, decision U5 alternative A): studio_mission_record_decision accepts `autonomous` inside the
// `decision` object and as a top-level argument; both shapes store the same Decision record. When both are given and
// differ, the call is refused SCHEMA_INVALID with pointer /decision/autonomous and nothing is written. A wrong type at
// either place names its own pointer. The autonomous-mode gate (P-04, AUTONOMOUS_MODE_OFF) is unchanged: a top-level
// autonomous: true without Swarm's mode mark is refused the same way as the nested shape.
// No server, no port: the store is opened on a temp folder; the tool is called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

const BASE = process.env.ROW80_TEST_DIR ?? path.join(tmpdir(), "row80-mc02-test")
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
const AUTO_SESSION = { sessionId: "mcp-80", agentId: "swarm", fileRoot: "/private/tmp/claude-501/row80", autonomousMode: true }
const OFF_SESSION = { sessionId: "mcp-80-off", agentId: "swarm", fileRoot: "/private/tmp/claude-501/row80" }
const decision = (id: string) => ({ id, by: "controller", date: "2026-11-12", text: "blueprint self-approved" })

async function draft(id: string) {
  await store.transaction(async (t) => M.create(t, { id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", project: { dir: "/private/tmp/claude-501/row80" }, rows: [row("1")] } as never))
}
const recordDecision = missionTools(store, { log: () => {} }).find((t) => t.name === "studio_mission_record_decision")! as S
const call = async (args: S, session: S = AUTO_SESSION) => {
  const r = (await recordDecision.call(args, session)) as S
  return { isError: r.isError === true, sc: (r.structuredContent ?? {}) as S, text: JSON.stringify(r) }
}
const stored = (mission: string) => (M.get(mission)!.mission.decisions ?? []).map((d: S) => ({ ...d }))
const pointers = (sc: S): string[] => ((sc.error?.details?.issues ?? []) as S[]).map((i) => i.pointer ?? i.path)

describe("row 80 MC-02: record_decision autonomous at top level or inside decision", () => {
  test("top-level autonomous: true stores the same record as decision.autonomous: true", async () => {
    const A = "2026-11-12_mc02-nested"
    const B = "2026-11-12_mc02-top"
    await draft(A)
    await draft(B)
    const a = await call({ mission: A, decision: { ...decision("C1"), autonomous: true } })
    const b = await call({ mission: B, decision: decision("C1"), autonomous: true })
    expect(a.isError).toBe(false)
    expect(b.isError).toBe(false)
    expect(stored(B)).toEqual(stored(A))
    expect(stored(B)[0].autonomous).toBe(true)
    // the self-approval then works with the decision recorded through the top-level shape
    const approve = missionTools(store, { log: () => {} }).find((t) => t.name === "studio_mission_approve")! as S
    const ap = (await approve.call({ mission: B, decision: "C1" }, AUTO_SESSION)) as S
    expect(ap.isError).not.toBe(true)
    expect(M.get(B)!.mission.status).toBe("approved")
  })

  test("both given and equal is accepted", async () => {
    const MI = "2026-11-12_mc02-equal"
    await draft(MI)
    const r = await call({ mission: MI, decision: { ...decision("C1"), autonomous: true }, autonomous: true })
    expect(r.isError).toBe(false)
    expect(stored(MI)[0].autonomous).toBe(true)
  })

  test("both given and conflicting is refused SCHEMA_INVALID naming /decision/autonomous; nothing written", async () => {
    const MI = "2026-11-12_mc02-conflict"
    await draft(MI)
    for (const [inner, top] of [[true, false], [false, true]] as const) {
      const r = await call({ mission: MI, decision: { ...decision("C1"), autonomous: inner }, autonomous: top })
      expect(r.isError).toBe(true)
      expect(r.sc.code).toBe("SCHEMA_INVALID")
      expect(pointers(r.sc)).toContain("/decision/autonomous")
      expect(r.text).toContain("/decision/autonomous")
    }
    expect(stored(MI)).toEqual([])
  })

  test("a wrong type names its own pointer: /autonomous at top level, /decision/autonomous inside", async () => {
    const MI = "2026-11-12_mc02-types"
    await draft(MI)
    const top = await call({ mission: MI, decision: decision("C1"), autonomous: "yes" })
    expect(top.sc.code).toBe("SCHEMA_INVALID")
    expect(pointers(top.sc)).toContain("/autonomous")
    const inner = await call({ mission: MI, decision: { ...decision("C1"), autonomous: "yes" } })
    expect(inner.sc.code).toBe("SCHEMA_INVALID")
    expect(pointers(inner.sc)).toContain("/decision/autonomous")
    expect(stored(MI)).toEqual([])
  })

  test("P-04 unchanged: top-level autonomous: true without the mode mark is refused AUTONOMOUS_MODE_OFF", async () => {
    const MI = "2026-11-12_mc02-off"
    await draft(MI)
    const r = await call({ mission: MI, decision: decision("C1"), autonomous: true }, OFF_SESSION)
    expect(r.isError).toBe(true)
    expect(r.sc.code).toBe("AUTONOMOUS_MODE_OFF")
    expect(r.text).toContain("studio_mission_request_decision")
    expect(stored(MI)).toEqual([])
  })
})
