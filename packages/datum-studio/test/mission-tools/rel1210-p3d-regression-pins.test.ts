// 1.2.10 row 51 (AC-P3d, N10-171): regression pins for the four parts the user saw pass in the 1.2.9 live run:
// drift for rows added or dropped after approval, a C3 decision that supersedes C1, C57(b) checkpoints, and the
// MEMORY_INDEX_MISSING close refusal. Green at BASE and at HEAD: every check reads single keys, never the whole
// `drift` object (HEAD adds `drift.changed`, so a whole-object toEqual would be red after row 49).
// Each pin was shown red under its own mutation in the red-base tree (see implementation/51_p3d_regression_pins.md).
// No server, no port: the store is opened on a temp folder.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"

const BASE = process.env.REL1210_P3D_TEST_DIR ?? path.join(tmpdir(), "rel1210-p3d-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(path.join(BASE, "bun-"))
let tick = 1_800_000_000_000
const clock = () => ++tick

const store = new SqliteStudioStore()
await store.open(path.join(RUN, "store"), { release: "1.2.10", log: () => {}, agentClock: clock })
afterAll(async () => {
  await store.close()
})
const M = store.missions

type S = Record<string, any>
const DIR = "/private/tmp/claude-501/rel1210-p3d"
const row = (id: string) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const dec = (id: string, text: string, extra: S = {}) => ({ id, by: "user", date: "2026-11-15", text, ...extra })
/** The U decisions model the person, so they are stored from an attested request (1.2.9 row 50c). */
const PERSON = { attested: true }
const code = async (p: Promise<unknown>) => {
  try {
    await p
    return undefined
  } catch (e) {
    return (e as S).code as string | undefined
  }
}

/** An approved mission with rows 1 and 2 (and an optional running move). */
async function approved(id: string, rows = ["1", "2"]) {
  await store.transaction(async (t) => M.create(t, { id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", project: { dir: DIR }, rows: rows.map(row), decisions: [dec("U1", "User approves the blueprint")] } as never, PERSON))
  await store.transaction(async (t) => M.approve(t, id, "U1"))
}

describe("P3-d: the parts the user saw pass stay passing", () => {
  test("pin 1: drift lists a row added and a row dropped after approval, each with its decision", async () => {
    const MI = "2026-11-15_p3d-drift"
    await approved(MI)
    await store.transaction(async (t) => M.recordDecision(t, MI, dec("U2", "Add row 3") as never, PERSON))
    await store.transaction(async (t) => M.recordDecision(t, MI, dec("U4", "Drop row 2") as never, PERSON))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "3", add: row("3") } as never], { decision: "U2" }))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "2", status: "dropped", note: "merged into row 1" } as never], { decision: "U4" }))
    const d = (M.get(MI)!.derived as S).drift
    // per-key checks only: HEAD adds `changed`, BASE has no such key
    expect(d.count).toBe(1)
    expect(d.rows.map((r: S) => [r.row, r.decision])).toEqual([["3", "U2"]])
    expect(d.dropped.map((r: S) => [r.row, r.decision])).toEqual([["2", "U4"]])
    expect(typeof d.rows[0].timeCreated).toBe("string")
    expect(typeof d.dropped[0].timeDropped).toBe("string")
  })

  test("pin 2: a C3 decision that supersedes C1 keeps both (append-only); an unrecorded target is DECISION_UNKNOWN", async () => {
    const MI = "2026-11-15_p3d-supersedes"
    await approved(MI)
    await store.transaction(async (t) => M.recordDecision(t, MI, dec("C1", "row 2 waits for row 1", { by: "controller" }) as never))
    await store.transaction(async (t) => M.recordDecision(t, MI, dec("C3", "row 2 also waits for row 3", { by: "controller", supersedes: ["C1"] }) as never))
    const ds = (M.get(MI)!.mission as S).decisions as S[]
    const ids = ds.map((d) => d.id)
    expect(ids).toContain("C1")
    expect(ids).toContain("C3")
    expect(ds.find((d) => d.id === "C3")!.supersedes).toEqual(["C1"])
    expect(ds.find((d) => d.id === "C1")!.supersedes).toBeUndefined()
    const bad = await code(store.transaction(async (t) => M.recordDecision(t, MI, dec("C5", "points at nothing", { by: "controller", supersedes: ["C9"] }) as never)))
    expect(bad).toBe("DECISION_UNKNOWN")
    expect(((M.get(MI)!.mission as S).decisions as S[]).map((d) => d.id)).not.toContain("C5")
  })

  test("pin 3: a C57(b) checkpoint is stored per row, leaves progress alone, and a done row refuses it (ROW_CLOSED)", async () => {
    const MI = "2026-11-15_p3d-checkpoint"
    await approved(MI, ["1", "2", "3"])
    const before = (M.get(MI)!.derived as S).progress
    await store.transaction(async (t) => M.recordCheckpoint(t, MI, "3", { n: 1, m: 4, label: "read inputs" }))
    const d = M.get(MI)!.derived as S
    expect(d.checkpoints["3"].n).toBe(1)
    expect(d.checkpoints["3"].m).toBe(4)
    expect(d.checkpoints["3"].label).toBe("read inputs")
    expect(d.progress.done).toBe(before.done)
    expect(d.progress.total).toBe(before.total)
    // a closed row takes no checkpoint
    await store.transaction(async (t) => M.recordDecision(t, MI, dec("U2", "Drop row 2") as never, PERSON))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "2", status: "dropped", note: "not needed" } as never], { decision: "U2" }))
    expect(await code(store.transaction(async (t) => M.recordCheckpoint(t, MI, "2", { n: 1, m: 2 })))).toBe("ROW_CLOSED")
  })

  test("pin 4: a done close is refused MEMORY_INDEX_MISSING while the memory lookup says absent; present closes it", async () => {
    const MI = "2026-11-15_p3d-memory-index"
    await approved(MI, ["1"])
    await store.transaction(async (t) => M.setStatus(t, MI, "running"))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "dropped", note: "not needed for this check" } as never], { decision: "U1" }))
    const refused = await code(store.transaction(async (t) => M.setStatus(t, MI, "done", {}, { memoryIndex: { missionId: MI, present: false } })))
    expect(refused).toBe("MEMORY_INDEX_MISSING")
    expect(((M.get(MI)!.mission as S).status as string)).toBe("running")
    await store.transaction(async (t) => M.setStatus(t, MI, "done", {}, { memoryIndex: { missionId: MI, present: true } }))
    expect(((M.get(MI)!.mission as S).status as string)).toBe("done")
  })
})
