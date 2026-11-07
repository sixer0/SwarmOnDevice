// Row 155: the mission rule of masterplan/01_specs_output_verification.md §7 (C129, C130, C140) and the completed G4
// seam (row 126, deliverables.ts) through the REAL host server (startStudioHostServer, streamable HTTP on 127.0.0.1,
// MCP SDK client) over a temp store opened with missionGuard: true, as start.ts does; the last block reopens the same
// store with the guard off. Verification records are written through row 149's store API (putOutputVerification),
// the same call row 154's studio_render wrapper makes.
// Needs the command sandbox off (binds an ephemeral port). globalThis.fetch is a trap: the host must never call it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW155_TEST_DIR ?? "/private/tmp/claude-501/row155/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row155-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-155")
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
const M = "2026-11-07_m155-feature"

const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row155 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
type S = Record<string, any>
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => {
  if (level === "error") console.log(`[row155] host error ${source}: ${message} ${JSON.stringify(context ?? {})}`)
}
const quote = (label: string, v: unknown) => console.log(`[row155] ${label}: ${JSON.stringify(v)}`)

async function start(missionGuard: boolean) {
  await resetEnvCache()
  store = await mod.openHostStore(STORE, { release: "1.2.1", logFile: LOG, missionGuard })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.1" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  c = new Client({ name: "row155-test", version: "0" })
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
      verifiedBy: "row155-test",
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

let docA = ""
let docC = ""

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
    mission: { id: M, title: "Row 155 mission", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: ["1", "2", "3", "4"].map(row), decisions: [{ id: "U1", by: "user", date: "2026-11-07", text: "go" }] },
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

describe("row 155: row done gate (guard on)", () => {
  test("B12-style unverified output: done refused OUTPUT_UNVERIFIED (NOT_CHECKED), also with a decision; deliverables read shows verified=false", async () => {
    docA = await deliverable("row-1-kajian", "Kajian row 155", "# Uji\n\nPengukuran titik uji dicatat tiap bulan.\n")
    await render(docA, ["html"])
    await toReview("1")
    const refused = await setRow("1", "done")
    quote("row 1 done, unverified", { code: refused.code, message: refused.error?.message, details: refused.error?.details })
    expect(refused._isError).toBe(true)
    expect(code(refused)).toBe("OUTPUT_UNVERIFIED")
    expect(refused.error.message).toBe("row 1 has deliverables that are not verified")
    const det = refused.error.details as S
    expect(det).toMatchObject({ mission: M, row: "1" })
    expect(det.deliverables).toHaveLength(1)
    expect(det.deliverables[0]).toMatchObject({ documentId: docA, docKey: "row-1-kajian", final: false })
    // Row 154: studio_render now records its verification; without a render bridge OVERLAP_CLIP is UNKNOWN -> CHECK_UNKNOWN.
    expect((det.deliverables[0].outputs as S[]).some((o) => o.format === "HTML" && o.state === "unverified" && o.reason === "CHECK_UNKNOWN")).toBe(true)
    // D-6: no decision lifts it
    const withDecision = await setRow("1", "done", { decision: "U1" })
    quote("row 1 done with decision U1", { code: withDecision.code })
    expect(code(withDecision)).toBe("OUTPUT_UNVERIFIED")
    // the row did not move
    const g = await call("studio_mission_get", { mission: M, include: ["rows", "deliverables"] })
    expect((g.mission.rows as S[]).find((r) => r.id === "1")!.status).toBe("needs-review")
    const outs = (g.deliverables as S[]).find((d) => d.documentId === docA)!.outputs as S[]
    quote("G4 before verify", outs.map((o) => ({ format: o.format, verified: o.verified })))
    expect(outs.length).toBeGreaterThan(0)
    expect(outs.every((o) => o.verified === false)).toBe(true)
  })

  test("a failing check keeps it refused (CHECK_FAILED); B11: all outputs verified -> done; G4 read shows verified=true from the store", async () => {
    const set = await outputSet(docA)
    const html = set.outputs.find((o) => o.format === "HTML" && o.role === "PRIMARY")!
    await verify(html.outputId, html.sha256, "unverified", ["PASS", "FAIL", "PASS"])
    const failed = await setRow("1", "done")
    quote("row 1 done, check failed", { code: failed.code, outputs: failed.error?.details?.deliverables?.[0]?.outputs })
    expect(code(failed)).toBe("OUTPUT_UNVERIFIED")
    expect((failed.error.details.deliverables[0].outputs as S[]).find((o) => o.outputId === html.outputId)!.reason).toBe("CHECK_FAILED")
    const g0 = await call("studio_mission_get", { mission: M, include: ["deliverables"] })
    expect(((g0.deliverables as S[]).find((d) => d.documentId === docA)!.outputs as S[]).find((o) => o.fileId === html.outputId)!.verified).toBe(false)

    for (const o of set.outputs) await verify(o.outputId, o.sha256, "verified", ["PASS", "PASS", "NOT_APPLICABLE"])
    expect((await outputSet(docA)).final).toBe(true)
    const g = await call("studio_mission_get", { mission: M, include: ["deliverables"] })
    const outs = (g.deliverables as S[]).find((d) => d.documentId === docA)!.outputs as S[]
    quote("G4 after verify", outs.map((o) => ({ format: o.format, verified: o.verified })))
    for (const o of set.outputs) expect(outs.find((x) => x.fileId === o.outputId)!.verified).toBe(true)
    const done = await setRow("1", "done")
    quote("row 1 done, verified", { code: code(done) })
    expect(code(done)).toBe("OK")
    const after = await call("studio_mission_get", { mission: M, include: ["rows"] })
    expect((after.mission.rows as S[]).find((r) => r.id === "1")!.status).toBe("done")
    // G2: activityAt is at least the newest verification time
    const l = await call("studio_mission_list", { projectDir: PROJECT })
    expect(Date.parse(l.items.find((m: S) => m.id === M).activityAt)).toBeGreaterThanOrEqual(Date.parse(after.mission.updatedAt))
  })

  test("C129: a row with no bound deliverables goes done (mission-level docKey and other rows' docs do not bind)", async () => {
    await deliverable("lampiran", "Lampiran mission-level")
    await deliverable("row-21-lain", "Row 21 doc, not row 2")
    await toReview("2")
    const done = await setRow("2", "done")
    quote("row 2 done, no deliverables", { code: code(done) })
    expect(code(done)).toBe("OK")
  })

  test("B12: deliverable created, never rendered -> refused NOT_RENDERED", async () => {
    docC = await deliverable("row-3-laporan", "Laporan row 3")
    await toReview("3")
    const r = await setRow("3", "done")
    quote("row 3 done, not rendered", { code: r.code, details: r.error?.details })
    expect(code(r)).toBe("OUTPUT_UNVERIFIED")
    expect(r.error.details.deliverables[0]).toMatchObject({ documentId: docC, docKey: "row-3-laporan", final: false })
    expect(r.error.details.deliverables[0].outputs).toContainEqual({ outputId: null, format: null, state: "unverified", reason: "NOT_RENDERED" })
  })

  test("B13: a verified DOCX alone has no layout witness -> refused NO_LAYOUT_WITNESS", async () => {
    const d = await deliverable("row-4-memo", "Memo row 4", "# Memo\n\nIsi memo singkat.\n")
    await render(d, ["docx"])
    const set = await outputSet(d)
    expect(set.outputs.some((o) => o.format === "DOCX")).toBe(true)
    // Row 154: the studio_render wrapper adds the measured HTML (§6.1) and records it; with no render bridge in this
    // test its OVERLAP_CLIP is UNKNOWN, so the HTML stays unverified and only the DOCX is verified here.
    for (const o of set.outputs.filter((x) => x.format === "DOCX")) await verify(o.outputId, o.sha256, "verified", ["PASS"])
    await toReview("4")
    const r = await setRow("4", "done")
    quote("row 4 done, docx only", { code: r.code, outputs: r.error?.details?.deliverables?.[0]?.outputs, set: set.outputs.map((o) => o.format) })
    expect(set.outputs.map((o) => o.format).sort()).toEqual(["DOCX", "HTML"])
    expect(set.outputs.find((o) => o.format === "HTML")!.state).toBe("unverified")
    expect(code(r)).toBe("OUTPUT_UNVERIFIED")
    expect(r.error.details.deliverables[0].outputs).toContainEqual({ outputId: null, format: null, state: "unverified", reason: "NO_LAYOUT_WITNESS" })
  }, 60_000)
})

describe("row 155: guard off (store reopened with missionGuard: false)", () => {
  test("the same never-rendered deliverable no longer blocks done (D-10)", async () => {
    await stop()
    await start(false)
    expect(store.missionGuardEnabled).toBe(false)
    const r = await setRow("3", "done")
    quote("row 3 done, guard off", { code: code(r) })
    expect(code(r)).toBe("OK")
  }, 60_000)
})
