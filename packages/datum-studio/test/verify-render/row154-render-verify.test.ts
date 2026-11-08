// Row 154 (decision U24 A, C130, C147): studio_render returns the output verification report and records the
// verified / unverified state per output (masterplan/01_specs_output_verification.md §2, §3.7, §6), through the REAL
// host server (startStudioHostServer, streamable HTTP on 127.0.0.1, MCP SDK client) over a temp store opened with
// missionGuard: true, as desktop does. The render bridge is a transport stub (`setRenderBridgeTransport`, as rows
// 32/67/151/151b): Electron cannot run under bun. What the page scripts measure on real Electron is row 151's and
// row 151b's evidence; here the stub stands for a bridge that has (or lacks) row 152's allow-list entry.
// Needs the command sandbox off (binds an ephemeral port). globalThis.fetch is a trap: the host must never call it.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { strFromU8, strToU8 } from "fflate"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import * as runtime from "../../vendor/src/lib/studio/engine/browser/runtime"
import { MEASURE_SCRIPT } from "../../vendor/src/lib/studio/engine/browser/measure"
import { OVERLAP_SCRIPT, OVERLAP_SCRIPT_NAME } from "../../src/mcp-host/verify/overlap-script"
import { choosePages, outputState, verifyBudgetMs } from "../../src/mcp-host/verify/verify-outputs"
import { addMeasuredSources, renderVerifyWrapper, RENDER_VERIFY_DESCRIPTION_SUFFIX, type RenderVerifyStore } from "../../src/mcp-host/verify/render-wrapper"
import type { VerifyCheck } from "../../src/mcp-host/verify/types"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW154_TEST_DIR ?? "/private/tmp/claude-501/row154/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row154-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-154")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET", "DATUM_RENDER_SOCKET", "STUDIO_VERIFY_BUDGET_MS"] as const
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

const TOKEN = "f".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const M = "2026-11-07_m154-feature"

const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row154 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
type S = Record<string, any>
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
const hostLog: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => {
  hostLog.push({ level, source, message, context })
  if (level === "error") console.log(`[row154] host error ${source}: ${message} ${JSON.stringify(context ?? {}).slice(0, 400)}`)
}
const quote = (label: string, v: unknown) => console.log(`[row154] ${label}: ${JSON.stringify(v)}`)

// ── render bridge stub ───────────────────────────────────────────────────────────────────────────────────────
// A locked-down bridge (same handshake fields as row 151's stub). measure: one paged sheet per `<section class="page"`
// with one text element per sheet; pdf: a PDF whose page count equals the sheets of the HTML it was given;
// overlap: clean, a B1 overlap, or refused like an app without row 152's entry; pagePng: writes small files.
const GOOD_INFO = { electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 16, scripts: ["studio.measure", OVERLAP_SCRIPT_NAME] }
type Bridge = { overlap: "clean" | "overlap" | "not-allowed"; down: boolean; pagePng: boolean; seen: S[] }
const bridge: Bridge = { overlap: "clean", down: false, pagePng: true, seen: [] }
const sheetsOf = (html: string) => Math.max(1, (html.match(/<section\b[^>]*class="[^"]*\bpage\b/g) ?? []).length)
const fakePdf = (pages: number) => Buffer.from(`%PDF-1.4\n1 0 obj<</Type /Pages /Count ${pages}>>endobj\n%%EOF\n`, "latin1")
let overlapAddress = "1.1"

function installBridge() {
  runtime.setRenderBridgeTransport(async (req) => {
    bridge.seen.push({ op: req.op, script: req.script === MEASURE_SCRIPT ? "measure" : req.script === OVERLAP_SCRIPT ? "overlap" : undefined, pages: req.pages })
    if (bridge.down) throw new Error("connect ENOENT /no/bridge.sock")
    if (req.op === "hello") return { ok: true, ...GOOD_INFO }
    if (req.op === "pdf") {
      const src = String(req.src ?? "")
      const html = typeof req.html === "string" ? req.html : existsSync(src) ? readFileSync(src, "utf8") : ""
      writeFileSync(String(req.dst), fakePdf(sheetsOf(html)))
      return { ok: true, electron: "42.3.3", dst: req.dst }
    }
    if (req.op === "checkPage") {
      const html = String(req.html ?? "")
      const n = sheetsOf(html)
      if (req.script === MEASURE_SCRIPT) {
        const elements = Array.from({ length: n }, (_, i) => [
          { kind: "page", page: i + 1, xMm: 0, yMm: i * 297, widthMm: 210, heightMm: 297, colors: ["#101418"], label: "page", overflow: false },
          { kind: "text", page: i + 1, xMm: 24, yMm: 30, widthMm: 160, heightMm: 5, address: `${i + 1}`, tag: "p", label: "st-p", fontSizePt: 10, measureMm: 160, lineCount: 1, charCount: 40, charsPerLine: 40, maxLineWidthMm: 120 },
        ]).flat()
        return { ok: true, script: "studio.measure", result: { paged: true, pageCount: n, truncated: false, elements } }
      }
      if (req.script === OVERLAP_SCRIPT) {
        if (bridge.overlap === "not-allowed") return { ok: false, code: "SCRIPT_NOT_ALLOWED", message: "stub" }
        const findings =
          bridge.overlap === "overlap"
            ? [{ code: "OVERLAP", page: 1, address: overlapAddress, label: "st-figure", kind: "figure", address2: "1.2", label2: "st-p", kind2: "text", areaMm2: 469.5, frac: 0.4 }]
            : []
        return { ok: true, script: OVERLAP_SCRIPT_NAME, result: { paged: true, pageCount: n, truncated: false, marginsUnreadable: false, contentHeightMm: null, boxes: 40, findingsTotal: findings.length, findings } }
      }
      return { ok: false, code: "SCRIPT_NOT_ALLOWED", message: "stub" }
    }
    if (req.op === "pagePng") {
      if (!bridge.pagePng) return { ok: false, code: "BAD_REQUEST", message: "unknown op" }
      const dir = String(req.dstDir)
      const pages = (Array.isArray(req.pages) ? (req.pages as number[]) : [1]).map((p) => {
        const dst = path.join(dir, `p${String(p).padStart(3, "0")}.png`)
        const bytes = Buffer.from(`png-${p}`)
        writeFileSync(dst, bytes)
        return { n: p, dst, width: 1239, height: 1753, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
      })
      return { ok: true, layout: "paged", media: "print", pageCount: Math.max(...pages.map((p) => p.n)), pageSizeMm: { wMm: 210, hMm: 297 }, pageSizeSource: "css", dpi: 150, pages }
    }
    return { ok: false, code: "BAD_REQUEST", message: "stub" }
  })
}
function resetBridge(o: Partial<Omit<Bridge, "seen">> = {}) {
  Object.assign(bridge, { overlap: "clean", down: false, pagePng: true }, o)
  bridge.seen.length = 0
  runtime.setRenderBridgeTransport(null) // drop the cached handshake
  installBridge()
}

// ── host ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function start(extensions?: (m: Mod) => ReturnType<Mod["missionHostExtension"]>) {
  await resetEnvCache()
  store = await mod.openHostStore(STORE, { release: "1.2.1", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.1" })
  const ext = extensions ? extensions(mod) : mod.missionHostExtension(store, { log, exporter: null })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: ext })
  c = new Client({ name: "row154-test", version: "0" })
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

async function callRaw(name: string, args: Record<string, unknown>) {
  return c.callTool({ name, arguments: args })
}
async function call(name: string, args: Record<string, unknown>): Promise<S> {
  const r = await callRaw(name, args)
  return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: ((r.content ?? []) as S[]).map((x) => x.text).join("\n") }
}
const code = (r: S) => (r.ok === false ? r.code : "OK")
const setRow = (id: string, status: string) => call("studio_mission_update_row", { mission: M, rows: [{ id, status }] })
function row(id: string) {
  return { id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate" }
}
async function toReview(id: string) {
  expect(code(await setRow(id, "running"))).toBe("OK")
  expect(code(await setRow(id, "needs-review"))).toBe("OK")
}

const MARKDOWN = [
  "# Kajian uji",
  "",
  "Pengukuran titik uji dicatat tiap bulan oleh tim lapangan.",
  "",
  "Paragraf penanda UJIHILANG berisi nilai 1.250 meter yang harus tetap ada.",
  "",
  "| Titik | Nilai |",
  "| --- | --- |",
  "| A | 1.250 |",
  "| B | 2.500 |",
  "",
].join("\n")

async function deliverable(docKey: string, title: string): Promise<string> {
  const d = await call("studio_document_create", { template: "datum-nota", mission: M, docKey, title })
  expect(d.ok).toBe(true)
  const id = String(d.documentId)
  const imp = await call("studio_chapter_import_markdown", { documentId: id, chapterKey: "1", markdown: MARKDOWN, submit: true, baseRevisionNo: 1 })
  expect(imp.ok).toBe(true)
  return id
}
async function render(documentId: string, formats: string[], extra: Record<string, unknown> = {}): Promise<S> {
  const rev = (await store.revisionVerification(documentId, "latest")).revisionNo
  const r = await call("studio_render", { documentId, revisionNo: rev, formats, ...extra })
  const v = r.verification as S | undefined
  quote(`render ${formats.join("+")}`, {
    ok: r.ok,
    isError: r._isError,
    outputs: (r.outputs ?? []).map((o: S) => o.format),
    overall: v?.overall,
    formatsAdded: v?.formatsAdded,
    states: (v?.outputs ?? []).map((o: S) => ({ format: o.format, state: o.state, checks: (o.checks as S[]).map((k) => `${k.id}:${k.status}${k.reason ? `/${k.reason}` : ""}`) })),
  })
  return r
}
const checkOf = (v: S, format: string, id: string): VerifyCheck => (v.outputs as S[]).find((o) => o.format === format)!.checks.find((k: S) => k.id === id)

let docGood = ""
let docBroken = ""

beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  delete process.env.STUDIO_VERIFY_BUDGET_MS
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  resetBridge()
  await start()
  const cr = await call("studio_mission_create", {
    mission: { id: M, title: "Row 154 mission", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: ["1", "2", "3"].map(row), decisions: [{ id: "U1", by: "user", date: "2026-11-07", text: "go" }] },
  })
  expect(cr.ok).toBe(true)
  expect((await call("studio_mission_approve", { mission: M, decision: "U1" })).ok).toBe(true)
  expect((await call("studio_mission_set_status", { mission: M, to: "running" })).ok).toBe(true)
}, 120_000)

afterEach(() => resetBridge())

afterAll(async () => {
  await stop()
  runtime.setRenderBridgeTransport(null)
  globalThis.fetch = realFetch
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await resetEnvCache()
})

describe("row 154: the studio_render wrapper in the host's tool list", () => {
  test("one wrapper, vendored inputSchema unchanged, description + U24 sentence, no fault seam in production", async () => {
    const tools = (await c.listTools()).tools
    const t = tools.find((x) => x.name === "studio_render")!
    const { TOOLS } = await import("../../vendor/scripts/studio/mcp/tools")
    const vendored = TOOLS.find((x) => x.name === "studio_render")!
    expect(t.inputSchema).toEqual(vendored.inputSchema as never)
    expect(t.description).toBe(`${vendored.description} ${RENDER_VERIFY_DESCRIPTION_SUFFIX}`)
    expect(tools.filter((x) => x.name === "studio_render")).toHaveLength(1)
    const w = mod.missionHostExtension(store, { log, exporter: null }).filter((e) => e.name === "studio_render")
    expect(w).toHaveLength(1)
    expect(w[0]!.wraps).toBe(true)
    expect((w[0] as unknown as { faultSeam: boolean }).faultSeam).toBe(false)
  })

  test("vendored tools.ts is byte-identical to its provenance record", async () => {
    const prov = JSON.parse(readFileSync(path.join(VENDOR, "provenance.json"), "utf8")) as S
    const entries: S[] = Array.isArray(prov.files) ? prov.files : Object.entries(prov.files ?? {}).map(([k, v]) => ({ path: k, ...(v as S) }))
    const e = entries.find((x) => String(x.path ?? x.file ?? "").endsWith("scripts/studio/mcp/tools.ts"))
    const bytes = readFileSync(path.join(VENDOR, "scripts", "studio", "mcp", "tools.ts"))
    const sha = createHash("sha256").update(bytes).digest("hex")
    quote("tools.ts sha256", { sha, provenance: e ? e.sha256 ?? e.after ?? e.sha : null })
    expect(e).toBeDefined()
    expect(JSON.stringify(e)).toContain(sha)
  })
})

describe("row 154: good render", () => {
  test("pdf requested -> html added; every check PASS; records verified; text lines; page images", async () => {
    docGood = await deliverable("row-1-kajian", "Kajian row 154")
    const r = await render(docGood, ["pdf"])
    expect(r._isError).toBe(false)
    expect(r.ok).toBe(true)
    const v = r.verification as S
    expect(v.$schema).toBe("studio.output-verification/v1")
    expect(v.formatsAdded).toEqual(["html"])
    expect((r.outputs as S[]).map((o) => o.format).sort()).toEqual(["HTML", "PDF"])
    expect(v.scope).toBe("DOCUMENT")
    expect(v.layout).toBe("paged")
    for (const o of v.outputs as S[]) {
      expect((o.checks as S[]).map((k) => k.id)).toEqual(["LINT", "OVERLAP_CLIP", "FIDELITY", "PAGE_COUNT", "FIGURE_FIT", "EMPTY_SLOTS"])
      for (const k of o.checks as S[]) expect(["PASS"]).toContain(k.status)
      expect(o.state).toBe("verified")
    }
    expect(checkOf(v, "PDF", "OVERLAP_CLIP").basis).toBe("same-job-html")
    expect(checkOf(v, "PDF", "FIDELITY").basis).toBe("same-job-html")
    expect(v.overall).toBe("verified")
    expect(v.layoutWitness).toBe(true)
    // page images: same files for HTML and PDF, under <store>/verify/<htmlOutputId>/
    const html = (v.outputs as S[]).find((o) => o.format === "HTML")!
    const pdf = (v.outputs as S[]).find((o) => o.format === "PDF")!
    expect(html.pages.length).toBeGreaterThan(0)
    expect(html.pages[0].png).toBe(path.join(store.rootDir, "verify", html.outputId, "p001.png"))
    expect(pdf.pages.map((p: S) => p.png)).toEqual(html.pages.map((p: S) => p.png))
    expect(existsSync(html.pages[0].png)).toBe(true)
    // text lines (safe tokens only)
    quote("text tail", r._text.split("\n").slice(-4))
    expect(r._text).toContain(`verification: VERIFIED (2/2 outputs verified)`)
    expect(r._text).toContain(`HTML ${html.outputId} VERIFIED`)
    expect(r._text).toContain(`pages: ${html.pages[0].png}`)
    expect(r._text).not.toContain("next:")
    expect(r.untrustedFields).toContain("verification.outputs[].checks[].findings")
    // records: one per output, state verified, counts 0/0, report = output + header
    for (const o of v.outputs as S[]) {
      const rec = await store.getOutputVerification(o.outputId)
      expect(rec).toMatchObject({ state: "verified", fail_count: 0, unknown_count: 0, output_sha256: o.sha256, checks_version: 1, verified_by: "studio_render/swarm" })
      expect(rec!.report).toMatchObject({ $schema: "studio.output-verification/v1", documentId: docGood, outputId: o.outputId, state: "verified" })
    }
    const set = await store.revisionVerification(docGood, "latest")
    quote("revisionVerification good", { final: set.final, reasons: set.reasons, outputs: set.outputs.map((o) => [o.format, o.state]) })
    expect(set.final).toBe(true)
  }, 60_000)

  test("mission rule (row 155) accepts the row; the deliverables read shows verified", async () => {
    const g = await call("studio_mission_get", { mission: M, include: ["deliverables"] })
    const outs = (g.deliverables as S[]).find((d) => d.documentId === docGood)!.outputs as S[]
    quote("deliverables good", outs.map((o) => ({ format: o.format, verified: o.verified })))
    expect(outs.length).toBe(2)
    expect(outs.every((o) => o.verified === true)).toBe(true)
    await toReview("1")
    const done = await setRow("1", "done")
    quote("row 1 done", { code: code(done) })
    expect(code(done)).toBe("OK")
  })

  test("without row 152's allow-list entry: OVERLAP_CLIP UNKNOWN BRIDGE_UNAVAILABLE, outputs unverified (UNKNOWN is never a pass)", async () => {
    resetBridge({ overlap: "not-allowed" })
    const r = await render(docGood, ["pdf"])
    const v = r.verification as S
    for (const f of ["HTML", "PDF"]) {
      expect(checkOf(v, f, "OVERLAP_CLIP")).toMatchObject({ status: "UNKNOWN", reason: "BRIDGE_UNAVAILABLE" })
      for (const id of ["LINT", "FIDELITY", "PAGE_COUNT", "FIGURE_FIT", "EMPTY_SLOTS"]) expect(checkOf(v, f, id as never).status).toBe("PASS")
    }
    expect(v.overall).toBe("unverified")
    expect(r._text).toContain("unknown=OVERLAP_CLIP:BRIDGE_UNAVAILABLE")
    // identical bytes re-used the output rows: the newest verification wins (D-7), attempt 2
    for (const o of v.outputs as S[]) {
      const rec = await store.getOutputVerification(o.outputId)
      expect(rec).toMatchObject({ state: "unverified", fail_count: 0, unknown_count: 1, attempt: 2 })
    }
    const set = await store.revisionVerification(docGood, "latest")
    expect(set.final).toBe(false)
    expect(set.reasons).toContain("CHECK_UNKNOWN")
  }, 60_000)
})

describe("row 154: broken renders (spec §9 B-cases)", () => {
  test("B1 overlap (bridge finding): OVERLAP_CLIP FAIL with page and both addresses; HTML+PDF unverified; row done refused CHECK_FAILED", async () => {
    docBroken = await deliverable("row-2-laporan", "Laporan row 154")
    resetBridge({ overlap: "overlap" })
    const r = await render(docBroken, ["pdf", "docx"])
    const v = r.verification as S
    expect(v.formatsAdded).toEqual(["html"])
    for (const f of ["HTML", "PDF"]) {
      const k = checkOf(v, f, "OVERLAP_CLIP")
      expect(k.status).toBe("FAIL")
      expect(k.findings[0]).toMatchObject({ code: "OVERLAP", page: 1, address: overlapAddress })
      quote(`B1 ${f} finding`, k.findings[0])
      expect((v.outputs as S[]).find((o) => o.format === f)!.state).toBe("unverified")
    }
    expect(checkOf(v, "DOCX", "OVERLAP_CLIP").status).toBe("NOT_APPLICABLE")
    expect(v.overall).toBe("unverified")
    expect(v.layoutWitness).toBe(false)
    expect(r._text).toMatch(/PDF \S+ UNVERIFIED fail=OVERLAP_CLIP unknown=-/)
    expect(r._text).toContain("next: read structuredContent.verification")
    // page 1 has a finding: it is imaged first
    const html = (v.outputs as S[]).find((o) => o.format === "HTML")!
    expect(html.pages.find((p: S) => p.n === 1)).toMatchObject({ findings: 1 })
    for (const o of v.outputs as S[]) {
      const rec = await store.getOutputVerification(o.outputId)
      expect(rec!.state).toBe(o.state)
    }
    await toReview("2")
    const refused = await setRow("2", "done")
    quote("row 2 done, B1", { code: code(refused), outputs: refused.error?.details?.deliverables?.[0]?.outputs })
    expect(code(refused)).toBe("OUTPUT_UNVERIFIED")
    expect((refused.error.details.deliverables[0].outputs as S[]).some((o) => o.reason === "CHECK_FAILED")).toBe(true)
    const g = await call("studio_mission_get", { mission: M, include: ["deliverables"] })
    const outs = (g.deliverables as S[]).find((d) => d.documentId === docBroken)!.outputs as S[]
    quote("deliverables B1", outs.map((o) => ({ format: o.format, verified: o.verified })))
    expect(outs.filter((o) => o.format === "HTML" || o.format === "PDF").every((o) => o.verified === false)).toBe(true)
  }, 60_000)

  test("B4 dropped paragraph and B5 changed number (fault seam, test-only host build): FIDELITY FAIL with addresses", async () => {
    // A second host whose studio_render wrapper carries the §9 fault seam; the production list is not used here.
    await stop()
    const drop = (s: string) => s.replace(/<p\b[^>]*>[^<]*UJIHILANG[^<]*<\/p>/, "").replace(">2.500</p></td>", ">2.050</p></td>")
    const fault = (format: string, bytes: Uint8Array) => (format === "HTML" ? strToU8(drop(strFromU8(bytes))) : bytes)
    await start((m) =>
      m.missionHostExtension(store, { log, exporter: null }).map((e) => (e.name === "studio_render" && e.wraps ? renderVerifyWrapper(store as unknown as RenderVerifyStore, { log, seam: { fault } }) : e)),
    )
    const w = (await c.listTools()).tools.filter((t) => t.name === "studio_render")
    expect(w).toHaveLength(1)
    const r = await render(docBroken, ["pdf"])
    const v = r.verification as S
    for (const f of ["HTML", "PDF"]) {
      const k = checkOf(v, f, "FIDELITY")
      quote(`B4/B5 ${f} findings`, k.findings)
      expect(k.status).toBe("FAIL")
      const missing = k.findings.find((x) => x.code === "BLOCK_MISSING")
      expect(missing?.address).toBeTruthy()
      expect(k.findings.some((x) => x.code === "NUMBER_CHANGED" || x.code === "TABLE_CELL_CHANGED")).toBe(true)
    }
    expect(v.overall).toBe("unverified")
    // the stored file was never changed by the seam
    const html = (v.outputs as S[]).find((o) => o.format === "HTML")!
    expect(strFromU8(await store.readOutputVerified(html.outputId))).toContain("UJIHILANG")
    await stop()
    await start()
  }, 90_000)

  test("B10 bridge down: html/docx render, OVERLAP_CLIP and PAGE_COUNT UNKNOWN BRIDGE_UNAVAILABLE, unverified; no page images", async () => {
    resetBridge({ down: true })
    const r = await render(docBroken, ["docx", "html"])
    expect(r._isError).toBe(false)
    const v = r.verification as S
    expect(v.formatsAdded).toEqual([])
    quote("B10 HTML FIDELITY", checkOf(v, "HTML", "FIDELITY"))
    expect(checkOf(v, "HTML", "OVERLAP_CLIP")).toMatchObject({ status: "UNKNOWN", reason: "BRIDGE_UNAVAILABLE" })
    expect(checkOf(v, "HTML", "PAGE_COUNT").status).toBe("UNKNOWN")
    expect(v.layout).toBe("none")
    expect((v.outputs as S[]).every((o) => o.state === "unverified")).toBe(true)
    expect(r._text).toContain("pages: none imaged (page count not measured); open the PDF or HTML output and look at every page")
    const set = await store.revisionVerification(docBroken, "latest")
    expect(set.final).toBe(false)
  }, 60_000)
})

describe("row 154: failure paths", () => {
  test("an error result is returned unchanged with no verification", async () => {
    const r = await call("studio_render", { documentId: "does-not-exist-154", formats: ["html"] })
    quote("error render", { isError: r._isError, ok: r.ok, code: r.code })
    expect(r.ok).toBe(false)
    expect(r.code).toBe("DOCUMENT_NOT_FOUND")
    expect(r.verification).toBeUndefined()
  })

  test("verification throwing: every check UNKNOWN VERIFY_INTERNAL, records unverified, render result still returned, error logged", async () => {
    await stop()
    const boom = () => {
      throw new Error("row154 injected verify failure")
    }
    await start((m) =>
      m.missionHostExtension(store, { log, exporter: null }).map((e) => (e.name === "studio_render" && e.wraps ? renderVerifyWrapper(store as unknown as RenderVerifyStore, { log, seam: { fault: boom } }) : e)),
    )
    hostLog.length = 0
    const r = await render(docGood, ["html"])
    expect(r._isError).toBe(false)
    expect(r.ok).toBe(true)
    const v = r.verification as S
    for (const o of v.outputs as S[]) {
      for (const k of o.checks as S[]) expect(k.status === "NOT_APPLICABLE" || (k.status === "UNKNOWN" && k.reason === "VERIFY_INTERNAL")).toBe(true)
      expect(o.state).toBe("unverified")
      expect((await store.getOutputVerification(o.outputId))!.state).toBe("unverified")
    }
    const err = hostLog.find((l) => l.level === "error" && l.source === "studio_render.verify")
    quote("logged", { message: err?.message, hasStack: typeof err?.context?.stack_trace === "string" })
    expect(err).toBeDefined()
    expect(String(err!.context!.stack_trace)).toContain("row154 injected verify failure")
    await stop()
    await start()
  }, 90_000)
})

describe("row 154: pure parts", () => {
  test("addMeasuredSources: pdf/docx without html gets html; png without svg gets svg; absent lists untouched; max 3 kept", () => {
    expect(addMeasuredSources({ formats: ["pdf"] })).toEqual({ args: { formats: ["pdf", "html"] }, formatsAdded: ["html"] })
    expect(addMeasuredSources({ formats: ["docx", "html"] }).formatsAdded).toEqual([])
    expect(addMeasuredSources({ figures: ["png"] })).toEqual({ args: { figures: ["png", "svg"] }, formatsAdded: ["svg"] })
    expect(addMeasuredSources({ documentId: "x" })).toEqual({ args: { documentId: "x" }, formatsAdded: [] })
  })
  test("state: UNKNOWN or FAIL never verified; NOT_APPLICABLE ignored", () => {
    const k = (status: VerifyCheck["status"]) => ({ id: "LINT", status, basis: "self", reason: null, findings: [], truncated: 0, ms: 0 }) as VerifyCheck
    expect(outputState([k("PASS"), k("NOT_APPLICABLE")])).toBe("verified")
    expect(outputState([k("PASS"), k("UNKNOWN")])).toBe("unverified")
    expect(outputState([k("FAIL")])).toBe("unverified")
  })
  test("choosePages: findings first, then first/last, evenly spaced, at most 12", () => {
    expect(choosePages(3, [])).toEqual([1, 2, 3])
    const p = choosePages(40, [17, 33])
    expect(p).toHaveLength(12)
    expect(p).toContain(1)
    expect(p).toContain(40)
    expect(p).toContain(17)
    expect(p).toContain(33)
    expect(choosePages(0, [1])).toEqual([])
  })
  test("budget: STUDIO_VERIFY_BUDGET_MS, default 120000", () => {
    expect(verifyBudgetMs({})).toBe(120_000)
    expect(verifyBudgetMs({ STUDIO_VERIFY_BUDGET_MS: "5000" })).toBe(5000)
    expect(verifyBudgetMs({ STUDIO_VERIFY_BUDGET_MS: "x" })).toBe(120_000)
  })
})
