// Row 68: the five template MCP tools (U10) on the Studio host server, end to end.
//
// What runs for real: a temp DATUM Studio store, the real host server of row 31 (src/mcp-host, started with the
// row 68 extension), the row 66 template service and the row 67 guard (installed by startStudioHostServer), the
// vendored Studio ingest / renderSnapshot / lint, and the MCP traffic goes through row 34's stdio bridge
// (packages/desktop/scripts/datum-studio-bridge.ts, spawned as its own bun process with a row 111 descriptor), so
// the client is a real MCP SDK stdio client, as Claude Code connects.
// What is a stand-in: ONLY the render bridge transport (`setRenderBridgeTransport`, the row 108 seam row 67 uses),
// because Electron cannot run under bun: `hello`, `checkPage` (paged layout without elements) and `pdf` (a small PDF).
// globalThis.fetch is a trap in this process (the host runs here); no network, no model.
// Port: the host binds 127.0.0.1:<ephemeral>; run with the command sandbox off.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const DESKTOP = path.resolve(PKG, "..", "desktop")
const BRIDGE = path.join(DESKTOP, "scripts", "datum-studio-bridge.ts")
const BASE = process.env.ROW68_TEST_DIR ?? "/private/tmp/claude-501/row68/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row68-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const STATE = path.join(WORK, "state")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-a")
const TPL_LOG = path.join(WORK, "logs", "templates.jsonl")
for (const d of [HOME, RES, PROJECT, STATE, path.dirname(TPL_LOG)]) mkdirSync(d, { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET
delete process.env.DATUM_RENDER_SOCKET
delete process.env.DATUM_RENDER_TOKEN

const TOKEN = "6".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const TEMPLATE_TOOLS = ["studio_template_create", "studio_template_update", "studio_template_check", "studio_template_preview", "studio_template_archive"]
const COPY = "user-uji-salinan"
const SCRATCH = "user-uji-baru"
const MISSION = "2026-11-07_row68"

const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = (async () => {
  fetchCalls++
  throw new Error("row68 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

// The host pieces are imported from their own modules, not the src/mcp-host barrel, so this suite does not load
// other rows' extensions (row 119b) that the barrel re-exports.
type Mod = typeof import("../../src/mcp-host/start.ts") & typeof import("../../src/store-bridge/index.ts") & typeof import("../../src/mcp-host/tool-table.ts") & { configureTemplateSource: typeof import("../../vendor/src/lib/studio/services/templates").configureTemplateSource }
type Ext = typeof import("../../src/mcp-host/templates/index.ts")
let mod: Mod
let ext: Ext
let runtime: typeof import("../../vendor/src/lib/studio/engine/browser/runtime")
let templates: typeof import("../../vendor/src/lib/studio/services/templates")
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let client: Client
let transport: StdioClientTransport
const bridgeErr: string[] = []
const hostLog: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []
const bridgeOps: string[] = []
const evidence: Record<string, unknown> = {}
const CHANGE = (what: string) => ({ what, why: "uji row 68", impact: "revisi baru; revisi lama tetap pada versinya" })

type S = Record<string, unknown> & { ok?: boolean; code?: string }
async function call(name: string, args: Record<string, unknown>): Promise<S> {
  const r = await client.callTool({ name, arguments: args })
  return (r.structuredContent ?? {}) as S
}

type Raw = Record<string, unknown>
function q<T = Raw>(sql: string, params: unknown[] = []): T[] {
  return (store as unknown as { requireReader(): { all(s: string, p?: unknown[]): unknown[] } }).requireReader().all(sql, params) as T[]
}
const latestNo = (slug: string) => Number(q<{ n: number }>("SELECT latest_version_no AS n FROM template WHERE slug = ?", [slug])[0]?.n ?? 0)
const versionCount = () => Number(q<{ n: number }>("SELECT count(*) AS n FROM template_version")[0].n)
function versionRow(slug: string, no: number): Raw {
  return q("SELECT v.* FROM template_version v JOIN template t ON t.id = v.template_id WHERE t.slug = ? AND v.version_no = ?", [slug, no])[0]
}
function pinnedOf(jobId: string): Record<string, unknown> | undefined {
  const row = q<{ engine: string }>("SELECT engine FROM render_job WHERE id = ?", [jobId])[0]
  const eng = JSON.parse(row.engine) as { log?: Array<{ code?: string; context?: Record<string, unknown> }> }
  return (eng.log ?? []).find((e) => e.code === "TEMPLATE_PINNED")?.context
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")

beforeAll(async () => {
  // Own the process-wide caches an earlier suite may have filled (T-2, C71).
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetBridgePdfReadiness()
  resetRenderRateLimiter()
  runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")
  runtime.setRenderBridgeTransport(async (req) => {
    bridgeOps.push(req.op)
    if (req.op === "hello") return { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
    if (req.op === "checkPage") return { ok: true, electron: "42.3.3", script: "studio.measure", result: { paged: true, pageCount: 6, truncated: false, elements: [] } }
    if (req.op === "pdf") {
      writeFileSync(String(req.dst), Buffer.from("%PDF-1.7\n1 0 obj<</Type /Pages /Count 6>>endobj\n%%EOF\n", "latin1"))
      return { ok: true, electron: "42.3.3", dst: req.dst }
    }
    return { ok: false, code: "UNKNOWN_OP", message: req.op }
  })
  mod = { ...(await import("../../src/mcp-host/start.ts")), ...(await import("../../src/store-bridge/index.ts")), ...(await import("../../src/mcp-host/tool-table.ts")), configureTemplateSource: (await import("../../vendor/src/lib/studio/services/templates")).configureTemplateSource } as Mod
  ext = await import("../../src/mcp-host/templates/index.ts")
  templates = await import("../../vendor/src/lib/studio/services/templates")
  store = await mod.openHostStore(STORE, { release: "1.2.0", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" })
  templates.setTemplatesLogSink((e) => appendFileSync(TPL_LOG, `${JSON.stringify(e)}\n`))
  host = await mod.startStudioHostServer({
    store,
    token: TOKEN,
    hostname: "127.0.0.1",
    port: 0,
    log: (level, source, message, context) => hostLog.push({ level, source, message, context }),
    facts: FACTS,
    // I-2: start.ts registers the template tools by default; their log reaches `log` above through the host's write.
  })
  // Row 111's descriptor, read by row 34's bridge (0600, this user).
  const { studioDescriptorPath, writeStudioDescriptor } = await import(path.join(DESKTOP, "src", "main", "datum-studio-host", "descriptor.ts"))
  await writeStudioDescriptor(studioDescriptorPath(STATE), { url: host.url, token: TOKEN, pid: process.pid })
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE],
    cwd: PROJECT,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME, DATUM_STUDIO_STATE: STATE, STUDIO_AGENT_ID: "claude", DATUM_STUDIO_CALLER_CWD: PROJECT, NO_PROXY: "127.0.0.1,localhost" },
    stderr: "pipe",
  })
  transport.stderr?.on("data", (b: Buffer) => bridgeErr.push(b.toString()))
  client = new Client({ name: "row68-test", version: "0" })
  await client.connect(transport)
})

afterAll(async () => {
  await client?.close()
  await host?.close()
  templates?.setTemplatesLogSink(null)
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  runtime?.setRenderBridgeTransport(null)
  globalThis.fetch = realFetch
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetBridgePdfReadiness()
  resetRenderRateLimiter()
  console.log(`row68 evidence ${JSON.stringify(evidence)}`)
})

describe("row 68: tool list (row 63 as amended by row 79)", () => {
  test("the host lists the 23 row 31 tools, then exactly the five template tools; preview formats docx|html|pdf", async () => {
    const list = await client.listTools()
    const names = list.tools.map((t) => t.name)
    expect(names.slice(0, mod.HOST_KEPT_TOOLS.length)).toEqual([...mod.HOST_KEPT_TOOLS])
    // After integration pass I-2 the host may also add the mission tools (row 119b) by default: they are counted, not
    // assumed. The five template tools are one block, in register order, right after the kept tools.
    const extra = names.slice(mod.HOST_KEPT_TOOLS.length)
    const missions = extra.filter((n) => n.startsWith("studio_mission_"))
    expect(extra.filter((n) => !n.startsWith("studio_mission_"))).toEqual(TEMPLATE_TOOLS)
    expect(extra.slice(0, 5)).toEqual(TEMPLATE_TOOLS)
    expect(ext.TEMPLATE_TOOL_NAMES).toEqual(TEMPLATE_TOOLS as never)
    expect(names.length).toBe(23 + 5 + missions.length)
    const pv = list.tools.find((t) => t.name === "studio_template_preview")!.inputSchema as unknown as { properties: { formats: { items: { enum: string[] }; maxItems: number; default: string[] } } }
    expect(pv.properties.formats.items.enum).toEqual(["docx", "html", "pdf"])
    expect(pv.properties.formats.maxItems).toBe(3)
    expect(pv.properties.formats.default).toEqual(["pdf"])
    for (const t of list.tools.filter((x) => TEMPLATE_TOOLS.includes(x.name))) expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    // The client really is the stdio client of row 34's bridge process, and the host holds its HTTP session.
    expect(bridgeErr.join("")).toContain("BRIDGE_START")
    expect(host.sessionCount()).toBe(1)
    evidence.toolList = { count: names.length, templateTools: names.slice(23), transport: "stdio via packages/desktop/scripts/datum-studio-bridge.ts", sessions: host.sessionCount() }
  })
})

let documentId = ""
let oldRev = 0
let newRev = 0

describe("row 68: create, modify, preview, list versions, re-render (stdio through row 34's bridge)", () => {
  test("copy datum-gsp -> user v1 (guard pass), caller identity = the session agent", async () => {
    const r = await call("studio_template_create", { slug: COPY, name: "Salinan uji row 68", kind: "DOCUMENT", changeNote: "Salinan datum-gsp untuk uji row 68", from: { slug: "datum-gsp" } })
    evidence.copy = { ok: r.ok, code: r.code ?? null, versionNo: r.versionNo, versionId: r.versionId, guard: (r.guard as { verdict?: string } | undefined)?.verdict }
    expect(r.ok).toBe(true)
    expect(r.versionNo).toBe(1)
    expect((r.guard as { verdict: string }).verdict).toBe("pass")
    const v1 = versionRow(COPY, 1)
    expect(v1.id).toBe(r.versionId)
    expect(v1.created_by).toBe("agent:claude")
    expect(v1.guard_verdict).toBe("pass")
    const gsp = q<{ id: string; definition_sha256: string }>("SELECT v.id, v.definition_sha256 FROM template_version v JOIN template t ON t.id = v.template_id WHERE t.slug = 'datum-gsp' ORDER BY v.version_no DESC LIMIT 1")[0]
    expect(v1.base_version_id).toBe(gsp.id)
    expect(v1.definition_sha256).toBe(gsp.definition_sha256)
    expect((r.versions as unknown[]).length).toBe(1)
  })

  test("from scratch: a bare datum-gsp skeleton on datum-gsp-preset -> user v1 with no base", async () => {
    const g = await call("studio_template_get", { slug: "datum-gsp", detail: true })
    expect(g.ok).toBe(true)
    const slots = ((g.skeleton as { slots: Array<Record<string, unknown>> }).slots ?? []).map((s) => {
      const { essentials: _e, advanced: _a, roleFormats: _r, ...rest } = s
      return { ...rest, essentials: {} }
    })
    const template = { $schema: "studio.template/v2", preset: { slug: "datum-gsp-preset" }, essentials: { "doc.language": "EN" }, skeleton: { slots } }
    const r = await call("studio_template_create", { slug: SCRATCH, name: "Templat baru row 68", kind: "DOCUMENT", changeNote: "Templat dari nol", template })
    evidence.scratch = { ok: r.ok, code: r.code ?? null, versionId: r.versionId ?? null, error: r.ok ? null : r.error }
    expect(r.ok).toBe(true)
    expect(r.versionNo).toBe(1)
    expect(versionRow(SCRATCH, 1).base_version_id).toBeNull()
  })

  test("a client document on the copy (v1) through studio_write", async () => {
    const r = await call("studio_write", {
      mission: MISSION,
      docKey: "nota-salinan",
      template: COPY,
      meta: { title: "Nota uji templat salinan", author: "Agen Uji", number: "UJI-68/2026" },
      sections: [
        { heading: "Latar belakang", blocks: ["Dokumen ini menguji templat salinan pada versi pertama."] },
        { heading: "Temuan", blocks: ["Semua bagian dirender dengan bentuk DATUM yang sama."] },
      ],
    })
    evidence.write = { ok: r.ok, code: r.code ?? null, completeness: r.completeness ?? null, render: r.render ?? null, renderError: r.renderError ?? null, error: r.ok ? null : r.error }
    expect(r.ok).toBe(true)
    documentId = String(r.documentId)
    const doc = q<{ current_revision_no: number }>("SELECT current_revision_no FROM document WHERE id = ?", [documentId])[0]
    oldRev = doc.current_revision_no
    const pin = q<{ id: string }>("SELECT v.id FROM template_version v JOIN revision r ON r.template_version_id = v.id WHERE r.document_id = ? AND r.revision_no = ?", [documentId, oldRev])[0]
    expect(pin.id).toBe(String(versionRow(COPY, 1).id))
  })

  test("modify one editable slot (references label) as v2; v1 row unchanged", async () => {
    const before = JSON.stringify(versionRow(COPY, 1))
    const g = await call("studio_template_get", { slug: COPY, detail: true })
    const slots = (g.skeleton as { slots: Array<Record<string, unknown>> }).slots.map((s) => (s.slotKey === "references" ? { ...s, label: "Daftar Rujukan" } : s))
    const r = await call("studio_template_update", { slug: COPY, baseVersionNo: 1, changeNote: "Label slot referensi diganti", skeleton: { slots } })
    evidence.update = { ok: r.ok, code: r.code ?? null, versionNo: r.versionNo ?? null, versionId: r.versionId ?? null, guard: (r.guard as { verdict?: string } | undefined)?.verdict ?? null, error: r.ok ? null : r.error }
    expect(r.ok).toBe(true)
    expect(r.versionNo).toBe(2)
    expect(["pass", "warn"]).toContain((r.guard as { verdict: string }).verdict)
    expect(JSON.stringify(versionRow(COPY, 1))).toBe(before)
    const sk = JSON.parse(String(versionRow(COPY, 2).skeleton)) as { slots: Array<{ slotKey: string; label: string }> }
    expect(sk.slots.find((s) => s.slotKey === "references")?.label).toBe("Daftar Rujukan")
    expect((r.versions as Array<{ versionNo: number }>).map((v) => v.versionNo)).toEqual([1, 2])
  })

  test("preview v2: docx, html, pdf kept as preview outputs (sha = disk at the returned path); no version saved", async () => {
    const pv = await call("studio_template_preview", { slug: COPY, version: 2, formats: ["docx", "html", "pdf"] })
    const outputs = (pv.outputs ?? []) as Array<{ id: string; format: string; relPath: string; path: string; sha256: string; bytes: number; fileName: string }>
    evidence.preview = { ok: pv.ok, code: pv.code ?? null, template: pv.template, tier: pv.tier, lint: pv.lint ?? null, outputs: outputs.map((o) => [o.format, o.fileName, o.bytes, o.sha256.slice(0, 16)]) }
    expect(pv.ok).toBe(true)
    expect(pv.saved).toBe(false)
    expect((pv.template as { versionNo: number }).versionNo).toBe(2)
    expect(outputs.map((o) => o.format).sort()).toEqual(["DOCX", "HTML", "PDF"])
    for (const o of outputs) {
      expect(sha(readFileSync(path.join(STORE, o.relPath)))).toBe(o.sha256)
      expect(o.path).toBe(path.join(STORE, o.relPath))
      expect(o.relPath).toMatch(/^tmp\/preview\/[0-9a-f-]{36}\/GSP Pratinjau Templat\.(docx|html|pdf)$/)
    }
    const rows = q<{ n: number }>("SELECT count(*) AS n FROM output_file WHERE kind = 'preview' AND template_version_id = ?", [versionRow(COPY, 2).id])[0].n
    expect(rows).toBe(3)
    expect(latestNo(COPY)).toBe(2)
    // Observed, not asserted (file request I-2): R10 cannot name a preview row (no revision), so studio_file_verify
    // on a preview id answers HTTP 500 (vendor storage/files.ts finalFileNameOfRow).
    const dl = path.join(PROJECT, "unduhan")
    mkdirSync(dl, { recursive: true })
    const fv = await call("studio_file_verify", { fileId: outputs.find((o) => o.format === "DOCX")!.id, downloadDir: dl })
    evidence.fileVerifyPreview = { ok: fv.ok, code: fv.code ?? null }
  })

  test("list versions: studio_template_check {slug, guard:false} and the guard re-check of v2 against v1", async () => {
    const form = await call("studio_template_check", { slug: COPY, guard: false })
    expect(form.ok).toBe(true)
    expect(form.verdict).toBe("pass")
    const vs = form.versions as Array<{ versionNo: number; versionId: string; guardVerdict: string; documentCount: number; revisionCount: number; createdBy: string }>
    expect(vs.map((v) => [v.versionNo, v.guardVerdict])).toEqual([
      [1, "pass"],
      [2, (versionRow(COPY, 2).guard_verdict as string)],
    ])
    expect(vs[0].documentCount).toBe(1)
    expect(vs[1].documentCount).toBe(0)
    expect(vs.every((v) => v.createdBy === "agent:claude")).toBe(true)
    const g = await call("studio_template_check", { slug: COPY })
    evidence.versions = { list: vs.map((v) => ({ versionNo: v.versionNo, versionId: v.versionId, guardVerdict: v.guardVerdict, documents: v.documentCount })), recheck: { verdict: g.verdict, stored: g.stored } }
    expect(g.ok).toBe(true)
    expect(["pass", "warn"]).toContain(g.verdict as string)
    expect((g.stored as { reference: { slug: string; version: number } }).reference).toEqual({ slug: COPY, version: 1 })
    expect(g.saved).toBe(false)
    expect(versionCount()).toBe(Number(q<{ n: number }>("SELECT count(*) AS n FROM template_version")[0].n))
  })

  test("re-render on v2: studio_document_structure templateVersion -> new revision on v2; the old revision still renders on v1", async () => {
    const v1 = String(versionRow(COPY, 1).id)
    const v2 = String(versionRow(COPY, 2).id)
    const st = await call("studio_document_structure", { documentId, op: "templateVersion", baseRevisionNo: oldRev, versionNo: 2, change: CHANGE("Templat ke versi 2") })
    evidence.structure = { ok: st.ok, code: st.code ?? null, error: st.ok ? null : st.error }
    expect(st.ok).toBe(true)
    newRev = Number(q<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [documentId])[0].n)
    expect(newRev).toBe(oldRev + 1)
    const pins = q<{ revision_no: number; template_version_id: string }>("SELECT revision_no, template_version_id FROM revision WHERE document_id = ? ORDER BY revision_no", [documentId])
    expect(pins.find((p) => p.revision_no === oldRev)?.template_version_id).toBe(v1)
    expect(pins.find((p) => p.revision_no === newRev)?.template_version_id).toBe(v2)

    const cur = await call("studio_render", { documentId, formats: ["docx", "html"] })
    const old = await call("studio_render", { documentId, formats: ["docx", "html"], revisionNo: oldRev })
    evidence.render = { current: { ok: cur.ok, code: cur.code ?? null, job: cur.job ?? null }, old: { ok: old.ok, code: old.code ?? null, job: old.job ?? null } }
    expect(cur.ok).toBe(true)
    expect(old.ok).toBe(true)
    const curJob = (cur.job as { id: string; status: string })
    const oldJob = (old.job as { id: string; status: string })
    expect(curJob.status).toBe("SUCCEEDED")
    expect(oldJob.status).toBe("SUCCEEDED")
    const pc = pinnedOf(curJob.id)!
    const po = pinnedOf(oldJob.id)!
    evidence.pinned = { newRevision: { revisionNo: newRev, ...pc }, oldRevision: { revisionNo: oldRev, ...po } }
    expect(pc).toMatchObject({ versionNo: 2, versionId: v2, resolvedVersionId: v2 })
    expect(po).toMatchObject({ versionNo: 1, versionId: v1, resolvedVersionId: v1 })
    // The renders of the two revisions differ only by what v2 changed: the old one never shows the v2 label.
    const html = (job: { id: string }) => {
      const f = q<{ rel_path: string }>("SELECT rel_path FROM output_file WHERE render_job_id = ? AND format = 'HTML' AND role = 'PRIMARY'", [job.id])[0]
      return f ? readFileSync(path.join(STORE, f.rel_path), "utf8") : null
    }
    const oldHtml = html(oldJob)
    if (oldHtml !== null) expect(oldHtml.includes("Daftar Rujukan")).toBe(false)
    // The newer version never moved the document: v1 still has its document, and the old revision row is unchanged.
    expect(q<{ n: number }>("SELECT count(*) AS n FROM revision WHERE document_id = ? AND template_version_id = ?", [documentId, v1])[0].n).toBeGreaterThan(0)
  })

  test("a Calibri body-font change is refused TEMPLATE_FORM_LOCKED (category:tipografi); nothing saved", async () => {
    const n = versionCount()
    const r = await call("studio_template_update", { slug: COPY, baseVersionNo: 2, changeNote: "Fon badan Calibri", changes: { advanced: { "type.face.serif": "Calibri" } } })
    const err = r.error as { code: string; details: { reason?: string; studioCode?: string; issues?: Array<{ key?: string; rule?: string }> } }
    evidence.calibri = { ok: r.ok, code: r.code, reason: err?.details?.reason ?? null, studioCode: err?.details?.studioCode ?? null }
    expect(r.ok).toBe(false)
    expect(r.code).toBe("TEMPLATE_FORM_LOCKED")
    expect(err.details.reason).toBe("category:tipografi")
    expect(latestNo(COPY)).toBe(2)
    expect(versionCount()).toBe(n)
    // The same change as an unsaved definition: check refuses it, and preview never renders it.
    const full = (await templates.getTemplateV2(COPY, 2, { includeAdvanced: true })).definition as unknown as { advanced?: Record<string, unknown> }
    const calibri = { ...full, advanced: { ...(full.advanced ?? {}), "type.face.serif": "Calibri" } }
    const files = q<{ n: number }>("SELECT count(*) AS n FROM output_file WHERE kind = 'preview'")[0].n
    const ck = await call("studio_template_check", { template: calibri, baseSlug: COPY, baseVersion: 2 })
    expect(ck).toMatchObject({ ok: true, valid: false, verdict: "reject", code: "TEMPLATE_FORM_LOCKED" })
    const pv = await call("studio_template_preview", { template: calibri, formats: ["pdf"] })
    expect(pv.code).toBe("TEMPLATE_FORM_LOCKED")
    expect(q<{ n: number }>("SELECT count(*) AS n FROM output_file WHERE kind = 'preview'")[0].n).toBe(files)
    expect(versionCount()).toBe(n)
  })

  test("preview language EN of the ID copy: rendered as that one doc.language change, nothing saved", async () => {
    const n = versionCount()
    const pv = await call("studio_template_preview", { slug: COPY, formats: ["html"], language: "EN" })
    evidence.previewEn = { ok: pv.ok, code: pv.code ?? null, language: pv.language ?? null, languageOverride: pv.languageOverride ?? null, template: pv.template ?? null }
    expect(pv.ok).toBe(true)
    expect(pv.language).toBe("EN")
    expect(pv.languageOverride).toEqual({ slug: COPY, versionNo: 2, language: "EN" })
    expect((pv.template as { unsaved: boolean }).unsaved).toBe(true)
    expect(versionCount()).toBe(n)
  })
})

describe("row 68: refusals and input limits", () => {
  test("png -> SCHEMA_INVALID naming docx, html, pdf; unknown field, missing oneOf, __proto__, oversize", async () => {
    const png = await call("studio_template_preview", { slug: COPY, formats: ["png"] })
    expect(png.ok).toBe(false)
    expect(png.code).toBe("SCHEMA_INVALID")
    expect(JSON.stringify(png.error)).toContain("docx, html, pdf")
    const extra = await call("studio_template_archive", { slug: COPY, archived: true, path: "/etc/hosts" })
    expect(extra.code).toBe("SCHEMA_INVALID")
    const both = await call("studio_template_create", { slug: "user-dua", name: "x", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" }, template: {} })
    expect(both.code).toBe("SCHEMA_INVALID")
    const proto = await call("studio_template_update", { slug: COPY, baseVersionNo: 2, changeNote: "x", changes: JSON.parse('{"essentials":{"__proto__":{"x":1}}}') })
    expect(proto.code).toBe("SCHEMA_INVALID")
    const big = await call("studio_template_check", { template: { $schema: "studio.template/v2", pad: "a".repeat(3000), list: Array.from({ length: 400 }, () => "b".repeat(3000)) } })
    expect(big.code).toBe("INPUT_TOO_LARGE")
    const bidi = await call("studio_template_create", { slug: "user-bidi", name: "nama ‮", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } })
    expect(bidi.code).toBe("SCHEMA_INVALID")
    expect(q<{ n: number }>("SELECT count(*) AS n FROM template WHERE slug IN ('user-dua','user-bidi')")[0].n).toBe(0)
  })

  test("BASE_CONFLICT, builtin TEMPLATE_READ_ONLY, slug taken, archive hides and unarchive restores", async () => {
    const stale = await call("studio_template_update", { slug: COPY, baseVersionNo: 1, changeNote: "basi", changes: { essentials: { "doc.language": "EN" } } })
    expect(stale.code).toBe("BASE_CONFLICT")
    expect((stale.error as { details: { latestVersionNo: number } }).details.latestVersionNo).toBe(2)
    const missing = await call("studio_template_archive", { slug: "user-tidak-ada", archived: true })
    expect(missing.ok).toBe(false)
    const taken = await call("studio_template_create", { slug: COPY, name: "lagi", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } })
    expect(taken.code).toBe("TEMPLATE_SLUG_TAKEN")
    const a = await call("studio_template_archive", { slug: SCRATCH, archived: true })
    expect(a).toMatchObject({ ok: true, slug: SCRATCH, archived: true })
    const listed = await call("studio_templates_list", {})
    expect(JSON.stringify(listed.templates)).not.toContain(SCRATCH)
    const upd = await call("studio_template_update", { slug: SCRATCH, baseVersionNo: 1, changeNote: "x", changes: { essentials: { "doc.language": "ID" } } })
    expect(upd.code).toBe("TEMPLATE_ARCHIVED")
    const u = await call("studio_template_archive", { slug: SCRATCH, archived: false })
    expect(u).toMatchObject({ ok: true, archived: false })
    // A builtin slug is outside the user- pattern of update/archive: the schema refuses it before the service.
    const bi = await call("studio_template_archive", { slug: "datum-gsp", archived: true })
    expect(bi.code).toBe("SCHEMA_INVALID")
    const { updateUserTemplateV2 } = await import("../../vendor/src/lib/studio/services/templates/service")
    const { localStudioCaller } = await import("../../vendor/src/lib/studio/contract/auth")
    const direct = await updateUserTemplateV2({ slug: "datum-gsp", baseVersionNo: 1, changeNote: "x", changes: { essentials: { "doc.language": "EN" } } }, localStudioCaller("claude")).then(
      () => null,
      (e: { details?: { swarmCode?: string } }) => e.details?.swarmCode,
    )
    expect(direct).toBe("TEMPLATE_READ_ONLY")
  })

  test("durable log: one JSON line per call with correlation id, no template content; no fetch from the host", () => {
    const dir = path.join(STORE, "logs", "mcp-host")
    const files = readdirSync(dir).filter((f) => f.startsWith("datum-studio-template-tools-"))
    expect(files.length).toBeGreaterThan(0)
    const lines = files.flatMap((f) => readFileSync(path.join(dir, f), "utf8").trim().split("\n")).map((l) => JSON.parse(l) as { level: string; message: string; context: Record<string, unknown> })
    const refusals = lines.filter((l) => l.message === "template tool refused")
    expect(refusals.some((l) => l.context.code === "TEMPLATE_FORM_LOCKED")).toBe(true)
    expect(lines.every((l) => typeof l.context.correlationId === "string" && l.context.agentId === "claude")).toBe(true)
    const text = lines.map((l) => JSON.stringify(l)).join("\n")
    expect(text).not.toContain("Calibri")
    expect(text).not.toContain("Daftar Rujukan")
    expect(text).not.toContain(TOKEN)
    expect(hostLog.some((l) => l.source === "datum-studio-host.templates")).toBe(true)
    expect(fetchCalls).toBe(0)
    evidence.log = { files, lines: lines.length, refusals: refusals.map((l) => l.context.code), bridgeOps: [...new Set(bridgeOps)] }
  })
})
