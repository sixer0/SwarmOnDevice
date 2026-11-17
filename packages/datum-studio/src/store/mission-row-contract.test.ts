/**
 * Swarm 1.3.3 row 5: the mission row contract (register section 1). Migration 0009 adds the columns
 * `mission_row.deliverables`, `.knowledge`, `.awaiting_human_check`; the row schema gains the three host fields; the
 * store gains the four setters. No gate, no default and no tool behaviour is tested here (rows 16, 62, 66, 68, 70,
 * 100-102 own those).
 * Temp folders: ROW5_133_TEST_DIR, else the OS temp folder. Nothing outside it is written.
 */
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSqlite } from "#sqlite"
import { applyMigrations } from "./migrations/index.ts"
import { MIGRATION_0009_ID } from "./migrations/0009_datum_mission_row_contract.ts"
import { isStoreError, latestSchemaId, MIGRATIONS, RESERVED_MIGRATIONS, SqliteStudioStore, type StoreErrorCode } from "./index.ts"
import { checkMissionSchema, pinBuiltinMissionTypes, type MissionRowContract, type MissionRowInput, type NewMission, type RowAwaitingHumanCheck, type RowDeliverable, type RowKnowledge } from "./mission/index.ts"
import { MISSION_TOOL_SCHEMAS } from "../mcp-host/mission/schemas.ts"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const T = (isBun ? await import("bun:test") : await import("./test-harness.node.ts")) as unknown as typeof import("./test-harness.node.ts")
const { describe, test, expect, afterAll } = T

const BASE = process.env.ROW5_133_TEST_DIR ?? join(tmpdir(), "row5-133-row-contract-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(join(BASE, `${isBun ? "bun" : "node"}-`))
const opened: SqliteStudioStore[] = []
let tick = 1_800_000_000_000
const clock = () => ++tick

async function openStore(name: string) {
  const s = new SqliteStudioStore()
  await s.open(join(RUN, name), { release: "1.3.3", log: () => {}, agentClock: clock })
  opened.push(s)
  return s
}

afterAll(async () => {
  for (const s of opened) await s.close()
})

async function expectCode(p: Promise<unknown>, code: StoreErrorCode): Promise<Record<string, unknown>> {
  try {
    await p
  } catch (e) {
    if (!isStoreError(e, code)) throw new Error(`expected ${code}, got ${e instanceof Error ? e.message : String(e)}`)
    return (e as { details?: Record<string, unknown> }).details ?? {}
  }
  throw new Error(`expected ${code}, nothing thrown`)
}

function sqlError(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return "nothing thrown"
}

function row(id: string, over: Partial<MissionRowInput> = {}): MissionRowInput {
  return { id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", ...over }
}

const U1 = { id: "U1", by: "user" as const, date: "2026-11-17", text: "User approves the blueprint" }
const MID = "2026-11-17_row-contract"
function mission(id: string, rows: MissionRowInput[]): NewMission {
  return { id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", project: { dir: "/private/tmp/row5-133/project" }, rows, decisions: [U1] }
}

const contract = (r: unknown) => r as MissionRowContract
const SHA = "ab".repeat(32)
const DOC = "a1b2c3d4e5f6a7b8c9d0e1f2"
const DELIVERABLES: RowDeliverable[] = [
  { path: `deliverables/${MID}/012-GSP-KT-XI-2026 RevD rev256.pdf`, format: "PDF", docRev: "D", revisionNo: 256, sha256: SHA, latest: true, documentId: DOC },
  { path: `deliverables/${MID}/012-GSP-KT-XI-2026 RevC rev200.pdf`, format: "PDF", docRev: "C", revisionNo: 200, sha256: "cd".repeat(32), latest: false, documentId: DOC },
  { path: `deliverables/${MID}/lampiran.xlsx`, format: "XLSX", sha256: "ef".repeat(32), latest: true },
]
const KNOWLEDGE: RowKnowledge = {
  domains: [
    { domain: "COMPUTER-VISION", firstFile: "computer-vision/00_index.md", consulted: [] },
    { domain: "DIAGRAM-STANDARD", firstFile: "references/index.md", consulted: [] },
  ],
}
const AWAITING: RowAwaitingHumanCheck = { checks: ["labels_verified"], since: "2026-11-17T08:00:00Z" }

describe("migration 0009: mission row contract columns", () => {
  test("0009 has seq 9; 0011 (row 144) is the last migration and nothing stays reserved", () => {
    // 1.3.3 row 82: 0010 landed after 0009, so the "last migration" pin moved by one and the reservation is empty.
    // 1.3.3 row 144: 0011 landed after 0010, the pin moved by one more.
    expect([MIGRATIONS.at(-3)!.seq, MIGRATIONS.at(-3)!.id]).toEqual([9, MIGRATION_0009_ID])
    expect(MIGRATION_0009_ID).toBe("20261117000000_datum_mission_row_contract")
    expect([MIGRATIONS.at(-1)!.seq, latestSchemaId()]).toEqual([11, "20261117180000_datum_purge_fk_indexes"])
    expect(Object.keys(RESERVED_MIGRATIONS)).toEqual([])
  })

  test("a store created before 0009 migrates; its rows open with the three fields empty", async () => {
    const dir = join(RUN, "upgrade")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "datum-studio.sqlite")
    const db = openSqlite(file)
    try {
      db.exec("PRAGMA foreign_keys = ON")
      expect(applyMigrations(db, { release: "1.3.2", now: clock }, MIGRATIONS.filter((m) => m.seq <= 8)).length).toBe(8)
      pinBuiltinMissionTypes(db, clock(), () => {})
      for (const id of ["2026-11-16_open", "2026-11-16_closed"]) {
        db.run("INSERT INTO mission (id, title, type_id, type_version, owner, project_dir, time_created, time_updated) VALUES (?, 't', 'feature-release', 1, 'master-controller', '/p', 1, 1)", [id])
        for (const r of ["1", "2"]) {
          db.run(
            "INSERT INTO mission_row (mission_id, row_id, phase_id, kind, title, agent, model_tier, size, output, verification, note, ord, time_created, time_updated) VALUES (?, ?, 'implementation', 'implementation', ?, 'coder-execution', 'thinker', 'S', 'o', 'v', 'old note', ?, 1, 1)",
            [id, r, `Row ${r} title`, Number(r)],
          )
        }
      }
      db.run("INSERT INTO mission_decision (mission_id, decision_id, by, date, text, time_created) VALUES ('2026-11-16_closed', 'U1', 'user', '2026-11-16', 'ok', 1)")
      db.run("UPDATE mission SET status = 'done', approval_decision_id = 'U1', time_approved = 2, time_closed = 3 WHERE id = '2026-11-16_closed'")
      expect(db.all<{ name: string }>("PRAGMA table_info(mission_row)").map((c) => c.name)).not.toContain("deliverables")
    } finally {
      db.close()
    }

    const db2 = openSqlite(file)
    try {
      db2.exec("PRAGMA foreign_keys = ON")
      expect(applyMigrations(db2, { release: "1.3.3", now: clock })).toEqual([MIGRATION_0009_ID, "20261117120000_datum_revision_retention", "20261117180000_datum_purge_fk_indexes"]) // 1.3.3 row 82: + 0010, row 144: + 0011
      expect(applyMigrations(db2, { release: "1.3.3", now: clock })).toEqual([])
      expect(db2.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'schema_version'")!.value).toBe(latestSchemaId())
      const cols = db2.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>("PRAGMA table_info(mission_row)").filter((c) => ["deliverables", "knowledge", "awaiting_human_check"].includes(c.name))
      expect(cols.map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? "-"}`)).toEqual(["deliverables:TEXT:1:'[]'", "knowledge:TEXT:0:-", "awaiting_human_check:TEXT:0:-"])
      const rows = db2.all<{ m: string; r: string; d: string; k: string | null; a: string | null; note: string }>("SELECT mission_id AS m, row_id AS r, deliverables AS d, knowledge AS k, awaiting_human_check AS a, note FROM mission_row ORDER BY m, r")
      expect(rows.map((x) => `${x.m}/${x.r}:${x.d}:${x.k ?? "-"}:${x.a ?? "-"}:${x.note}`)).toEqual([
        "2026-11-16_closed/1:[]:-:-:old note",
        "2026-11-16_closed/2:[]:-:-:old note",
        "2026-11-16_open/1:[]:-:-:old note",
        "2026-11-16_open/2:[]:-:-:old note",
      ])
      // each column refuses text that is not JSON
      for (const col of ["deliverables", "knowledge", "awaiting_human_check"]) {
        expect(sqlError(() => db2.run(`UPDATE mission_row SET ${col} = 'not json' WHERE mission_id = '2026-11-16_open' AND row_id = '1'`))).toContain("CHECK constraint failed")
      }
      expect(db2.all("PRAGMA foreign_key_check")).toEqual([])
      expect(db2.all<{ integrity_check: string }>("PRAGMA integrity_check").map((x) => x.integrity_check)).toEqual(["ok"])
    } finally {
      db2.close()
    }

    // the store itself opens the migrated file and reads the old rows through the contract
    const s = await openStore("upgrade")
    for (const id of ["2026-11-16_open", "2026-11-16_closed"]) {
      const got = s.missions.get(id)!.mission
      expect(got.rows.map((r) => [r.id, r.note, contract(r).deliverables, contract(r).knowledge, contract(r).awaitingHumanCheck])).toEqual([
        ["1", "old note", [], undefined, undefined],
        ["2", "old note", [], undefined, undefined],
      ])
      expect(checkMissionSchema("MissionDoc", got)).toEqual([])
    }
  })
})

describe("row fields deliverables, knowledge, awaitingHumanCheck", () => {
  test("a new row reads back empty; the three fields are host fields (FIELD_READ_ONLY)", async () => {
    const s = await openStore("main")
    const M = s.missions
    await s.transaction(async (t) => M.create(t, mission(MID, [row("1"), row("2")]), { attested: true }))
    const r1 = M.get(MID)!.mission.rows[0]!
    expect([contract(r1).deliverables, contract(r1).knowledge, contract(r1).awaitingHumanCheck]).toEqual([[], undefined, undefined])
    expect(M.rowContract(MID, "1")).toEqual({ deliverables: [] })

    for (const [field, value] of [["deliverables", DELIVERABLES], ["knowledge", KNOWLEDGE], ["awaitingHumanCheck", AWAITING]] as const) {
      const d = await expectCode(s.transaction(async (t) => M.create(t, mission(`2026-11-17_ro-${field.toLowerCase()}`, [{ ...row("1"), [field]: value } as MissionRowInput]), { attested: true })), "FIELD_READ_ONLY")
      expect(d.fields).toEqual([`rows/0/${field}`])
      const d2 = await expectCode(s.transaction(async (t) => M.updateRows(t, MID, [{ id: "9", add: { ...row("9"), [field]: value } as MissionRowInput }])), "FIELD_READ_ONLY")
      expect(d2.fields).toEqual([field])
      const d3 = await expectCode(s.transaction(async (t) => M.updateRows(t, MID, [{ id: "1", set: { [field]: value } as never }])), "FIELD_READ_ONLY")
      expect(d3.fields).toEqual([field])
    }
  })

  test("the four setters store the fields; they round-trip through get, a row change and a reopen", async () => {
    const s = opened.find((x) => x.missions.get(MID))!
    const M = s.missions
    await s.transaction(async (t) => {
      M.setRowDeliverables(t, MID, "1", DELIVERABLES)
      M.setRowKnowledge(t, MID, "1", KNOWLEDGE)
      M.setAwaitingHumanCheck(t, MID, "1", AWAITING)
    })
    const want = { deliverables: DELIVERABLES, knowledge: KNOWLEDGE, awaitingHumanCheck: AWAITING }
    expect(M.rowContract(MID, "1")).toEqual(want)
    const doc = M.get(MID)!.mission
    expect({ deliverables: contract(doc.rows[0]).deliverables, knowledge: contract(doc.rows[0]).knowledge, awaitingHumanCheck: contract(doc.rows[0]).awaitingHumanCheck }).toEqual(want)
    expect(M.rowContract(MID, "2")).toEqual({ deliverables: [] }) // the other row is untouched
    expect(checkMissionSchema("MissionDoc", doc)).toEqual([])

    // a caller's change of other fields keeps the host fields and is not refused because the row carries them
    await s.transaction(async (t) => M.updateRows(t, MID, [{ id: "1", set: { title: "Row 1 renamed" }, note: "renamed" }]))
    expect(M.get(MID)!.mission.rows[0]!.title).toBe("Row 1 renamed")
    expect(M.rowContract(MID, "1")).toEqual(want)

    // sign-off shape (row 62 writes it): cleared by a user decision
    const cleared: RowAwaitingHumanCheck = { ...AWAITING, clearedBy: "U1", clearedAt: "2026-11-17T09:00:00Z" }
    await s.transaction(async (t) => M.setAwaitingHumanCheck(t, MID, "1", cleared))
    expect(M.rowContract(MID, "1").awaitingHumanCheck).toEqual(cleared)

    // undefined clears the optional fields; an empty list clears deliverables
    await s.transaction(async (t) => {
      M.setRowKnowledge(t, MID, "2", KNOWLEDGE)
      M.setRowKnowledge(t, MID, "2", undefined)
      M.setAwaitingHumanCheck(t, MID, "2", AWAITING)
      M.setAwaitingHumanCheck(t, MID, "2", undefined)
      M.setRowDeliverables(t, MID, "2", DELIVERABLES.slice(0, 1))
      M.setRowDeliverables(t, MID, "2", [])
    })
    expect(M.rowContract(MID, "2")).toEqual({ deliverables: [] })

    // persisted: a second handle on the same file reads the same values
    const db = openSqlite(join(RUN, "main", "datum-studio.sqlite"), { readonly: true })
    try {
      const raw = db.get<{ d: string; k: string; a: string }>("SELECT deliverables AS d, knowledge AS k, awaiting_human_check AS a FROM mission_row WHERE mission_id = ? AND row_id = '1'", [MID])!
      expect([JSON.parse(raw.d), JSON.parse(raw.k), JSON.parse(raw.a)]).toEqual([DELIVERABLES, KNOWLEDGE, cleared])
    } finally {
      db.close()
    }
  })

  test("values outside the register are refused with SCHEMA_INVALID and nothing is written", async () => {
    const s = opened.find((x) => x.missions.get(MID))!
    const M = s.missions
    const before = M.rowContract(MID, "1")
    const ok = DELIVERABLES[0]!
    const badDeliverables: Array<[string, unknown]> = [
      ["absolute path", [{ ...ok, path: "/tmp/x.pdf" }]],
      ["path outside deliverables/<mission>/", [{ ...ok, path: "deliverables/2026-11-17_other/x.pdf" }]],
      ["path with ..", [{ ...ok, path: `deliverables/${MID}/../x.pdf` }]],
      ["unknown format", [{ ...ok, format: "ZIP" }]],
      ["sha256 not 64 hex", [{ ...ok, sha256: "abc" }]],
      ["documentId without docRev and revisionNo", [{ path: ok.path, format: "PDF", sha256: SHA, latest: true, documentId: DOC }]],
      ["revisionNo out of range", [{ ...ok, revisionNo: 1_000_000 }]],
      ["docRev too long", [{ ...ok, docRev: "ABCDEFGHI" }]],
      ["latest missing", [{ path: ok.path, format: "PDF", sha256: SHA }]],
      ["unknown property", [{ ...ok, title: "x" }]],
      ["101 items", Array.from({ length: 101 }, (_, i) => ({ path: `deliverables/${MID}/f${i}.txt`, format: "TXT", sha256: SHA, latest: true }))],
      ["not an array", { path: ok.path }],
    ]
    for (const [label, value] of badDeliverables) {
      await expectCode(s.transaction(async (t) => M.setRowDeliverables(t, MID, "1", value as RowDeliverable[])), "SCHEMA_INVALID").catch((e) => {
        throw new Error(`${label}: ${String(e)}`)
      })
    }
    const dom = KNOWLEDGE.domains[0]!
    const badKnowledge: Array<[string, unknown]> = [
      ["no domains", { domains: [] }],
      ["26 domains", { domains: Array.from({ length: 26 }, (_, i) => ({ ...dom, domain: `D-${i}` })) }],
      ["lower-case domain", { domains: [{ ...dom, domain: "computer-vision" }] }],
      ["firstFile with ..", { domains: [{ ...dom, firstFile: "../x.md" }] }],
      ["21 consulted", { domains: [{ ...dom, consulted: Array.from({ length: 21 }, (_, i) => `f${i}.md`) }] }],
      ["reason of two lines", { domains: [dom], reason: "a\nb" }],
      ["reason over 300 chars", { domains: [dom], reason: "x".repeat(301) }],
      ["unknown property", { domains: [dom], note: "x" }],
    ]
    for (const [label, value] of badKnowledge) {
      await expectCode(s.transaction(async (t) => M.setRowKnowledge(t, MID, "1", value as RowKnowledge)), "SCHEMA_INVALID").catch((e) => {
        throw new Error(`${label}: ${String(e)}`)
      })
    }
    const badAwaiting: Array<[string, unknown]> = [
      ["no checks", { checks: [], since: AWAITING.since }],
      ["unknown check", { checks: ["pages_verified"], since: AWAITING.since }],
      ["duplicate check", { checks: ["labels_verified", "labels_verified"], since: AWAITING.since }],
      ["since missing", { checks: ["labels_verified"] }],
      ["since not an instant", { checks: ["labels_verified"], since: "today" }],
      ["clearedBy a controller decision", { ...AWAITING, clearedBy: "C1" }],
      ["clearedBy a name", { ...AWAITING, clearedBy: "budi" }],
      ["unknown property", { ...AWAITING, by: "x" }],
    ]
    for (const [label, value] of badAwaiting) {
      await expectCode(s.transaction(async (t) => M.setAwaitingHumanCheck(t, MID, "1", value as RowAwaitingHumanCheck)), "SCHEMA_INVALID").catch((e) => {
        throw new Error(`${label}: ${String(e)}`)
      })
    }
    await expectCode(s.transaction(async (t) => M.setRowDeliverables(t, MID, "77", [])), "ROW_UNKNOWN")
    await expectCode(s.transaction(async (t) => M.setRowKnowledge(t, "2026-11-17_nowhere", "1", KNOWLEDGE)), "MISSION_NOT_FOUND")
    expect(M.rowContract(MID, "1")).toEqual(before)
    // setRowKnowledge fills a missing `consulted` with [] and accepts a reason
    await s.transaction(async (t) => M.setRowKnowledge(t, MID, "2", { domains: [{ domain: "COMPUTER-VISION", firstFile: "computer-vision/00_index.md" }], reason: "not relevant: text-only row" } as unknown as RowKnowledge))
    expect(M.rowContract(MID, "2").knowledge).toEqual({ domains: [{ domain: "COMPUTER-VISION", firstFile: "computer-vision/00_index.md", consulted: [] }], reason: "not relevant: text-only row" })
    await s.transaction(async (t) => M.setRowKnowledge(t, MID, "2", undefined))
  })

  test("markKnowledgeConsulted marks a running row only, once per file, at most 20 per domain", async () => {
    const s = opened.find((x) => x.missions.get(MID))!
    const M = s.missions
    const first = KNOWLEDGE.domains[0]!.firstFile
    // row 1 is pending: nothing is marked
    expect(await s.transaction(async (t) => M.markKnowledgeConsulted(t, MID, "1", { path: first }))).toEqual({ marked: false, domains: [], reason: "row-not-running" })
    await s.transaction(async (t) => M.approve(t, MID, "U1"))
    await s.transaction(async (t) => M.updateRows(t, MID, [{ id: "1", status: "running" }, { id: "2", status: "running" }]))
    // row 2 runs but has no knowledge field
    expect(await s.transaction(async (t) => M.markKnowledgeConsulted(t, MID, "2", { path: first }))).toEqual({ marked: false, domains: [], reason: "no-knowledge" })
    // a first file marks its own domain
    expect(await s.transaction(async (t) => M.markKnowledgeConsulted(t, MID, "1", { path: first }))).toEqual({ marked: true, domains: ["COMPUTER-VISION"] })
    expect(await s.transaction(async (t) => M.markKnowledgeConsulted(t, MID, "1", { path: first }))).toEqual({ marked: false, domains: [], reason: "already-marked" })
    // another file needs the domain named by the caller (the store holds no index)
    expect(await s.transaction(async (t) => M.markKnowledgeConsulted(t, MID, "1", { path: "computer-vision/01_detail.md" }))).toEqual({ marked: false, domains: [], reason: "no-domain" })
    expect(await s.transaction(async (t) => M.markKnowledgeConsulted(t, MID, "1", { path: "computer-vision/01_detail.md", domain: "COMPUTER-VISION" }))).toEqual({ marked: true, domains: ["COMPUTER-VISION"] })
    expect(await s.transaction(async (t) => M.markKnowledgeConsulted(t, MID, "1", { path: "x.md", domain: "NOT-ON-ROW" }))).toEqual({ marked: false, domains: [], reason: "no-domain" })
    await expectCode(s.transaction(async (t) => M.markKnowledgeConsulted(t, MID, "1", { path: "../outside.md", domain: "COMPUTER-VISION" })), "SCHEMA_INVALID")
    for (let i = 2; i < 20; i++) await s.transaction(async (t) => M.markKnowledgeConsulted(t, MID, "1", { path: `computer-vision/f${i}.md`, domain: "COMPUTER-VISION" }))
    expect(await s.transaction(async (t) => M.markKnowledgeConsulted(t, MID, "1", { path: "computer-vision/late.md", domain: "COMPUTER-VISION" }))).toEqual({ marked: false, domains: [], reason: "cap" })
    const k = M.rowContract(MID, "1").knowledge!
    expect(k.domains.map((d) => [d.domain, d.consulted.length])).toEqual([["COMPUTER-VISION", 20], ["DIAGRAM-STANDARD", 0]])
    expect(k.domains[0]!.consulted.slice(0, 2)).toEqual([first, "computer-vision/01_detail.md"])
    expect(checkMissionSchema("MissionDoc", M.get(MID)!.mission)).toEqual([])
  })

  test("studio_mission_update_row accepts knowledgeReason in a row patch (one line, 1-300 characters)", () => {
    const patch = ((MISSION_TOOL_SCHEMAS.studio_mission_update_row as { properties: Record<string, { items?: { properties?: Record<string, Record<string, unknown>> } }> }).properties.rows!.items!.properties!)
    const k = patch.knowledgeReason!
    expect({ type: k.type, minLength: k.minLength, maxLength: k.maxLength, pattern: k.pattern }).toEqual({ type: "string", minLength: 1, maxLength: 300, pattern: "^[^\\u0000-\\u001f]+$" })
  })
})
