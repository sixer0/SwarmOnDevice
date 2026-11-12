/**
 * Row 119a tests: migration 0003 and the mission store API (masterplan/01_specs_mission_contract.md; U19, U20, C57).
 * Runs under `bun test` and unchanged under Electron's Node (test-harness.node.ts), like store.test.ts.
 * Temp folders: ROW119A_TEST_DIR, else ROW30_TEST_DIR, else the OS temp folder. Nothing outside it is written.
 */
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSqlite } from "#sqlite"
import { applyMigrations } from "./migrations/index.ts"
import { MIGRATION_0003_SPEC_SHA256, MIGRATION_0003_SPEC_SQL } from "./migrations/0003_datum_mission.ts"
import { canonicalJson, isStoreError, latestSchemaId, MIGRATIONS, newId, sha256Hex, SqliteStudioStore, type BuiltinTemplateFile, type StoreErrorCode, type StoreLogEntry } from "./index.ts"
import {
  BUILTIN_MISSION_TYPES,
  BUILTIN_MISSION_TYPES_SHA256,
  checkMissionSchema,
  MISSION_SCHEMA_V1,
  MISSION_SCHEMA_V1_SHA256,
  pinBuiltinMissionTypes,
  type MissionRowInput,
  type MissionTypeDoc,
  type NewMission,
} from "./mission/index.ts"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const T = (isBun ? await import("bun:test") : await import("./test-harness.node.ts")) as unknown as typeof import("./test-harness.node.ts")
const { describe, test, expect, afterAll } = T

const BASE = process.env.ROW119A_TEST_DIR ?? process.env.ROW30_TEST_DIR ?? join(tmpdir(), "row119a-mission-store-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(join(BASE, `${isBun ? "bun" : "node"}-`))
const RELEASE = "1.2.0"
const ID_0001 = "20261106000000_datum_studio_init"
const ID_0002 = "20261106120000_datum_template_guard"
const ID_0003 = "20261107000000_datum_mission"
const ID_0004 = "20261107120000_datum_output_verification" // row 149: 0004 follows 0003
const ID_0006 = "20261108120000_datum_mission_autonomous_decision" // row 188: autonomous decision mark
const ID_0007 = "20261112000000_datum_mission_document_link" // 1.2.6 row 86: mission_document link
const ID_0005 = "20261108000000_datum_mission_gsp_tiers" // row 166: GSP AI model tiers
const logs: StoreLogEntry[] = []
const opened: SqliteStudioStore[] = []
let tick = 1_800_000_000_000
const clock = () => ++tick

async function openStore(name: string, extra: Partial<Parameters<SqliteStudioStore["open"]>[1]> = {}) {
  const s = new SqliteStudioStore()
  await s.open(join(RUN, name), { release: RELEASE, log: (e) => logs.push(e), agentClock: clock, ...extra })
  opened.push(s)
  return s
}

afterAll(async () => {
  for (const s of opened) await s.close()
})

async function expectCode(p: Promise<unknown> | (() => unknown), code: StoreErrorCode): Promise<{ details?: Record<string, unknown> }> {
  try {
    await (typeof p === "function" ? p() : p)
  } catch (e) {
    if (!isStoreError(e, code)) throw new Error(`expected ${code}, got ${e instanceof Error ? e.message : String(e)}`)
    return e as { details?: Record<string, unknown> }
  }
  throw new Error(`expected ${code}, nothing thrown`)
}

/** Quote the refusal into the test log so the report can cite it. */
async function refused(label: string, p: Promise<unknown> | (() => unknown), code: StoreErrorCode) {
  const e = await expectCode(p, code)
  console.log(`[row119a] refused ${label}: ${code} ${JSON.stringify(e.details ?? {})}`)
  return e.details ?? {}
}

// ── fixtures ────────────────────────────────────────────────────────────────

const PROJECT = { dir: "/private/tmp/claude-501/row119a/project" }
const SES_A = "ses_0123456789abAbCdEfGhIjKlMn"
const SES_B = "ses_fedcba987654ZyXwVuTsRqPoNm"

function row(id: string, phase: string, kind: MissionRowInput["kind"], over: Partial<MissionRowInput> = {}): MissionRowInput {
  return { id, phase, kind, title: `Row ${id} ${kind}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", ...over }
}

function mission(id: string, type: string, rows: MissionRowInput[], over: Partial<NewMission> = {}): NewMission {
  return { id, title: `Mission ${id}`, type, owner: "master-controller", project: PROJECT, rows, ...over }
}

const U1 = { id: "U1", by: "user" as const, date: "2026-11-07", text: "User approves the blueprint (full autonomy)" }
const C1 = { id: "C1", by: "controller" as const, date: "2026-11-07", text: "Controller notes the plan" }

const store = await openStore("main")
const M = store.missions
const tx = <R>(fn: (t: Parameters<Parameters<SqliteStudioStore["transaction"]>[0]>[0]) => R) => store.transaction(async (t) => fn(t))

// ── 1. migration, schema and data hashes ─────────────────────────────────────

describe("migration 0003 and the contract files", () => {
  test("0003 applied after 0002; spec DDL, schema and builtin types match the row 118 hashes; ajv strict compiles", () => {
    expect(sha256Hex(MIGRATION_0003_SPEC_SQL)).toBe(MIGRATION_0003_SPEC_SHA256)
    expect(sha256Hex(canonicalJson(MISSION_SCHEMA_V1))).toBe(MISSION_SCHEMA_V1_SHA256)
    expect(sha256Hex(canonicalJson(BUILTIN_MISSION_TYPES))).toBe(BUILTIN_MISSION_TYPES_SHA256)
    expect(MIGRATIONS.map((m) => m.id)).toEqual([ID_0001, ID_0002, ID_0003, ID_0004, ID_0005, ID_0006, ID_0007])
    expect(latestSchemaId()).toBe(ID_0007)
    for (const t of BUILTIN_MISSION_TYPES) expect(checkMissionSchema("root", t)).toEqual([])
    const db = openSqlite(join(RUN, "main", "datum-studio.sqlite"), { readonly: true })
    try {
      const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mission%' AND name NOT LIKE 'mission_fts_%' ORDER BY name").map((r) => r.name)
      expect(tables).toEqual([
        "mission",
        "mission_decision",
        "mission_decision_request",
        "mission_document",
        "mission_event",
        "mission_finding",
        "mission_fts",
        "mission_lock",
        "mission_message",
        "mission_report",
        "mission_row",
        "mission_row_checkpoint",
        "mission_row_dep",
        "mission_session",
        "mission_snapshot",
        "mission_type",
        "mission_type_phase",
      ])
      const pinned = db.all<{ id: string; version: number; n: number }>("SELECT t.id, t.version, (SELECT count(*) FROM mission_type_phase p WHERE p.type_id = t.id AND p.type_version = t.version) AS n FROM mission_type t ORDER BY t.id")
      expect(pinned.map((p) => `${p.id}@${p.version}:${p.n}`)).toEqual(["debug@1:4", "document@1:4", "feature-release@1:5", "research@1:4"])
      expect(db.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'schema_version'")!.value).toBe(ID_0007)
      console.log(`[row119a] runtime=${isBun ? "bun" : "node " + process.versions.node + " electron " + (process.versions.electron ?? "-")} driver=${db.driver} sqlite=${db.get<{ v: string }>("select sqlite_version() v")!.v} tables=${tables.length}`)
    } finally {
      db.close()
    }
  })

  test("a pinned type is never overwritten; a changed shipped definition is logged MISSION_TYPE_CHANGED", async () => {
    const s = await openStore("pin")
    await s.close()
    const db = openSqlite(join(RUN, "pin", "datum-studio.sqlite"))
    const seen: string[] = []
    try {
      const changed: MissionTypeDoc = { ...BUILTIN_MISSION_TYPES[0]!, name: { id: "Riset (ubah)", en: "Research (changed)" } }
      const r = pinBuiltinMissionTypes(db, clock(), (_l, _s, e) => seen.push(isStoreError(e) ? e.code : "?"), [changed])
      expect(r).toEqual({ pinned: [], changed: ["research@1"] })
      expect(seen).toEqual(["MISSION_TYPE_CHANGED"])
      expect(db.get<{ name_en: string }>("SELECT name_en FROM mission_type WHERE id = 'research'")!.name_en).toBe("Research")
      // raw driver errors are not mapped to StoreError; the trigger message is checked instead
      let msg = ""
      try {
        db.run("UPDATE mission_type SET name_en = 'x' WHERE id = 'research'")
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e)
      }
      expect(msg).toContain("MISSION_TYPE_IMMUTABLE")
    } finally {
      db.close()
    }
  })
})

// ── 2. types shape the phases (U20) ─────────────────────────────────────────

describe("mission types and phases (U20)", () => {
  const cases: Array<[string, string, MissionRowInput["kind"], string[]]> = [
    ["research", "research", "research", ["identification", "research", "synthesis", "report"]],
    ["debug", "reproduce", "reproduce", ["reproduce", "diagnose", "fix", "verify"]],
    ["feature-release", "implementation", "implementation", ["identification", "research", "implementation", "verification", "release"]],
    ["document", "draft", "draft", ["brief", "draft", "review", "publish"]],
  ]
  test("one mission of each of the 4 types reads back its own phases in order", async () => {
    for (const [type, phase, kind, phases] of cases) {
      const id = `2026-11-07_type-${type}`
      const out = await tx((t) => M.create(t, mission(id, type, [row("1", phase, kind)])))
      expect([out.id, out.status, out.rows]).toEqual([id, "draft", 1])
      const got = M.get(id)!
      expect([got.mission.type, got.mission.typeVersion]).toEqual([type, 1])
      expect(got.derived.phases.map((p) => p.id)).toEqual(phases)
      expect(got.derived.phases.find((p) => p.id === phase)!.rows).toEqual(["1"])
      console.log(`[row119a] type ${type}: phases ${got.derived.phases.map((p) => `${p.order}.${p.id}(${p.name.id}/${p.name.en})`).join(" -> ")}`)
    }
    expect(M.listTypes().map((t) => t.id)).toEqual(["debug", "document", "feature-release", "research"])
  })

  test("research has no implementation, debug has no research; unknown phase or type refused", async () => {
    await refused("implementation row in a research mission", tx((t) => M.create(t, mission("2026-11-07_bad-research", "research", [row("1", "synthesis", "implementation")]))), "KIND_NOT_ALLOWED")
    await refused("research row in a debug mission", tx((t) => M.create(t, mission("2026-11-07_bad-debug", "debug", [row("1", "diagnose", "research")]))), "KIND_NOT_ALLOWED")
    await refused("unknown phase", tx((t) => M.create(t, mission("2026-11-07_bad-phase", "debug", [row("1", "implementation", "fix")]))), "PHASE_UNKNOWN")
    await refused("unknown type", tx((t) => M.create(t, mission("2026-11-07_bad-type", "galaxy", []))), "MISSION_TYPE_UNKNOWN")
    await refused("second create with the same id", tx((t) => M.create(t, mission("2026-11-07_type-debug", "debug", []))), "MISSION_ID_TAKEN")
    // the trigger holds even when code is bypassed
    let msg = ""
    try {
      await store.transaction(async (t) => {
        t.run(
          "INSERT INTO mission_row (mission_id, row_id, phase_id, kind, title, agent, model_tier, size, output, verification, ord, time_created, time_updated) VALUES ('2026-11-07_type-research', '9', 'research', 'implementation', 't', 'a', 'thinker', 'S', 'o', 'v', 9, 1, 1)",
        )
      })
    } catch (e) {
      msg = isStoreError(e) ? e.code : String(e)
    }
    expect(msg).toBe("KIND_NOT_ALLOWED")
    expect(M.get("2026-11-07_bad-research")).toBeNull()
  })
})

// ── 3. approve, B/C deps, transitions ───────────────────────────────────────

const FR = "2026-11-07_feature-a"

describe("approve, dependencies and status transitions", () => {
  test("approve needs rows and a user decision", async () => {
    await tx((t) => M.create(t, mission("2026-11-07_empty", "feature-release", [], { decisions: [U1] })))
    await refused("approve without rows", tx((t) => M.approve(t, "2026-11-07_empty", "U1")), "MISSION_EMPTY")
    await tx((t) =>
      M.create(
        t,
        mission(FR, "feature-release", [row("1", "implementation", "implementation"), row("2", "implementation", "implementation", { deps: ["1:B"] }), row("3", "implementation", "test", { deps: ["1:C"] }), row("4", "verification", "review", { deps: ["2:B", "3:B"] })], {
          decisions: [U1, C1],
        }),
      ),
    )
    await refused("approve without decision", tx((t) => M.approve(t, FR, undefined)), "DECISION_REQUIRED")
    await refused("approve with unknown decision", tx((t) => M.approve(t, FR, "U9")), "DECISION_UNKNOWN")
    await refused("approve with a controller decision", tx((t) => M.approve(t, FR, "C1")), "APPROVAL_NEEDS_USER_DECISION")
    await refused("row running before approval", tx((t) => M.updateRows(t, FR, [{ id: "1", status: "running" }])), "MISSION_NOT_APPROVED")
    const a = await tx((t) => M.approve(t, FR, "U1", { actor: "master-controller" }))
    expect([a.status, typeof a.snapshotId]).toEqual(["approved", "string"])
    expect(M.listSnapshots(FR).map((s) => [s.reason, s.body.missionStatus, s.body.counts.pending])).toEqual([["approve", "approved", 4]])
    const d = await refused("approve twice", tx((t) => M.approve(t, FR, "U1")), "STATUS_TRANSITION")
    expect(d).toEqual({ from: "approved", to: "approved", allowed: ["running", "paused", "cancelled"] })
  })

  test("B dependency blocks the start, C dependency does not; waves and ready derived", async () => {
    const before = M.get(FR)!.derived
    expect(before.waves).toEqual([
      { wave: 1, rows: ["1", "3"] },
      { wave: 2, rows: ["2"] },
      { wave: 3, rows: ["4"] },
    ])
    expect(before.ready).toEqual(["1", "3"])
    const d = await refused("B row before its dependency is done", tx((t) => M.updateRows(t, FR, [{ id: "2", status: "running" }])), "DEP_NOT_DONE")
    expect(d.open).toEqual(["1"])
    const ok = await tx((t) => M.updateRows(t, FR, [{ id: "3", status: "running" }]))
    expect(ok.changed).toEqual(["3"])
    expect(M.get(FR)!.mission.status).toBe("running") // approved -> running with the first running row
    await tx((t) => M.updateRows(t, FR, [{ id: "1", status: "running" }, { id: "1", status: "needs-review" }, { id: "1", status: "done" }]))
    const r2 = await tx((t) => M.updateRows(t, FR, [{ id: "2", status: "running" }]))
    expect(r2.ready).toEqual([])
    const g = M.get(FR)!
    expect(g.mission.rows.map((r) => [r.id, r.status, r.deps])).toEqual([
      ["1", "done", []],
      ["2", "running", ["1:B"]],
      ["3", "running", ["1:C"]],
      ["4", "pending", ["2:B", "3:B"]],
    ])
    expect(g.derived.progress).toEqual({ done: 1, total: 4 })
  })

  test("dependency refusals: self, unknown, cycle, dropped; structural change after approval needs a decision", async () => {
    await refused("dep on itself", tx((t) => M.updateRows(t, FR, [{ id: "4", set: { deps: ["4:B"] } }], { decision: "C1" })), "DEP_SELF")
    await refused("dep on unknown row", tx((t) => M.updateRows(t, FR, [{ id: "4", set: { deps: ["77:B"] } }], { decision: "C1" })), "DEP_UNKNOWN")
    const cyc = await refused("B cycle", tx((t) => M.updateRows(t, FR, [{ id: "1", set: { deps: ["4:B"] } }], { decision: "C1" })), "DEP_CYCLE")
    expect(cyc.cycle).toEqual(["1", "4", "2", "1"])
    await refused("structural change without decision", tx((t) => M.updateRows(t, FR, [{ id: "4", set: { title: "Review all" } }])), "DECISION_REQUIRED")
    await refused("add row after approval without decision", tx((t) => M.updateRows(t, FR, [{ id: "5", add: row("5", "release", "release") }])), "DECISION_REQUIRED")
    await tx((t) => M.updateRows(t, FR, [{ id: "5", add: row("5", "release", "release", { deps: ["4:B"] }) }], { decision: "C1" }))
    await refused("drop a row others B-depend on", tx((t) => M.updateRows(t, FR, [{ id: "4", status: "dropped", note: "not needed" }], { decision: "C1" })), "DEP_DROPPED")
    await refused("drop without note", tx((t) => M.updateRows(t, FR, [{ id: "5", status: "dropped" }], { decision: "C1" })), "SCHEMA_INVALID")
    const changed = await tx((t) => M.updateRows(t, FR, [{ id: "4", set: { title: "Review rows 2 and 3" }, note: "scope narrowed" }], { decision: "C1" }))
    expect(changed.changed).toEqual(["4"])
    const r4 = M.get(FR)!.mission.rows.find((r) => r.id === "4")!
    expect([r4.title, r4.note, r4.decision]).toEqual(["Review rows 2 and 3", "scope narrowed", "C1"])
  })

  test("invalid transitions are STATUS_TRANSITION {from, to, allowed}; paused mission: no row may go running", async () => {
    const d1 = await refused("row pending -> done", tx((t) => M.updateRows(t, FR, [{ id: "4", status: "done" }])), "STATUS_TRANSITION")
    expect(d1).toEqual({ row: "4", from: "pending", to: "done", allowed: ["running", "blocked", "dropped"] })
    const d2 = await refused("mission running -> draft", tx((t) => M.setStatus(t, FR, "draft")), "STATUS_TRANSITION")
    expect(d2).toEqual({ from: "running", to: "draft", allowed: ["paused", "done", "cancelled"] })
    const draftOnly = await refused("mission draft -> running", tx((t) => M.setStatus(t, "2026-11-07_empty", "running")), "STATUS_TRANSITION")
    expect(draftOnly).toEqual({ from: "draft", to: "running", allowed: ["approved", "cancelled"] })
    await tx((t) => M.setStatus(t, FR, "paused", { note: "owner pause" }))
    await tx((t) => M.updateRows(t, FR, [{ id: "2", status: "needs-review" }, { id: "3", status: "needs-review" }, { id: "2", status: "done" }, { id: "3", status: "done" }]))
    await refused("row running while paused", tx((t) => M.updateRows(t, FR, [{ id: "4", status: "running" }])), "MISSION_PAUSED")
    await tx((t) => M.setStatus(t, FR, "running"))
    const open = await refused("done with open rows", tx((t) => M.setStatus(t, FR, "done")), "MISSION_ROWS_OPEN")
    expect(open.rows).toEqual(["4", "5"])
    await tx((t) =>
      M.updateRows(t, FR, [
        { id: "4", status: "running" },
        { id: "4", status: "needs-review" },
        { id: "4", status: "done" },
        { id: "5", status: "running" },
        { id: "5", status: "needs-review" },
        { id: "5", status: "done" },
      ]),
    )
    const done = await tx((t) => M.setStatus(t, FR, "done"))
    expect([done.from, done.to]).toEqual(["running", "done"])
    await refused("write to a done mission", tx((t) => M.recordDecision(t, FR, { id: "C2", by: "controller", date: "2026-11-07", text: "late" })), "MISSION_CLOSED")
    expect(M.listSnapshots(FR).map((s) => `${s.reason}:${s.body.missionStatus}`)).toEqual(["approve:approved", "status:running", "status:paused", "status:running", "status:done"])
    const verbs = M.listEvents(FR).map((e) => e.verb)
    expect(verbs[0]).toBe("create")
    expect(verbs.filter((v) => v === "status").length).toBe(4)
  })
})

// ── 4. superseded-by, sessions ──────────────────────────────────────────────

describe("superseded-by and many-to-many sessions", () => {
  test("a cancelled mission names the mission that supersedes it", async () => {
    const OLD = "2026-11-06_swarm_1_1_4_patch"
    const NEW = "2026-11-06_swarm_1_2_0_datum_installer"
    await tx((t) => M.create(t, mission(NEW, "feature-release", [row("1", "identification", "intake")], { decisions: [U1] })))
    await tx((t) => M.create(t, mission(OLD, "feature-release", [row("1", "implementation", "fix")], { decisions: [{ id: "U3", by: "user", date: "2026-11-06", text: "1.2.0 replaces the 1.1.4 patch" }] })))
    await refused("cancel without decision", tx((t) => M.setStatus(t, OLD, "cancelled", { supersededBy: NEW })), "DECISION_REQUIRED")
    await refused("superseded by itself", tx((t) => M.setStatus(t, OLD, "cancelled", { decision: "U3", supersededBy: OLD })), "SUPERSEDE_TARGET")
    await refused("superseded by unknown", tx((t) => M.setStatus(t, OLD, "cancelled", { decision: "U3", supersededBy: "2026-11-06_nope" })), "SUPERSEDE_TARGET")
    await tx((t) => M.setStatus(t, OLD, "cancelled", { decision: "U3", supersededBy: NEW }))
    const got = M.get(OLD)!.mission
    expect([got.status, got.supersededBy, typeof got.closedAt]).toEqual(["cancelled", NEW, "string"])
    expect(checkMissionSchema("MissionDoc", got)).toEqual([])
    await refused("a row into a cancelled mission", tx((t) => M.updateRows(t, OLD, [{ id: "2", add: row("2", "implementation", "fix") }], { decision: "U3" })), "MISSION_CLOSED")
  })

  test("one session holds two missions; one mission spans two sessions; list by session returns both", async () => {
    const A = "2026-11-07_session-a"
    const B = "2026-11-07_session-b"
    await tx((t) => M.create(t, mission(A, "research", [row("1", "research", "research")], { sessions: [{ client: "swarm", ref: SES_A, role: "controller" }] })))
    await tx((t) => M.create(t, mission(B, "debug", [row("1", "reproduce", "reproduce")]), { session: { client: "swarm", ref: SES_A, role: "controller" } }))
    await tx((t) => M.linkSession(t, A, { client: "swarm", ref: SES_B, role: "driver" }))
    await tx((t) => M.linkSession(t, A, { client: "claude", ref: "claude-session.42", role: "viewer" }))
    const listed = M.list({ session: { client: "swarm", ref: SES_A } })
    expect(listed.items.map((i) => i.id).sort()).toEqual([A, B])
    expect(listed.items.find((i) => i.id === A)!.phases.map((p) => p.id)).toEqual(["identification", "research", "synthesis", "report"])
    expect(M.list({ session: { client: "swarm", ref: SES_B } }).items.map((i) => i.id)).toEqual([A])
    expect(M.get(A)!.mission.sessions!.map((s) => `${s.client}:${s.ref}:${s.role}`)).toEqual([`swarm:${SES_A}:controller`, `swarm:${SES_B}:driver`, "claude:claude-session.42:viewer"])
    await refused("swarm session ref of the wrong shape", tx((t) => M.linkSession(t, A, { client: "swarm", ref: "not-a-session" })), "SCHEMA_INVALID")
    // paging: keyset cursor, no duplicates
    const p1 = M.list({ take: 2 })
    const p2 = M.list({ take: 2, cursor: p1.nextCursor! })
    expect(p1.items.length).toBe(2)
    expect(p2.items.some((i) => p1.items.some((j) => j.id === i.id))).toBe(false)
  })
})

// ── 5. C57: decision requests, checkpoints, messages, owner instructions ─────

const RS = "2026-11-07_research-c57"

describe("C57 entities", () => {
  test("a decision request with two options + recommended blocks its row until answered once", async () => {
    await tx((t) => M.create(t, mission(RS, "research", [row("1", "research", "research"), row("2", "synthesis", "synthesis", { deps: ["1:C"] })], { decisions: [U1] })))
    await tx((t) => M.approve(t, RS, "U1"))
    const req = await tx((t) =>
      M.requestDecision(
        t,
        RS,
        {
          id: "D-07",
          question: "Which data source does the synthesis use?",
          context: "Two sources disagree on the 2025 figures",
          options: [
            { id: "A", label: "Official statistics", consequence: "Slower, citable" },
            { id: "B", label: "Vendor survey", consequence: "Faster, needs a caveat" },
          ],
          recommended: "A",
          blockingRows: ["2"],
        },
        { actor: "master-controller" },
      ),
    )
    expect([req.status, req.recommended, req.blockingRows]).toEqual(["open", "A", ["2"]])
    expect(M.get(RS)!.derived.ready).toEqual(["1"])
    await refused("blocked row starts while the request is open", tx((t) => M.updateRows(t, RS, [{ id: "2", status: "running" }])), "DECISION_PENDING")
    await refused("answer with an option not offered", tx((t) => M.answerDecision(t, RS, "D-07", { option: "C", by: "user", decisionId: "U2" })), "OPTION_UNKNOWN")
    await refused("request with one option", tx((t) => M.requestDecision(t, RS, { id: "D-08", question: "q", options: [{ id: "A", label: "a", consequence: "c" }] })), "SCHEMA_INVALID")
    const ans = await tx((t) => M.answerDecision(t, RS, "D-07", { option: "A", by: "user", decisionId: "U2" }))
    expect([ans.request.status, ans.request.answer, ans.decision.id, ans.decision.by, ans.released]).toEqual(["answered", { option: "A", by: "user", decision: "U2" }, "U2", "user", ["2"]])
    expect(ans.decision.text).toBe("Which data source does the synthesis use? -> Official statistics (D-07)")
    await refused("second answer", tx((t) => M.answerDecision(t, RS, "D-07", { option: "B", by: "user", decisionId: "U3" })), "DECISION_REQUEST_CLOSED")
    await refused("answer by user with a C id", tx((t) => M.requestDecision(t, RS, { id: "D-09", question: "q2", options: [{ id: "A", label: "a", consequence: "c" }, { id: "B", label: "b", consequence: "d" }] }).id && M.answerDecision(t, RS, "D-09", { option: "A", by: "user", decisionId: "C9" })), "SCHEMA_INVALID")
    await tx((t) => M.updateRows(t, RS, [{ id: "2", status: "running" }]))
    expect(M.listDecisionRequests(RS).map((r) => `${r.id}:${r.status}`)).toEqual(["D-07:answered"])
  })

  test("row checkpoints, message log and an owner instruction are stored and listed in order", async () => {
    await tx((t) => M.recordCheckpoint(t, RS, "2", { n: 1, m: 4, label: "sources read" }, { actor: "data-analyst" }))
    await tx((t) => M.recordCheckpoint(t, RS, "2", { n: 3, m: 4, label: "draft written" }, { actor: "data-analyst" }))
    await refused("checkpoint n > m", tx((t) => M.recordCheckpoint(t, RS, "2", { n: 5, m: 4 })), "SCHEMA_INVALID")
    await tx((t) => M.postMessage(t, RS, { from: "controller", to: "agent", kind: "instruction", text: "Use source A only", row: "2", actor: "master-controller" }))
    await tx((t) => M.postMessage(t, RS, { from: "agent", to: "controller", kind: "question", text: "Include 2024 too?", row: "2", actor: "data-analyst" }))
    await tx((t) => M.ownerInstruction(t, RS, "Stop after the synthesis; I review before the report."))
    await refused("message to oneself", tx((t) => M.postMessage(t, RS, { from: "owner", to: "owner", kind: "instruction", text: "x" })), "SCHEMA_INVALID")
    const cps = M.listCheckpoints(RS, "2")
    expect(cps.map((c) => [c.n, c.m, c.label, c.actor])).toEqual([
      [1, 4, "sources read", "data-analyst"],
      [3, 4, "draft written", "data-analyst"],
    ])
    const got = M.get(RS)!.derived
    expect([got.checkpoints["2"]!.n, got.checkpoints["2"]!.m]).toEqual([3, 4])
    expect(got.progress).toEqual({ done: 0, total: 2 }) // mission progress is rows, not checkpoints
    const msgs = M.listMessages(RS)
    expect(msgs.map((m) => `${m.from}>${m.to}:${m.kind}:${m.text}`)).toEqual([
      "controller>agent:instruction:Use source A only",
      "agent>controller:question:Include 2024 too?",
      "owner>controller:instruction:Stop after the synthesis; I review before the report.",
    ])
    expect(msgs[0]!.seq < msgs[1]!.seq && msgs[1]!.seq < msgs[2]!.seq).toBe(true)
    expect(M.listMessages(RS, { from: "owner", kind: "instruction" }).map((m) => m.text)).toEqual(["Stop after the synthesis; I review before the report."])
    expect(M.listMessages(RS, { afterSeq: msgs[1]!.seq }).length).toBe(1)
    let msg = ""
    try {
      await store.transaction(async (t) => {
        t.run("UPDATE mission_message SET text = 'changed' WHERE mission_id = ?", [RS])
      })
    } catch (e) {
      msg = isStoreError(e) ? e.code : String(e)
    }
    expect(msg).toBe("MESSAGE_IMMUTABLE")
  })

  test("mission_fts finds decision text; list {q} returns the mission with a snippet", async () => {
    const hits = M.search("official statistics")
    expect(hits.some((h) => h.mission === RS && h.refKind === "decision" && h.refId === "U2")).toBe(true)
    const u2 = hits.find((h) => h.refId === "U2")!
    expect(u2.snippet).toContain("[[Official]] [[statistics]]")
    expect(M.search("blueprint full autonomy", { mission: FR }).map((h) => `${h.refKind}:${h.refId}`)).toEqual(["decision:U1"])
    const l = M.list({ q: "official statistics" })
    expect(l.items.map((i) => i.id)).toEqual([RS])
    expect(String(l.items[0]!.snippet)).toContain("[[")
    console.log(`[row119a] mission_fts "official statistics": ${JSON.stringify(u2)}`)
  })
})

// ── 6. findings, locks, reports, malformed records ──────────────────────────

const LK = "2026-11-07_locks"

describe("findings, locks, reports and malformed records", () => {
  test("shared-resource lock: one holder across missions, released then taken", async () => {
    await tx((t) => M.create(t, mission(LK, "feature-release", [row("28", "implementation", "implementation", { resources: ["lockfile"] })], { decisions: [U1] })))
    await tx((t) => M.approve(t, LK, "U1"))
    await tx((t) => M.updateRows(t, RS, [{ id: "1", acquire: ["lockfile"] }]))
    const d = await refused("second holder of lockfile", tx((t) => M.updateRows(t, LK, [{ id: "28", acquire: ["lockfile"] }])), "LOCK_HELD")
    expect(d).toEqual({ resource: "lockfile", mission: RS, row: "1", holder: "swarm" })
    await tx((t) => M.updateRows(t, RS, [{ id: "1", release: ["lockfile"] }]))
    await tx((t) => M.updateRows(t, LK, [{ id: "28", acquire: ["lockfile"] }]))
    expect(M.list({ status: ["running", "approved"] }).items.find((i) => i.id === LK)!.heldLocks).toEqual(["lockfile"])
    await refused("release a lock not held", tx((t) => M.updateRows(t, LK, [{ id: "28", release: ["build"] }])), "LOCK_NOT_HELD")
  })

  test("findings: open needs an owner row, deferred needs a decision; upsert records status change", async () => {
    await refused("deferred without decision", tx((t) => M.recordFinding(t, LK, { id: "28-C9", severity: "low", title: "Stale offer", sourceRow: "28", status: "deferred" })), "SCHEMA_INVALID")
    await tx((t) => M.recordFinding(t, LK, { id: "28-M1", severity: "medium", title: "Patch routed", sourceRow: "28", ownerRow: "28", status: "open" }))
    await tx((t) => M.recordFinding(t, LK, { id: "28-M1", severity: "medium", title: "Patch routed", sourceRow: "28", status: "accepted", decision: "U1" }))
    expect(M.get(LK)!.mission.findings).toEqual([{ id: "28-M1", severity: "medium", title: "Patch routed", sourceRow: "28", status: "accepted", decision: "U1" }])
    expect(M.listEvents(LK).filter((e) => e.verb === "finding").map((e) => `${e.from ?? "-"}>${e.to}`)).toEqual(["->open", "open>accepted"])
  })

  test("report link + row effect; work report without mission refused when the guard is on", async () => {
    const tv = await store.transaction((t) => store.pinBuiltinVersion(t, builtinFile()))
    const doc = await store.transaction((t) => store.createDocument(t, newDoc(tv.id, { missionFolder: LK, missionDocKey: "row-28" })))
    await refused("row report with a wrong docKey", tx((t) => M.linkReport(t, { documentId: doc.id, mission: LK, kind: "row", row: "28", docKey: "row-29" })), "DOC_KEY_MISMATCH")
    const out = await tx((t) => M.recordReport(t, { documentId: doc.id, revisionNo: 1, mission: LK, kind: "row", row: "28", docKey: "row-28", status: "complete" }))
    expect(out).toEqual({ mission: LK, row: "28", rowStatus: "needs-review" })
    expect(M.get(LK)!.mission.rows[0]!.reports).toEqual([{ documentId: doc.id, revisionNo: 1, kind: "row" }])
    const blocked = await tx((t) => M.applyReport(t, { documentId: doc.id, revisionNo: 2, status: "blocked" }))
    expect(blocked.rowStatus).toBe("blocked")
    expect(M.get(LK)!.mission.rows[0]!.note).toBe(`blocked: report ${doc.id} rev 2`)

    const g = await openStore("guarded", { missionGuard: true })
    expect([g.missionGuardEnabled, store.missionGuardEnabled]).toEqual([true, false]) // row 119d: public read of the flag
    const gtv = await g.transaction((t) => g.pinBuiltinVersion(t, builtinFile()))
    await refused("work report without a mission id", g.transaction((t) => g.createDocument(t, newDoc(gtv.id, { contract: { kind: "agentWorkReport", status: "complete" } }))), "MISSION_REQUIRED")
    await refused("work report for an unknown mission", g.transaction((t) => g.createDocument(t, newDoc(gtv.id, { missionFolder: "2026-11-07_none", missionDocKey: "row-1", contract: { kind: "agentWorkReport" } }))), "MISSION_NOT_FOUND")
    await g.transaction(async (t) => g.missions.create(t, mission("2026-11-07_guarded", "debug", [row("1", "reproduce", "reproduce")], { decisions: [U1] })))
    const linked = await g.transaction((t) => g.createDocument(t, newDoc(gtv.id, { missionFolder: "2026-11-07_guarded", missionDocKey: "row-1", contract: { kind: "agentWorkReport", status: "draft" } })))
    expect(g.missions.get("2026-11-07_guarded")!.mission.rows[0]!.reports!.map((r) => r.documentId)).toEqual([linked.id])
    const client = await g.transaction((t) => g.createDocument(t, newDoc(gtv.id, {})))
    expect(typeof client.id).toBe("string") // a client document keeps mission optional
  })

  test("malformed records are refused with the §6 code", async () => {
    await refused("row size L", tx((t) => M.create(t, mission("2026-11-07_bad-size", "debug", [row("1", "reproduce", "reproduce", { size: "L" as never })]))), "SCHEMA_INVALID")
    await refused("worker without reason", tx((t) => M.create(t, mission("2026-11-07_bad-model", "debug", [row("1", "reproduce", "reproduce", { model: { tier: "worker" } })]))), "SCHEMA_INVALID")
    await refused("worker-fast without reason", tx((t) => M.create(t, mission("2026-11-07_bad-model2", "debug", [row("1", "reproduce", "reproduce", { model: { tier: "worker-fast" } })]))), "SCHEMA_INVALID")
    await refused("dep without kind", tx((t) => M.create(t, mission("2026-11-07_bad-dep", "debug", [row("1", "reproduce", "reproduce", { deps: ["2"] })]))), "SCHEMA_INVALID")
    await refused("mission id with a space", tx((t) => M.create(t, mission("swarm 1.2.0", "debug", []))), "SCHEMA_INVALID")
    await refused("U decision by the controller", tx((t) => M.recordDecision(t, RS, { id: "U5", by: "controller", date: "2026-11-07", text: "x" })), "SCHEMA_INVALID")
    await refused("host field createdAt", tx((t) => M.create(t, { ...mission("2026-11-07_bad-host", "debug", []), createdAt: "2026-11-07T00:00:00Z" } as never)), "FIELD_READ_ONLY")
    await refused("decision id twice", tx((t) => M.recordDecision(t, RS, U1)), "DECISION_ID_TAKEN")
    let msg = ""
    try {
      await store.transaction(async (t) => {
        t.run("UPDATE mission_decision SET text = 'rewritten' WHERE mission_id = ? AND decision_id = 'U1'", [RS])
      })
    } catch (e) {
      msg = isStoreError(e) ? e.code : String(e)
    }
    expect(msg).toBe("DECISION_IMMUTABLE")
    expect(M.get("2026-11-07_bad-size")).toBeNull()
  })
})

// ── 7. an existing 0002 store migrates to 0003 ──────────────────────────────

const DEF = { schema: "studio.template/v2", slug: "nota-dinas", slots: [{ slotKey: "isi" }] }
function builtinFile(over: Partial<BuiltinTemplateFile> = {}): BuiltinTemplateFile {
  return { slug: "nota-dinas", name: "Nota Dinas", kind: "DOCUMENT", versionNo: 1, definition: DEF, definitionSha256: sha256Hex(canonicalJson(DEF)), file: "nota-dinas.json", fileSha256: "a".repeat(64), release: RELEASE, ...over }
}
let docSeq = 0
function newDoc(tvId: string, over: Record<string, unknown>) {
  docSeq++
  return {
    docNumber: `${String(docSeq).padStart(3, "0")}/GSP/LKA/XI/2026`,
    numberSource: "AGENT" as const,
    title: `Laporan ${docSeq}`,
    typeCode: "LKA",
    classification: "TERBATAS",
    tier: "NOTA" as const,
    templateVersionId: tvId,
    createdBy: "swarm",
    revision: { snapshot: { n: docSeq }, inputSha256: sha256Hex(`d${docSeq}`), docRev: "A", change: { what: "w", why: "y", impact: "i" }, createdBy: "swarm" },
    ...over,
  }
}

function counts(file: string): Record<string, number> {
  const db = openSqlite(file, { readonly: true })
  try {
    const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'doc_block_fts_%' AND name NOT LIKE 'mission%' AND name <> 'output_verification' ORDER BY name").map((r) => r.name)
    return Object.fromEntries(names.map((n) => [n, Number(db.get<{ n: number }>(`SELECT count(*) AS n FROM "${n}"`)!.n)]))
  } finally {
    db.close()
  }
}

function contentSha(file: string): string {
  const db = openSqlite(file, { readonly: true })
  try {
    return sha256Hex(JSON.stringify([db.all("SELECT * FROM template ORDER BY id"), db.all("SELECT * FROM template_version ORDER BY id"), db.all("SELECT * FROM document ORDER BY id"), db.all("SELECT * FROM revision ORDER BY id")]))
  } finally {
    db.close()
  }
}

describe("migration 0003 on an existing 0002 store", () => {
  test("0002 store with documents and templates migrates; counts and contents unchanged; mission tables added", async () => {
    const dir = join(RUN, "upgrade")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "datum-studio.sqlite")
    const db = openSqlite(file)
    try {
      db.get("PRAGMA journal_mode = WAL")
      db.exec("PRAGMA foreign_keys = ON")
      expect(applyMigrations(db, { release: "1.2.0-pre119", now: clock }, MIGRATIONS.filter((m) => m.seq <= 2))).toEqual([ID_0001, ID_0002])
      const t0 = clock()
      const tB = newId()
      const vB = newId()
      db.run("INSERT INTO template (id, slug, origin, name, kind, latest_version_no, created_by, time_created, time_updated) VALUES (?, 'nota-dinas', 'builtin', 'Nota Dinas', 'DOCUMENT', 1, 'swarm', ?, ?)", [tB, t0, t0])
      db.run(
        `INSERT INTO template_version (id, template_id, version_no, definition, definition_sha256, overrides, resolved_params, params_sha256, role_formats, section_plan, assets, provenance, change_note, created_by, time_created, guard_verdict)
         VALUES (?, ?, 1, ?, ?, '{}', '{}', ?, '{}', '[]', '[]', '{"origin":"test"}', 'v1', 'swarm', ?, 'pass')`,
        [vB, tB, JSON.stringify(DEF), sha256Hex(canonicalJson(DEF)), sha256Hex("{}"), t0],
      )
      for (let n = 1; n <= 3; n++) {
        const id = newId()
        db.run(
          "INSERT INTO document (id, doc_number, doc_number_safe, number_source, title, type_code, classification, tier, template_id, current_revision_no, mission_folder, mission_doc_key, created_by, time_created, time_updated) VALUES (?, ?, ?, 'AGENT', ?, 'KT', 'TERBATAS', 'NOTA', ?, 1, ?, ?, 'swarm', ?, ?)",
          [id, `00${n}/GSP/KT/XI/2026`, `00${n}-GSP-KT-XI-2026`, `Dokumen ${n}`, tB, n === 1 ? "2026-11-06_old-mission" : null, n === 1 ? "row-1" : null, t0, t0],
        )
        db.run(
          `INSERT INTO revision (id, document_id, revision_no, template_version_id, snapshot, snapshot_sha256, input_sha256, doc_rev, change_what, change_why, change_impact, created_by, time_created)
           VALUES (?, ?, 1, ?, ?, ?, ?, 'A', 'w', 'y', 'i', 'swarm', ?)`,
          [newId(), id, vB, JSON.stringify({ n }), "d".repeat(64), "e".repeat(64), t0],
        )
      }
    } finally {
      db.close()
    }
    const before = counts(file)
    const shaBefore = contentSha(file)
    expect([before.template, before.template_version, before.document, before.revision, before.migration]).toEqual([1, 1, 3, 3, 2])

    const s = await openStore("upgrade")
    await s.close()
    const after = counts(file)
    console.log(`[row119a] 0002 -> 0003 counts before ${JSON.stringify(before)}`)
    console.log(`[row119a] 0002 -> 0003 counts after  ${JSON.stringify(after)}`)
    expect({ ...after, migration: after.migration! - 5 }).toEqual(before) // row 149: + 0004, row 166: + 0005, row 188: + 0006, 1.2.6 row 86: + 0007
    expect(contentSha(file)).toBe(shaBefore)
    const r = openSqlite(file, { readonly: true })
    try {
      expect(r.all<{ id: string }>("SELECT id FROM migration ORDER BY id").map((x) => x.id)).toEqual([ID_0001, ID_0002, ID_0003, ID_0004, ID_0005, ID_0006, ID_0007])
      expect(r.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'schema_version'")!.value).toBe(ID_0007)
      expect(r.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'created_by_release'")!.value).toBe("1.2.0-pre119")
      expect(Number(r.get<{ n: number }>("SELECT count(*) AS n FROM mission_type")!.n)).toBe(4)
      expect(Number(r.get<{ n: number }>("SELECT count(*) AS n FROM mission")!.n)).toBe(0)
      expect(r.get<{ integrity_check: string }>("PRAGMA integrity_check")!.integrity_check).toBe("ok")
      expect(r.all("PRAGMA foreign_key_check")).toEqual([])
    } finally {
      r.close()
    }
    const again = await openStore("upgrade")
    expect(again.missions.listTypes().length).toBe(4)
    await again.close()
    expect(counts(file).migration).toBe(7) // row 149: + 0004, row 166: + 0005, row 188: + 0006, 1.2.6 row 86: + 0007
  })
})

// keep the readFileSync import meaningful: the spec DDL in the repo equals the row 118 probe file when it is present
test("spec DDL equals the row 118 probe file (when the scratch file exists)", () => {
  const p = "/private/tmp/claude-501/row118/schema/0003_datum_mission.sql"
  let text: string | null = null
  try {
    text = readFileSync(p, "utf8")
  } catch {
    text = null
  }
  if (text !== null) expect(text).toBe(MIGRATION_0003_SPEC_SQL)
})
