// Row 136b (C151, row 136 review M4 + M5): ONE rule for "verified" and "Final". The row done gate
// (store/mission/output-gate.ts), the store API (revisionVerification) and mission control's G1 read
// (mcp-host/mission/deliverables.ts) all use `revisionOutputState`; the deliverables read returns `verified` and
// `final` per deliverable and its outputs are exactly the rule's output set. Harness copied from row 155's test:
// REAL host server over a temp store opened with missionGuard: true. Needs the command sandbox off (ephemeral port).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW136B_TEST_DIR ?? "/private/tmp/claude-501/row136b/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row136b-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-136b")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

/** Process-wide caches and rate buckets reset on entry and exit (same pattern as rows 119b/126). */
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
const M = "2026-11-08_m136b-feature"

const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row136b test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
type S = Record<string, any>
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => {
  if (level === "error") console.log(`[row136b] host error ${source}: ${message} ${JSON.stringify(context ?? {})}`)
}
const quote = (label: string, v: unknown) => console.log(`[row136b] ${label}: ${JSON.stringify(v)}`)

async function start(missionGuard: boolean) {
  await resetEnvCache()
  store = await mod.openHostStore(STORE, { release: "1.2.1", logFile: LOG, missionGuard })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.1" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  c = new Client({ name: "row136b-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
}

async function stop() {
  await c?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
}

async function call(name: string, args: Record<string, unknown>): Promise<S> {
  const r = await c.callTool({ name, arguments: args })
  return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true }
}
const code = (r: S) => (r.ok === false ? r.code : "OK")
const setRow = (id: string, status: string, extra: Record<string, unknown> = {}) => call("studio_mission_update_row", { mission: M, rows: [{ id, status }], ...extra })
/** pending -> running -> needs-review (the path a controller's accept starts from). */
async function toReview(id: string) {
  expect(code(await setRow(id, "running"))).toBe("OK")
  expect(code(await setRow(id, "needs-review"))).toBe("OK")
}

function row(id: string) {
  return { id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "opus" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate" }
}

/** The §7.1 output set of a document's current revision, from row 149's store read. */
async function outputSet(documentId: string) {
  return store.revisionVerification(documentId, "latest")
}

/** Writes one verification record through row 149's API (what row 154's studio_render wrapper does). */
async function verify(outputId: string, sha256: string, state: "verified" | "unverified", statuses: readonly string[]) {
  const failCount = statuses.filter((s) => s === "FAIL").length
  const unknownCount = statuses.filter((s) => s === "UNKNOWN").length
  await store.transaction((tx) =>
    store.putOutputVerification(tx, {
      outputFileId: outputId,
      outputSha256: sha256,
      state,
      checksVersion: 1,
      failCount,
      unknownCount,
      report: { state, checks: statuses.map((status, i) => ({ check: `C${i}`, status })) },
      verifiedBy: "row136b-test",
    }),
  )
}

async function render(documentId: string, formats: string[]) {
  const rev = (await outputSet(documentId)).revisionNo
  const r = await call("studio_render", { documentId, revisionNo: rev, formats })
  quote(`render ${formats.join("+")}`, { ok: r.ok, code: r.code ?? null, outputs: (r.outputs ?? []).map((o: S) => ({ format: o.format, role: o.role })) })
  expect(r.ok).toBe(true)
}

async function deliverable(docKey: string, title: string, markdown?: string): Promise<string> {
  const d = await call("studio_document_create", { template: "datum-nota", mission: M, docKey, title })
  expect(d.ok).toBe(true)
  const id = String(d.documentId)
  if (markdown) expect((await call("studio_chapter_import_markdown", { documentId: id, chapterKey: "1", markdown, submit: true, baseRevisionNo: 1 })).ok).toBe(true)
  return id
}


beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  await start(true)
  expect(store.missionGuardEnabled).toBe(true)
  const cr = await call("studio_mission_create", {
    mission: { id: M, title: "Row 136b mission", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: ["1", "2", "3", "4"].map(row), decisions: [{ id: "U1", by: "user", date: "2026-11-07", text: "go" }] },
  })
  expect(cr.ok).toBe(true)
  expect((await call("studio_mission_approve", { mission: M, decision: "U1" })).ok).toBe(true)
  expect((await call("studio_mission_set_status", { mission: M, to: "running" })).ok).toBe(true)
}, 120_000)

afterAll(async () => {
  await stop()
  globalThis.fetch = realFetch
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await resetEnvCache()
})


/** Adds an output_file row copied from `fromId` (a superseded re-render or a scoped draft the rule must ignore). */
async function extraOutput(fromId: string, o: { sha: string; dt: number; scope?: "DOCUMENT" | "CHAPTER"; draft?: 0 | 1; format?: string }): Promise<string> {
  const id = `row136b-${o.sha[0]}-${Math.abs(o.dt)}-${fromId.slice(-6)}`
  await store.transaction(async (tx) => {
    tx.run(
      `INSERT INTO output_file (id, kind, document_id, revision_id, template_version_id, render_job_id, format, role, figure_label, rel_path, file_name, bytes, sha256, mime, lint_verdict, scope_kind, scope_key, draft, time_created)
       SELECT ?, kind, document_id, revision_id, template_version_id, render_job_id, COALESCE(?, format), role, figure_label, rel_path || '.' || ?, file_name, bytes, ?, mime, lint_verdict, ?, ?, ?, time_created + ?
         FROM output_file WHERE id = ?`,
      [id, o.format ?? null, id, o.sha, o.scope ?? "DOCUMENT", o.scope === "CHAPTER" ? "1" : null, o.draft ?? 0, o.dt, fromId],
    )
  })
  return id
}

/** The old app rule (mission-model.ts before row 136b): every listed PRIMARY output verified. */
const oldAppVerified = (d: S) => {
  const p = (d.outputs as S[]).filter((o) => o.role === "PRIMARY")
  return p.length > 0 && p.every((o) => o.verified === true)
}

async function deliverablesRead(): Promise<S[]> {
  const g = await call("studio_mission_get", { mission: M, include: ["deliverables"] })
  return g.deliverables as S[]
}

/** The read agrees with the store rule for one document: same set, same per-output state, same final. */
async function expectReadMatchesStore(d: S) {
  const set = await outputSet(String(d.documentId))
  expect(d.final).toBe(set.final)
  expect(d.verified).toBe(set.outputs.length > 0 && set.outputs.every((o) => o.state === "verified"))
  expect((d.outputs as S[]).map((o) => o.fileId).sort()).toEqual(set.outputs.map((o) => o.outputId).sort())
  for (const o of set.outputs) expect((d.outputs as S[]).find((x) => x.fileId === o.outputId)!.verified).toBe(o.state === "verified")
}

describe("row 136b: one verified/Final rule (guard on)", () => {
  test("M5 case where the old rules disagreed: gate lets the row go done; the read now says verified + final with the gate's output set", async () => {
    const doc = await deliverable("row-1-kajian", "Kajian row 136b", "# Uji\n\nPengukuran titik uji dicatat tiap bulan.\n")
    await render(doc, ["html"])
    const set0 = await outputSet(doc)
    for (const o of set0.outputs) await verify(o.outputId, o.sha256, "verified", ["PASS"])
    const html = set0.outputs.find((o) => o.format === "HTML" && o.role === "PRIMARY")!
    // an older superseded HTML re-render (unverified) and a newer scoped chapter draft (unverified)
    const superseded = await extraOutput(html.outputId, { sha: "a".repeat(64), dt: -60_000 })
    const draft = await extraOutput(html.outputId, { sha: "b".repeat(64), dt: 60_000, scope: "CHAPTER", draft: 1 })
    const set = await outputSet(doc)
    expect(set.final).toBe(true)
    expect(set.outputs.map((o) => o.outputId)).not.toContain(superseded)
    expect(set.outputs.map((o) => o.outputId)).not.toContain(draft)

    await toReview("1")
    const done = await setRow("1", "done")
    quote("row 1 done (gate)", { code: code(done) })
    expect(code(done)).toBe("OK")

    const d = (await deliverablesRead()).find((x) => x.documentId === doc)!
    quote("read row-1-kajian", { verified: d.verified, final: d.final, outputs: (d.outputs as S[]).map((o) => ({ id: o.fileId, f: o.format, v: o.verified })) })
    expect(d.verified).toBe(true)
    expect(d.final).toBe(true)
    expect((d.outputs as S[]).map((o) => o.fileId)).not.toContain(superseded)
    expect((d.outputs as S[]).map((o) => o.fileId)).not.toContain(draft)
    // the old app rule over the new wire also agrees now (it said Unverified before: the extra PRIMARY HTMLs were listed)
    expect(oldAppVerified(d)).toBe(true)
    await expectReadMatchesStore(d)
  }, 60_000)

  test("gate refusal and deliverables read always match (NOT_RENDERED, CHECK_UNKNOWN, NO_LAYOUT_WITNESS, superseded DOCX, Final, mission-level)", async () => {
    const notRendered = await deliverable("row-2-laporan", "Laporan row 2")
    const unknown = await deliverable("row-3-catatan", "Catatan row 3", "# Catatan\n\nIsi catatan.\n")
    await render(unknown, ["html"])
    const docxOnly = await deliverable("row-4-memo", "Memo row 4", "# Memo\n\nIsi memo singkat.\n")
    await render(docxOnly, ["docx"])
    for (const o of (await outputSet(docxOnly)).outputs.filter((x) => x.format === "DOCX")) await verify(o.outputId, o.sha256, "verified", ["PASS"])
    const supersededDocx = await deliverable("row-4-lampiran", "Lampiran row 4", "# Lampiran\n\nIsi lampiran.\n")
    await render(supersededDocx, ["docx"])
    const s4 = await outputSet(supersededDocx)
    for (const o of s4.outputs) await verify(o.outputId, o.sha256, "verified", ["PASS"])
    await extraOutput(s4.outputs.find((o) => o.format === "DOCX")!.outputId, { sha: "c".repeat(64), dt: -60_000 })
    const missionLevel = await deliverable("lampiran", "Lampiran mission-level", "# L\n\nIsi.\n")
    await render(missionLevel, ["html"])

    const byRow: Record<string, string[]> = { "2": [notRendered], "3": [unknown], "4": [docxOnly, supersededDocx] }
    const reads = await deliverablesRead()
    const seen: S[] = []
    for (const [rowId, docs] of Object.entries(byRow)) {
      await toReview(rowId)
      const r = await setRow(rowId, "done")
      const refused = new Set(r.ok === false ? (r.error.details.deliverables as S[]).map((x) => x.documentId) : [])
      for (const doc of docs) {
        const d = reads.find((x) => x.documentId === doc)!
        seen.push({ row: rowId, doc: d.docKey, gateRefused: refused.has(doc), readFinal: d.final, readVerified: d.verified, gate: code(r) })
        expect(refused.has(doc)).toBe(!d.final)
        await expectReadMatchesStore(d)
      }
    }
    quote("gate vs read", seen)
    // the four expected verdicts (row-4-lampiran: DOCX + measured HTML verified, older unverified DOCX ignored -> Final)
    expect(seen.map((x) => [x.doc, x.readFinal])).toEqual([["row-2-laporan", false], ["row-3-catatan", false], ["row-4-memo", false], ["row-4-lampiran", true]])
    await expectReadMatchesStore(reads.find((x) => x.documentId === missionLevel)!)
  }, 120_000)
})
