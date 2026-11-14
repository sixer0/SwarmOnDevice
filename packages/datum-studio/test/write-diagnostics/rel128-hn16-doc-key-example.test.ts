// Swarm 1.2.8 row 34b (H-N16, AC-HN16, N8-336; TEXT-PIN): every DOC_KEY_MISMATCH message of the host report tools
// (mission/report-tools.ts, mission/guard-writes.ts) carries one example payload: a studio_report_submit argument object
// that parses as JSON and passes that tool's (host-extended) input schema. The studio_report_submit description states
// the 20-column / 20-cells-per-row table limit of the v2 contract schema (maxItems 20).
// Red at BASE (e1f9673772): no message contains `contoh: {...}`, docKeyExample does not exist, the description has no 20.
// CHAR: the code DOC_KEY_MISMATCH and when it fires are unchanged (existing row119b/119c/119d tests).
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import Ajv from "ajv"

const PKG = path.resolve(import.meta.dir, "..", "..")
const MISSION_DIR = path.join(PKG, "src", "mcp-host", "mission")
const RT = (await import(path.join(MISSION_DIR, "report-tools.ts"))) as Record<string, any>
const common = await import(path.join(PKG, "vendor", "src", "lib", "studio", "contract", "schema", "v2", "common.schema.ts"))

const fakeStore = (mission: Record<string, unknown> | null) =>
  ({ missions: { get: () => (mission ? { mission } : undefined), listDecisionRequests: () => [] } }) as any
const wrappers: any[] = RT.reportWrappers(fakeStore(null), { log: () => undefined })
const tool = (name: string) => wrappers.find((w) => w.name === name)
const ajv = new Ajv({ allErrors: true, strict: false })
const validSubmit = ajv.compile(tool("studio_report_submit").inputSchema)

/** The single example payload of a message: the JSON object after `contoh: `, parsed and schema-checked. */
function example(message: string): Record<string, unknown> {
  const hits = message.match(/contoh: /g) ?? []
  expect(hits.length, message).toBe(1)
  const json = message.slice(message.indexOf("contoh: ") + "contoh: ".length)
  const payload = JSON.parse(json)
  expect(validSubmit(payload), `${json} ${JSON.stringify(validSubmit.errors)}`).toBe(true)
  expect(payload.docKey).toBe(`row-${payload.row}`)
  return payload
}

function thrown(fn: () => unknown): { code: string; message: string } {
  try {
    fn()
  } catch (e) {
    return e as { code: string; message: string }
  }
  throw new Error("expected a refusal")
}

describe("H-N16: DOC_KEY_MISMATCH messages carry one valid example payload", () => {
  test("resolveTarget: docKey disagreeing with row -> the example uses the call's mission and row", () => {
    const e = thrown(() => RT.resolveTarget({ mission: "2026-11-14_m", docKey: "row-2" }, "3"))
    expect(e.code).toBe("DOC_KEY_MISMATCH")
    expect(e.message.startsWith("docKey must be row-<row> when row is given")).toBe(true)
    expect(example(e.message)).toEqual({ mission: "2026-11-14_m", row: "3", docKey: "row-3" })
  })

  test("resolveTarget: docKey neither row-<row> nor delegation -> example with the fallback row 1", () => {
    const e = thrown(() => RT.resolveTarget({ mission: "2026-11-14_m", docKey: "lap-1" }, null))
    expect(e.code).toBe("DOC_KEY_MISMATCH")
    expect(example(e.message)).toEqual({ mission: "2026-11-14_m", row: "1", docKey: "row-1" })
  })

  test("missionIssues: TaskRef differing from the row of docKey -> issue message with the example", () => {
    const m = { id: "2026-11-14_m", status: "running", rows: [{ id: "4", status: "running", deps: [] }, { id: "5", status: "pending", deps: [] }] }
    const issues = RT.missionIssues(fakeStore(m), { mission: m.id, kind: "row", row: "4", docKey: "row-4" }, { taskRef: "5", status: "complete" })
    const dk = issues.filter((i: any) => i.code === "DOC_KEY_MISMATCH")
    expect(dk.length).toBe(1)
    expect(example(dk[0].message)).toEqual({ mission: m.id, row: "4", docKey: "row-4" })
  })

  test("docKeyExample: a missing or unusable mission/row falls back and still passes the schema", () => {
    for (const [mi, row] of [[null, null], ["", "0"], ["x".repeat(121), "row-3"], ["a\u0001b", undefined], ["2026-11-14_\"q\"", "12a"]] as const) {
      const p = example(RT.docKeyExample(mi, row))
      expect(typeof p.mission).toBe("string")
    }
  })

  test("every DOC_KEY_MISMATCH site in report-tools.ts and guard-writes.ts appends docKeyExample (8 + 2 sites)", () => {
    for (const [file, n] of [["report-tools.ts", 8], ["guard-writes.ts", 2]] as const) {
      const lines = readFileSync(path.join(MISSION_DIR, file), "utf8").split("\n")
      const sites = lines.filter((l) => /"DOC_KEY_MISMATCH",/.test(l))
      expect(sites.length, file).toBe(n)
      for (const l of sites) expect(l, `${file}: ${l.trim().slice(0, 120)}`).toContain("${docKeyExample(")
    }
  })
})

describe("H-N16: the 20-item table limit is stated", () => {
  test("v2 schema: table columns and row cells are maxItems 20", () => {
    const defs = common.commonV2Schema.$defs ?? common.commonV2Schema.definitions
    const table = Object.values(defs).find((d: any) => d?.properties?.columns?.maxItems !== undefined) as any
    expect(table.properties.columns.maxItems).toBe(20)
    const row = Object.values(defs).find((d: any) => d?.properties?.cells?.maxItems !== undefined) as any
    expect(row.properties.cells.maxItems).toBe(20)
  })

  test("studio_report_submit description says: tabel maks 20 kolom, 20 sel per baris", () => {
    expect(tool("studio_report_submit").description).toContain("tabel maks 20 kolom, 20 sel per baris")
  })
})
