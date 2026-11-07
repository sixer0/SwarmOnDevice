// Row 126: the host read fields of masterplan/01_specs_mission_control_ui.md §8 (G1 deliverables, G2 activityAt,
// G3 messages tail, G4 verified) through the REAL host server (startStudioHostServer, streamable HTTP on 127.0.0.1,
// MCP SDK client) over a temp store opened with missionGuard: true, as start.ts does (row 119b test pattern).
// G4: row 149's store state is not landed; the seam (deliverables.ts `outputVerification`) reads the store's optional
// `outputVerificationStates` when present, else "unverified". Both branches are proven here.
// Needs the command sandbox off (binds an ephemeral port). globalThis.fetch is a trap: the host must never call it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { FINAL_FILENAME_PATTERN } from "../../vendor/src/lib/studio/contract/env"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW126_TEST_DIR ?? "/private/tmp/claude-501/row126/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row126-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-126")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

/**
 * Process-wide state (the getStudioEnv root cache, the per-caller rate buckets) is reset on entry and on exit, so the
 * files sharing one `bun test` process stay independent (row 119b relies on a fresh cache and fresh buckets).
 */
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

const TOKEN = "d".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const M = "2026-11-07_m126-feature"
const M_OTHER = "2026-11-07_m126-other"

const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row126 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
type S = Record<string, any>
let mod: Mod
let bridge: typeof import("../../src/store-bridge/index.ts")
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => {
  if (level === "error") console.log(`[row126] host error ${source}: ${message} ${JSON.stringify(context ?? {})}`)
}
const quote = (label: string, v: unknown) => console.log(`[row126] ${label}: ${JSON.stringify(v)}`)

async function call(name: string, args: Record<string, unknown>): Promise<S> {
  const r = await c.callTool({ name, arguments: args })
  return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true }
}
const code = (r: S) => (r.ok === false ? r.code : "OK")
const sql = <T = S>(q: string, p: unknown[] = []) => bridge.withStudioTx(async (tx) => tx.all(q, p as never) as T[])

function row(id: string, phase: string, kind: string, deps: string[] = []) {
  return { id, phase, kind, title: `Row ${id}`, agent: "coder-execution", model: { tier: "opus" }, deps, size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate" }
}

/** A valid work report (same shape as the row 119b test). */
function report(mission: string, taskRef: string): string {
  return `# Laporan baris

mission: ${mission}
Status: complete
Owner: coder-execution
TaskRef: ${taskRef}
ReportedAt: 2026-11-07

## Ringkasan

Pekerjaan baris selesai ditulis dan diuji.

## Rincian kerja

| key | judul | status | owner | bukti |
|---|---|---|---|---|
| KUNCI-1 | Tulis kode | done | coder-execution | src/a.ts |

Kode ditulis lalu diuji.

## Bukti

Uji lulus 10 dari 10.

## Isu terbuka

Tidak ada.

## Langkah berikut

Kontroler meninjau.
`
}

let docA = ""
let docB = ""
let docReport = ""

beforeAll(async () => {
  await resetEnvCache()
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  bridge = await import("../../src/store-bridge/index.ts")
  store = await mod.openHostStore(STORE, { release: "1.2.1", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.1" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  c = new Client({ name: "row126-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
  for (const [id, title] of [
    [M, "Row 126 feature mission"],
    [M_OTHER, "Row 126 other mission"],
  ] as const) {
    const cr = await call("studio_mission_create", {
      mission: { id, title, type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1", "implementation", "implementation"), row("2", "implementation", "implementation")], decisions: [{ id: "U1", by: "user", date: "2026-11-07", text: "go" }] },
    })
    expect(cr.ok).toBe(true)
    expect((await call("studio_mission_approve", { mission: id, decision: "U1" })).ok).toBe(true)
    expect((await call("studio_mission_set_status", { mission: id, to: "running" })).ok).toBe(true)
  }
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

describe("row 126: G1 deliverables + G4 verified", () => {
  test("a rendered mission document is a deliverable with outputs, finalFileName, sha256, linked row and verified=false (no row 149 state)", async () => {
    const a = await call("studio_document_create", { template: "datum-nota", mission: M, docKey: "row-1-kajian", title: "Kajian row 126" })
    expect(a.ok).toBe(true)
    docA = String(a.documentId)
    const imp = await call("studio_chapter_import_markdown", { documentId: docA, chapterKey: "1", markdown: "# Uji\n\nPengukuran titik uji dicatat tiap bulan.\n", submit: true, baseRevisionNo: 1 })
    expect(imp.ok).toBe(true)
    // docKey without the row-<id>-<slug> form, and one naming a row that does not exist: listed without a row
    const b = await call("studio_document_create", { template: "datum-nota", mission: M, docKey: "lampiran", title: "Lampiran row 126" })
    expect(b.ok).toBe(true)
    docB = String(b.documentId)
    const ghost = await call("studio_document_create", { template: "datum-nota", mission: M, docKey: "row-99-hantu", title: "Baris tak ada" })
    expect(ghost.ok).toBe(true)
    // A work report of row 2 is a row report, not a deliverable (spec §7.1)
    const rep = await call("studio_report_submit", { markdown: report(M, "2"), row: "2" })
    quote("work report submit", { ok: rep.ok, code: rep.code ?? null })
    expect(rep.ok).toBe(true)
    docReport = String(rep.documentId)

    const rev = Number((await sql<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [docA]))[0]!.n)
    const r = await call("studio_render", { documentId: docA, revisionNo: rev, formats: ["html"] })
    quote("render html", { ok: r.ok, code: r.code ?? null, outputs: (r.outputs ?? []).map((o: S) => ({ id: o.id, format: o.format, sha256: o.sha256 })) })
    expect(r.ok).toBe(true)
    const out = (r.outputs as S[]).find((o) => o.format === "HTML")!
    expect(out).toBeTruthy()

    const g = await call("studio_mission_get", { mission: M, include: ["deliverables"] })
    expect(g.ok).toBe(true)
    quote("deliverables", g.deliverables)
    const keys = (g.deliverables as S[]).map((d) => d.docKey)
    expect(keys).toEqual(expect.arrayContaining(["row-1-kajian", "lampiran", "row-99-hantu"]))
    expect(keys).not.toContain("row-2")
    expect((g.deliverables as S[]).map((d) => d.documentId)).not.toContain(docReport)
    const da = (g.deliverables as S[]).find((d) => d.documentId === docA)!
    expect(da).toMatchObject({ docKey: "row-1-kajian", rowId: "1", revisionNo: rev, title: "Kajian row 126" })
    expect(typeof da.docNumber).toBe("string")
    expect(typeof da.docRev).toBe("string")
    const o = (da.outputs as S[]).find((x) => x.fileId === out.id)!
    expect(o).toMatchObject({ format: "HTML", role: "PRIMARY", sha256: out.sha256, verified: false })
    expect(o.bytes).toBeGreaterThan(0)
    expect(o.finalFileName).toMatch(new RegExp(FINAL_FILENAME_PATTERN))
    expect(o.finalFileName).toContain(`_rev${rev}_`)
    expect(o.finalFileName).toContain(String(out.sha256).slice(0, 8))
    // same name R10 / studio_file_verify would give: the DB row through Studio's own naming
    const stored = (await sql<{ sha256: string; bytes: number }>("SELECT sha256, bytes FROM output_file WHERE id = ?", [out.id]))[0]!
    expect(o.sha256).toBe(stored.sha256)
    expect(o.bytes).toBe(Number(stored.bytes))
    expect((g.deliverables as S[]).find((d) => d.documentId === docB)!.rowId).toBeUndefined()
    expect((g.deliverables as S[]).find((d) => d.docKey === "row-99-hantu")!.rowId).toBeUndefined()
    // without include: no deliverables key (existing default unchanged)
    const plain = await call("studio_mission_get", { mission: M })
    expect(plain.deliverables).toBeUndefined()
    expect(plain.mission.rows.length).toBe(2)
  })

  test("G4 seam: when the store has row 149's read, its 'verified' record shows verified=true; any other state stays false", async () => {
    const outs = await sql<{ id: string; sha256: string }>("SELECT o.id, o.sha256 FROM output_file o JOIN document d ON d.id = o.document_id WHERE d.id = ?", [docA])
    expect(outs.length).toBeGreaterThan(0)
    const target = outs[0]!.id
    const s = store as unknown as { outputVerificationStates?: (ids: readonly string[]) => ReadonlyMap<string, { state: string; at?: number }> }
    try {
      s.outputVerificationStates = (ids) => new Map(ids.map((id) => [id, { state: id === target ? "verified" : "failed", at: Date.parse("2030-01-01T00:00:00Z") }]))
      // Row 136b (C151, M5): G1 `verified` is the store's one rule over row 149 records, not this injected seam;
      // the injected source now feeds only G2's verification time.
      const g = await call("studio_mission_get", { mission: M, include: ["deliverables"] })
      const all = (g.deliverables as S[]).flatMap((d) => d.outputs as S[])
      quote("G4 with injected source (G1 ignores it)", all.map((x) => ({ fileId: x.fileId, verified: x.verified })))
      expect(all.every((x) => x.verified === false)).toBe(true)
      // G2 also takes the verification time into account
      const l = await call("studio_mission_list", { projectDir: PROJECT })
      expect(l.items.find((m: S) => m.id === M).activityAt).toBe("2030-01-01T00:00:00.000Z")
    } finally {
      delete s.outputVerificationStates
    }
    // a real row 149 record: 'verified' of the same bytes -> verified=true for that output only
    const rec = (state: "verified" | "unverified") =>
      store.transaction((tx) =>
        store.putOutputVerification(tx, { outputFileId: target, outputSha256: outs[0]!.sha256, state, checksVersion: 1, failCount: 0, unknownCount: state === "verified" ? 0 : 1, report: { state, checks: [{ check: "C0", status: state === "verified" ? "PASS" : "UNKNOWN" }] }, verifiedBy: "row126-test" }),
      )
    await rec("verified")
    const g2 = await call("studio_mission_get", { mission: M, include: ["deliverables"] })
    const all2 = (g2.deliverables as S[]).flatMap((d) => d.outputs as S[])
    quote("G4 with a store record", all2.map((x) => ({ fileId: x.fileId, verified: x.verified })))
    expect(all2.find((x) => x.fileId === target)!.verified).toBe(true)
    expect(all2.filter((x) => x.fileId !== target).every((x) => x.verified === false)).toBe(true)
    await rec("unverified")
    const back = await call("studio_mission_get", { mission: M, include: ["deliverables"] })
    expect((back.deliverables as S[]).flatMap((d) => d.outputs as S[]).every((x) => x.verified === false)).toBe(true)
  })
})

describe("row 126: G2 activityAt", () => {
  test("every list item has activityAt; a render moves it while updatedAt stays", async () => {
    const before = await call("studio_mission_list", { projectDir: PROJECT })
    expect(before.ok).toBe(true)
    for (const it of before.items as S[]) expect(Date.parse(it.activityAt)).toBeGreaterThanOrEqual(Date.parse(it.updatedAt))
    const m0 = (before.items as S[]).find((m) => m.id === M)!
    const other = (before.items as S[]).find((m) => m.id === M_OTHER)!
    expect(other.activityAt).toBe(other.updatedAt) // no documents
    await Bun.sleep(5)
    const rev = Number((await sql<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [docA]))[0]!.n)
    const r = await call("studio_render", { documentId: docA, revisionNo: rev, formats: ["docx"] })
    expect(r.ok).toBe(true)
    const after = await call("studio_mission_list", { projectDir: PROJECT })
    const m1 = (after.items as S[]).find((m) => m.id === M)!
    quote("activityAt before/after render", { before: m0.activityAt, after: m1.activityAt, updatedAt: m1.updatedAt })
    expect(m1.updatedAt).toBe(m0.updatedAt)
    expect(Date.parse(m1.activityAt)).toBeGreaterThan(Date.parse(m0.activityAt))
    expect((after.items as S[]).find((m) => m.id === M_OTHER)!.activityAt).toBe(other.activityAt)
  })
})

describe("row 126: G3 messages tail", () => {
  test("messagesTail N returns the newest N in ascending seq; schema bounds 1-50", async () => {
    const texts = Array.from({ length: 7 }, (_, i) => `message ${i + 1}`)
    for (const t of texts) expect((await call("studio_mission_update_row", { mission: M, messages: [{ from: "agent", to: "controller", kind: "report", text: t }] })).ok).toBe(true)
    // a message in another mission must not appear
    expect((await call("studio_mission_update_row", { mission: M_OTHER, messages: [{ from: "agent", to: "controller", kind: "report", text: "other mission" }] })).ok).toBe(true)
    const g = await call("studio_mission_get", { mission: M, include: ["rows"], messagesTail: 4 })
    quote("tail 4", (g.messages as S[]).map((m) => m.text))
    expect((g.messages as S[]).map((m) => m.text)).toEqual(["message 4", "message 5", "message 6", "message 7"])
    const seqs = (g.messages as S[]).map((m) => m.seq)
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs)
    const big = await call("studio_mission_get", { mission: M, messagesTail: 50 })
    expect((big.messages as S[]).map((m) => m.text)).toEqual(texts)
    const all = await call("studio_mission_get", { mission: M, include: ["messages"] })
    expect((all.messages as S[]).map((m) => m.text)).toEqual(texts) // existing oldest-first read unchanged
    expect(code(await call("studio_mission_get", { mission: M, messagesTail: 0 }))).toBe("SCHEMA_INVALID")
    expect(code(await call("studio_mission_get", { mission: M, messagesTail: 51 }))).toBe("SCHEMA_INVALID")
    expect(code(await call("studio_mission_get", { mission: "2026-11-07_m126-none", messagesTail: 3 }))).toBe("MISSION_NOT_FOUND")
  })
})
