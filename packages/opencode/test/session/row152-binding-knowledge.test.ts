// 1.3.3 row 152 (senior review S3): the mission binding learns `knowledge` from the create and update_row replies, not
// only from `get`, so the compaction summary's `Mission state` block lists it. The reply shapes are the host's
// (packages/datum-studio/src/mcp-host/mission/mission-tools.ts, row 101): create returns
// `knowledge: {rows: [{row, domains: [{domain, firstFile, words}]}], mission: [...], unavailable?}`; update_row returns
// `knowledge: {rows: [{row, domains: [{domain, firstFile}]}], unavailable?}` for the rows the call started. Ids are synthetic.
import { beforeEach, describe, expect, test } from "bun:test"
import { missionStateBlock } from "../../src/session/compaction"
import { MissionBinding } from "../../src/session/mission-binding"

const A = "ses_a"
const M1 = "2026-11-18_alpha"
const M2 = "2026-11-18_beta"
const DIAGRAM = "skill:gsp-diagram-standard/references/index.md"
const NET = "4 Knowledge Bank/ekas-lapis-teks/04_KNOWLEDGE-CARDS/NETWORKING/"

const ok = (tool: string, data: Record<string, unknown>) => ({
  content: [{ type: "text", text: "x" }],
  structuredContent: { ok: true, tool, ...data },
})

const create = (id: string, knowledge?: unknown, extra: Record<string, unknown> = {}) =>
  MissionBinding.observe({
    sessionID: A,
    tool: "studio_mission_create",
    args: { mission: { id, title: "t", type: "generic", rows: [] } },
    result: ok("studio_mission_create", {
      id,
      status: "draft",
      rows: 3,
      waves: [],
      issues: [],
      dryRun: false,
      ...(knowledge !== undefined ? { knowledge } : {}),
      ...extra,
    }),
  })

const update = (mission: string, rows: Array<Record<string, unknown>>, knowledge?: unknown, results?: Array<{ id: string; ok: boolean }>) =>
  MissionBinding.observe({
    sessionID: A,
    tool: "studio_mission_update_row",
    args: { mission, rows },
    result: ok("studio_mission_update_row", {
      changed: rows.map((r) => String(r.id)),
      results: results ?? rows.map((r) => ({ id: String(r.id), ok: true })),
      waves: [],
      ready: [],
      checkpoints: [],
      messages: [],
      dryRun: false,
      ...(knowledge !== undefined ? { knowledge } : {}),
    }),
  })

const createKnowledge = {
  rows: [
    { row: "2", domains: [{ domain: "NETWORKING", firstFile: NET, words: ["jaringan"] }] },
    { row: "3", domains: [{ domain: "DIAGRAM-STANDARD", firstFile: DIAGRAM, words: ["diagram"] }] },
  ],
  mission: [{ domain: "CCTV", firstFile: "x", words: ["cctv"] }],
}

beforeEach(() => MissionBinding.reset())

describe("row 152: knowledge from create", () => {
  test("a create reply with knowledge reaches the compaction summary block", () => {
    expect(create(M1, createKnowledge)).toBe("set")
    expect(MissionBinding.get(A)?.knowledge).toEqual([
      { row: "2", domain: "NETWORKING", firstFile: NET },
      { row: "3", domain: "DIAGRAM-STANDARD", firstFile: DIAGRAM },
    ])
    const block = missionStateBlock(MissionBinding.get(A)!)
    expect(block).toContain(`- knowledge: row 2 NETWORKING, first file ${NET}; row 3 DIAGRAM-STANDARD, first file ${DIAGRAM}`)
    expect(block).not.toContain("none recorded\n")
    // The mission title's hits are listed by the host only; they belong to no row and are not carried.
    expect(block).not.toContain("CCTV")
  })

  test("a create reply without knowledge, or with the library unavailable, records none", () => {
    create(M1)
    expect(MissionBinding.get(A)?.knowledge).toEqual([])
    create(M2, { rows: [], mission: [], unavailable: "index path not known" })
    expect(MissionBinding.get(A)?.knowledge).toEqual([])
    expect(missionStateBlock(MissionBinding.get(A)!)).toContain("- knowledge: none recorded")
  })

  test("malformed knowledge entries are skipped and the good ones kept; nothing throws", () => {
    create(M1, {
      rows: [
        null,
        7,
        { row: 4, domains: [{ domain: "X", firstFile: "y" }] },
        { row: "5", domains: "x" },
        { row: "6", domains: [{ domain: "STORAGE" }, { firstFile: "f" }, null, { domain: "STORAGE", firstFile: "s/00.md" }] },
      ],
    })
    expect(MissionBinding.get(A)?.knowledge).toEqual([{ row: "6", domain: "STORAGE", firstFile: "s/00.md" }])
    create(M2, "not an object")
    expect(MissionBinding.get(A)?.missionID).toBe(M2)
    expect(MissionBinding.get(A)?.knowledge).toEqual([])
  })

  test("a dry-run create changes nothing", () => {
    expect(create(M1, createKnowledge, { dryRun: true })).toBe("none")
    expect(MissionBinding.get(A)).toBeUndefined()
  })
})

describe("row 152: knowledge from update_row", () => {
  test("starting a row adds the knowledge the reply lists for it", () => {
    create(M1)
    update(M1, [{ id: "2", status: "running" }], { rows: [{ row: "2", domains: [{ domain: "NETWORKING", firstFile: NET }] }] })
    const b = MissionBinding.get(A)!
    expect(b.runningRows).toEqual(["2"])
    expect(b.knowledge).toEqual([{ row: "2", domain: "NETWORKING", firstFile: NET }])
    expect(missionStateBlock(b)).toContain(`- knowledge: row 2 NETWORKING, first file ${NET}`)
  })

  test("an update_row alone (after a restart) binds and records the started row's knowledge", () => {
    update(M1, [{ id: "3", status: "running" }], { rows: [{ row: "3", domains: [{ domain: "DIAGRAM-STANDARD", firstFile: DIAGRAM }] }] })
    expect(MissionBinding.get(A)?.knowledge).toEqual([{ row: "3", domain: "DIAGRAM-STANDARD", firstFile: DIAGRAM }])
  })

  test("the reply's list for a started row replaces what create said for it; other rows keep theirs", () => {
    create(M1, createKnowledge)
    update(M1, [{ id: "2", status: "running" }], { rows: [{ row: "2", domains: [{ domain: "FIBER-OPTIC", firstFile: "fo/00.md" }] }] })
    expect(MissionBinding.get(A)?.knowledge).toEqual([
      { row: "3", domain: "DIAGRAM-STANDARD", firstFile: DIAGRAM },
      { row: "2", domain: "FIBER-OPTIC", firstFile: "fo/00.md" },
    ])
  })

  test("a row that leaves running, or closes, drops its knowledge; rows not yet started keep theirs", () => {
    create(M1, createKnowledge)
    update(M1, [{ id: "2", status: "running" }])
    expect(MissionBinding.get(A)?.knowledge.map((k) => k.row)).toEqual(["2", "3"])
    update(M1, [{ id: "2", status: "done" }])
    expect(MissionBinding.get(A)?.knowledge).toEqual([{ row: "3", domain: "DIAGRAM-STANDARD", firstFile: DIAGRAM }])
    update(M1, [{ id: "3", status: "dropped" }])
    expect(MissionBinding.get(A)?.knowledge).toEqual([])
  })

  test("knowledge for a row whose patch was refused, or that the call did not start, is not taken", () => {
    create(M1)
    update(
      M1,
      [{ id: "2", status: "running" }, { id: "4", title: "renamed" }],
      { rows: [{ row: "2", domains: [{ domain: "NETWORKING", firstFile: NET }] }, { row: "4", domains: [{ domain: "STORAGE", firstFile: "s" }] }] },
      [{ id: "2", ok: false }, { id: "4", ok: true }],
    )
    expect(MissionBinding.get(A)?.knowledge).toEqual([])
  })

  test("a get still replaces the list with the running rows it shows", () => {
    create(M1, createKnowledge)
    MissionBinding.observe({
      sessionID: A,
      tool: "studio_mission_get",
      args: { mission: M1 },
      result: ok("studio_mission_get", {
        mission: { id: M1, status: "running", rows: [{ id: "2", status: "running", knowledge: { domains: [{ domain: "NETWORKING", firstFile: NET }] } }, { id: "3", status: "pending" }] },
        derived: {},
      }),
    })
    expect(MissionBinding.get(A)?.knowledge).toEqual([{ row: "2", domain: "NETWORKING", firstFile: NET }])
  })
})
