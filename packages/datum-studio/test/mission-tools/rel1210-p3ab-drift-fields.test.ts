// 1.2.10 row 49 (AC-P3a, AC-P3b; register N10-169; spec 01c §2, §3.1-§3.5; decisions C16 D-P3-1..9, C30 S10-30/S10-31):
// derived.drift.changed lists the post-approval changes to a row's approved blueprint fields (deps, agent, phase,
// kind, size, model tier, output, verification), one entry per row-change event, each with its decision id. Structured
// fields carry {field, from, to}; the free-text output and verification carry the field name only (S10-30), so an old
// value is never kept in the event trail, the /docs export or the read (S10-31). Running fields never count.
// Red at BASE (a3e3c4c93a): driftOf never reads row-change events, so `changed` is undefined and the text has no
// `changed:` segment.
// No server, no port: the store is opened on a temp folder; tools are called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"
import { missionDocsExporter } from "../../src/mcp-host/mission/export/index.ts"
import { MISSION_LIFECYCLE } from "../../src/mcp-host/mission/mission-guide.ts"

const BASE = process.env.REL1210_P3AB_TEST_DIR ?? path.join(tmpdir(), "rel1210-p3ab-test")
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
const DIR = "/private/tmp/claude-501/rel1210-p3ab"
const row = (id: string, extra: S = {}) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", ...extra })
const dec = (id: string, text: string, extra: S = {}) => ({ id, by: id.startsWith("U") ? "user" : "controller", date: "2026-11-15", text, ...extra })
/** The U decisions model the person, so they are stored from an attested request (1.2.9 row 50c). */
const PERSON = { attested: true }
const session = { sessionId: "mcp-p3ab", agentId: "swarm", fileRoot: DIR }
const tools = missionTools(store, { log: () => {}, exporter: missionDocsExporter as never })
const tool = (name: string) => tools.find((t) => t.name === name)! as S
const EMPTY = { count: 0, rows: [], dropped: [], changed: [] }

/** The BASE literal of the studio_mission_get description (spec 01c F11, D-P3-6). */
const GET_DESCRIPTION =
  "Read one mission: the MissionDoc plus derived {phases (U20), waves, ready, counts, progress, checkpoints, drift (rows added or dropped after approval, each with its decision id)}. include: rows, decisions, findings, locks, reports, events, snapshots, requests, checkpoints, messages, deliverables (the mission's Studio documents with current outputs: finalFileName, sha256, verified). messagesTail: N = the newest N messages."

const GUIDE_5 =
  "Lifecycle 5/6 gate: a row is done only with verified outputs (OUTPUT_UNVERIFIED otherwise); a note never lifts the output gate. Other close refusals: DELIVERABLE_NOT_IN_PROJECT (the file of the current revision is missing from deliverables/<mission-id>/ in the project, or its sha256 differs: datum-studio_studio_render the document again), KNOWLEDGE_NOT_CONSULTED (read a listed library file with datum-studio_studio_library_read, or send knowledgeReason on the row patch saying why the library does not apply). A row whose labels await a person (awaitingHumanCheck) closes with that marker shown instead of being refused. Rows added or dropped after approval, and changes to a row's deps, agent, phase, kind, size, model tier, output or verification, need a decision and show in studio_mission_get derived.drift (each with its decision id)."

/** An approved mission (type feature-release) with the given rows, decision C1 at create, approved with U1. */
async function approved(id: string, rows: S[], decisions: string[] = []) {
  await store.transaction(async (t) =>
    M.create(t, { id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", project: { dir: DIR }, rows, decisions: [dec("U1", "User approves the blueprint"), dec("C1", "Initial plan")] } as never, PERSON),
  )
  await store.transaction(async (t) => M.approve(t, id, "U1"))
  for (const d of decisions) await store.transaction(async (t) => M.recordDecision(t, id, dec(d, `decision ${d}`) as never, d.startsWith("U") ? PERSON : undefined))
}
const set = (MI: string, id: string, s: S, decision?: string) => store.transaction(async (t) => M.updateRows(t, MI, [{ id, set: s } as never], decision ? { decision } : {}))
const drift = (MI: string) => (M.get(MI)!.derived as S).drift as S
const getText = async (MI: string) => {
  const res = (await tool("studio_mission_get").call({ mission: MI }, session)) as S
  expect(res.isError).not.toBe(true)
  return (res.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n")
}
const driftLine = (text: string) => text.split("\n").filter((l) => l.startsWith("  drift:"))

describe("P3-a: the user's scenario", () => {
  test("P3-a: the user's scenario, a deps change after approval is a drift entry", async () => {
    const MI = "2026-11-15_p3a-user"
    await approved(MI, [row("1"), row("2", { deps: ["1:B"] }), row("3")])
    await store.transaction(async (t) => M.recordDecision(t, MI, dec("C3", "row 2 also waits for row 3", { supersedes: ["C1"] }) as never))
    const upd = (await tool("studio_mission_update_row").call({ mission: MI, rows: [{ id: "2", set: { deps: ["1:B", "3:C"] } }], decision: "C3" }, session)) as S
    expect(upd.isError).not.toBe(true)

    const res = (await tool("studio_mission_get").call({ mission: MI, include: ["events", "rows"] }, session)) as S
    const data = res.structuredContent?.data ?? res.structuredContent
    const d = data.derived.drift
    expect(d.count).toBe(0)
    expect(d.rows).toEqual([])
    expect(d.dropped).toEqual([])
    expect(d.changed).toHaveLength(1)
    const { timeChanged, ...entry } = d.changed[0]
    expect(entry).toEqual({ row: "2", decision: "C3", fields: ["deps"], changes: [{ field: "deps", from: ["1:B"], to: ["1:B", "3:C"] }] })
    expect(typeof timeChanged).toBe("string")
    expect(new Date(timeChanged).toISOString()).toBe(timeChanged)
    const text = (res.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n")
    expect(driftLine(text)).toEqual(["  drift: 0 rows added after approval (-); changed: 2 by C3 (deps)"])
    // the stored deps read back, and the event carries the recorded change
    expect(M.get(MI)!.mission.rows!.find((r) => r.id === "2")!.deps).toEqual(["1:B", "3:C"])
    const ev = (data.events as S[]).filter((e) => e.verb === "row-change" && e.row === "2").at(-1)!
    expect(ev.detail).toEqual({ fields: ["deps"], changes: [{ field: "deps", from: ["1:B"], to: ["1:B", "3:C"] }] })
    expect(ev.decision).toBe("C3")
  })

  test("P3-a: the same scenario through the store", async () => {
    const MI = "2026-11-15_p3a-store"
    await approved(MI, [row("1"), row("2", { deps: ["1:B"] }), row("3")])
    await store.transaction(async (t) => M.recordDecision(t, MI, dec("C3", "row 2 also waits for row 3", { supersedes: ["C1"] }) as never))
    await set(MI, "2", { deps: ["1:B", "3:C"] }, "C3")
    const d = drift(MI)
    expect(d.changed.map(({ timeChanged: _t, ...e }: S) => e)).toEqual([{ row: "2", decision: "C3", fields: ["deps"], changes: [{ field: "deps", from: ["1:B"], to: ["1:B", "3:C"] }] }])
    expect(d.count).toBe(0)
  })

  // S10-31 guard (CHAR: green at BASE, where no value is copied, and at HEAD, where output changes carry the name only).
  test("P3-a (S10-31): an old output value never reaches the read or the /docs export", async () => {
    const MI = "2026-11-15_p3a-export"
    await approved(MI, [row("1"), row("2", { output: "OLD-OUTPUT-P3" })], ["C3"])
    await set(MI, "2", { output: "implementation/2_new.md" }, "C3")
    const res = (await tool("studio_mission_get").call({ mission: MI, include: ["events", "rows", "decisions"] }, session)) as S
    expect(JSON.stringify(res)).not.toContain("OLD-OUTPUT-P3")
    const exp = (await tool("studio_mission_export").call({ mission: MI }, session)) as S
    expect(exp.isError).not.toBe(true)
    const files = ((exp.structuredContent?.data ?? exp.structuredContent).files as S[])
    expect(files.length).toBeGreaterThanOrEqual(4)
    for (const f of files) expect(f.markdown as string).not.toContain("OLD-OUTPUT-P3")
  })
})

describe("P3-b: every approved field counts, running fields never", () => {
  test("P3-b: every approved field counts, running fields never; a normal run is drift 0", async () => {
    // one entry per structured field, each with from/to
    const one: Array<[string, S, S[]]> = [
      ["agent", { agent: "test-expert" }, [{ field: "agent", from: "coder-execution", to: "test-expert" }]],
      ["phase+kind", { phase: "verification", kind: "test" }, [{ field: "phase", from: "implementation", to: "verification" }, { field: "kind", from: "implementation", to: "test" }]],
      ["kind", { kind: "fix" }, [{ field: "kind", from: "implementation", to: "fix" }]],
      ["size", { size: "M" }, [{ field: "size", from: "S", to: "M" }]],
      ["model", { model: { tier: "worker", reason: "mechanical" } }, [{ field: "model", from: "thinker", to: "worker" }]],
      ["deps kind", { deps: ["1:C"] }, [{ field: "deps", from: ["1:B"], to: ["1:C"] }]],
      // S10-30: free text carries the field name only
      ["output", { output: "implementation/other.md" }, [{ field: "output" }]],
      ["verification", { verification: "typecheck 0" }, [{ field: "verification" }]],
    ]
    for (const [name, s, changes] of one) {
      const MI = `2026-11-15_p3b-${name.replace(/[^a-z]/g, "")}`
      await approved(MI, [row("1"), row("2", { deps: ["1:B"] })], ["C2"])
      await set(MI, "2", s, "C2")
      const d = drift(MI)
      expect([name, d.changed.map(({ timeChanged: _t, ...e }: S) => e)]).toEqual([name, [{ row: "2", decision: "C2", fields: changes.map((c) => c.field), changes }]])
      for (const c of d.changed[0].changes) if (c.field === "output" || c.field === "verification") expect("from" in c || "to" in c).toBe(false)
      expect(d.count).toBe(0)
    }

    // multi-field set: one entry, note left out, DRIFT_FIELDS order
    {
      const MI = "2026-11-15_p3b-multi"
      await approved(MI, [row("1"), row("2")], ["C2"])
      await set(MI, "2", { note: "switch", model: { tier: "worker", reason: "mechanical" }, agent: "test-expert" }, "C2")
      const d = drift(MI)
      expect(d.changed).toHaveLength(1)
      expect(d.changed[0].fields).toEqual(["agent", "model"])
    }

    // D-P3-5: a row added after approval and later changed is in rows and in changed
    {
      const MI = "2026-11-15_p3b-added"
      await approved(MI, [row("1")], ["U2", "U3"])
      await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "5", add: row("5") } as never], { decision: "U2" }))
      await set(MI, "5", { agent: "test-expert" }, "U3")
      const d = drift(MI)
      expect(d.rows.map((r: S) => [r.row, r.decision])).toEqual([["5", "U2"]])
      expect(d.changed.map((c: S) => [c.row, c.decision, c.fields])).toEqual([["5", "U3", ["agent"]]])
    }

    // zero entries
    const zero: Array<[string, S, string[]?]> = [
      ["title", { title: "Renamed" }],
      ["ownership", { ownership: { text: "the store" } }],
      ["model reason", { model: { tier: "thinker", reason: "new" } }],
      ["same agent", { agent: "coder-execution" }],
      ["deps reorder", { deps: ["3:C", "1:B"] }],
      ["resources", { resources: ["build"] }],
      ["checks", { checks: "bun test" }],
      ["review", { review: "none" }],
    ]
    for (const [name, s] of zero) {
      const MI = `2026-11-15_p3b-z-${name.replace(/[^a-z]/g, "")}`
      await approved(MI, [row("1"), row("3"), row("2", { deps: ["1:B", "3:C"] })], ["C2"])
      await set(MI, "2", s, "C2")
      expect([name, drift(MI).changed]).toEqual([name, []])
    }

    // a deps change while draft is not drift
    {
      const MI = "2026-11-15_p3b-draft"
      await store.transaction(async (t) => M.create(t, { id: MI, title: "Draft", type: "feature-release", owner: "master-controller", project: { dir: DIR }, rows: [row("1"), row("2", { deps: ["1:B"] })], decisions: [dec("U1", "x")] } as never, PERSON))
      await set(MI, "2", { deps: ["1:C"] })
      expect(drift(MI).changed).toEqual([])
      await store.transaction(async (t) => M.approve(t, MI, "U1"))
      expect(drift(MI)).toEqual(EMPTY)
    }

    // a patch refused inside its savepoint stores nothing and writes no event
    {
      const MI = "2026-11-15_p3b-refused"
      await approved(MI, [row("1"), row("2", { deps: ["1:B"] })], ["C2"])
      const refused = await set(MI, "2", { deps: ["9:B"] }, "C2").then(
        () => undefined,
        (e: S) => e.code as string,
      )
      expect(refused).toBe("DEP_UNKNOWN")
      expect(drift(MI)).toEqual(EMPTY)
      expect(M.get(MI)!.mission.rows!.find((x) => x.id === "2")!.deps).toEqual(["1:B"])
    }

    // a normal run is drift 0
    {
      const MI = "2026-11-15_p3b-normal"
      await approved(MI, [row("1"), row("2")])
      await store.transaction(async (t) => M.setStatus(t, MI, "running"))
      const up = (p: S) => store.transaction(async (t) => M.updateRows(t, MI, [p as never]))
      await up({ id: "1", status: "running" })
      await store.transaction(async (t) => M.recordCheckpoint(t, MI, "1", { n: 1, m: 2 }))
      await up({ id: "1", acquire: ["build"] })
      await up({ id: "1", release: ["build"] })
      await up({ id: "1", note: "half way" })
      await up({ id: "1", status: "blocked", note: "waiting for input" })
      await up({ id: "1", status: "running", note: "input arrived" })
      await up({ id: "1", status: "done", note: "bun test 3 pass, log test/1.log" })
      await up({ id: "2", status: "running" })
      await up({ id: "2", status: "done", note: "bun test 2 pass, log test/2.log" })
      expect(M.get(MI)!.derived.progress.done).toBe(2)
      expect(drift(MI)).toEqual(EMPTY)
    }

    // events written before 1.2.10 carry names only
    {
      const MI = "2026-11-15_p3b-legacy"
      await approved(MI, [row("1"), row("2")], ["U2"])
      const raw = (detail: S, decision: string | null) =>
        store.transaction(async (t) =>
          (t as S).run("INSERT INTO mission_event (mission_id, row_id, actor, verb, from_status, to_status, decision_id, detail, time_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [MI, "2", "swarm", "row-change", null, null, decision, JSON.stringify(detail), clock()]),
        )
      await raw({ fields: ["deps", "note"] }, "U2")
      await raw({ fields: ["model"] }, "U2")
      await raw({ fields: ["note"] }, null)
      await raw({ fields: ["title"] }, "U2")
      await raw({ fields: ["retire"], retired: [], keeps: [] }, null)
      const ch = drift(MI).changed as S[]
      expect(ch.map((c) => [c.row, c.decision, c.fields])).toEqual([
        ["2", "U2", ["deps"]],
        ["2", "U2", ["model"]],
      ])
      for (const c of ch) expect("changes" in c).toBe(false)
    }
  })

  test("P3-b: tool text names changes, never values; description and guide", async () => {
    const MI = "2026-11-15_p3b-text"
    await approved(MI, [row("1"), row("2", { deps: ["1:B"] }), row("3"), row("4")], ["C3", "C4"])
    await set(MI, "2", { deps: ["1:B", "3:C"] }, "C3")
    await set(MI, "4", { agent: "test-expert", model: { tier: "worker", reason: "mechanical" } }, "C4")
    expect(driftLine(await getText(MI))).toEqual(["  drift: 0 rows added after approval (-); changed: 2 by C3 (deps), 4 by C4 (agent, model)"])

    const MI2 = "2026-11-15_p3b-text2"
    await approved(MI2, [row("1"), row("2"), row("3", { deps: ["1:B"] })], ["U2", "U4", "U5"])
    await store.transaction(async (t) => M.updateRows(t, MI2, [{ id: "5", add: row("5") } as never], { decision: "U2" }))
    await store.transaction(async (t) => M.updateRows(t, MI2, [{ id: "2", status: "dropped", note: "merged" } as never], { decision: "U4" }))
    await set(MI2, "3", { deps: ["1:C"] }, "U5")
    const lines = driftLine(await getText(MI2))
    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith("  drift: 1 row added after approval (5 by U2); dropped: 2 by U4")).toBe(true)
    expect(lines[0].endsWith("; changed: 3 by U5 (deps)")).toBe(true)
    expect(lines[0]).not.toContain("1:C")

    expect(tool("studio_mission_get").description).toBe(GET_DESCRIPTION)
  })

  test("guide 5/6 names row changes", () => {
    expect(MISSION_LIFECYCLE.length).toBe(6)
    expect(MISSION_LIFECYCLE[4] as string).toBe(GUIDE_5)
  })
})
