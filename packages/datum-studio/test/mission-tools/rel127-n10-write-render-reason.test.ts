// Swarm 1.2.7 row 38 (AC-N10, N-10, register N7-106 / N7-144; C8 D-14, C9, C12 O-3).
// (1) "reason": a `studio_write` whose render is refused (DT-10a, FIGURE_OVER_CAPACITY) names that refusal in its text
//     (`berkas: tidak dirender (galat FIGURE_OVER_CAPACITY (DT-10a))`), never the bare `NO_DOCX_OUTPUT`; the server's
//     message stays inside the untrusted block (MCP-D4). Red at 04067a9d02: `berkas: tidak dirender (galat NO_DOCX_OUTPUT)`.
// (2) "retire matrix" (PROBE, C9): (a) a failed write with docKey row-1-<name> is retirable once another row-1
//     deliverable exists; (b) a non-row docKey is refused NOT_BOUND_TO_ROW; (c) a row's only deliverable is refused
//     NO_CURRENT_DELIVERABLE. (b)/(c) are by design. Expected green at BASE (01c K-1) -> "not reproduced".
// (3) "idempotent" (CHAR): the same studio_write repeated after a failed render reuses the same document (one document
//     for the docKey); a renderable write still returns render.fileId, sha256 and verified.
// Through the REAL host server (startStudioHostServer, streamable HTTP on 127.0.0.1, MCP SDK client) over a temp store
// with missionGuard: true (row 86 / row 174 pattern). Needs the command sandbox off (binds an ephemeral port).
// Fixture: syn127/n10_write_dt10a.json (row 20, cells re-made unbreakable in row 48c: 60 characters, no separator).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const FIXTURE = path.join(PKG, "test", "fixtures", "syn127", "n10_write_dt10a.json")
const WORK = realpathSync(mkdtempSync(path.join(tmpdir(), "n10-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-n10")
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
const M = "2026-11-13_m127-n10"

const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("rel127 n10 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
type S = Record<string, any>
let mod: Mod
let bridge: typeof import("../../src/store-bridge/index.ts")
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => {
  if (level === "error") console.log(`[rel127-n10] host error ${source}: ${message} ${JSON.stringify(context ?? {})}`)
}
const quote = (label: string, v: unknown) => console.log(`[rel127-n10] ${label}: ${JSON.stringify(v)}`)

async function call(name: string, args: Record<string, unknown>): Promise<S> {
  const r = await c.callTool({ name, arguments: args })
  const text = ((r.content ?? []) as Array<{ type: string; text?: string }>).filter((x) => x.type === "text").map((x) => x.text ?? "").join("\n")
  return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: text }
}
const code = (r: S) => (r.ok === false ? r.code : "OK")
const sql = <T = S>(q: string, p: unknown[] = []) => bridge.withStudioTx(async (tx) => tx.all(q, p as never) as T[])

function row(id: string) {
  return { id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate" }
}

const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as { args: S; expected: { renderError: string; checkId: string } }
/** The fixture's studio_write args under this mission and `docKey` (each cell is one unbreakable token). */
function failingArgs(docKey: string): S {
  const a = JSON.parse(JSON.stringify(fx.args)) as S
  return { ...a, mission: M, docKey }
}
/** Same document shape, short cells: renders. */
function renderableArgs(docKey: string): S {
  const a = JSON.parse(JSON.stringify(fx.args)) as S
  a.sections[1].blocks[0].table = [["Kode A", "Kode B", "Kode C"], ["R-01", "R-02", "R-03"]]
  return { ...a, mission: M, docKey }
}
const patch = (p: Record<string, unknown>) => call("studio_mission_update_row", { mission: M, rows: [p] })

beforeAll(async () => {
  await resetEnvCache()
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  bridge = await import("../../src/store-bridge/index.ts")
  store = await mod.openHostStore(STORE, { release: "1.2.7", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.7" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  c = new Client({ name: "rel127-n10-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
  const cr = await call("studio_mission_create", {
    mission: { id: M, title: "N-10 mission", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: ["1", "2", "3"].map(row), decisions: [{ id: "U1", by: "user", date: "2026-11-13", text: "go" }] },
  })
  expect(cr.ok).toBe(true)
  expect((await call("studio_mission_approve", { mission: M, decision: "U1" })).ok).toBe(true)
  expect((await call("studio_mission_set_status", { mission: M, to: "running" })).ok).toBe(true)
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
  rmSync(WORK, { recursive: true, force: true })
})

let failedA = ""

describe("rel127 N-10 studio_write render reason (N7-106)", () => {
  test("reason: a DT-10a refusal is named as FIGURE_OVER_CAPACITY (DT-10a); NO_DOCX_OUTPUT is gone; the message stays in the untrusted block", async () => {
    const r = await call("studio_write", failingArgs("row-1-nota-a"))
    quote("failed write", { ok: r.ok, code: r.code ?? null, renderError: r.renderError ?? null, render: r.render ?? null, text: r._text })
    expect(r.ok).not.toBe(false)
    failedA = String(r.documentId)
    expect(failedA.length).toBeGreaterThan(0)
    expect(r.render ?? null).toBeNull()
    expect(r._text).toMatch(/berkas: tidak dirender \(galat FIGURE_OVER_CAPACITY \(DT-10a\)\)/)
    expect(r._text).not.toContain("NO_DOCX_OUTPUT")
    expect(r.renderError).toBe(`${fx.expected.renderError} (${fx.expected.checkId})`)
    // The server message (document-derived) only inside the untrusted block, never on the plain line.
    const plain = r._text.split("\n").find((l: string) => l.startsWith("berkas:"))!
    expect(plain).toBe("berkas: tidak dirender (galat FIGURE_OVER_CAPACITY (DT-10a))")
    const open = r._text.indexOf("<data-tak-tepercaya")
    expect(open).toBeGreaterThan(-1)
    const block = r._text.slice(open)
    expect(block).toContain("DT-10a")
    expect(r.untrusted).toBe(true)
    expect(r.untrustedFields).toContain("renderErrors")
  }, 120_000)

  test("idempotent (CHAR): the same studio_write after the failed render reuses the document; one document for the docKey", async () => {
    const r = await call("studio_write", failingArgs("row-1-nota-a"))
    quote("retry", { ok: r.ok, documentId: r.documentId, renderError: r.renderError ?? null })
    expect(String(r.documentId)).toBe(failedA)
    const docs = await sql("SELECT id FROM document WHERE mission_folder = ? AND mission_doc_key = ?", [M, "row-1-nota-a"])
    expect(docs).toEqual([{ id: failedA }])
  }, 120_000)

  test("idempotent (CHAR): a renderable write still returns render.fileId, sha256 and verified", async () => {
    const r = await call("studio_write", { ...renderableArgs("row-1-nota-b"), detail: true })
    quote("renderable write", { ok: r.ok, render: r.render ?? null, renderError: r.renderError ?? null, text: r._text.split("\n").slice(0, 3) })
    expect(r.renderError).toBeUndefined()
    expect(typeof r.render?.fileId).toBe("string")
    expect(r.render.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.render.verified).toBe(true)
    expect(r._text).toContain("FILE_VERIFIED(sha256)")
  }, 120_000)

  test("retire matrix (a) PROBE: the failed row-1 write is retirable while row-1-nota-b stays", async () => {
    const r = await patch({ id: "1", retire: [failedA], note: "draf gagal render" })
    quote("retire (a)", { code: code(r), details: r.error?.details ?? null, results: r.results ?? null })
    expect(code(r)).toBe("OK")
    const d = await sql("SELECT archived FROM document WHERE id = ?", [failedA])
    expect(Number(d[0]!.archived)).toBe(1)
  }, 120_000)

  test("retire matrix (b) by design: a failed write with a non-row docKey is refused NOT_BOUND_TO_ROW", async () => {
    const w = await call("studio_write", failingArgs("nota-bebas"))
    const id = String(w.documentId)
    const r = await patch({ id: "2", retire: [id], note: "draf gagal render" })
    quote("retire (b)", { code: code(r), details: r.error?.details ?? null })
    expect(code(r)).toBe("DELIVERABLE_NOT_RETIRABLE")
    expect(r.error.details.reason).toBe("NOT_BOUND_TO_ROW")
  }, 120_000)

  test("retire matrix (c) by design: a row's only deliverable is refused NO_CURRENT_DELIVERABLE", async () => {
    const w = await call("studio_write", failingArgs("row-3-nota-c"))
    const id = String(w.documentId)
    const r = await patch({ id: "3", retire: [id], note: "draf gagal render" })
    quote("retire (c)", { code: code(r), details: r.error?.details ?? null })
    expect(code(r)).toBe("DELIVERABLE_NOT_RETIRABLE")
    expect(r.error.details.reason).toBe("NO_CURRENT_DELIVERABLE")
  }, 120_000)
})
