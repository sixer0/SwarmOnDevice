// Row 174 (C218 F146b-3, host side of F146b-2): an abandoned old draft linked to a mission row (docKey row-<R>-<name>)
// blocked the row's done gate for ever (OUTPUT_UNVERIFIED) although the row's current deliverable was VERIFIED; the agent
// had no way to unlink it and dropped the row. Fix: a row patch `retire: [documentId]` (studio_mission_update_row)
// archives a linked draft that another live deliverable of the same row supersedes; the gate and the Deliverables read
// then judge only the current deliverables. The gate itself is unchanged (UNKNOWN never passes, an unverified current
// output still refuses done). Harness copied from row 155 (real host server, MCP SDK client, temp store, guard on).
// Needs the command sandbox off (binds an ephemeral port). globalThis.fetch is a trap: the host must never call it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW174_TEST_DIR ?? "/private/tmp/claude-501/row174/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row174-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-174")
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
const M = "2026-11-07_m174-retire"

const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row174 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
type S = Record<string, any>
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => {
  if (level === "error") console.log(`[row174] host error ${source}: ${message} ${JSON.stringify(context ?? {})}`)
}
const quote = (label: string, v: unknown) => console.log(`[row174] ${label}: ${JSON.stringify(v)}`)

async function start(missionGuard: boolean) {
  await resetEnvCache()
  store = await mod.openHostStore(STORE, { release: "1.2.1", logFile: LOG, missionGuard })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.1" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  c = new Client({ name: "row174-test", version: "0" })
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
  return { id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate" }
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
      verifiedBy: "row174-test",
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
  const cr = await call("studio_mission_create", {
    mission: { id: M, title: "Row 174 mission", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: ["1", "2"].map(row), decisions: [{ id: "U1", by: "user", date: "2026-11-08", text: "go" }] },
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

async function verifyAll(documentId: string) {
  for (const o of (await outputSet(documentId)).outputs) await verify(o.outputId, o.sha256, "verified", ["PASS", "PASS"])
  expect((await outputSet(documentId)).final).toBe(true)
}
const patch = (p: Record<string, unknown>, extra: Record<string, unknown> = {}) => call("studio_mission_update_row", { mission: M, rows: [p], ...extra })

describe("row 174: a superseded draft no longer blocks the row (F146b-3)", () => {
  let oldDraft = ""
  let current = ""
  let other = ""

  test("before: old draft (never verified) + current deliverable VERIFIED -> done refused, only the old draft listed", async () => {
    oldDraft = await deliverable("row-1-laporan", "Laporan lama", "# Draf\n\nDraf lama yang ditinggalkan.\n")
    await render(oldDraft, ["html"])
    current = await deliverable("row-1-kajian", "Kajian kini", "# Kajian\n\nPengukuran titik uji dicatat tiap bulan.\n")
    await render(current, ["html"])
    await verifyAll(current)
    await toReview("1")
    const r = await setRow("1", "done")
    quote("row 1 done with old draft linked", { code: code(r), deliverables: r.error?.details?.deliverables?.map((d: S) => d.docKey) })
    expect(code(r)).toBe("OUTPUT_UNVERIFIED")
    expect((r.error.details.deliverables as S[]).map((d) => d.documentId)).toEqual([oldDraft])
  })

  test("retire is refused without a note, for a document of another row, for an unknown id, and when it would leave the row without a live deliverable", async () => {
    other = await deliverable("row-2-memo", "Memo row 2")
    const noNote = await patch({ id: "1", retire: [oldDraft] })
    quote("retire without note", { code: code(noNote), message: noNote.error?.message })
    expect(code(noNote)).toBe("SCHEMA_INVALID")
    const wrongRow = await patch({ id: "1", retire: [other], note: "draf lama" })
    quote("retire other row's doc", { code: code(wrongRow), details: wrongRow.error?.details })
    expect(code(wrongRow)).toBe("DELIVERABLE_NOT_RETIRABLE")
    expect(wrongRow.error.details).toMatchObject({ row: "1", documentId: other, reason: "NOT_BOUND_TO_ROW" })
    const unknown = await patch({ id: "1", retire: ["cunknownunknownunknown000"], note: "draf lama" })
    expect(code(unknown)).toBe("DELIVERABLE_NOT_RETIRABLE")
    expect(unknown.error.details.reason).toBe("NOT_IN_MISSION")
    const all = await patch({ id: "1", retire: [oldDraft, current], note: "semua" })
    quote("retire every deliverable of the row", { code: code(all), details: all.error?.details })
    expect(code(all)).toBe("DELIVERABLE_NOT_RETIRABLE")
    expect(all.error.details.reason).toBe("NO_CURRENT_DELIVERABLE")
    // nothing changed: the old draft still blocks
    expect(code(await setRow("1", "done"))).toBe("OUTPUT_UNVERIFIED")
  })

  test("after: retire the old draft and set done in one patch -> OK; Deliverables read lists only the current, verified, final document", async () => {
    const r = await patch({ id: "1", retire: [oldDraft], status: "done", note: "Draf lama row-1-laporan digantikan row-1-kajian." })
    quote("retire + done", { code: code(r), message: r.error?.message })
    expect(code(r)).toBe("OK")
    const g = await call("studio_mission_get", { mission: M, include: ["rows", "deliverables"] })
    expect((g.mission.rows as S[]).find((x) => x.id === "1")!.status).toBe("done")
    const ds = (g.deliverables as S[]).filter((d) => d.rowId === "1")
    quote("deliverables of row 1", ds.map((d) => ({ docKey: d.docKey, verified: d.verified, final: d.final })))
    expect(ds.map((d) => d.documentId)).toEqual([current])
    expect(ds[0]).toMatchObject({ verified: true, final: true })
  })

  test("the gate still refuses an unverified CURRENT output: retiring the verified doc leaves the unverified one blocking", async () => {
    const a = await deliverable("row-2-laporan", "Laporan row 2", "# Isi\n\nIsi laporan.\n")
    await render(a, ["html"])
    await verifyAll(a)
    // `other` (row-2-memo, never rendered) is the current, unverified deliverable; retiring the verified one does not help
    expect(code(await patch({ id: "2", retire: [a], note: "uji" }))).toBe("OK")
    await toReview("2")
    const r = await setRow("2", "done")
    quote("row 2 done, unverified current", { code: code(r), deliverables: r.error?.details?.deliverables })
    expect(code(r)).toBe("OUTPUT_UNVERIFIED")
    expect(r.error.details.deliverables[0]).toMatchObject({ documentId: other, final: false })
    // a decision does not lift it either (D-6)
    expect(code(await setRow("2", "done", { decision: "U1" }))).toBe("OUTPUT_UNVERIFIED")
  })
})
