// Row 70a (security M1 of row 70, decision C90): `studio_template_preview` is charged to the render rate limiter
// (per agent, STUDIO_RENDER_RATE_LIMIT, the limiter R17 uses), runs through the R17 admission queue (renderGate),
// and the store keeps at most PREVIEW_KEEP_MAX previews.
//
// What runs for real: a temp DATUM Studio store (openHostStore), the row 68 tool handler (`templateHostExtension`,
// called with an MCP session object, as the host routes `tools/call`), the row 67 preview service, the vendored
// Studio ingest / renderSnapshot / lint, the vendored rate limiter and admission gate. What is a stand-in: ONLY the
// render bridge transport (`setRenderBridgeTransport`, as rows 67/68/70), because Electron cannot run under bun.
// No port, no network (globalThis.fetch is a trap), no model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { closeHostStore, openHostStore, type SqliteStudioStore } from "../../src/store-bridge/index.ts"
import { makeDocumentOutput, previewCensus, reader } from "./helpers.ts"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW70A_TEST_DIR ?? "/private/tmp/claude-501/row70a/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "preview-")))
const ROOT = path.join(WORK, "datum-studio")
const TPL_LOG = path.join(WORK, "logs", "templates.jsonl")
mkdirSync(path.dirname(TPL_LOG), { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = ROOT
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
const ENV_KEYS = ["STUDIO_RENDER_RATE_LIMIT", "STUDIO_RENDER_RATE_WINDOW_MS", "STUDIO_RENDER_MAX_CONCURRENT", "STUDIO_RENDER_MAX_QUEUED", "STUDIO_RENDER_QUEUE_RETRY_AFTER_SEC"]
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
for (const k of ENV_KEYS) delete process.env[k]

const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row70a test: globalThis.fetch must not be called")
}) as unknown as typeof fetch

let store: SqliteStudioStore
let runtime: typeof import("../../vendor/src/lib/studio/engine/browser/runtime")
let templates: typeof import("../../vendor/src/lib/studio/services/templates")
let preview: typeof import("../../vendor/src/lib/studio/services/templates/preview")
let guard: typeof import("../../vendor/src/lib/studio/http/render-guard")
let admission: typeof import("../../vendor/src/lib/studio/services/render/admission")
let auth: typeof import("../../vendor/src/lib/studio/contract/auth")
let envMod: typeof import("../../vendor/src/lib/studio/contract/env")
let tool: { call(raw: Record<string, unknown>, session: { sessionId: string; agentId: string; fileRoot: string }): Promise<CallToolResult> }
let onCheckPage: (() => void) | null = null
const evidence: Record<string, unknown> = {}

function resetProcessCaches(): void {
  envMod.resetStudioEnvCache()
  guard.resetRenderRateLimiter()
  admission.resetRenderGate()
}

type S = Record<string, unknown> & { ok?: boolean; code?: string; error?: { code?: string; details?: Record<string, unknown> } }
async function callPreview(agentId: string, args: Record<string, unknown>): Promise<S> {
  const r = await tool.call(args, { sessionId: `s-${agentId}`, agentId, fileRoot: WORK })
  return (r.structuredContent ?? {}) as S
}
const ALL = { slug: "datum-gsp", formats: ["docx", "html", "pdf"] }

beforeAll(async () => {
  envMod = await import("../../vendor/src/lib/studio/contract/env")
  guard = await import("../../vendor/src/lib/studio/http/render-guard")
  admission = await import("../../vendor/src/lib/studio/services/render/admission")
  auth = await import("../../vendor/src/lib/studio/contract/auth")
  const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
  resetBridgePdfReadiness()
  resetProcessCaches()
  store = await openHostStore(ROOT, { release: "1.2.0", logFile: path.join(WORK, "logs", "store.jsonl") })
  templates = await import("../../vendor/src/lib/studio/services/templates")
  templates.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" })
  templates.setTemplatesLogSink((e) => appendFileSync(TPL_LOG, `${JSON.stringify(e)}\n`))
  preview = await import("../../vendor/src/lib/studio/services/templates/preview")
  runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")
  runtime.setRenderBridgeTransport(async (req) => {
    if (req.op === "hello") return { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
    if (req.op === "checkPage") {
      onCheckPage?.()
      return { ok: true, electron: "42.3.3", script: "studio.measure", result: { paged: true, pageCount: 6, truncated: false, elements: [] } }
    }
    if (req.op === "pdf") {
      writeFileSync(String(req.dst), Buffer.from("%PDF-1.7\n1 0 obj<</Type /Pages /Count 6>>endobj\n%%EOF\n", "latin1"))
      return { ok: true, electron: "42.3.3", dst: req.dst }
    }
    return { ok: false, code: "UNKNOWN_OP", message: req.op }
  })
  await templates.ensureBuiltinTemplates()
  const { templateHostExtension } = await import("../../src/mcp-host/templates/index.ts")
  tool = templateHostExtension().find((t) => t.name === "studio_template_preview")! as unknown as typeof tool
})

afterAll(async () => {
  runtime?.setRenderBridgeTransport(null)
  templates?.setTemplatesLogSink(null)
  templates?.configureTemplateSource(null)
  if (store) await closeHostStore(store)
  globalThis.fetch = realFetch
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  if (envMod) resetProcessCaches()
  console.log(`row70a evidence ${JSON.stringify(evidence)}`)
})

describe("row 70a: render rate limit and kept-preview cap (row 70 probe, re-run)", () => {
  test("60 rapid previews by one agent: 30 kept (the render limit), 30 RATE_LIMITED with nothing kept; at most 20 previews on disk and in rows; a document output survives", async () => {
    resetProcessCaches()
    expect(preview.PREVIEW_KEEP_MAX).toBe(20)
    const tv = reader(store).all("SELECT v.id FROM template_version v JOIN template t ON t.id = v.template_id WHERE t.slug = 'datum-gsp' LIMIT 1")[0]!.id as string
    const docOut = await makeDocumentOutput(store, tv, "probe")
    const okIds: string[] = []
    const refused: S[] = []
    let maxFolders = 0
    let maxRows = 0
    let refusedChangedSomething = 0
    const t0 = Date.now()
    for (let i = 0; i < 60; i++) {
      const before = previewCensus(store)
      const r = await callPreview("claude", ALL)
      const after = previewCensus(store)
      if (r.ok) okIds.push(String(r.previewId))
      else {
        refused.push(r)
        if (JSON.stringify(before) !== JSON.stringify(after)) refusedChangedSomething++
      }
      maxFolders = Math.max(maxFolders, after.folders.length)
      maxRows = Math.max(maxRows, after.rows.length)
      // files == rows after every call (no file without a row, no row without a file)
      expect(after.files).toEqual(after.rows)
    }
    const ms = Date.now() - t0
    expect(ms).toBeLessThan(60_000) // one fixed 60 s window, so the default limit 30 applies exactly
    const c = previewCensus(store)
    evidence.probe = { calls: 60, ok: okIds.length, refused: refused.length, codes: [...new Set(refused.map((r) => r.code))], retryAfterSec: refused[0]?.error?.details?.retryAfterSec ?? null, ms, keptFolders: c.folders.length, keptRows: c.rows.length, keptFiles: c.files.length, keptBytes: c.bytes, maxFolders, maxRows, refusedChangedSomething }
    expect(okIds.length).toBe(30)
    expect(refused.length).toBe(30)
    for (const r of refused) {
      expect(r.code).toBe("RATE_LIMITED")
      expect(Number(r.error?.details?.retryAfterSec)).toBeGreaterThan(0)
    }
    expect(refusedChangedSomething).toBe(0)
    // the cap: never more than 20 previews (3 files and 3 rows each), and they are the newest 20
    expect(maxFolders).toBeLessThanOrEqual(20)
    expect(maxRows).toBeLessThanOrEqual(60)
    expect(c.folders).toEqual(okIds.slice(-20).sort())
    expect(c.rows.length).toBe(60)
    expect(c.files).toEqual(c.rows)
    // the document output is untouched
    expect(c.rowsOfOtherKinds).toBe(1)
    const { createHash } = await import("node:crypto")
    expect(createHash("sha256").update(await store.readOutputVerified(docOut.id)).digest("hex")).toBe(docOut.sha256)
    // the store log has the prune lines and the templates log the TEMPLATE_PREVIEW_PRUNED code
    const { readFileSync } = await import("node:fs")
    expect(readFileSync(TPL_LOG, "utf8")).toContain("TEMPLATE_PREVIEW_PRUNED")
  })

  test("the same bucket as R17: after the previews, the R17 rate check (checkRenderRate) refuses that agent with 429 RATE_LIMITED; another agent still previews", async () => {
    // r17-render.ts:39 `checkRate: checkRenderRate`
    const ctx = { correlationId: crypto.randomUUID(), route: "/api/studio/documents/[id]/render", method: "POST", source: "row70a-test" }
    const res = guard.checkRenderRate(auth.localStudioCaller("claude"), ctx)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(429)
    const body = (await res!.json()) as { code?: string; error?: { code?: string } }
    expect(body.code ?? body.error?.code).toBe("RATE_LIMITED")
    const other = await callPreview("swarm", { slug: "datum-gsp", formats: ["docx"] })
    expect(other.ok).toBe(true)
    evidence.sameBucket = { r17Status: res!.status, r17Code: body.code ?? body.error?.code, otherAgentOk: other.ok }
  })

  test("the R17 admission queue: a full renderGate refuses the preview with RENDER_QUEUE_FULL and keeps nothing; a preview holds a gate slot while it renders", async () => {
    process.env.STUDIO_RENDER_MAX_CONCURRENT = "1"
    process.env.STUDIO_RENDER_MAX_QUEUED = "0"
    try {
      resetProcessCaches()
      let release: () => void = () => undefined
      const held = admission.renderGate().run(() => new Promise<void>((r) => (release = r)))
      expect(admission.renderGate().stats().running).toBe(1)
      const before = previewCensus(store)
      const r = await callPreview("claude", ALL)
      expect(r.ok).toBe(false)
      expect(r.code).toBe("RENDER_QUEUE_FULL")
      expect(Number(r.error?.details?.retryAfterSec)).toBe(30)
      expect(previewCensus(store)).toEqual(before)
      release()
      await held
      expect(admission.renderGate().stats().running).toBe(0)
      let seen: unknown = null
      onCheckPage = () => {
        seen = admission.renderGate().stats()
      }
      const ok = await callPreview("claude", ALL)
      onCheckPage = null
      expect(ok.ok).toBe(true)
      expect(seen).toEqual({ running: 1, queued: 0, maxConcurrent: 1, maxQueued: 0 })
      expect(admission.renderGate().stats().running).toBe(0)
      evidence.admission = { refusedCode: r.code, retryAfterSec: r.error?.details?.retryAfterSec, statsDuringPreview: seen }
    } finally {
      delete process.env.STUDIO_RENDER_MAX_CONCURRENT
      delete process.env.STUDIO_RENDER_MAX_QUEUED
      resetProcessCaches()
    }
  })

  test("refusals before the charge (schema, form lock) are not charged; the direct service call has the same limit (anonymous agent bucket)", async () => {
    process.env.STUDIO_RENDER_RATE_LIMIT = "2"
    try {
      resetProcessCaches()
      const before = previewCensus(store)
      const bad = await callPreview("claude", { slug: "datum-gsp", formats: ["png"] })
      expect(bad.code).toBe("SCHEMA_INVALID")
      expect(previewCensus(store)).toEqual(before)
      // the refused call was not charged: the same agent still gets its 2 renders, then RATE_LIMITED
      const t1 = await callPreview("claude", { slug: "datum-gsp", formats: ["docx"] })
      const t2 = await callPreview("claude", { slug: "datum-gsp", formats: ["docx"] })
      const t3 = await callPreview("claude", { slug: "datum-gsp", formats: ["docx"] })
      expect([t1.ok, t2.ok, t3.ok, t3.code]).toEqual([true, true, false, "RATE_LIMITED"])
      // two allowed, the third refused, through the service entry the tool uses
      const a = await preview.previewTemplate({ slug: "datum-gsp", formats: ["docx"] })
      const b = await preview.previewTemplate({ slug: "datum-gsp", formats: ["docx"] })
      expect(a.files.length + b.files.length).toBe(2)
      const mid = previewCensus(store)
      let code: string | undefined
      try {
        await preview.previewTemplate({ slug: "datum-gsp", formats: ["docx"] })
      } catch (e) {
        code = (e as { code?: string }).code
      }
      expect(code).toBe("RATE_LIMITED")
      expect(previewCensus(store)).toEqual(mid)
      expect(mid.folders.length).toBeLessThanOrEqual(20)
    } finally {
      delete process.env.STUDIO_RENDER_RATE_LIMIT
      resetProcessCaches()
    }
  })
})
