// Swarm 1.2.6 row 86 (MC-08, register N-065, U5): a document owned by mission A and revised under mission B is
// listed with that revision in B's `studio_mission_get include: deliverables` (and in B's exported status_tasks.md).
// "Revised under B" = a work report of B's row names the revision as its `output` in `## Rujukan` (contract ref rel
// output, stored in doc_ref); migration 0007 links it in `mission_document`.
// Through the REAL host server (startStudioHostServer, streamable HTTP on 127.0.0.1, MCP SDK client) over a temp store
// opened with missionGuard: true (row 126 test pattern). Needs the command sandbox off (binds an ephemeral port).
// Red at e363918a69: B's deliverables are empty (assertion) and the mission_document table is absent (class B).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW86_TEST_DIR ?? "/private/tmp/claude-501/row86/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row86-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-86")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

async function resetEnvCache() {
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  const { resetQueryRateLimiter } = await import("../../vendor/src/lib/studio/http/quota")
  const { resetImportRateLimiter } = await import("../../src/mcp-host/local-api/routes/import-rate.ts")
  const { resetValidateRateLimiter } = await import("../../src/mcp-host/local-api/routes/validate-rate.ts")
  resetStudioEnvCache()
  resetRenderRateLimiter()
  resetQueryRateLimiter()
  resetImportRateLimiter()
  resetValidateRateLimiter()
}

const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const MA = "2026-11-12_m86-owner"
const MB = "2026-11-12_m86-reviser"

const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row86 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
type S = Record<string, any>
let mod: Mod
let bridge: typeof import("../../src/store-bridge/index.ts")
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => {
  if (level === "error") console.log(`[row86] host error ${source}: ${message} ${JSON.stringify(context ?? {})}`)
}
const quote = (label: string, v: unknown) => console.log(`[row86] ${label}: ${JSON.stringify(v)}`)

async function call(name: string, args: Record<string, unknown>): Promise<S> {
  const r = await c.callTool({ name, arguments: args })
  return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true }
}
const sql = <T = S>(q: string, p: unknown[] = []) => bridge.withStudioTx(async (tx) => tx.all(q, p as never) as T[])
const currentRev = async (id: string) => Number((await sql<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [id]))[0]!.n)

function row(id: string) {
  return { id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate" }
}

/** A work report of row `taskRef` that names `refs` (documentId, revisionNo) as its outputs in `## Rujukan`. */
function report(mission: string, taskRef: string, refs: Array<[string, number]>, basis?: string): string {
  return `# Laporan baris

mission: ${mission}
${basis ? `basis: ${basis}\n` : ""}Status: complete
Owner: coder-execution
TaskRef: ${taskRef}
ReportedAt: 2026-11-12

## Ringkasan

Dokumen milik misi lain direvisi di baris ini.

## Rincian kerja

| key | judul | status | owner | bukti |
|---|---|---|---|---|
| KUNCI-1 | Revisi kajian | done | coder-execution | kajian |

Kajian direvisi lalu diperiksa.

## Bukti

Revisi tersimpan.

## Isu terbuka

Tidak ada.

## Langkah berikut

Kontroler meninjau.

## Rujukan

| hubungan | dokumen | paragraf | revisi |
|---|---|---|---|
${refs.map(([id, rev]) => `| keluaran | ${id} | | ${rev} |`).join("\n")}
`
}

let docA = ""
let reportB = ""

beforeAll(async () => {
  await resetEnvCache()
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  bridge = await import("../../src/store-bridge/index.ts")
  store = await mod.openHostStore(STORE, { release: "1.2.6", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.6" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  c = new Client({ name: "row86-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
  for (const [id, title] of [
    [MA, "Row 86 owner mission"],
    [MB, "Row 86 reviser mission"],
  ] as const) {
    const cr = await call("studio_mission_create", {
      mission: { id, title, type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1"), row("2")], decisions: [{ id: "U1", by: "user", date: "2026-11-12", text: "go" }] },
    })
    expect(cr.ok).toBe(true)
    expect((await call("studio_mission_approve", { mission: id, decision: "U1" })).ok).toBe(true)
    expect((await call("studio_mission_set_status", { mission: id, to: "running" })).ok).toBe(true)
  }
  // Mission A owns the document.
  const a = await call("studio_document_create", { template: "datum-nota", mission: MA, docKey: "row-1-kajian", title: "Kajian milik misi A" })
  expect(a.ok).toBe(true)
  docA = String(a.documentId)
}, 120_000)

afterAll(async () => {
  await c?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  globalThis.fetch = realFetch
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await resetEnvCache()
})

describe("row 86 MC-08: a document owned by mission A and revised under mission B is a deliverable of B", () => {
  test("B's deliverables list A's document with the revision B's report names (submit path)", async () => {
    // Mission B revises A's document, then its row 2 report names that revision as output.
    const imp = await call("studio_chapter_import_markdown", { documentId: docA, chapterKey: "1", markdown: "# Revisi B\n\nPengukuran titik uji direvisi oleh misi B.\n", submit: true, baseRevisionNo: 1 })
    expect(imp.ok).toBe(true)
    const revB = await currentRev(docA)
    expect(revB).toBeGreaterThan(1)
    const rep = await call("studio_report_submit", { markdown: report(MB, "2", [[docA, revB]]), row: "2" })
    quote("report submit", { ok: rep.ok, code: rep.code ?? null, message: rep.message ?? null })
    expect(rep.ok).toBe(true)
    reportB = String(rep.documentId)

    const g = await call("studio_mission_get", { mission: MB, include: ["deliverables"] })
    expect(g.ok).toBe(true)
    quote("B deliverables", g.deliverables)
    const list = g.deliverables as S[]
    const d = list.find((x) => x.documentId === docA)
    expect(d).toBeTruthy()
    expect(d).toMatchObject({ documentId: docA, revisionNo: revB, rowId: "2", linked: true, ownerMission: MA, title: "Kajian milik misi A" })
    expect(list.map((x) => x.documentId)).not.toContain(reportB) // the work report itself is never a deliverable

    // A still lists it as its own (current revision, no link marks).
    const ga = await call("studio_mission_get", { mission: MA, include: ["deliverables"] })
    const own = (ga.deliverables as S[]).find((x) => x.documentId === docA)!
    expect(own).toMatchObject({ documentId: docA, revisionNo: revB, rowId: "1" })
    expect(own.linked).toBeUndefined()
    expect(own.ownerMission).toBeUndefined()

    // The store row (N-065 shape).
    const links = await sql("SELECT mission_id, document_id, revision_no, row_id FROM mission_document WHERE document_id = ? ORDER BY revision_no", [docA])
    expect(links).toEqual([{ mission_id: MB, document_id: docA, revision_no: revB, row_id: "2" }])
  })

  test("a later revision named by a report update moves B's listed revision (update path, link history kept)", async () => {
    const revB = await currentRev(docA)
    const imp = await call("studio_chapter_import_markdown", { documentId: docA, chapterKey: "1", markdown: "# Revisi B kedua\n\nPengukuran titik uji direvisi lagi oleh misi B.\n", submit: true, baseRevisionNo: revB })
    expect(imp.ok).toBe(true)
    const rev2 = await currentRev(docA)
    expect(rev2).toBeGreaterThan(revB)
    const up = await call("studio_report_update", { documentId: reportB, markdown: report(MB, "2", [[docA, rev2]], `${reportB}@rev${await currentRev(reportB)}`) })
    quote("report update", { ok: up.ok, code: up.code ?? null, message: up.message ?? null })
    expect(up.ok).toBe(true)
    const g = await call("studio_mission_get", { mission: MB, include: ["deliverables"] })
    const d = (g.deliverables as S[]).filter((x) => x.documentId === docA)
    expect(d.length).toBe(1)
    expect(d[0]).toMatchObject({ revisionNo: rev2, linked: true, ownerMission: MA, rowId: "2" })
    const revs = (await sql<{ revision_no: number }>("SELECT revision_no FROM mission_document WHERE mission_id = ? AND document_id = ? ORDER BY revision_no", [MB, docA])).map((r) => Number(r.revision_no))
    expect(revs).toEqual([revB, rev2])
  })

  test("B's exported status_tasks.md carries the linked deliverable; a mission without deliverables keeps the old file", async () => {
    const { missionDocsExporter } = await import("../../src/mcp-host/mission/export/exporter.ts")
    const [status] = await missionDocsExporter({ mission: MB, files: ["status"], store: store as never })
    quote("B status_tasks.md", status!.markdown)
    expect(status!.markdown).toContain("## Deliverables")
    const line = status!.markdown.split("\n").find((l) => l.includes(`linked from ${MA}`))
    expect(line).toBeTruthy()
    expect(line).toContain(`rev ${await currentRev(docA)} (`)
    expect(line).toContain("| 2 |")
    // A fresh mission with nothing: no Deliverables part at all.
    const id = "2026-11-12_m86-empty"
    expect((await call("studio_mission_create", { mission: { id, title: "Empty", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1")], decisions: [{ id: "U1", by: "user", date: "2026-11-12", text: "go" }] } })).ok).toBe(true)
    const [empty] = await missionDocsExporter({ mission: id, files: ["status"], store: store as never })
    expect(empty!.markdown).not.toContain("Deliverables")
  })

  test("a report that names an unknown document or revision links nothing and is not refused by the link", async () => {
    const before = await sql("SELECT count(*) AS n FROM mission_document")
    // revision far beyond the document's: the reference is the report tools' to judge; the link table stays unchanged
    const rep = await call("studio_report_submit", { markdown: report(MB, "1", [[docA, 999]]), row: "1" })
    quote("report with a revision that does not exist", { ok: rep.ok, code: rep.code ?? null })
    const after = await sql("SELECT count(*) AS n FROM mission_document")
    expect(after).toEqual(before)
  })
})
