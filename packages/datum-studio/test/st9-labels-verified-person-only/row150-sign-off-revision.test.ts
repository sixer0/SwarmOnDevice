// Swarm 1.3.3 row 150 (senior S1): the person's label sign-off writes ONE revision for all figures of the request, and
// the person's decision renders it through the path of an agent's studio_render (vendored render service -> row 154
// verification -> row 68 project copy -> row's deliverables). So a `done` row's latest deliverable is the checked
// revision, its control sheet loses the draft remark of row 63 once every figure is checked, and a second label-check
// request naming the document is no longer refused by row 70's gate. Renderer unavailable: the revision is stored, the
// marker clears, and the render is owed (reply line + finding labels-render-r<row>).
// REAL host (startStudioHostServer over streamable HTTP; binds an ephemeral port: run with the command sandbox off),
// store opened with missionGuard: true as desktop does. The render bridge is row 68's transport stub (Electron cannot
// run under bun). Synthetic data only. globalThis.fetch is a trap: the host must never call it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { PERSON_KEY, personCaller } from "../mission-tools/_attested-person.ts"
import { clone, diagramsOf, FIXTURE, META, type S } from "../diagram-persist/hna-host"
import * as runtime from "../../vendor/src/lib/studio/engine/browser/runtime"
import { MEASURE_SCRIPT } from "../../vendor/src/lib/studio/engine/browser/measure"
import { OVERLAP_SCRIPT, OVERLAP_SCRIPT_NAME } from "../../src/mcp-host/verify/overlap-script"
import { makePng } from "../ported/renderers/_kit"
import { labelsCheckContext, labelsCheckText } from "../../src/mcp-host/mission/labels-check.ts"
import { uncheckedFigureCount } from "../../vendor/src/lib/studio/services/compose/front"
import { controlSheetDraftRemarkText } from "../../vendor/src/lib/studio/engine/front/texts"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const WORK = realpathSync(mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "row150-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-150")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })
const TOKEN = "f".repeat(16) + "0123456789abcdef".repeat(3)
const M = "2026-11-18_row150"
const REMARK = "label belum diperiksa manusia"

const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET", "STUDIO_RENDER_RATE_LIMIT"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row150 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

// ── render bridge stub (row 68's, trimmed): measure, a PDF with one page per sheet, clean overlap, page images ──
const GOOD_INFO = { electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 16, scripts: ["studio.measure", OVERLAP_SCRIPT_NAME] }
const bridge = { down: false }
const sheetsOf = (html: string) => Math.max(1, (html.match(/<section\b[^>]*class="[^"]*\bpage\b/g) ?? []).length)
function installBridge() {
  runtime.setRenderBridgeTransport(async (req) => {
    if (bridge.down) throw new Error("connect ENOENT /no/bridge.sock")
    if (req.op === "hello") return { ok: true, ...GOOD_INFO }
    if (req.op === "png") {
      // figure rasterisation (DOCX figures), as the row 137 stub
      writeFileSync(String(req.dst), makePng(Number(req.width), Number(req.height)))
      return { ok: true, electron: "42.3.3", dst: req.dst, width: req.width, height: req.height }
    }
    if (req.op === "pdf") {
      const src = String(req.src ?? "")
      const html = typeof req.html === "string" ? req.html : existsSync(src) ? readFileSync(src, "utf8") : ""
      writeFileSync(String(req.dst), Buffer.from(`%PDF-1.4\n1 0 obj<</Type /Pages /Count ${sheetsOf(html)}>>endobj\n%%EOF\n`, "latin1"))
      return { ok: true, electron: "42.3.3", dst: req.dst }
    }
    if (req.op === "checkPage") {
      const n = sheetsOf(String(req.html ?? ""))
      if (req.script === MEASURE_SCRIPT) {
        const elements = Array.from({ length: n }, (_, i) => [
          { kind: "page", page: i + 1, xMm: 0, yMm: i * 297, widthMm: 210, heightMm: 297, colors: ["#101418"], label: "page", overflow: false },
          { kind: "text", page: i + 1, xMm: 24, yMm: 30, widthMm: 160, heightMm: 5, address: `${i + 1}`, tag: "p", label: "st-p", fontSizePt: 10, measureMm: 160, lineCount: 1, charCount: 40, charsPerLine: 40, maxLineWidthMm: 120 },
        ]).flat()
        return { ok: true, script: "studio.measure", result: { paged: true, pageCount: n, truncated: false, elements } }
      }
      if (req.script === OVERLAP_SCRIPT) return { ok: true, script: OVERLAP_SCRIPT_NAME, result: { paged: true, pageCount: n, truncated: false, marginsUnreadable: false, contentHeightMm: null, boxes: 40, findingsTotal: 0, findings: [] } }
      return { ok: false, code: "SCRIPT_NOT_ALLOWED", message: "stub" }
    }
    if (req.op === "pagePng") {
      const pages = (Array.isArray(req.pages) ? (req.pages as number[]) : [1]).map((p) => {
        const dst = path.join(String(req.dstDir), `p${String(p).padStart(3, "0")}.png`)
        const bytes = Buffer.from(`png-${p}`)
        writeFileSync(dst, bytes)
        return { n: p, dst, width: 1239, height: 1753, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
      })
      return { ok: true, layout: "paged", media: "print", pageCount: Math.max(...pages.map((p) => p.n)), pageSizeMm: { wMm: 210, hMm: 297 }, pageSizeSource: "css", dpi: 150, pages }
    }
    return { ok: false, code: "BAD_REQUEST", message: "stub" }
  })
}
function setBridge(down: boolean) {
  bridge.down = down
  runtime.setRenderBridgeTransport(null) // drop the cached handshake
  installBridge()
}

// ── host ──
let mod: S
let store: S
let host: S
let agent: Client
let person: ReturnType<typeof personCaller>
const logs: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []

async function resetEnvCache() {
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetRenderRateLimiter()
}

beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  process.env.STUDIO_RENDER_RATE_LIMIT = "1000"
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  await resetEnvCache()
  setBridge(false)
  mod = await import("../../src/mcp-host/index.ts")
  store = await mod.openHostStore(STORE, { release: "1.3.3", logFile: path.join(WORK, "logs", "store.jsonl"), missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.3.3" })
  const log = (level: string, source: string, message: string, context?: Record<string, unknown>) => {
    logs.push({ level, source, message, context })
    if (level === "error") console.log(`[row150] host error ${source}: ${message} ${JSON.stringify(context ?? {}).slice(0, 400)}`)
  }
  const facts = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
  host = await mod.startStudioHostServer({ store, token: TOKEN, missionControlKey: PERSON_KEY, hostname: "127.0.0.1", port: 0, log, facts, extensions: mod.missionHostExtension(store, { log, exporter: null }) } as never)
  agent = new Client({ name: "row150-agent", version: "0" })
  await agent.connect(new StreamableHTTPClientTransport(new URL(host.url), { fetch: realFetch as never, requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } } }))
  person = personCaller({ url: host.url, token: TOKEN, cwd: PROJECT, agent: "mission-control", fetchImpl: realFetch })
  const row = (id: string) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
  const cr = await person("studio_mission_create", { mission: { id: M, title: "Row 150 mission", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: ["1", "2"].map(row), decisions: [{ id: "U1", by: "user", date: "2026-11-18", text: "go" }] } })
  expect(cr.ok, JSON.stringify(cr)).toBe(true)
  expect((await call("studio_mission_approve", { mission: M, decision: "U1" })).ok).toBe(true)
  expect((await call("studio_mission_set_status", { mission: M, to: "running" })).ok).toBe(true)
}, 180_000)

afterAll(async () => {
  await agent?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  runtime.setRenderBridgeTransport(null)
  globalThis.fetch = realFetch
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await resetEnvCache()
  rmSync(WORK, { recursive: true, force: true })
})

async function call(name: string, args: unknown): Promise<S> {
  const r = await agent.callTool({ name, arguments: args as Record<string, unknown> })
  return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: ((r.content ?? []) as S[]).map((x) => x.text ?? "").join("\n") }
}
const brief = (r: S) => String(r._text ?? JSON.stringify(r)).slice(0, 400).replace(/\n/g, " / ")
const content = async (id: string): Promise<S> => (await call("studio_document_get", { documentId: id, view: "content" })).content as S
const revOf = async (id: string) => Number((await call("studio_document_get", { documentId: id })).revisionNo)
const revisions = (id: string): Promise<number> => store.transaction(async (t: S) => Number(t.get("SELECT count(*) AS n FROM revision WHERE document_id = ?", [id]).n))
/** A straight three-box flow (the syn128 fixture's shape set, without its branch, so FIGURE_FIT passes), unchecked. */
const block = (): S => {
  const b = clone(FIXTURE.writeBlock)
  b.diagram.spec = {
    family: "flow",
    labels_verified: false,
    nodes: [
      { id: "a", label: "Mulai", class: { col: 0, row: 0 }, shape: "stadium" },
      { id: "b", label: "Periksa berkas", class: { col: 0, row: 1 }, shape: "box" },
      { id: "c", label: "Selesai", class: { col: 0, row: 2 }, shape: "stadium" },
    ],
    edges: [
      { from: "a", to: "b", kind: "data", label: "masuk" },
      { from: "b", to: "c", kind: "data", label: "simpan" },
    ],
  }
  return b
}
async function figuresDoc(docKey: string, n: number): Promise<{ id: string; pids: string[] }> {
  const blocks = Array.from({ length: n }, (_, i) => [`Paragraf sintetis ${i + 1} alfa bravo charlie delta.`, block()]).flat()
  const w = await call("studio_write", { mission: M, docKey, template: "datum-nota", meta: META, sections: [{ heading: "Pendahuluan", blocks }] })
  expect(w.ok, w._text).not.toBe(false)
  const id = String(w.documentId)
  return { id, pids: diagramsOf(await content(id)).map((d) => String(d.id)) }
}
async function agentRender(id: string): Promise<S> {
  const r = await call("studio_render", { documentId: id, revisionNo: await revOf(id), formats: ["pdf", "docx"] })
  const v = r.verification as S | undefined
  console.log(`[row150] agent render: ok=${r.ok} overall=${v?.overall} copy=${JSON.stringify(r.projectCopy).slice(0, 200)}`)
  if (v?.overall !== "verified") console.log(`[row150] checks: ${JSON.stringify((v?.outputs ?? []).map((o: S) => ({ f: o.format, s: o.state, c: (o.checks as S[]).filter((k) => k.status !== "PASS").map((k) => `${k.id}:${k.status}/${k.reason ?? ""}:${JSON.stringify(k.findings ?? []).slice(0, 300)}`) })))}`)
  return r
}
/**
 * The draft remark row 63 composes into the control sheet's method statement for revision `n`: its own counter
 * (`uncheckedFigureCount`, called by compose/snapshot.ts) over the revision's stored source, and its own text. The
 * datum-nota tier omits the control sheet slot (snapshot `state: OMITTED`), so the printed sheet is row 63's tests';
 * here the input of that sheet is read from the revision the row's deliverable was rendered from. "" = no remark.
 */
const sheetRemark = async (id: string, n: number): Promise<string> => {
  const raw = await store.transaction(async (t: S) => t.get("SELECT snapshot FROM revision WHERE document_id = ? AND revision_no = ?", [id, n]).snapshot)
  const snap = typeof raw === "string" ? JSON.parse(raw) : raw
  const count = uncheckedFigureCount(snap.source.sections)
  return count === 0 ? "" : controlSheetDraftRemarkText(REMARK, count, "ID")
}
/** Text of the newest PRIMARY HTML output of revision `n` (the source the PDF is printed from). */
const htmlText = (id: string, n: number): Promise<string> =>
  store.transaction(async (t: S) => {
    const o = t.get(
      "SELECT o.rel_path FROM output_file o JOIN revision r ON r.id = o.revision_id WHERE o.document_id = ? AND r.revision_no = ? AND o.format = 'HTML' AND o.role = 'PRIMARY' ORDER BY o.time_created DESC, o.rowid DESC LIMIT 1",
      [id, n],
    )
    return o ? readFileSync(path.join(STORE, String(o.rel_path)), "utf8") : ""
  })
const latest = (row: string, id: string): S[] => store.missions.rowContract(M, row).deliverables.filter((d: S) => d.documentId === id && d.latest)
const ask = (id: string, context: string) =>
  call("studio_mission_request_decision", { mission: M, request: { id, question: "Label gambar sudah Anda periksa?", context, options: [{ id: "approve", label: "Sudah diperiksa", consequence: "Gambar ditandai sudah diperiksa manusia" }, { id: "decline", label: "Belum", consequence: "Dokumen tetap draf" }] } })

let d1 = { id: "", pids: [] as string[] }
let d2 = { id: "", pids: [] as string[] }

describe("row 150: the person's sign-off makes one rendered, verified and copied revision", () => {
  test("setup: row 1 (4 unchecked figures) and row 2 (1 figure) rendered, copied, done and waiting for the label check", async () => {
    d1 = await figuresDoc("row-1-gambar", 4)
    d2 = await figuresDoc("row-2-gambar", 1)
    expect(d1.pids).toHaveLength(4)
    for (const [row, d] of [["1", d1], ["2", d2]] as const) {
      const r = await agentRender(d.id)
      expect((r.verification as S).overall).toBe("verified")
      expect(r.projectCopy).toMatchObject({ ok: true, recorded: true, row })
      expect((await call("studio_mission_update_row", { mission: M, rows: [{ id: row, status: "running" }] })).ok).toBe(true)
      const done = await call("studio_mission_update_row", { mission: M, rows: [{ id: row, status: "done", note: "rendered and verified" }] })
      console.log(`[row150] row ${row} done: ${brief(done)}`)
      expect(done.ok, String(done._text)).toBe(true)
      expect(store.missions.rowContract(M, row).awaitingHumanCheck).toMatchObject({ checks: ["labels_verified"] })
    }
    const before = await sheetRemark(d1.id, await revOf(d1.id))
    console.log(`[row150] method statement remark before: ${before}`)
    expect(before).toBe(`Status: draf. ${REMARK} (4 gambar).`)
  }, 300_000)

  test("one approval of three figures: ONE revision, rendered on the decision, the row's latest deliverable points at it", async () => {
    const rev0 = await revOf(d1.id)
    const count0 = await revisions(d1.id)
    const q = await ask("D-1", labelsCheckContext({ row: "1", documentId: d1.id, revisionNo: rev0, figures: d1.pids.slice(0, 3) }))
    expect(q.ok, q._text).not.toBe(false)
    const r = await person("studio_mission_answer_decision", { mission: M, request: "D-1", option: "approve", by: "user", decisionId: "U2" })
    console.log(`[row150] person D-1: ${JSON.stringify(r.labelsCheck)}`)
    expect(r.labelsCheck).toMatchObject({ outcome: "raised", decision: "U2", raised: d1.pids.slice(0, 3), remaining: 1, markerCleared: false, revisionNo: rev0 + 1 })
    expect(await revisions(d1.id)).toBe(count0 + 1)
    expect(r.labelsCheck.render).toMatchObject({ state: "rendered", by: "user", decision: "U2", revisionNo: rev0 + 1 })
    // the person's action, recorded as such: revision author, render job requester, verification records
    const who = await store.transaction(async (t: S) => ({
      revision: t.get("SELECT created_by FROM revision WHERE document_id = ? AND revision_no = ?", [d1.id, rev0 + 1]).created_by,
      verifiedBy: t.all("SELECT DISTINCT v.verified_by AS b FROM output_verification v JOIN output_file o ON o.id = v.output_file_id JOIN revision r ON r.id = o.revision_id WHERE o.document_id = ? AND r.revision_no = ?", [d1.id, rev0 + 1]).map((x: S) => x.b),
    }))
    console.log(`[row150] recorded as: ${JSON.stringify(who)}`)
    expect(who).toEqual({ revision: "user:mission-control", verifiedBy: ["studio_render/user:mission-control"] })
    const items = latest("1", d1.id)
    expect(items.length).toBeGreaterThan(0)
    for (const it of items) expect(it.revisionNo).toBe(rev0 + 1)
    for (const it of items) expect(existsSync(path.join(PROJECT, it.path))).toBe(true)
    // the copied files are this revision's rendered outputs (sha256 of the project file = the store output's)
    const html = await htmlText(d1.id, rev0 + 1)
    const htmlItem = items.find((it) => it.format === "HTML")!
    expect(createHash("sha256").update(readFileSync(path.join(PROJECT, htmlItem.path))).digest("hex")).toBe(createHash("sha256").update(html).digest("hex"))
    expect(await sheetRemark(d1.id, rev0 + 1)).toBe(`Status: draf. ${REMARK} (1 gambar).`)
  }, 300_000)

  test("a second request for the last figure succeeds (row 70's gate finds the copy), and its approval removes the draft remark", async () => {
    const rev1 = await revOf(d1.id)
    const q = await ask("D-2", labelsCheckContext({ row: "1", documentId: d1.id, revisionNo: rev1, figures: [d1.pids[3]!] }))
    console.log(`[row150] D-2 request: ${brief(q)}`)
    expect(q.ok, q._text).not.toBe(false)
    const r = await person("studio_mission_answer_decision", { mission: M, request: "D-2", option: "approve", by: "user", decisionId: "U3" })
    console.log(`[row150] person D-2: ${JSON.stringify(r.labelsCheck)}`)
    expect(r.labelsCheck).toMatchObject({ outcome: "raised", raised: [d1.pids[3]], remaining: 0, markerCleared: true, render: { state: "rendered", revisionNo: rev1 + 1 } })
    expect(store.missions.rowContract(M, "1")).toMatchObject({ awaitingHumanCheck: { clearedBy: "U3" } })
    for (const it of latest("1", d1.id)) expect(it.revisionNo).toBe(rev1 + 1)
    // every figure checked: row 63's remark is gone (its sheet is then byte-identical to a checked document's)
    expect(await sheetRemark(d1.id, rev1 + 1)).toBe("")
    const html = await htmlText(d1.id, rev1 + 1)
    expect(html.length).toBeGreaterThan(0)
    expect(html).not.toContain(REMARK)
    expect(html).not.toContain("Status: draf")
    expect(labelsCheckText(r.labelsCheck)).toContain("rendered on this decision")
    expect(labelsCheckText(r.labelsCheck)).not.toMatch(/[a-z_]+ \{/) // decision C40
  }, 300_000)

  test("renderer unavailable: the revision is stored, the marker clears, the render is owed (reply + finding); the next render refreshes", async () => {
    const rev0 = await revOf(d2.id)
    const q = await ask("D-3", labelsCheckContext({ row: "2", documentId: d2.id, revisionNo: rev0, figures: d2.pids }))
    expect(q.ok, q._text).not.toBe(false)
    setBridge(true)
    const r = await person("studio_mission_answer_decision", { mission: M, request: "D-3", option: "approve", by: "user", decisionId: "U4" })
    setBridge(false)
    console.log(`[row150] person D-3 (renderer down): ${JSON.stringify(r.labelsCheck)}`)
    expect(r.labelsCheck).toMatchObject({ outcome: "raised", raised: d2.pids, remaining: 0, markerCleared: true, revisionNo: rev0 + 1, render: { state: "owed", revisionNo: rev0 + 1, finding: "labels-render-r2" } })
    expect(typeof r.labelsCheck.render.cause).toBe("string")
    expect(store.missions.rowContract(M, "2").awaitingHumanCheck).toMatchObject({ clearedBy: "U4" })
    for (const it of latest("2", d2.id)) expect(it.revisionNo).toBe(rev0)
    const finding = store.missions.get(M).mission.findings.find((f: S) => f.id === "labels-render-r2")
    console.log(`[row150] finding: ${JSON.stringify(finding)}`)
    expect(finding).toMatchObject({ status: "open", sourceRow: "2", decision: "U4" })
    // What the person sees: the decision's reply line, and the open finding in the mission's findings.
    const line = labelsCheckText(r.labelsCheck)
    console.log(`[row150] reply line: ${line}`)
    expect(line).toContain("render owed")
    expect(line).toContain("call the tool datum-studio_studio_render for the whole document")
    // decision C40: no call-shaped text (a tool name followed by a JSON object) in the reply or the finding
    expect(line).not.toMatch(/[a-z_]+ \{/)
    expect(String(finding.evidence)).not.toMatch(/[a-z_]+ \{/)
    // a request naming the document is refused until the render (row 70), with studio_render as the fix
    const refused = await call("studio_mission_request_decision", { mission: M, request: { id: "D-4", question: "Dokumen ini siap ditinjau?", context: `review document=${d2.id}`, options: [{ id: "approve", label: "Ya", consequence: "a" }, { id: "decline", label: "Tidak", consequence: "b" }] } })
    console.log(`[row150] request while owed: ${brief(refused)}`)
    expect(JSON.stringify(refused)).toContain("DELIVERABLE_NOT_IN_PROJECT")
    // the next render (an agent's ordinary studio_render) refreshes the row's deliverable
    const again = await agentRender(d2.id)
    expect(again.projectCopy).toMatchObject({ ok: true, recorded: true })
    for (const it of latest("2", d2.id)) expect(it.revisionNo).toBe(rev0 + 1)
  }, 300_000)
})
