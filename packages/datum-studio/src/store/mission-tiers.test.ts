/**
 * Row 166: mission row model tiers are the GSP AI tiers of Swarm's bundled provider (thinker, worker, worker-fast,
 * inherit), not Claude Code's opus/sonnet. Migration 0005 rebuilds mission_row and maps stored rows; the schema
 * accepts only the new words and names them when it refuses an old one.
 */
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSqlite } from "#sqlite"
import { applyMigrations } from "./migrations/index.ts"
import { isStoreError, MIGRATION_0005_ID, MIGRATIONS, MISSION_MODEL_TIERS, SqliteStudioStore } from "./index.ts"
import { checkMissionSchema, pinBuiltinMissionTypes } from "./mission/index.ts"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const T = (isBun ? await import("bun:test") : await import("./test-harness.node.ts")) as unknown as typeof import("./test-harness.node.ts")
const { describe, test, expect } = T

const BASE = process.env.ROW166_TEST_DIR ?? join(tmpdir(), "row166-mission-tiers-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(join(BASE, `${isBun ? "bun" : "node"}-`))
let tick = 1_800_000_000_000
const clock = () => ++tick

const ROW_TRIGGERS = ["mission_closed_row", "mission_fts_row_ai", "mission_fts_row_au", "mission_row_kind_ins", "mission_row_phase_ins", "mission_row_phase_upd"]

function insertRow(db: ReturnType<typeof openSqlite>, mission: string, id: string, tier: string, reason: string | null, ord: number) {
  db.run(
    "INSERT INTO mission_row (mission_id, row_id, phase_id, kind, title, agent, model_tier, model_reason, size, output, verification, ord, time_created, time_updated) VALUES (?, ?, 'reproduce', 'reproduce', ?, 'coder-execution', ?, ?, 'S', 'o', 'v', ?, 1, 1)",
    [mission, id, `Row ${id} title`, tier, reason, ord],
  )
}

function sqlCode(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return "nothing thrown"
}

describe("migration 0005: mission_row model tiers", () => {
  test("a 0004 store holding opus/sonnet/inherit rows migrates to thinker/worker/inherit; deps, checkpoints, search, triggers kept", async () => {
    const dir = join(RUN, "upgrade")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "datum-studio.sqlite")
    const db = openSqlite(file)
    try {
      db.exec("PRAGMA foreign_keys = ON")
      expect(applyMigrations(db, { release: "1.2.0-pre166", now: clock }, MIGRATIONS.filter((m) => m.seq <= 4)).length).toBe(4)
      pinBuiltinMissionTypes(db, clock(), () => {})
      for (const id of ["2026-11-08_open", "2026-11-08_closed"]) {
        db.run("INSERT INTO mission (id, title, type_id, type_version, owner, project_dir, time_created, time_updated) VALUES (?, 't', 'debug', 1, 'master-controller', '/p', 1, 1)", [id])
        insertRow(db, id, "1", "opus", null, 1)
        insertRow(db, id, "2", "sonnet", "mechanical copy", 2)
        insertRow(db, id, "3", "inherit", null, 3)
        db.run("INSERT INTO mission_row_dep (mission_id, row_id, dep_row_id, kind, position) VALUES (?, '2', '1', 'B', 1)", [id])
        db.run("INSERT INTO mission_row_checkpoint (mission_id, row_id, n, m, actor, time_created) VALUES (?, '1', 1, 3, 'swarm', 1)", [id])
      }
      // a closed mission: its rows must survive although the closed-mission insert trigger would refuse a new row
      db.run("INSERT INTO mission_decision (mission_id, decision_id, by, date, text, time_created) VALUES ('2026-11-08_closed', 'U1', 'user', '2026-11-08', 'ok', 1)")
      db.run("UPDATE mission SET status = 'done', approval_decision_id = 'U1', time_approved = 2, time_closed = 3 WHERE id = '2026-11-08_closed'")
      expect(sqlCode(() => insertRow(db, "2026-11-08_open", "9", "thinker", null, 9))).toContain("CHECK constraint failed")
    } finally {
      db.close()
    }

    const db2 = openSqlite(file)
    try {
      db2.exec("PRAGMA foreign_keys = ON")
      const ftsBefore = Number(db2.get<{ n: number }>("SELECT count(*) AS n FROM mission_fts WHERE ref_kind = 'row'")!.n)
      expect(applyMigrations(db2, { release: "1.2.0", now: clock })).toEqual([MIGRATION_0005_ID])
      // the runner restores foreign keys after the rebuild
      expect(Number(db2.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys)).toBe(1)
      const tiers = db2.all<{ m: string; r: string; t: string; why: string | null }>("SELECT mission_id AS m, row_id AS r, model_tier AS t, model_reason AS why FROM mission_row ORDER BY m, r")
      console.log(`[row166] after 0005: ${JSON.stringify(tiers)}`)
      expect(tiers.map((x) => `${x.m}/${x.r}:${x.t}:${x.why ?? "-"}`)).toEqual([
        "2026-11-08_closed/1:thinker:-",
        "2026-11-08_closed/2:worker:mechanical copy",
        "2026-11-08_closed/3:inherit:-",
        "2026-11-08_open/1:thinker:-",
        "2026-11-08_open/2:worker:mechanical copy",
        "2026-11-08_open/3:inherit:-",
      ])
      expect(Number(db2.get<{ n: number }>("SELECT count(*) AS n FROM mission_row_dep")!.n)).toBe(2)
      expect(Number(db2.get<{ n: number }>("SELECT count(*) AS n FROM mission_row_checkpoint")!.n)).toBe(2)
      expect(Number(db2.get<{ n: number }>("SELECT count(*) AS n FROM mission_fts WHERE ref_kind = 'row'")!.n)).toBe(ftsBefore)
      expect(db2.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'mission_row' ORDER BY name").map((r) => r.name)).toEqual(ROW_TRIGGERS)
      expect(db2.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mission_row' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name)).toEqual(["mission_row_agent", "mission_row_status"])
      expect(db2.all("SELECT name FROM sqlite_master WHERE name = 'mission_row_tier_0005'")).toEqual([])
      expect(db2.get<{ integrity_check: string }>("PRAGMA integrity_check")!.integrity_check).toBe("ok")
      expect(db2.all("PRAGMA foreign_key_check")).toEqual([])
      // the new CHECKs: old words refused, a tier below thinker needs a reason, triggers still fire
      expect(sqlCode(() => insertRow(db2, "2026-11-08_open", "4", "opus", null, 4))).toContain("CHECK constraint failed")
      expect(sqlCode(() => insertRow(db2, "2026-11-08_open", "4", "worker-fast", null, 4))).toContain("CHECK constraint failed")
      expect(sqlCode(() => insertRow(db2, "2026-11-08_closed", "4", "thinker", null, 4))).toContain("MISSION_CLOSED")
      insertRow(db2, "2026-11-08_open", "4", "worker-fast", "lookup only", 4)
      expect(Number(db2.get<{ n: number }>("SELECT count(*) AS n FROM mission_fts WHERE ref_kind = 'row'")!.n)).toBe(ftsBefore + 1)
      // a dependency on a row is still enforced against the rebuilt table
      expect(sqlCode(() => db2.run("DELETE FROM mission_row WHERE mission_id = '2026-11-08_open' AND row_id = '1'"))).toContain("FOREIGN KEY constraint failed")
    } finally {
      db2.close()
    }

    // the store opens the migrated file and reads the new tiers
    const s = new SqliteStudioStore()
    await s.open(dir, { release: "1.2.0", log: () => {}, agentClock: clock })
    try {
      const m = s.missions.get("2026-11-08_open")
      expect(m?.mission.rows.map((r) => r.model)).toEqual([{ tier: "thinker" }, { tier: "worker", reason: "mechanical copy" }, { tier: "inherit" }, { tier: "worker-fast", reason: "lookup only" }])
    } finally {
      await s.close()
    }
  })
})

describe("studio.mission/v1 Model: GSP AI tiers only", () => {
  const base = { id: "1", phase: "reproduce", kind: "reproduce", title: "Row 1", agent: "coder-execution", deps: [], size: "S", status: "pending", output: "implementation/1.md", verification: "tests pass" }

  test("thinker, inherit, worker and worker-fast with a reason are accepted", () => {
    expect(MISSION_MODEL_TIERS).toEqual(["thinker", "worker", "worker-fast", "inherit"])
    for (const model of [{ tier: "thinker" }, { tier: "inherit" }, { tier: "worker", reason: "copy" }, { tier: "worker-fast", reason: "lookup" }, { tier: "thinker", reason: "optional" }]) {
      expect(checkMissionSchema("Row", { ...base, model })).toEqual([])
    }
  })

  test("opus and sonnet are refused with a message naming the allowed values; worker without a reason is refused", () => {
    for (const tier of ["opus", "sonnet", "haiku"]) {
      const issues = checkMissionSchema("Row", { ...base, model: { tier, reason: "x" } })
      const e = issues.find((i) => i.keyword === "enum")
      console.log(`[row166] tier ${tier}: ${JSON.stringify(e)}`)
      expect(e?.path).toBe("/model/tier")
      expect(e?.message).toBe("must be equal to one of the allowed values: thinker, worker, worker-fast, inherit")
    }
    for (const tier of ["worker", "worker-fast"]) {
      const issues = checkMissionSchema("Row", { ...base, model: { tier } })
      expect(issues.some((i) => i.keyword === "required" && i.path === "/model")).toBe(true)
    }
  })

  test("a store create with an old tier is SCHEMA_INVALID and the details name the allowed values", async () => {
    const s = new SqliteStudioStore()
    await s.open(join(RUN, "create"), { release: "1.2.0", log: () => {}, agentClock: clock })
    try {
      const err = await s
        .transaction(async (t) => s.missions.create(t, { id: "2026-11-08_old-tier", title: "t", type: "debug", owner: "master-controller", project: { dir: "/p" }, rows: [{ ...base, model: { tier: "opus" } } as never] }))
        .then(() => null, (e: unknown) => e)
      expect(isStoreError(err, "SCHEMA_INVALID")).toBe(true)
      expect(JSON.stringify((err as { details?: unknown }).details)).toContain("allowed values: thinker, worker, worker-fast, inherit")
    } finally {
      await s.close()
    }
  })
})
