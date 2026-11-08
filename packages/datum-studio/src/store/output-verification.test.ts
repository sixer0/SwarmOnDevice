/**
 * Row 149 tests: migration 0004 and the output verification store API
 * (masterplan/01_specs_output_verification.md §5, §7.1, §7.2; decisions U24, C130).
 * Runs under `bun test` and unchanged under Electron's Node (test-harness.node.ts), like store.test.ts.
 * Temp folders: ROW149_TEST_DIR, else ROW30_TEST_DIR, else the OS temp folder. Nothing outside it is written.
 */
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSqlite } from "#sqlite"
import type { SqlParam } from "./driver-types.ts"
import { applyMigrations } from "./migrations/index.ts"
import {
  canonicalJson,
  isStoreError,
  latestSchemaId,
  MIGRATION_0004_ID,
  MIGRATION_0004_SPEC_SHA256,
  MIGRATION_0004_SQL,
  MIGRATIONS,
  newId,
  OUTPUT_VERIFICATION_REPORT_MAX_BYTES,
  sha256Hex,
  SqliteStudioStore,
  STORE_ERROR_CODES,
  type NewOutputVerification,
  type StoreErrorCode,
  type StoreLogEntry,
} from "./index.ts"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const T = (isBun ? await import("bun:test") : await import("./test-harness.node.ts")) as unknown as typeof import("./test-harness.node.ts")
const { describe, test, expect, afterAll } = T

const BASE = process.env.ROW149_TEST_DIR ?? process.env.ROW30_TEST_DIR ?? join(tmpdir(), "row149-output-verification-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(join(BASE, `${isBun ? "bun" : "node"}-`))
const RELEASE = "1.2.1"
const ID_0001 = "20261106000000_datum_studio_init"
const ID_0002 = "20261106120000_datum_template_guard"
const ID_0003 = "20261107000000_datum_mission"
const ID_0004 = "20261107120000_datum_output_verification"
const ID_0006 = "20261108120000_datum_mission_autonomous_decision" // row 188: autonomous decision mark
const ID_0005 = "20261108000000_datum_mission_gsp_tiers" // row 166
const logs: StoreLogEntry[] = []
const opened: SqliteStudioStore[] = []
let tick = 1_800_000_000_000
const clock = () => ++tick
const RUNTIME = isBun ? "bun" : `node ${process.versions.node} electron ${process.versions.electron ?? "-"}`

async function openStore(name: string) {
  const s = new SqliteStudioStore()
  await s.open(join(RUN, name), { release: RELEASE, log: (e) => logs.push(e), agentClock: clock })
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

async function refused(label: string, p: Promise<unknown> | (() => unknown), code: StoreErrorCode) {
  const e = await expectCode(p, code)
  console.log(`[row149] refused ${label}: ${code} ${JSON.stringify(e.details ?? {})}`)
  return e.details ?? {}
}

// ── fixtures (plain SQL, so the test needs no render engine and no files) ─────

type Runner = { run(sql: string, params?: readonly SqlParam[]): unknown }
const SHA = (c: string) => c.repeat(64)
const CHECK_IDS = ["LINT", "OVERLAP_CLIP", "FIDELITY", "PAGE_COUNT", "FIGURE_FIT", "EMPTY_SLOTS"] as const

/** One template + version + document with `revs` revisions. Returns ids. */
function seedDocument(db: Runner, n: number, revs = 1): { templateVersionId: string; documentId: string; revisionIds: string[] } {
  const t0 = clock()
  const tId = newId()
  const vId = newId()
  db.run("INSERT INTO template (id, slug, origin, name, kind, latest_version_no, created_by, time_created, time_updated) VALUES (?, ?, 'user', ?, 'DOCUMENT', 1, 'swarm', ?, ?)", [tId, `user-tpl-${n}-${tId}`, `Tpl ${n}`, t0, t0])
  db.run(
    `INSERT INTO template_version (id, template_id, version_no, definition, definition_sha256, overrides, resolved_params, params_sha256, role_formats, section_plan, assets, provenance, change_note, created_by, time_created)
     VALUES (?, ?, 1, '{}', ?, '{}', '{}', ?, '{}', '[]', '[]', '{"origin":"test"}', 'v1', 'swarm', ?)`,
    [vId, tId, sha256Hex("{}"), sha256Hex("{}"), t0],
  )
  const documentId = newId()
  db.run(
    "INSERT INTO document (id, doc_number, doc_number_safe, number_source, title, type_code, classification, tier, template_id, current_revision_no, created_by, time_created, time_updated) VALUES (?, ?, ?, 'AGENT', ?, 'KT', 'TERBATAS', 'NOTA', ?, ?, 'swarm', ?, ?)",
    [documentId, `${n}/GSP/KT/XI/2026-${documentId}`, `${n}-GSP-KT-XI-2026-${documentId}`, `Dokumen ${n}`, tId, revs, t0, t0],
  )
  const revisionIds: string[] = []
  for (let r = 1; r <= revs; r++) {
    const id = newId()
    revisionIds.push(id)
    db.run(
      `INSERT INTO revision (id, document_id, revision_no, parent_revision_no, template_version_id, snapshot, snapshot_sha256, input_sha256, doc_rev, change_what, change_why, change_impact, created_by, time_created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'A', 'w', 'y', 'i', 'swarm', ?)`,
      [id, documentId, r, r === 1 ? null : r - 1, vId, JSON.stringify({ n, r }), SHA("d"), SHA("e"), t0 + r],
    )
  }
  return { templateVersionId: vId, documentId, revisionIds }
}

function seedRenderJob(db: Runner, documentId: string, revisionId: string): string {
  const id = newId()
  db.run("INSERT INTO render_job (id, document_id, revision_id, formats, status, requested_by, time_queued) VALUES (?, ?, ?, '[\"pdf\",\"html\"]', 'SUCCEEDED', 'swarm', ?)", [id, documentId, revisionId, clock()])
  return id
}

interface OutSeed {
  format: "DOCX" | "PDF" | "HTML" | "SVG" | "PNG"
  role?: "PRIMARY" | "FIGURE"
  figureLabel?: string | null
  draft?: boolean
  scope?: "DOCUMENT" | "CHAPTER" | "SLOT"
  renderJobId?: string | null
  sha?: string
}

function seedOutput(db: Runner, documentId: string, revisionId: string, o: OutSeed): { id: string; sha256: string } {
  const id = newId()
  const sha256 = o.sha ?? sha256Hex(`${id}-${o.format}`)
  db.run(
    `INSERT INTO output_file (id, kind, document_id, revision_id, render_job_id, format, role, figure_label, rel_path, file_name, bytes, sha256, mime, scope_kind, draft, time_created)
     VALUES (?, 'document', ?, ?, ?, ?, ?, ?, ?, ?, 10, ?, 'application/octet-stream', ?, ?, ?)`,
    [id, documentId, revisionId, o.renderJobId ?? null, o.format, o.role ?? "PRIMARY", o.figureLabel ?? null, `docs/${documentId}/${id}.${o.format.toLowerCase()}`, `${id}.${o.format.toLowerCase()}`, sha256, o.scope ?? "DOCUMENT", o.draft ? 1 : 0, clock()],
  )
  return { id, sha256 }
}

/** A §2 VerifiedOutput plus header fields, with the given status per check id (in VerifyCheckId order). */
function report(out: { id: string; sha256: string }, state: "verified" | "unverified", statuses: readonly string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: "studio.output-verification/v1",
    checksVersion: 1,
    documentId: "doc",
    revisionNo: 1,
    renderJobId: null,
    scope: "DOCUMENT",
    draft: false,
    layout: "paged",
    outputId: out.id,
    format: "PDF",
    role: "PRIMARY",
    figureLabel: null,
    sha256: out.sha256,
    state,
    checks: CHECK_IDS.map((id, i) => ({ id, status: statuses[i], basis: "self", reason: statuses[i] === "UNKNOWN" ? "BRIDGE_UNAVAILABLE" : null, findings: [], truncated: 0, ms: 1 })),
    pages: [],
    ...extra,
  }
}

const ALL_PASS = ["PASS", "PASS", "PASS", "PASS", "NOT_APPLICABLE", "PASS"] as const
const ONE_UNKNOWN = ["PASS", "UNKNOWN", "PASS", "PASS", "NOT_APPLICABLE", "PASS"] as const
const ONE_FAIL = ["PASS", "FAIL", "PASS", "PASS", "NOT_APPLICABLE", "PASS"] as const

function rec(out: { id: string; sha256: string }, state: "verified" | "unverified", statuses: readonly string[], over: Partial<NewOutputVerification> = {}): NewOutputVerification {
  const fail = statuses.filter((s) => s === "FAIL").length
  const unknown = statuses.filter((s) => s === "UNKNOWN").length
  return { outputFileId: out.id, outputSha256: out.sha256, state, checksVersion: 1, failCount: fail, unknownCount: unknown, report: report(out, state, statuses), verifiedBy: "studio_render", ...over }
}

function counts(file: string): Record<string, number> {
  const db = openSqlite(file, { readonly: true })
  try {
    const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'doc_block_fts_%' AND name NOT LIKE 'mission_fts_%' AND name <> 'output_verification' ORDER BY name").map((r) => r.name)
    return Object.fromEntries(names.map((n) => [n, Number(db.get<{ n: number }>(`SELECT count(*) AS n FROM "${n}"`)!.n)]))
  } finally {
    db.close()
  }
}

function contentSha(file: string): string {
  const db = openSqlite(file, { readonly: true })
  try {
    return sha256Hex(JSON.stringify(["template", "template_version", "document", "revision", "render_job", "output_file"].map((t) => db.all(`SELECT * FROM ${t} ORDER BY id`))))
  } finally {
    db.close()
  }
}

const store = await openStore("main")
type Tx = Parameters<Parameters<SqliteStudioStore["transaction"]>[0]>[0]
const tx = <R>(fn: (t: Tx) => R | Promise<R>) => store.transaction(async (t) => fn(t))

// ── 1. migration 0004 ─────────────────────────────────────────────────────────

describe("migration 0004", () => {
  test("0004 is the spec §5 DDL byte for byte, listed after 0003; table, CHECKs and 2 indexes exist, no trigger", () => {
    expect(sha256Hex(MIGRATION_0004_SQL)).toBe(MIGRATION_0004_SPEC_SHA256)
    expect(MIGRATION_0004_ID).toBe(ID_0004)
    expect(MIGRATIONS.map((m) => `${m.seq}:${m.id}`)).toEqual([`1:${ID_0001}`, `2:${ID_0002}`, `3:${ID_0003}`, `4:${ID_0004}`, `5:${ID_0005}`, `6:${ID_0006}`])
    expect(latestSchemaId()).toBe(ID_0006)
    for (const c of ["VERIFY_SHA_MISMATCH", "VERIFY_STATE_INVALID", "VERIFY_REPORT_TOO_LARGE", "OUTPUT_UNVERIFIED"] as const) expect(STORE_ERROR_CODES as readonly string[]).toContain(c)
    expect(OUTPUT_VERIFICATION_REPORT_MAX_BYTES).toBe(262_144)
    const db = openSqlite(join(RUN, "main", "datum-studio.sqlite"), { readonly: true })
    try {
      const cols = db.all<{ name: string; notnull: number; pk: number }>("PRAGMA table_info(output_verification)").map((r) => `${r.name}${Number(r.pk) ? "*" : ""}${Number(r.notnull) ? "!" : ""}`)
      expect(cols).toEqual(["output_file_id*", "output_sha256!", "revision_id", "render_job_id", "state!", "checks_version!", "fail_count!", "unknown_count!", "report!", "report_sha256!", "attempt!", "verified_by!", "time_verified!"])
      const fks = db.all<{ table: string; from: string; on_delete: string }>("PRAGMA foreign_key_list(output_verification)").map((r) => `${r.from}->${r.table}:${r.on_delete}`).sort()
      expect(fks).toEqual(["output_file_id->output_file:CASCADE", "render_job_id->render_job:SET NULL", "revision_id->revision:CASCADE"])
      const idx = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'output_verification' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name)
      expect(idx).toEqual(["output_verification_revision_idx", "output_verification_state_idx"])
      expect(db.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'output_verification'")).toEqual([])
      expect(db.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'schema_version'")!.value).toBe(ID_0006)
      console.log(`[row149] runtime=${RUNTIME} driver=${db.driver} sqlite=${db.get<{ v: string }>("select sqlite_version() v")!.v} migration0004 sha=${MIGRATION_0004_SPEC_SHA256}`)
    } finally {
      db.close()
    }
  })

  test("0003 store with documents, revisions, a render job and outputs migrates; counts and contents unchanged", async () => {
    const dir = join(RUN, "upgrade")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "datum-studio.sqlite")
    let out: { id: string; sha256: string } = { id: "", sha256: "" }
    {
      const db = openSqlite(file)
      try {
        db.get("PRAGMA journal_mode = WAL")
        db.exec("PRAGMA foreign_keys = ON")
        expect(applyMigrations(db, { release: "1.2.1-pre149", now: clock }, MIGRATIONS.filter((m) => m.seq <= 3))).toEqual([ID_0001, ID_0002, ID_0003])
        for (let n = 1; n <= 3; n++) {
          const d = seedDocument(db, n, n)
          const job = seedRenderJob(db, d.documentId, d.revisionIds[0]!)
          const o = seedOutput(db, d.documentId, d.revisionIds[0]!, { format: "PDF", renderJobId: job })
          seedOutput(db, d.documentId, d.revisionIds[0]!, { format: "HTML", renderJobId: job })
          if (n === 1) out = o
        }
        expect(db.get("SELECT name FROM sqlite_master WHERE name = 'output_verification'") ?? null).toBeNull()
      } finally {
        db.close()
      }
    }
    const before = counts(file)
    const shaBefore = contentSha(file)
    expect([before.document, before.revision, before.render_job, before.output_file, before.migration]).toEqual([3, 6, 3, 6, 3])

    const s = await openStore("upgrade")
    // a pre-0004 output has no record: unverified, NOT_CHECKED
    expect(await s.getOutputVerification(out.id)).toBeNull()
    await s.close()
    const after = counts(file)
    console.log(`[row149] 0003 -> 0004 counts before ${JSON.stringify(before)}`)
    console.log(`[row149] 0003 -> 0004 counts after  ${JSON.stringify(after)}`)
    // the only delta outside the mission tables pinned at open: journal rows 0004 and 0005 (row 166)
    const strip = (c: Record<string, number>) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith("mission")))
    expect({ ...strip(after), migration: after.migration! - 3 }) // row 188: + 0006.toEqual(strip(before))
    expect(contentSha(file)).toBe(shaBefore)
    const r = openSqlite(file, { readonly: true })
    try {
      expect(r.all<{ id: string }>("SELECT id FROM migration ORDER BY id").map((x) => x.id)).toEqual([ID_0001, ID_0002, ID_0003, ID_0004, ID_0005, ID_0006])
      expect(r.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'schema_version'")!.value).toBe(ID_0006)
      expect(r.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'created_by_release'")!.value).toBe("1.2.1-pre149")
      expect(Number(r.get<{ n: number }>("SELECT count(*) AS n FROM output_verification")!.n)).toBe(0)
      expect(r.get<{ integrity_check: string }>("PRAGMA integrity_check")!.integrity_check).toBe("ok")
      expect(r.all("PRAGMA foreign_key_check")).toEqual([])
    } finally {
      r.close()
    }
    // reopen applies nothing; the old output can now be verified
    const again = await openStore("upgrade")
    const row = await again.transaction((t) => again.putOutputVerification(t, rec(out, "verified", ALL_PASS)))
    expect(row.state).toBe("verified")
    await again.close()
    const j = openSqlite(file, { readonly: true })
    expect(Number(j.get<{ n: number }>("SELECT count(*) AS n FROM migration")!.n)).toBe(6)
    j.close()
  })
})

// ── 2. write / read ───────────────────────────────────────────────────────────

describe("putOutputVerification / getOutputVerification / listOutputVerifications", () => {
  test("write a verified record and read it back; revision and render job copied; report stored canonical", async () => {
    const { d, job, out } = await tx((t) => {
      const d = seedDocument(t, 10)
      const job = seedRenderJob(t, d.documentId, d.revisionIds[0]!)
      return { d, job, out: seedOutput(t, d.documentId, d.revisionIds[0]!, { format: "PDF", renderJobId: job }) }
    })
    const r = rec(out, "verified", ALL_PASS)
    const row = await tx((t) => store.putOutputVerification(t, r))
    expect(row.output_file_id).toBe(out.id)
    expect(row.output_sha256).toBe(out.sha256)
    expect(row.revision_id).toBe(d.revisionIds[0]!)
    expect(row.render_job_id).toBe(job)
    expect([row.state, row.checks_version, row.fail_count, row.unknown_count, row.attempt, row.verified_by]).toEqual(["verified", 1, 0, 0, 1, "studio_render"])
    expect(row.report_sha256).toBe(sha256Hex(canonicalJson(r.report)))
    expect(canonicalJson(row.report)).toBe(canonicalJson(r.report))
    expect(typeof row.time_verified).toBe("number")
    const read = await store.getOutputVerification(out.id)
    expect(canonicalJson(read)).toBe(canonicalJson(row))
    expect(await store.getOutputVerification("nope")).toBeNull()
  })

  test("re-verify replaces the record, attempt + 1; the newest wins even when it downgrades (D-7)", async () => {
    const out = await tx((t) => {
      const d = seedDocument(t, 11)
      return seedOutput(t, d.documentId, d.revisionIds[0]!, { format: "HTML" })
    })
    await tx((t) => store.putOutputVerification(t, rec(out, "verified", ALL_PASS)))
    const down = await tx((t) => store.putOutputVerification(t, rec(out, "unverified", ONE_UNKNOWN)))
    expect([down.state, down.unknown_count, down.fail_count, down.attempt]).toEqual(["unverified", 1, 0, 2])
    const up = await tx((t) => store.putOutputVerification(t, rec(out, "verified", ALL_PASS, { verifiedBy: "studio_render#2" })))
    expect([up.state, up.attempt, up.verified_by]).toEqual(["verified", 3, "studio_render#2"])
    const n = await tx((t) => Number(t.get<{ n: number }>("SELECT count(*) AS n FROM output_verification WHERE output_file_id = ?", [out.id])!.n))
    expect(n).toBe(1)
    console.log(`[row149] D-7 attempts: verified(1) -> unverified/CHECK_UNKNOWN(2) -> verified(3)`)
  })

  test("listOutputVerifications returns records in the order given, missing ids omitted, duplicates once", async () => {
    const [a, b, c] = await tx((t) => {
      const d = seedDocument(t, 12)
      return [
        seedOutput(t, d.documentId, d.revisionIds[0]!, { format: "PDF" }),
        seedOutput(t, d.documentId, d.revisionIds[0]!, { format: "HTML" }),
        seedOutput(t, d.documentId, d.revisionIds[0]!, { format: "DOCX" }),
      ]
    })
    await tx(async (t) => {
      await store.putOutputVerification(t, rec(a!, "verified", ALL_PASS))
      await store.putOutputVerification(t, rec(c!, "unverified", ONE_FAIL))
    })
    const list = await store.listOutputVerifications([c!.id, "missing", b!.id, a!.id, c!.id])
    expect(list.map((x) => `${x.output_file_id === a!.id ? "a" : x.output_file_id === c!.id ? "c" : "?"}:${x.state}`)).toEqual(["c:unverified", "a:verified"])
    expect(await store.listOutputVerifications([])).toEqual([])
  })

  test("refusals: NOT_FOUND, VERIFY_SHA_MISMATCH, VERIFY_REPORT_TOO_LARGE, SCHEMA_INVALID; a refusal leaves the record unchanged", async () => {
    const out = await tx((t) => {
      const d = seedDocument(t, 13)
      return seedOutput(t, d.documentId, d.revisionIds[0]!, { format: "PDF" })
    })
    await tx((t) => store.putOutputVerification(t, rec(out, "verified", ALL_PASS)))
    await refused("no output row", tx((t) => store.putOutputVerification(t, rec({ id: "missing-output", sha256: out.sha256 }, "verified", ALL_PASS))), "NOT_FOUND")
    await refused("other bytes", tx((t) => store.putOutputVerification(t, rec({ id: out.id, sha256: SHA("a") }, "verified", ALL_PASS))), "VERIFY_SHA_MISMATCH")
    const big = rec(out, "unverified", ONE_FAIL)
    big.report = { ...big.report, pad: "x".repeat(OUTPUT_VERIFICATION_REPORT_MAX_BYTES) }
    await refused("report > 256 KiB", tx((t) => store.putOutputVerification(t, big)), "VERIFY_REPORT_TOO_LARGE")
    await refused("bad state", tx((t) => store.putOutputVerification(t, { ...rec(out, "verified", ALL_PASS), state: "passed" as "verified" })), "SCHEMA_INVALID")
    await refused("negative count", tx((t) => store.putOutputVerification(t, { ...rec(out, "unverified", ONE_FAIL), failCount: -1 })), "SCHEMA_INVALID")
    await refused("checksVersion 0", tx((t) => store.putOutputVerification(t, { ...rec(out, "verified", ALL_PASS), checksVersion: 0 })), "SCHEMA_INVALID")
    await refused("report not an object", tx((t) => store.putOutputVerification(t, { ...rec(out, "verified", ALL_PASS), report: [] as unknown as Record<string, unknown> })), "SCHEMA_INVALID")
    await refused("unknown check status", tx((t) => store.putOutputVerification(t, rec(out, "verified", ["PASS", "SKIPPED", "PASS", "PASS", "PASS", "PASS"]))), "SCHEMA_INVALID")
    await refused("no verifiedBy", tx((t) => store.putOutputVerification(t, { ...rec(out, "verified", ALL_PASS), verifiedBy: " " })), "SCHEMA_INVALID")
    const kept = (await store.getOutputVerification(out.id))!
    expect([kept.state, kept.attempt]).toEqual(["verified", 1])
    expect(logs.some((l) => l.source === "StudioStore.putOutputVerification" && l.level === "warn" && (l.context as { code?: string }).code === "VERIFY_SHA_MISMATCH")).toBe(true)
  })
})

// ── 3. UNKNOWN never counts as a pass ─────────────────────────────────────────

describe("UNKNOWN never counts as a pass (spec §2, §5; C130; broken case B10)", () => {
  test("store API: verified with UNKNOWN or FAIL is refused VERIFY_STATE_INVALID, also when counts hide it", async () => {
    const out = await tx((t) => {
      const d = seedDocument(t, 20)
      return seedOutput(t, d.documentId, d.revisionIds[0]!, { format: "PDF" })
    })
    await refused("verified, unknownCount 1", tx((t) => store.putOutputVerification(t, { ...rec(out, "unverified", ONE_UNKNOWN), state: "verified" })), "VERIFY_STATE_INVALID")
    await refused("verified, failCount 1", tx((t) => store.putOutputVerification(t, { ...rec(out, "unverified", ONE_FAIL), state: "verified" })), "VERIFY_STATE_INVALID")
    // counts say 0/0 but the report's own checks hold an UNKNOWN: the report decides, never a hidden pass
    const hidden = rec(out, "verified", ONE_UNKNOWN, { unknownCount: 0 })
    ;(hidden.report as { state: string }).state = "verified"
    await refused("verified, report holds UNKNOWN, counts 0", tx((t) => store.putOutputVerification(t, hidden)), "VERIFY_STATE_INVALID")
    await refused("state differs from report.state", tx((t) => store.putOutputVerification(t, { ...rec(out, "verified", ALL_PASS), report: report(out, "unverified", ALL_PASS) })), "VERIFY_STATE_INVALID")
    expect(await store.getOutputVerification(out.id)).toBeNull()
    // the honest record is accepted as unverified
    const ok = await tx((t) => store.putOutputVerification(t, rec(out, "unverified", ONE_UNKNOWN)))
    expect([ok.state, ok.unknown_count]).toEqual(["unverified", 1])
  })

  test("DB rule: the 0004 CHECK refuses a raw verified row with unknown_count 1 (store tx -> VERIFY_STATE_INVALID; plain SQLite -> CHECK constraint failed)", async () => {
    const out = await tx((t) => {
      const d = seedDocument(t, 21)
      return seedOutput(t, d.documentId, d.revisionIds[0]!, { format: "HTML" })
    })
    const raw = (unknown: number, fail: number, state = "verified") =>
      tx((t) =>
        t.run(
          "INSERT INTO output_verification (output_file_id, output_sha256, state, checks_version, fail_count, unknown_count, report, report_sha256, verified_by, time_verified) VALUES (?, ?, ?, 1, ?, ?, '{}', ?, 'raw', 1)",
          [out.id, out.sha256, state, fail, unknown, SHA("f")],
        ),
      )
    await refused("raw SQL verified unknown_count=1", raw(1, 0), "VERIFY_STATE_INVALID")
    await refused("raw SQL verified fail_count=1", raw(0, 1), "VERIFY_STATE_INVALID")
    await refused("raw SQL state 'pass'", raw(0, 0, "pass"), "SCHEMA_INVALID")
    await raw(1, 0, "unverified")
    // raw UPDATE of the stored row to verified is refused as well
    await refused("raw SQL UPDATE to verified", tx((t) => t.run("UPDATE output_verification SET state = 'verified' WHERE output_file_id = ?", [out.id])), "VERIFY_STATE_INVALID")

    // plain SQLite connection, no store code at all (closed copy of the upgrade store)
    const db = openSqlite(join(RUN, "upgrade", "datum-studio.sqlite"))
    try {
      db.exec("PRAGMA foreign_keys = ON")
      const o = db.get<{ id: string; sha256: string }>("SELECT id, sha256 FROM output_file WHERE id NOT IN (SELECT output_file_id FROM output_verification) LIMIT 1")!
      let msg = ""
      try {
        db.run(
          "INSERT INTO output_verification (output_file_id, output_sha256, state, checks_version, fail_count, unknown_count, report, report_sha256, verified_by, time_verified) VALUES (?, ?, 'verified', 1, 0, 1, '{}', ?, 'raw', 1)",
          [o.id, o.sha256, SHA("f")],
        )
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e)
      }
      console.log(`[row149] plain SQLite refusal: ${msg}`)
      expect(msg).toMatch(/CHECK constraint failed/)
      expect(Number(db.get<{ n: number }>("SELECT count(*) AS n FROM output_verification WHERE output_file_id = ?", [o.id])!.n)).toBe(0)
    } finally {
      db.close()
    }
  })
})

// ── 4. revisionVerification (spec §7.1, §7.2) ─────────────────────────────────

describe("revisionVerification", () => {
  test("output set (newest per role/format/label; draft and chapter outputs excluded); Final only when all verified with a layout witness", async () => {
    const s = await tx((t) => {
      const d = seedDocument(t, 30, 2)
      const rev = d.revisionIds[1]!
      const oldPdf = seedOutput(t, d.documentId, rev, { format: "PDF" })
      const pdf = seedOutput(t, d.documentId, rev, { format: "PDF" })
      const html = seedOutput(t, d.documentId, rev, { format: "HTML" })
      const docx = seedOutput(t, d.documentId, rev, { format: "DOCX" })
      const svg = seedOutput(t, d.documentId, rev, { format: "SVG", role: "FIGURE", figureLabel: "Gambar 1" })
      const draft = seedOutput(t, d.documentId, rev, { format: "PDF", draft: true })
      const chapter = seedOutput(t, d.documentId, rev, { format: "HTML", scope: "CHAPTER" })
      const rev1 = seedOutput(t, d.documentId, d.revisionIds[0]!, { format: "PDF" })
      return { d, oldPdf, pdf, html, docx, svg, draft, chapter, rev1 }
    })
    const v0 = await store.revisionVerification(s.d.documentId, "latest")
    expect(v0.revisionNo).toBe(2)
    expect(v0.revisionId).toBe(s.d.revisionIds[1]!)
    expect(v0.outputs.map((o) => o.outputId).sort()).toEqual([s.pdf.id, s.html.id, s.docx.id, s.svg.id].sort())
    expect(v0.outputs.every((o) => o.state === "unverified" && o.reason === "NOT_CHECKED" && o.attempt === null)).toBe(true)
    expect([v0.final, v0.reasons]).toEqual([false, ["NO_LAYOUT_WITNESS", "NOT_CHECKED"]])

    // verify all four outputs of the set (the excluded ones are irrelevant)
    await tx(async (t) => {
      for (const o of [s.pdf, s.html, s.docx, s.svg]) await store.putOutputVerification(t, rec(o, "verified", ALL_PASS))
    })
    const v1 = await store.revisionVerification(s.d.documentId, 2)
    expect([v1.final, v1.reasons]).toEqual([true, []])
    expect(v1.outputs.every((o) => o.state === "verified" && o.reason === null && o.attempt === 1)).toBe(true)
    console.log(`[row149] revisionVerification all verified: final=${v1.final} outputs=${v1.outputs.map((o) => `${o.role}/${o.format}${o.figureLabel ? "/" + o.figureLabel : ""}:${o.state}`).join(",")}`)

    // a re-verify that hits UNKNOWN downgrades the figure: not Final, reason CHECK_UNKNOWN (D-7, UNKNOWN never a pass)
    await tx((t) => store.putOutputVerification(t, rec(s.svg, "unverified", ONE_UNKNOWN)))
    const v2 = await store.revisionVerification(s.d.documentId, 2)
    expect([v2.final, v2.reasons]).toEqual([false, ["CHECK_UNKNOWN"]])
    expect(v2.outputs.find((o) => o.outputId === s.svg.id)!.reason).toBe("CHECK_UNKNOWN")

    // a FAIL on the PDF while the HTML stays verified: still a layout witness, reason CHECK_FAILED
    await tx((t) => store.putOutputVerification(t, rec(s.pdf, "unverified", ONE_FAIL)))
    const v3 = await store.revisionVerification(s.d.documentId, 2)
    expect([v3.final, v3.reasons]).toEqual([false, ["CHECK_FAILED", "CHECK_UNKNOWN"]])

    // HTML fails too: no verified PRIMARY PDF/HTML left
    await tx((t) => store.putOutputVerification(t, rec(s.html, "unverified", ONE_FAIL)))
    const v4 = await store.revisionVerification(s.d.documentId, 2)
    expect(v4.reasons).toEqual(["NO_LAYOUT_WITNESS", "CHECK_FAILED", "CHECK_UNKNOWN"])

    // revision 1 is its own set; a stale record (output sha changed under it) reads STALE, never verified
    await tx((t) => store.putOutputVerification(t, rec(s.rev1, "verified", ALL_PASS)))
    expect((await store.revisionVerification(s.d.documentId, 1)).final).toBe(true)
    await tx((t) => t.run("UPDATE output_verification SET output_sha256 = ? WHERE output_file_id = ?", [SHA("b"), s.rev1.id]))
    const v5 = await store.revisionVerification(s.d.documentId, 1)
    expect([v5.final, v5.reasons, v5.outputs[0]!.state]).toEqual([false, ["NO_LAYOUT_WITNESS", "STALE"], "unverified"])
  })

  test("DOCX-only verified set is not Final (NO_LAYOUT_WITNESS); no outputs is NOT_RENDERED; unknown ids refused", async () => {
    const s = await tx((t) => {
      const d = seedDocument(t, 31)
      const empty = seedDocument(t, 32)
      return { d, empty, docx: seedOutput(t, d.documentId, d.revisionIds[0]!, { format: "DOCX" }) }
    })
    await tx((t) => store.putOutputVerification(t, rec(s.docx, "verified", ALL_PASS)))
    const v = await store.revisionVerification(s.d.documentId, 1)
    expect([v.final, v.reasons]).toEqual([false, ["NO_LAYOUT_WITNESS"]])
    const e = await store.revisionVerification(s.empty.documentId, "latest")
    expect([e.final, e.reasons, e.outputs.length]).toEqual([false, ["NOT_RENDERED"], 0])
    await refused("unknown document", store.revisionVerification("no-doc", 1), "NOT_FOUND")
    await refused("unknown revision", store.revisionVerification(s.d.documentId, 9), "NOT_FOUND")
    await refused("revision 0", store.revisionVerification(s.d.documentId, 0), "SCHEMA_INVALID")
  })

  test("deleting an output deletes its record (FK CASCADE); a deleted render job leaves the record with render_job_id NULL", async () => {
    const s = await tx((t) => {
      const d = seedDocument(t, 33)
      const job = seedRenderJob(t, d.documentId, d.revisionIds[0]!)
      return { a: seedOutput(t, d.documentId, d.revisionIds[0]!, { format: "PDF", renderJobId: job }), b: seedOutput(t, d.documentId, d.revisionIds[0]!, { format: "HTML", renderJobId: job }), job }
    })
    await tx(async (t) => {
      await store.putOutputVerification(t, rec(s.a, "verified", ALL_PASS))
      await store.putOutputVerification(t, rec(s.b, "verified", ALL_PASS))
    })
    await tx((t) => t.run("DELETE FROM output_file WHERE id = ?", [s.a.id]))
    expect(await store.getOutputVerification(s.a.id)).toBeNull()
    await tx((t) => t.run("DELETE FROM render_job WHERE id = ?", [s.job]))
    const b = (await store.getOutputVerification(s.b.id))!
    expect([b.state, b.render_job_id]).toEqual(["verified", null])
  })
})
