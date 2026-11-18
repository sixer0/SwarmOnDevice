// Swarm 1.3.3 row 66 (MC-5): seeding helper of the row-close gate tests. Plain SQL over a real SqliteStudioStore opened
// with missionGuard: true (the switch that turns the done gate on, as start.ts does); no host server, no port, no
// render engine. Output files are written as small real files under the store root, because the gate looks at them.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { newId, sha256Hex, SqliteStudioStore, type StoreLogEntry } from "../../src/store/index.ts"
import type { MissionRowInput, NewMission } from "../../src/store/mission/index.ts"

export type Tx = Parameters<Parameters<SqliteStudioStore["transaction"]>[0]>[0]
export type Rec = Record<string, unknown>

const BASE = process.env.ROW66_TEST_DIR ?? join(process.env.TMPDIR ?? tmpdir(), "row66-row-close-gate")
mkdirSync(BASE, { recursive: true })
export const RUN = mkdtempSync(join(BASE, "run-"))
let tick = 1_800_000_000_000
export const clock = () => ++tick
export const logs: StoreLogEntry[] = []
const opened: SqliteStudioStore[] = []

export async function openStore(name: string, missionGuard = true): Promise<SqliteStudioStore> {
  const s = new SqliteStudioStore()
  await s.open(join(RUN, name), { release: "1.3.3", log: (e) => logs.push(e), agentClock: clock, missionGuard })
  opened.push(s)
  return s
}
export async function closeStores(): Promise<void> {
  for (const s of opened) await s.close()
}

export const U1 = { id: "U1", by: "user" as const, date: "2026-11-17", text: "User approves the blueprint" }
const PERSON = { attested: true }
export function row(id: string, over: Partial<MissionRowInput> = {}): MissionRowInput {
  return { id, phase: "draft", kind: "draft", title: `Row ${id}`, agent: "document-writer", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "outputs verified", ...over } as MissionRowInput
}
/** A `document` mission with the given row ids, approved by U1; the named rows are moved to `running`. */
export async function mission(store: SqliteStudioStore, id: string, rowIds: string[], running: string[] = rowIds): Promise<void> {
  const doc: NewMission = { id, title: `Mission ${id}`, type: "document", owner: "master-controller", project: { dir: join(RUN, "project") }, rows: rowIds.map((r) => row(r)), decisions: [U1] }
  await store.transaction(async (t) => store.missions.create(t, doc, PERSON))
  await store.transaction(async (t) => store.missions.approve(t, id, "U1"))
  if (running.length > 0) await store.transaction(async (t) => store.missions.updateRows(t, id, running.map((r) => ({ id: r, status: "running" as const }))))
}

export interface DocSeed { documentId: string; revisionId: string; revisionNo: number }
/** One template + version + document bound to `mission` under `docKey`, with `revs` revisions; `lint` is the lint report of the current one. */
export function seedDocument(t: Tx, o: { mission: string; docKey: string; id?: string; revs?: number; revisionNo?: number; tier?: "NOTA" | "TERBIT" | "SERAH"; lint?: unknown; contractKind?: string }): DocSeed {
  const t0 = clock()
  const tId = newId()
  const vId = newId()
  t.run("INSERT INTO template (id, slug, origin, name, kind, latest_version_no, created_by, time_created, time_updated) VALUES (?, ?, 'user', ?, 'DOCUMENT', 1, 'swarm', ?, ?)", [tId, `user-tpl-${tId}`, `Tpl ${tId}`, t0, t0])
  t.run(
    `INSERT INTO template_version (id, template_id, version_no, definition, definition_sha256, overrides, resolved_params, params_sha256, role_formats, section_plan, assets, provenance, change_note, created_by, time_created)
     VALUES (?, ?, 1, '{}', ?, '{}', '{}', ?, '{}', '[]', '[]', '{"origin":"test"}', 'v1', 'swarm', ?)`,
    [vId, tId, sha256Hex("{}"), sha256Hex("{}"), t0],
  )
  const documentId = o.id ?? newId()
  const revs = o.revs ?? 1
  // `revisionNo` numbers the current revision like the replayed store did (rev 12, 36, 104 ...); earlier ones count down.
  const last = o.revisionNo ?? revs
  t.run(
    "INSERT INTO document (id, doc_number, doc_number_safe, number_source, title, type_code, classification, tier, template_id, current_revision_no, mission_folder, mission_doc_key, contract_kind, created_by, time_created, time_updated) VALUES (?, ?, ?, 'AGENT', ?, 'KT', 'TERBATAS', ?, ?, ?, ?, ?, ?, 'swarm', ?, ?)",
    [documentId, `1/GSP/KT/XI/2026-${documentId}`, `1-GSP-KT-XI-2026-${documentId}`, `Dokumen ${o.docKey}`, o.tier ?? "TERBIT", tId, last, o.mission, o.docKey, o.contractKind ?? null, t0, t0],
  )
  let revisionId = ""
  for (let i = revs - 1; i >= 0; i--) {
    const no = last - i
    const id = newId()
    if (i === 0) revisionId = id
    t.run(
      `INSERT INTO revision (id, document_id, revision_no, parent_revision_no, template_version_id, snapshot, snapshot_sha256, input_sha256, doc_rev, change_what, change_why, change_impact, lint_report, created_by, time_created)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?, 'A', 'w', 'y', 'i', ?, 'swarm', ?)`,
      [id, documentId, no, i === revs - 1 ? null : no - 1, vId, "d".repeat(64), "e".repeat(64), i === 0 && o.lint !== undefined ? JSON.stringify(o.lint) : null, t0 + no],
    )
  }
  return { documentId, revisionId, revisionNo: last }
}

export interface OutSeed { id: string; sha256: string; relPath: string; format: string }
/** One output_file row of a revision plus, unless `file: false`, its file on disk under the store root. */
export function seedOutput(t: Tx, root: string, d: { documentId: string; revisionId: string }, o: { format: string; role?: "PRIMARY" | "FIGURE"; figureLabel?: string | null; id?: string; sha?: string; file?: boolean }): OutSeed {
  const id = o.id ?? newId()
  const sha256 = o.sha ?? sha256Hex(`${id}-${o.format}`)
  const relPath = `docs/${d.documentId}/${id}.${o.format.toLowerCase()}`
  t.run(
    `INSERT INTO output_file (id, kind, document_id, revision_id, render_job_id, format, role, figure_label, rel_path, file_name, bytes, sha256, mime, scope_kind, draft, time_created)
     VALUES (?, 'document', ?, ?, NULL, ?, ?, ?, ?, ?, 10, ?, 'application/octet-stream', 'DOCUMENT', 0, ?)`,
    [id, d.documentId, d.revisionId, o.format, o.role ?? "PRIMARY", o.figureLabel ?? null, relPath, `${id}.${o.format.toLowerCase()}`, sha256, clock()],
  )
  if (o.file !== false) {
    mkdirSync(dirname(join(root, relPath)), { recursive: true })
    writeFileSync(join(root, relPath), "0123456789")
  }
  return { id, sha256, relPath, format: o.format }
}

export type CheckSeed = { id: string; status: "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE"; reason?: string | null; findings?: Rec[]; truncated?: number }
/** One verification record, written as the render wrapper's record is stored (raw row, so a replay keeps the stored report). */
export function seedRecord(t: Tx, out: { id: string; sha256: string }, d: { revisionId: string }, checks: CheckSeed[] | string, over: { sha?: string; state?: "verified" | "unverified"; fail?: number; unknown?: number; attempt?: number; time?: number } = {}): void {
  const report = typeof checks === "string" ? checks : JSON.stringify({ $schema: "studio.output-verification/v1", checks: checks.map((c) => ({ basis: "self", reason: null, findings: [], truncated: 0, ...c })) })
  const list = (JSON.parse(report) as { checks: Array<{ status: string }> }).checks
  const fail = over.fail ?? list.filter((c) => c.status === "FAIL").length
  const unknown = over.unknown ?? list.filter((c) => c.status === "UNKNOWN").length
  t.run(
    `INSERT INTO output_verification (output_file_id, output_sha256, revision_id, render_job_id, state, checks_version, fail_count, unknown_count, report, report_sha256, attempt, verified_by, time_verified)
     VALUES (?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, 'studio_render', ?)`,
    [out.id, over.sha ?? out.sha256, d.revisionId, over.state ?? (fail + unknown === 0 ? "verified" : "unverified"), fail, unknown, report, sha256Hex(report), over.attempt ?? 1, over.time ?? clock()],
  )
}

export const PASS: CheckSeed[] = [
  { id: "LINT", status: "PASS" },
  { id: "OVERLAP_CLIP", status: "PASS" },
  { id: "FIDELITY", status: "PASS" },
]
/** The LINT finding the render of the test day stored for a diagram whose labels a person had not checked. */
export const labelFinding = (address: string, rule: "D09" | "P1-labels_verified" = "D09") => ({ address, code: "LINT_FAIL", detail: `${rule}: Gambar ${address}: labels_verified bukan true`, label: rule, page: null })
