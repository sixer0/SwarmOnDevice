// 1.3.3 row 13 (MC-3, SK-3): content test of the rewritten built-in skill mission-control.
// - No bundled skill writes a call as `studio_x {…}` (the text form the model copied into its answers).
// - Every Studio tool the skill names carries the server prefix and exists in the host's registered tool lists.
// - The skill opens with two tables: the legal status moves (equal to the store's own tables) and the row fields.
// - Every example is an argument block under a heading that is the tool name; its top level fits the tool schema.
// datum-studio sources are imported read-only; non-literal specifiers keep the opencode typecheck out of that package.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { toolName } from "../../src/mcp/catalog"
import { DATUM_STUDIO_MCP } from "../../src/mcp/datum-studio"

type S = Record<string, any>
const SKILLS = path.join(import.meta.dir, "../../src/skill")
const STUDIO = path.join(import.meta.dir, "../../../datum-studio/src")
const load = (rel: string): Promise<S> => import(path.join(STUDIO, rel))

const TEXT = readFileSync(path.join(SKILLS, "mission-control.md"), "utf8")
const flat = TEXT.replace(/\s+/g, " ")
const PREFIX = toolName(DATUM_STUDIO_MCP, "")

/**
 * Tools the 1.3.3 register (masterplan/03_register.md section 8) defines and another row registers. A name here is
 * accepted only until it is in the host lists; remove the entry when its row lands (studio_library_read: row 100).
 */
const REGISTER_PENDING = ["studio_library_read"]

/** The host's registered Studio tools: kept vendored tools, mission tools, template tools, the asset tool. */
async function registered(): Promise<Set<string>> {
  const table = await load("mcp-host/tool-table.ts")
  const mission = await load("mcp-host/mission/schemas.ts")
  const templates = await load("mcp-host/templates/schemas.ts")
  const asset = await load("mcp-host/asset-tool.ts")
  return new Set<string>([...table.HOST_KEPT_TOOLS, ...mission.MISSION_TOOL_NAMES, ...templates.TEMPLATE_TOOL_NAMES, asset.ASSET_TOOL_NAME])
}

/** Studio tool names in the text, with whether each occurrence carries the prefix. The `_*` family wildcard is no tool. */
function namedTools(text: string): Array<{ name: string; prefixed: boolean }> {
  const body = text.replaceAll(`${PREFIX}studio_mission_*`, "")
  return [...body.matchAll(/(datum-studio_)?(studio_[a-z_]*[a-z])\b/g)].map((m) => ({ name: m[2]!, prefixed: m[1] !== undefined }))
}

/** Every ```json block with the nearest heading above it; a block is one value, or one value per line. */
function examples(): Array<{ heading: string; values: S[] }> {
  const out: Array<{ heading: string; values: S[] }> = []
  let heading = ""
  const lines = TEXT.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
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
    out.push({ heading, values })
    i = end
  }
  return out
}

/** The cells of the first table after a `## ` heading that starts with `title`. */
function table(title: string): string[][] {
  const lines = TEXT.split("\n")
  const start = lines.findIndex((l) => l.startsWith(`## ${title}`))
  expect(start).toBeGreaterThanOrEqual(0)
  const first = lines.findIndex((l, i) => i > start && l.startsWith("|"))
  const rows: string[][] = []
  for (let i = first; i < lines.length && lines[i]!.startsWith("|"); i++) rows.push(lines[i]!.split("|").slice(1, -1).map((c) => c.trim()))
  return rows
}

describe("row 13 MC-3: no call written as text in the bundled skills", () => {
  test("grep `studio_\\w+ \\{` over every bundled skill finds 0 matches", () => {
    const files = readdirSync(SKILLS).filter((f) => f.endsWith(".md"))
    expect(files).toContain("mission-control.md")
    expect(files.length).toBeGreaterThanOrEqual(8)
    const hits = files.flatMap((f) => [...readFileSync(path.join(SKILLS, f), "utf8").matchAll(/studio_\w+ \{/g)].map((m) => `${f}: ${m[0]}`))
    expect(hits).toEqual([])
  })

  test("mission-control has no `tool {arguments}` sentence and no `name {json}` example of any tool", () => {
    expect(flat).not.toMatch(/Each call is written|tool \{arguments\}/)
    expect([...TEXT.matchAll(/\b[a-z][a-z0-9_-]* \{\s*"?[a-z]+"?:/g)].map((m) => m[0])).toEqual([])
    expect(flat).toContain("Calls are made through the tools, never written in the answer.")
  })
})

describe("row 13 MC-3: tool names are the callable names", () => {
  test("the prefix is the one Swarm composes for the built-in Studio server", () => {
    expect(PREFIX).toBe("datum-studio_")
    expect(toolName(DATUM_STUDIO_MCP, "studio_mission_create")).toBe("datum-studio_studio_mission_create")
  })

  test("every Studio tool the skill names carries the prefix and is registered", async () => {
    const known = await registered()
    const named = namedTools(TEXT)
    expect(named.length).toBeGreaterThanOrEqual(30)
    expect(named.filter((n) => !n.prefixed).map((n) => n.name)).toEqual([])
    const unknown = [...new Set(named.map((n) => n.name))].filter((n) => !known.has(n) && !REGISTER_PENDING.includes(n))
    expect(unknown).toEqual([])
    // The pending list never hides a registered name and never grows past the register.
    expect(REGISTER_PENDING.filter((n) => !named.some((x) => x.name === n))).toEqual([])
    for (const tool of ["create", "get", "approve", "set_status", "update_row", "record_decision", "record_finding", "request_decision", "answer_decision", "export"])
      expect(TEXT).toContain(`datum-studio_studio_mission_${tool}`)
    for (const tool of ["studio_render", "studio_file_verify", "studio_report_template", "studio_report_check", "studio_report_submit"]) expect(TEXT).toContain(`datum-studio_${tool}`)
  })
})

describe("row 13 MC-3: the two opening tables", () => {
  test("both tables come before the first rule and the first step", () => {
    const moves = TEXT.indexOf("\n## Status moves")
    const fields = TEXT.indexOf("\n## Row fields")
    expect(moves).toBeGreaterThan(0)
    expect(fields).toBeGreaterThan(moves)
    expect(fields).toBeLessThan(TEXT.indexOf("\n## Rules"))
    expect(TEXT.indexOf("\n## Rules")).toBeLessThan(TEXT.indexOf("\n## 1. "))
    // Nothing but the title and one paragraph stands before the first table.
    expect(TEXT.slice(0, moves).split("\n").filter((l) => l.trim()).length).toBe(2)
  })

  test("the status table equals the store's transition tables, mission and row", async () => {
    const store = await load("store/mission/mission-store.ts")
    const rows = table("Status moves").slice(2)
    const targets = (cell: string) => (cell === "nothing" ? [] : cell.split(",").map((s) => s.trim()))
    const got: Record<string, Record<string, string[]>> = { mission: {}, row: {} }
    for (const [from, to] of rows) {
      const [kind, ...statuses] = from!.split(" ")
      for (const status of statuses.join(" ").split(",").map((s) => s.trim())) got[kind!]![status] = targets(to!)
    }
    expect(got.mission).toEqual(Object.fromEntries(Object.entries(store.MISSION_TRANSITIONS).map(([k, v]) => [k, [...(v as string[])]])))
    expect(got.row).toEqual(Object.fromEntries(Object.entries(store.ROW_TRANSITIONS).map(([k, v]) => [k, [...(v as string[])]])))
    expect(flat).toContain(store.ROW_RUNNING_DONE_RULE)
  })

  test("the field table has required, default and limits columns and a line for every row field an agent sends", async () => {
    const { MISSION_SCHEMA } = await load("store/mission/schema.ts").then((m) => ({ MISSION_SCHEMA: Object.values(m).find((v: any) => v?.$defs?.Row) as S }))
    const rows = table("Row fields")
    expect(rows[0]).toEqual(["Field", "Must you send it", "Default when left out", "Limits"])
    const listed = new Set(rows.slice(2).flatMap((r) => r[0]!.split(",").map((s) => s.trim())))
    for (const field of MISSION_SCHEMA.$defs.Row.required as string[]) expect(listed.has(field) ? field : `missing ${field}`).toBe(field)
    for (const field of ["size", "note", "review", "resources", "knowledgeReason", "deliverables", "knowledge", "awaitingHumanCheck"])
      expect(listed.has(field) ? field : `missing ${field}`).toBe(field)
    for (const r of rows.slice(2)) expect(r.every((c) => c.length > 0) ? r[0] : `empty cell in ${r[0]}`).toBe(r[0])
    // Limits quoted from the schema the store checks.
    expect(MISSION_SCHEMA.$defs.Row.properties.deps.maxItems).toBe(64)
    expect(MISSION_SCHEMA.$defs.Row.properties.resources.maxItems).toBe(16)
    expect(MISSION_SCHEMA.$defs.Cell.maxLength).toBe(4000)
    expect(MISSION_SCHEMA.$defs.Line.maxLength).toBe(300)
    expect(MISSION_SCHEMA.$defs.Model.properties.tier.enum).toEqual(["thinker", "worker", "worker-fast", "inherit"])
  })
})

describe("row 13 MC-3: examples are argument blocks under the tool name", () => {
  test("every json block sits under a heading that is a registered, prefixed mission tool, and fits its top level", async () => {
    const { MISSION_TOOL_SCHEMAS } = await load("mcp-host/mission/schemas.ts")
    const all = examples()
    expect(all.length).toBeGreaterThanOrEqual(10)
    for (const { heading, values } of all) {
      expect(heading.startsWith(PREFIX) ? heading : `block under "${heading}"`).toBe(heading)
      const schema = MISSION_TOOL_SCHEMAS[heading.slice(PREFIX.length)] as S | undefined
      expect(schema ? heading : `no schema for ${heading}`).toBe(heading)
      for (const args of values) {
        const unknown = Object.keys(args).filter((k) => !(k in schema!.properties))
        const missing = ((schema!.required as string[] | undefined) ?? []).filter((k) => !(k in args))
        expect({ heading, unknown, missing }).toEqual({ heading, unknown: [], missing: [] })
      }
    }
  })

  test("row patches use only patch fields; done, blocked, dropped and retire carry a note", async () => {
    const { MISSION_TOOL_SCHEMAS } = await load("mcp-host/mission/schemas.ts")
    const patch = MISSION_TOOL_SCHEMAS.studio_mission_update_row.properties.rows.items as S
    const patches = examples().filter((e) => e.heading === `${PREFIX}studio_mission_update_row`).flatMap((e) => e.values.flatMap((v) => (v.rows ?? []) as S[]))
    expect(patches.length).toBeGreaterThanOrEqual(7)
    for (const p of patches) {
      expect(Object.keys(p).filter((k) => !(k in patch.properties))).toEqual([])
      if (p.status) expect(patch.properties.status.enum).toContain(p.status)
      if (p.status === "done" || p.status === "blocked" || p.status === "dropped" || p.retire) expect(typeof p.note).toBe("string")
      // The done-gate procedure: a retire never shares a patch with a status.
      if (p.retire) expect(p.status).toBeUndefined()
    }
  })

  test("the decision request example passes the store's validator and the skill prints its real limits", async () => {
    const { assertDecisionRequest } = await load("store/mission/validate.ts")
    const [req] = examples().filter((e) => e.heading === `${PREFIX}studio_mission_request_decision`).flatMap((e) => e.values)
    expect(Object.keys(req!)).not.toContain("blockingRows")
    expect(Array.isArray(req!.request.blockingRows)).toBe(true)
    expect(() => assertDecisionRequest(req!.request)).not.toThrow()
    // The limits the text states are the validator's: 300 one line, 2-8 options, 64 blocking rows.
    const base = req!.request
    expect(() => assertDecisionRequest({ ...base, context: "x".repeat(300) })).not.toThrow()
    expect(() => assertDecisionRequest({ ...base, context: "x".repeat(301) })).toThrow()
    expect(() => assertDecisionRequest({ ...base, context: "two\nlines" })).toThrow()
    expect(() => assertDecisionRequest({ ...base, options: base.options.slice(0, 1), recommended: "approve" })).toThrow()
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: "L", consequence: "C" }))
    expect(() => assertDecisionRequest({ ...base, options: nine, recommended: "o0" })).toThrow()
    expect(() => assertDecisionRequest({ ...base, options: nine.slice(0, 8), recommended: "o0" })).not.toThrow()
    expect(() => assertDecisionRequest({ ...base, blockingRows: Array.from({ length: 65 }, (_, i) => String(i + 1)) })).toThrow()
    expect(flat).toContain("context is one line of at most 300 characters; options are 2 to 8")
    expect(flat).toContain("blockingRows goes inside request (at most 64 row ids), never at the top level")
  })
})

describe("row 13 MC-3 and SK-3: procedure, one voice, size", () => {
  test("the done gate is a procedure: retire alone, render, verify the file, then done with a note", () => {
    const at = (s: string) => {
      const i = TEXT.indexOf(s)
      expect(i >= 0 ? s : `missing ${s}`).toBe(s)
      return i
    }
    const order = [at("1. Retire a draft"), at("2. Render the final revision with datum-studio_studio_render"), at("3. Verify each output of that render with datum-studio_studio_file_verify"), at("4. Send done with a note")]
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(flat).toContain("in a patch call of its own")
  })

  test("the 1.3.3 gates and replies are named with the register's names, and the store knows the codes", async () => {
    const errors = await load("store/errors.ts")
    const codes = new Set<string>(Object.values(errors).find((v) => Array.isArray(v) && (v as string[]).includes("OUTPUT_UNVERIFIED")) as string[])
    for (const code of ["DELIVERABLE_NOT_IN_PROJECT", "KNOWLEDGE_NOT_CONSULTED", "PROJECT_UNWRITABLE", "LABELS_VERIFIED_PERSON_ONLY", "OUTPUT_UNVERIFIED", "STATUS_TRANSITION", "SCHEMA_INVALID", "LOCK_HELD", "DEP_DROPPED", "FIELD_READ_ONLY"]) {
      expect(codes.has(code) ? code : `store has no ${code}`).toBe(code)
      expect(TEXT).toContain(code)
    }
    for (const name of ["corrected", "fields", "awaitingHumanCheck", "knowledgeReason", "projectCopy", "deliverables/<mission-id>/", "lintNotRun", "pagesWithoutWitness"]) expect(TEXT).toContain(name)
  })

  test("SK-3: derived numbers are recomputed by a second party before a chapter is submitted, with formula and source in a table", () => {
    expect(flat).toContain("every derived number (a sum, ratio, conversion or estimate) is recomputed by a second party")
    expect(flat).toContain("before the chapter is submitted")
    expect(flat).toMatch(/table with one line per number: the number, its formula, its source/)
  })

  test("one skill, one language, no contradiction on running to done, within the register cap", () => {
    expect(flat).not.toMatch(/running -> done does not exist|running → done ditolak|needs-review → blocked juga ditolak|studio-mission-ops/i)
    // English body: none of the staged draft's Indonesian section words (the reader-facing library name is the one phrase kept).
    expect(flat.replace("pustaka pengetahuan teknis GSP", "")).not.toMatch(/\b(wajib|hanya|baris|berkas|sebelum|setelah|misi|tinjau)\b/)
    expect(TEXT.replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(180)
    expect(Buffer.byteLength(TEXT)).toBeLessThanOrEqual(24_000)
    expect(TEXT.startsWith("# Mission Control")).toBe(true)
  })
})
