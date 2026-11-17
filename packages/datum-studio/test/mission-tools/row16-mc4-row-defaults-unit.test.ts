// 1.3.3 row 16 (MC-4 item 1, register 1.1): the server-side defaults normaliser, as a pure function.
// It fills only what the caller left out, never overwrites a value that was sent, and returns what it filled.
import { describe, expect, test } from "bun:test"
import { BUILTIN_MISSION_TYPES } from "../../src/store/mission/builtin-types.ts"
import { checkMissionSchema } from "../../src/store/mission/validate.ts"
import { AGENT_DEFAULT, AGENT_TIERS, defaultsSentence, fillMissionDefaults, modelForAgent, OUTPUT_DEFAULT, OWNER_DEFAULT, VERIFICATION_DEFAULT, type MissionTypeLookup } from "../../src/mcp-host/mission/row-defaults.ts"

type S = Record<string, any>
const FEATURE = BUILTIN_MISSION_TYPES.find((t) => t.id === "feature-release")!
const FIRST = [...FEATURE.phases].sort((a, b) => a.order - b.order)[0]
const lookup: MissionTypeLookup = {
  type: (id) => BUILTIN_MISSION_TYPES.find((t) => t.id === id) ?? null,
  typeOfMission: (id) => (id === "2026-11-17_known" ? FEATURE : null),
}
const create = (mission: S) => {
  const args = { mission }
  return { args, filled: fillMissionDefaults("studio_mission_create", args, lookup) }
}

describe("row 16: create from id, title, type and step titles", () => {
  test("the four-field mission becomes a schema-valid MissionDoc; every default equals the register", () => {
    const { args, filled } = create({ id: "2026-11-17_small", title: "Small", type: "feature-release", rows: [{ title: "One" }, { title: "Two" }] })
    const m = args.mission as S
    expect(m.owner).toBe(OWNER_DEFAULT)
    expect(m.rows).toEqual(
      ["One", "Two"].map((title, i) => ({
        title,
        id: String(i + 1),
        phase: FIRST.id,
        kind: FIRST.kinds[0],
        agent: AGENT_DEFAULT,
        model: { tier: "inherit" },
        deps: [],
        size: "S",
        status: "pending",
        output: OUTPUT_DEFAULT,
        verification: VERIFICATION_DEFAULT,
      })),
    )
    // What the store checks (it adds $schema, typeVersion and status itself; the host adds project.dir).
    expect(checkMissionSchema("MissionDoc", { $schema: "studio.mission/v1", typeVersion: 1, status: "draft", project: { dir: "/tmp/p" }, ...m })).toEqual([])
    expect(filled.mission).toEqual(["owner"])
    expect(filled.rows).toEqual(["1", "2"].map((row) => ({ row, fields: ["id", "phase", "kind", "agent", "model", "deps", "size", "status", "output", "verification"] })))
  })

  test("the fixed values are schema-valid on their own and the default output is not a file path", () => {
    expect(OWNER_DEFAULT).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    expect(AGENT_DEFAULT).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    for (const text of [OUTPUT_DEFAULT, VERIFICATION_DEFAULT]) {
      expect(text.length).toBeGreaterThan(0)
      expect(text.length).toBeLessThanOrEqual(4000)
      expect(text).not.toMatch(/[\u0000-\u001f]/)
    }
    expect(OUTPUT_DEFAULT).not.toMatch(/[/\\]|\.(md|docx|pdf|html|xlsx|pptx|txt)\b/i)
  })
})

describe("row 16: model.tier from the agent", () => {
  test("the shipped Swarm tier map; a tier below thinker carries its reason; an unmapped agent inherits", () => {
    expect(Object.fromEntries(Object.entries(AGENT_TIERS).map(([a, m]) => [a, m.tier]))).toEqual({
      planner: "thinker",
      verifier: "thinker",
      coder: "worker",
      "document-writer": "worker",
      "data-collector": "worker-fast",
      explore: "worker-fast",
      researcher: "inherit",
    })
    expect(modelForAgent("coder")).toEqual({ tier: "worker", reason: "Swarm tier map: coder runs on worker" })
    expect(modelForAgent("explore")).toEqual({ tier: "worker-fast", reason: "Swarm tier map: explore runs on worker-fast" })
    expect(modelForAgent("researcher")).toEqual({ tier: "inherit", reason: "runs on the session model" })
    expect(modelForAgent("verifier")).toEqual({ tier: "thinker" })
    expect(modelForAgent("coder-execution")).toEqual({ tier: "inherit" })
    expect(modelForAgent(AGENT_DEFAULT)).toEqual({ tier: "inherit" })
    for (const agent of [...Object.keys(AGENT_TIERS), "anything-else"]) expect(checkMissionSchema("Row", { id: "1", phase: FIRST.id, kind: FIRST.kinds[0], title: "t", agent, model: modelForAgent(agent), deps: [], size: "S", status: "pending", output: "o", verification: "v" })).toEqual([])
  })

  test("a row with an agent and no model gets that agent's tier; the returned object is a copy", () => {
    const { args } = create({ id: "2026-11-17_tier", title: "T", type: "feature-release", rows: [{ title: "a", agent: "coder" }, { title: "b", agent: "coder" }] })
    const rows = (args.mission as S).rows
    expect(rows[0].model).toEqual({ tier: "worker", reason: "Swarm tier map: coder runs on worker" })
    expect(rows[0].model).not.toBe(rows[1].model)
    expect(rows[0].deps).not.toBe(rows[1].deps)
  })
})

describe("row 16: explicit values are never overwritten", () => {
  test("a full row and an owner pass through unchanged and nothing is reported", () => {
    const row = { id: "7", phase: "verification", kind: "test", title: "Full", agent: "verifier", model: { tier: "worker", reason: "mechanical run" }, deps: ["3:B"], size: "M", status: "dropped", note: "n", output: "07_test/r.md", verification: "suite green", review: "none" }
    const { args, filled } = create({ id: "2026-11-17_full", title: "F", type: "feature-release", owner: "master-controller", rows: [structuredClone(row)] })
    expect((args.mission as S).owner).toBe("master-controller")
    expect((args.mission as S).rows[0]).toEqual(row)
    expect(filled).toEqual({ mission: [], rows: [] })
    expect(defaultsSentence(filled)).toBeUndefined()
  })

  test("wrong explicit values are left for the schema check: null, a wrong type, a model without the reason its tier needs", () => {
    const { args, filled } = create({ id: "2026-11-17_bad", title: "B", type: "feature-release", owner: null, rows: [{ title: "x", size: null, deps: "1", agent: 5, model: { tier: "worker" }, status: "done", output: "" }] })
    const r = (args.mission as S).rows[0]
    expect((args.mission as S).owner).toBeNull()
    expect(r).toMatchObject({ size: null, deps: "1", agent: 5, model: { tier: "worker" }, status: "done", output: "" })
    expect(filled.mission).toEqual([])
    expect(filled.rows).toEqual([{ row: "1", fields: ["id", "phase", "kind", "verification"] }])
  })

  test("phase and kind: a sent phase gets its own first kind; a sent kind gets the first phase that allows it", () => {
    const { args } = create({ id: "2026-11-17_pk", title: "P", type: "feature-release", rows: [{ title: "a", phase: "verification" }, { title: "b", kind: "test" }, { title: "c", phase: "nope" }, { title: "d", kind: "nope" }] })
    const rows = (args.mission as S).rows
    const verification = FEATURE.phases.find((p) => p.id === "verification")!
    expect(rows[0]).toMatchObject({ phase: "verification", kind: verification.kinds[0] })
    const firstWithTest = [...FEATURE.phases].sort((a, b) => a.order - b.order).find((p) => p.kinds.includes("test" as never))!
    expect(rows[1]).toMatchObject({ phase: firstWithTest.id, kind: "test" })
    expect(rows[2].phase).toBe("nope")
    expect("kind" in rows[2]).toBe(false) // unknown phase: no kind is guessed
    expect(rows[3]).toMatchObject({ phase: FIRST.id, kind: "nope" }) // unknown kind: the store names it
  })

  test("an unknown mission type fills everything except phase and kind", () => {
    const { args, filled } = create({ id: "2026-11-17_type", title: "T", type: "no-such-type", rows: [{ title: "a" }] })
    const r = (args.mission as S).rows[0]
    expect("phase" in r).toBe(false)
    expect("kind" in r).toBe(false)
    expect(filled.rows[0].fields).toEqual(["id", "agent", "model", "deps", "size", "status", "output", "verification"])
  })

  test("row ids follow the list position; a sent id is kept", () => {
    const { args } = create({ id: "2026-11-17_ids", title: "I", type: "feature-release", rows: [{ title: "a" }, { title: "b", id: "2a" }, { title: "c" }] })
    expect((args.mission as S).rows.map((r: S) => r.id)).toEqual(["1", "2a", "3"])
  })

  test("input that is not the expected shape is left alone", () => {
    for (const mission of [undefined, null, "text", [], { rows: "x" }, { rows: [1, null, "a", []] }]) {
      const args = { mission } as S
      const before = structuredClone(args)
      const filled = fillMissionDefaults("studio_mission_create", args, lookup)
      const m = args.mission
      if (m && typeof m === "object" && !Array.isArray(m)) expect(m).toEqual({ ...before.mission, owner: OWNER_DEFAULT })
      else expect(args).toEqual(before)
      expect(filled.rows).toEqual([])
    }
    expect(fillMissionDefaults("studio_mission_get", { mission: { rows: [{ title: "a" }] } }, lookup)).toEqual({ mission: [], rows: [] })
  })
})

describe("row 16: a row added later (studio_mission_update_row add)", () => {
  test("add gets the same defaults, its id from the patch, phase and kind from the mission's type", () => {
    const args: S = { mission: "2026-11-17_known", rows: [{ id: "4", add: { title: "Check the docs", agent: "verifier" } }, { id: "2", status: "running" }, { id: "5", add: { id: "5", title: "x", phase: "verification", kind: "test", agent: "verifier", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: "o", verification: "v" } }] }
    const filled = fillMissionDefaults("studio_mission_update_row", args, lookup)
    expect(args.rows[0].add).toEqual({ title: "Check the docs", agent: "verifier", id: "4", phase: FIRST.id, kind: FIRST.kinds[0], model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: OUTPUT_DEFAULT, verification: VERIFICATION_DEFAULT })
    expect(checkMissionSchema("Row", args.rows[0].add)).toEqual([])
    expect(args.rows[1]).toEqual({ id: "2", status: "running" })
    expect(filled).toEqual({ mission: [], rows: [{ row: "4", fields: ["id", "phase", "kind", "model", "deps", "size", "status", "output", "verification"] }] })
  })

  test("an unknown mission: no phase or kind; a differing add.id is kept for the store to refuse", () => {
    const args: S = { mission: "2026-11-17_unknown", rows: [{ id: "4", add: { id: "9", title: "x" } }] }
    fillMissionDefaults("studio_mission_update_row", args, lookup)
    expect(args.rows[0].add.id).toBe("9")
    expect("phase" in args.rows[0].add).toBe(false)
  })
})

describe("row 16: the reply sentence", () => {
  test("one line naming the fields and the fixed values; rows with the same fields are grouped", () => {
    const { filled } = create({ id: "2026-11-17_say", title: "S", type: "feature-release", rows: [{ title: "a" }, { title: "b", agent: "coder" }, { title: "c" }] })
    const text = defaultsSentence(filled)!
    expect(text).not.toContain("\n")
    expect(text).toBe(
      `defaults filled (a value you send is never replaced): mission owner "${OWNER_DEFAULT}"; rows 1, 3: id, phase, kind, agent "${AGENT_DEFAULT}", model, deps, size, status, output, verification; row 2: id, phase, kind, model, deps, size, status, output, verification.`,
    )
  })

  test("many rows stay one short line", () => {
    const { filled } = create({ id: "2026-11-17_many", title: "M", type: "feature-release", rows: Array.from({ length: 200 }, (_, i) => ({ title: `r${i}` })) })
    const text = defaultsSentence(filled)!
    expect(text).toContain("rows 1-200:")
    expect(text.length).toBeLessThan(300)
  })
})
