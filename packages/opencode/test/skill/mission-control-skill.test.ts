// Row 189 (decision L47): the built-in skill mission-control. It ships in the binary on every platform, needs no
// ~/.claude, cannot be shadowed by a disk copy, names only real Studio tools, and every JSON example in it is valid
// for the mission schema the store checks (datum-studio sources are imported read-only).
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import path from "node:path"
import { Skill } from "../../src/skill"
import { ConfigMarkdown } from "../../src/config/markdown"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

const TEXT = Skill.MISSION_CONTROL_SKILL_CONTENT
const flat = TEXT.replace(/\s+/g, " ")

// Read-only imports from datum-studio. Non-literal specifiers keep the opencode typecheck out of that package.
const STUDIO = path.join(import.meta.dir, "../../../datum-studio/src")
type S = Record<string, any>
async function studio() {
  const at = (rel: string) => path.join(STUDIO, rel)
  const validate: S = await import(at("store/mission/validate.ts"))
  const schemas: S = await import(at("mcp-host/mission/schemas.ts"))
  const guide: S = await import(at("mcp-host/mission/mission-guide.ts"))
  return { validate, schemas, guide }
}

/** Every JSON value in the ```json blocks: a block is one value, or one value per line. */
function jsonExamples(): unknown[] {
  const out: unknown[] = []
  for (const [, body] of TEXT.matchAll(/```json\n([\s\S]*?)```/g)) {
    try {
      out.push(JSON.parse(body))
    } catch {
      for (const line of body.split("\n").filter((l) => l.trim())) out.push(JSON.parse(line))
    }
  }
  return out
}

/**
 * 1.3.3 row 14 (MC-3): every example is a json block under a heading that is the prefixed tool name (the `tool {json}`
 * line form is gone). One entry per value in the block, in document order; `section` is the nearest `## ` heading.
 */
const PREFIX = "datum-studio_"
function inlineExamples(): Array<{ tool: string; args: S; section: string }> {
  const out: Array<{ tool: string; args: S; section: string }> = []
  const lines = TEXT.split("\n")
  let heading = ""
  let section = ""
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith("## ")) section = line.slice(3)
    if (line.startsWith("#")) heading = line.replace(/^#+\s*/, "")
    if (line !== "```json") continue
    const end = lines.indexOf("```", i + 1)
    const body = lines.slice(i + 1, end).join("\n")
    let values: S[]
    try {
      values = [JSON.parse(body)]
    } catch {
      values = body.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    }
    expect(heading.startsWith(`${PREFIX}studio_`) ? "" : `block without a tool heading: ${heading}`).toBe("")
    for (const args of values) out.push({ tool: heading.slice(PREFIX.length), args, section })
    i = end
  }
  return out
}

/**
 * The create example sends partial rows. The server fills the rest (row 16, register 1.1): the test runs the real
 * normaliser (`fillMissionDefaults`, the one the tool wrapper calls) on a copy, so the example is proven valid against
 * the shipped defaults and not against values of this test.
 */
async function withRowDefaults(mission: S, _type?: S): Promise<S> {
  const at = (rel: string) => path.join(STUDIO, rel)
  const defaults: S = await import(at("mcp-host/mission/row-defaults.ts"))
  const types: S = await import(at("store/mission/builtin-types.ts"))
  const copy: S = structuredClone(mission)
  defaults.fillMissionDefaults(
    "studio_mission_create",
    { mission: copy },
    { type: (id: string) => types.BUILTIN_MISSION_TYPES.find((t: S) => t.id === id) ?? null, typeOfMission: () => null },
  )
  return copy
}

/** Top-level argument check: no unknown key (additionalProperties false), every required key present. */
function topLevel(schema: S, args: S) {
  const unknown = Object.keys(args).filter((k) => !(k in schema.properties))
  const missing = ((schema.required as string[] | undefined) ?? []).filter((k) => !(k in args))
  return { unknown, missing }
}

describe("mission-control built-in skill", () => {
  it.live("is discovered as a built-in and loads by name without any ~/.claude", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const skill = yield* Skill.Service
        const listed = (yield* skill.available()).find((s) => s.name === Skill.MISSION_CONTROL_SKILL_NAME)
        expect(listed?.location).toBe("<built-in>")
        expect(listed?.description).toBe(Skill.MISSION_CONTROL_SKILL_DESCRIPTION)
        const got = yield* skill.require("mission-control")
        expect(got.content).toBe(TEXT)
      }),
    ),
  )

  it.live("a disk copy with the same name never shadows it", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          for (const where of [".swarm/skill", ".claude/skills", ".agents/skills"])
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, where, "mission-control", "SKILL.md"),
                "---\nname: mission-control\ndescription: Imitation.\n---\n\n# Imitation body\n",
              ),
            )
          const skill = yield* Skill.Service
          const all = (yield* skill.all()).filter((s) => s.name === "mission-control")
          expect(all).toHaveLength(1)
          expect(all[0].location).toBe("<built-in>")
          expect(all[0].content).not.toContain("Imitation body")
        }),
      { git: true },
    ),
  )

  test("the text passes the built-in guards and stays concise", () => {
    // 1.3.3 row 14: register section 9 cap (was 120 lines)
    expect(TEXT.replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(180)
    expect(Buffer.byteLength(TEXT)).toBeLessThanOrEqual(24_000)
    expect(TEXT.includes("!`")).toBe(false)
    expect(/\$(?:\d|ARGUMENTS)/.test(TEXT)).toBe(false)
    expect(ConfigMarkdown.files(TEXT)).toHaveLength(0)
    expect(TEXT.startsWith("---")).toBe(false)
    expect(TEXT).not.toMatch(/alugra|iris|gsp-budi|\/Users\/|ses_[0-9a-f]|100\.102\./i)
  })

  test("every studio tool it names exists, and the lifecycle tools are all named", async () => {
    const { schemas } = await studio()
    const known = new Set<string>([...schemas.MISSION_TOOL_NAMES, ...Object.keys(schemas.REPORT_EXTRA_PROPERTIES)])
    // 1.2.7 row 28 (U-6, INTENT): the close step names studio_file_verify (downloadDir docs/<mission>/11_deliverables);
    // it is a vendor Studio tool, checked by name in the vendor tool table.
    const vendorTools = await Bun.file(path.join(STUDIO, "..", "vendor", "scripts", "studio", "mcp", "tools.ts")).text()
    expect(vendorTools).toContain('"studio_file_verify"')
    known.add("studio_file_verify")
    // 1.3.3 row 14: callable names carry the server prefix; the other tools the skill names are vendored or host tools.
    const table: S = await import(path.join(STUDIO, "mcp-host/tool-table.ts"))
    for (const t of table.HOST_KEPT_TOOLS) known.add(t)
    // 1.3.3 row 100 landed: the library tool's name comes from the host module that registers it (no temporary allowance).
    const library: S = await import(path.join(STUDIO, "mcp-host/library-read.ts"))
    known.add(library.LIBRARY_READ_TOOL)
    const body = TEXT.replaceAll(`${PREFIX}studio_mission_*`, "")
    const found = [...body.matchAll(/(datum-studio_)?(studio_[a-z_]*[a-z])\b/g)]
    for (const m of found) expect(m[1] ? "prefixed" : `no server prefix on ${m[2]}`).toBe("prefixed")
    const named = new Set(found.map((m) => m[2]!))
    for (const name of named) expect(known.has(name) ? name : `unknown tool ${name}`).toBe(name)
    for (const name of [
      "studio_mission_create",
      "studio_mission_request_decision",
      "studio_mission_record_decision",
      "studio_mission_approve",
      "studio_mission_set_status",
      "studio_mission_update_row",
      "studio_mission_get",
      "studio_mission_answer_decision",
      "studio_report_check",
      "studio_report_submit",
    ])
      expect(named.has(name) ? name : `missing ${name}`).toBe(name)
    expect(TEXT).toContain("studio://skema/mission")
  })

  test("the create example is a valid MissionDoc once the host fills project.dir, and passes the tool's top level", async () => {
    const { validate, schemas, guide } = await studio()
    const [create] = jsonExamples() as S[]
    expect(create.dryRun).toBe(true)
    expect(topLevel(schemas.MISSION_TOOL_SCHEMAS.studio_mission_create, create)).toEqual({ unknown: [], missing: [] })
    // Swarm fills project.dir and the session link: the example carries neither.
    expect(create.mission.project).toBeUndefined()
    expect(create.mission.sessions).toBeUndefined()
    expect(create.session).toBeUndefined()
    const type = guide.missionGuideFacts().types.find((t: S) => t.id === create.mission.type)
    const doc: S = { $schema: "studio.mission/v1", typeVersion: 1, status: "draft", ...(await withRowDefaults(create.mission, type)), project: { dir: "/abs/project" } }
    expect(validate.checkMissionSchema("MissionDoc", doc)).toEqual([])
    // Kinds belong to their phase in the mission type (the store's own table, via the guide facts).
    for (const row of doc.rows) {
      const phase = type.phases.find((p: S) => p.id === row.phase)
      expect(phase?.kinds ?? []).toContain(row.kind)
    }
    // 1.3.3 row 14: the example is the short form: title only on row 1, which the server defaults.
    expect(create.mission.rows[0]).toEqual({ title: "Write the spec" })
  })

  // SW-13 (row 192, spec 191 §3.1), moved to the 1.3.3 form: the example names only Swarm agents, each in the shipped tier
  // table the skill prints, the table keeps researcher on the session model, and other workflows' role names are accepted.
  // INTENT NO LONGER COVERED: `owner` "swarm-workflow" and the per-row reason "Swarm tier map: coder runs on worker" are no
  // longer in the example (the owner is a server default of row 16; the reason is no longer printed).
  test("SW-13 the create example uses Swarm agents from the printed tier table; role names of other workflows are accepted", async () => {
    const { validate, guide } = await studio()
    const [create] = jsonExamples() as S[]
    const tiers: Record<string, string> = { planner: "thinker", verifier: "thinker", coder: "worker", "document-writer": "worker", "data-collector": "worker-fast", explore: "worker-fast", researcher: "inherit" }
    const sent = create.mission.rows.map((row: S) => row.agent).filter(Boolean)
    expect(sent).toEqual(["coder", "verifier"])
    const type = guide.missionGuideFacts().types.find((t: S) => t.id === create.mission.type)
    const rows = (await withRowDefaults(create.mission, type)).rows
    for (const row of rows) {
      const agent = row.agent as string
      // A row that sends no agent gets the server default (row 16: "general", model inherit); every agent the example sends is in the table.
      if (agent === "general") {
        expect(row.model).toEqual({ tier: "inherit" })
        continue
      }
      expect(tiers[agent] ? "" : `agent ${agent} is not in the tier table`).toBe("")
      const tier = tiers[agent]!
      const model = tier === "thinker" ? { tier } : { tier, reason: "tier map" }
      expect(validate.checkMissionSchema("Row", { ...row, model })).toEqual([])
    }
    expect(TEXT).toContain("| planner, verifier | thinker |")
    expect(TEXT).toContain("| coder, document-writer | worker |")
    expect(TEXT).toContain("| data-collector, explore | worker-fast |")
    expect(TEXT).not.toMatch(/master-controller|task-architect|coder-execution|test-expert/)
    expect(TEXT).toContain("after swarm-workflow's plan")
    expect(flat).toContain("Role names from other workflows are accepted and run as their Swarm agent.")
  })

  // O4 (spec 191 §8): a researcher row runs on the session model: tier inherit with a reason is accepted. Finding: the
  // schema requires a reason only for worker/worker-fast ($defs/Model if/then), so inherit without one also validates;
  // the skill text asks for the reason anyway.
  test("O4 a researcher row with tier inherit and a reason validates (the reason is optional for inherit)", async () => {
    const { validate } = await studio()
    const [create] = jsonExamples() as S[]
    const researcher = {
      id: "4", phase: "identification", kind: "spec", title: "Read the public sources", agent: "researcher",
      model: { tier: "inherit", reason: "runs on the session model" }, deps: [], size: "S", status: "pending",
      output: "research/01_web.md", verification: "sources cited",
    }
    expect(validate.checkMissionSchema("Row", researcher)).toEqual([])
    const { guide } = await studio()
    const type = guide.missionGuideFacts().types.find((t: S) => t.id === create.mission.type)
    const filled = await withRowDefaults(create.mission, type)
    const doc = { $schema: "studio.mission/v1", typeVersion: 1, status: "draft", ...filled, project: { dir: "/abs/project" }, rows: [...filled.rows, researcher] }
    expect(validate.checkMissionSchema("MissionDoc", doc)).toEqual([])
    expect(validate.checkMissionSchema("Row", { ...researcher, model: { tier: "inherit" } })).toEqual([])
    // A worker row without its reason is refused (the rule the skill's "a row below thinker gives a reason" follows).
    expect(validate.checkMissionSchema("Row", { ...researcher, agent: "coder", model: { tier: "worker" } }).length).toBeGreaterThan(0)
    expect(TEXT).toContain('| researcher | inherit, reason "runs on the session model" |')
  })

  // 1.2.6 row 100 (G-03, INTENT): every call after create is a one-line `tool {json}` example, autonomous sits at the top
  // level (MC-02), and the row examples include the checkpoint/messages and the per-patch decision (MC-03) shapes.
  test("the decision request, autonomous decision and row patch examples validate", async () => {
    const { validate, schemas } = await studio()
    const inline = inlineExamples()
    const examples = inline.map((i) => i.args)
    const request = inline.find((i) => i.tool === "studio_mission_request_decision")!.args
    expect(topLevel(schemas.MISSION_TOOL_SCHEMAS.studio_mission_request_decision, request)).toEqual({ unknown: [], missing: [] })
    expect(() => validate.assertDecisionRequest(request.request)).not.toThrow()

    const decision = inline.find((i) => i.tool === "studio_mission_record_decision" && i.args.autonomous === true)!.args
    expect(topLevel(schemas.MISSION_TOOL_SCHEMAS.studio_mission_record_decision, decision)).toEqual({ unknown: [], missing: [] })
    expect(decision.decision).toMatchObject({ by: "controller" })
    expect(validate.checkMissionSchema("Decision", { ...decision.decision, autonomous: true })).toEqual([])

    const rowSchema = schemas.MISSION_TOOL_SCHEMAS.studio_mission_update_row
    const patchSchema = rowSchema.properties.rows.items
    const updates = inline.filter((i) => i.tool === "studio_mission_update_row").map((i) => i.args)
    expect(updates.length).toBeGreaterThanOrEqual(6)
    for (const u of updates) {
      expect(topLevel(rowSchema, u)).toEqual({ unknown: [], missing: [] })
      for (const p of u.rows) {
        expect(topLevel(patchSchema, p)).toEqual({ unknown: [], missing: [] })
        if (p.status) expect(patchSchema.properties.status.enum).toContain(p.status)
        if (p.status === "blocked" || p.status === "dropped" || p.status === "done" || p.retire) expect(typeof p.note).toBe("string")
        if (p.add) expect(validate.checkMissionSchema("Row", p.add)).toEqual([])
      }
    }
    // 1.3.3 row 14: the close example of step 6 adds a second done (the retire call carries no status).
    expect(updates.flatMap((u) => u.rows.map((p: S) => p.status)).filter(Boolean)).toEqual(["running", "done", "blocked", "dropped", "done"])
    expect(inline.filter((i) => i.tool !== "studio_mission_create").some((i) => i.args.dryRun)).toBe(false)
    expect(examples.length).toBeGreaterThan(0)
  })

  test("the inline examples name valid arguments", async () => {
    const { schemas } = await studio()
    const inline = inlineExamples()
    expect(inline.map((i) => i.tool)).toEqual(
      // INTENT NO LONGER COVERED: studio_mission_get had a one-line example; it is prose now (arguments: mission, include).
      expect.arrayContaining(["studio_mission_approve", "studio_mission_set_status"]),
    )
    for (const { tool, args } of inline) {
      expect(topLevel(schemas.MISSION_TOOL_SCHEMAS[tool], args)).toEqual({ unknown: [], missing: [] })
      if (tool === "studio_mission_set_status") expect(["running", "paused", "done"]).toContain(args.to)
      if (tool === "studio_mission_approve") expect(args.decision).toMatch(/^[UC][1-9][0-9]{0,3}$/)
    }
  })

  test("it explains each refusal code with the next step", () => {
    for (const code of [
      "SCHEMA_INVALID",
      "MISSION_NOT_APPROVED",
      "APPROVAL_NEEDS_USER_DECISION",
      "OUTPUT_UNVERIFIED",
      "DELIVERABLE_NOT_RETIRABLE",
    ])
      expect(flat).toMatch(new RegExp(`- ${code}: [^\\n]{40,}`))
  })

  test("it keeps the approval honest: the person answers, autonomy is marked", () => {
    expect(flat).toContain("Never call datum-studio_studio_mission_answer_decision: it is the person's answer, given in Mission Control, never yours.")
    // Row 197 (S194-01): the condition is Swarm's setting, not what anyone said; the host refusal is named.
    expect(flat).toContain("only when Swarm's autonomous mode setting (the person turns it on) is on for this session")
    expect(flat).not.toContain("the person said this session runs autonomously")
    expect(flat).toMatch(/- AUTONOMOUS_MODE_OFF: [^\n]{40,}/)
    expect(flat).toContain("Ask the person in Mission Control with datum-studio_studio_mission_request_decision and wait.")
    // 1.2.6 row 100 (MC-02, INTENT): autonomous is shown at the top level of record_decision.
    expect(flat).toContain('"by":"controller","date":"2026-11-08","text":"Self-approved (autonomous): plan of 3 rows."},"autonomous":true}')
    expect(flat).toContain("Leave out project.dir and session: Swarm fills both from your session. Never invent a session id.")
  })

  // Row 182 duties, moved here from auto_workflow by row 189.
  test("it carries the row and Studio duties", () => {
    for (const duty of [
      "one row per plan step",
      // 1.2.6 row 100 (S-02, INTENT): a subagent's update_row asks the person, so the controller writes the row.
      "the controller writes row status and messages from the agent's returned report",
      "Make documents in Studio",
      "A row is done only when its Studio verification gate passes",
      "the done note names the check that was run and its existing result file",
      "Never drop a row to get past a gate",
      "A draft the row no longer delivers is retired",
    ])
      expect(flat).toContain(duty)
  })

  // L48: the session that finished a job outside a draft mission.
  test("it forbids work outside an unapproved mission and requires an honest close", () => {
    for (const rule of [
      "once a mission exists, the work happens inside it",
      "Do not start any step's work while the mission is draft or unapproved",
      "If approval is refused or cannot be obtained, stop and tell the person",
      "never finish the job outside the mission",
      "every row is done, or dropped with a note, matching the work actually done",
    ])
      expect(flat).toContain(rule)
  })
})
