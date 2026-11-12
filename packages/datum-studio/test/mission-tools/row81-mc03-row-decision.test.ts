// Row 81 (1.2.6, MC-03, decision U5 alternative A): a row patch of studio_mission_update_row accepts its own `decision`,
// which overrides the call-level `decision` for that patch only. One call can add several rows after approval, each
// with its own decision id. The store's patch-key whitelist accepts `decision`; per-patch results (row 85, MC-07)
// stay correct: a patch naming an unknown decision is refused alone, the other patches apply.
// No server, no port: the store is opened on a temp folder; the tool is called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

const BASE = process.env.ROW81_TEST_DIR ?? path.join(tmpdir(), "row81-mc03-test")
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
const SESSION = { sessionId: "mcp-81", agentId: "swarm", fileRoot: "/private/tmp/claude-501/row81" }
const decision = (id: string) => ({ id, by: "user", date: "2026-11-12", text: `decision ${id}` })

/** An approved mission with decisions U1 (approval), U2, U3 recorded. */
async function approved(id: string) {
  await store.transaction(async (t) => {
    M.create(t, { id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", project: { dir: "/private/tmp/claude-501/row81" }, rows: [row("1")], decisions: [decision("U1"), decision("U2"), decision("U3")] } as never)
    M.approve(t, id, "U1")
  })
}
const updateRow = missionTools(store, { log: () => {} }).find((t) => t.name === "studio_mission_update_row")! as S
const call = async (args: S) => {
  const r = (await updateRow.call(args, SESSION)) as S
  return { isError: r.isError === true, sc: (r.structuredContent ?? {}) as S, text: JSON.stringify(r) }
}
const rowOf = (mission: string, id: string) => (M.get(mission)!.mission.rows as S[]).find((r) => r.id === id)

describe("row 81 MC-03: per-patch decision on update_row", () => {
  test("one call adds two rows after approval, each stored with its own decision", async () => {
    const MI = "2026-11-12_mc03-two-rows"
    await approved(MI)
    const r = await call({ mission: MI, rows: [{ id: "2", add: row("2"), decision: "U2" }, { id: "3", add: row("3"), decision: "U3" }] })
    expect(r.isError).toBe(false)
    expect(r.sc.changed).toEqual(["2", "3"])
    expect(rowOf(MI, "2")!.decision).toBe("U2")
    expect(rowOf(MI, "3")!.decision).toBe("U3")
  })

  test("a patch decision overrides the call-level decision for that patch only", async () => {
    const MI = "2026-11-12_mc03-override"
    await approved(MI)
    const r = await call({ mission: MI, decision: "U2", rows: [{ id: "2", add: row("2") }, { id: "3", add: row("3"), decision: "U3" }] })
    expect(r.isError).toBe(false)
    expect(rowOf(MI, "2")!.decision).toBe("U2")
    expect(rowOf(MI, "3")!.decision).toBe("U3")
    // a structural set with a per-patch decision is judged with that decision
    const s = await call({ mission: MI, decision: "U2", rows: [{ id: "2", set: { size: "M" }, decision: "U3" }] })
    expect(s.isError).toBe(false)
    expect(rowOf(MI, "2")!.decision).toBe("U3")
  })

  test("per-patch results stay correct: an unknown patch decision refuses that patch alone", async () => {
    const MI = "2026-11-12_mc03-results"
    await approved(MI)
    const r = await call({ mission: MI, rows: [{ id: "2", add: row("2"), decision: "U2" }, { id: "3", add: row("3"), decision: "U9" }, { id: "4", add: row("4"), decision: "U3" }] })
    expect(r.isError).toBe(false)
    expect(r.sc.changed).toEqual(["2", "4"])
    expect(r.sc.results.map((x: S) => [x.id, x.ok, x.code ?? null])).toEqual([
      ["2", true, null],
      ["3", false, "DECISION_UNKNOWN"],
      ["4", true, null],
    ])
    expect(rowOf(MI, "3")).toBeUndefined()
    expect(rowOf(MI, "4")!.decision).toBe("U3")
  })

  test("store whitelist: updateRows accepts a patch-level decision; other unknown keys stay refused", async () => {
    const MI = "2026-11-12_mc03-store"
    await approved(MI)
    const out = await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "2", add: row("2"), decision: "U2" } as never]))
    expect(out.changed).toEqual(["2"])
    expect(rowOf(MI, "2")!.decision).toBe("U2")
    await expect(store.transaction(async (t) => M.updateRows(t, MI, [{ id: "2", bogus: 1 } as never]))).rejects.toMatchObject({ code: "SCHEMA_INVALID" })
  })

  test("the tool schema still refuses a malformed patch decision", async () => {
    const MI = "2026-11-12_mc03-schema"
    await approved(MI)
    const r = await call({ mission: MI, rows: [{ id: "2", add: row("2"), decision: "not a decision id" }] })
    expect(r.isError).toBe(true)
    expect(r.sc.code).toBe("SCHEMA_INVALID")
    expect(rowOf(MI, "2")).toBeUndefined()
  })
})
