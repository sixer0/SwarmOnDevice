// Row 43 (decision U6): documents stay retrievable from the SQLite store after a restart.
//
// One phase per process. Phase A opens a store, starts the real host server, writes two documents with revisions
// and rendered outputs through the MCP tools, then closes the host and the store. Phase B runs in a NEW process
// (bun, or Electron 42's Node through ELECTRON_RUN_AS_NODE=1 with a bundle of this file), opens a host on the same
// store root and lists, fetches, verifies, re-renders and searches what phase A wrote.
//
// Runtime neutral on purpose: no bun API, no import.meta.dir; every path comes in through the config, so the same
// code runs under bun (source) and under Electron's Node (bundle built by row43-retrieval.test.ts).
// Real: store, host server on 127.0.0.1 (ephemeral port), MCP SDK client, vendored services and engines, and the
// row 24 render bridge (socket, token, dispatch). Fake: only the bridge's PageEngine (row 32 harness), which
// phase A needs for PDF. globalThis.fetch is a counting trap; no network, no model.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { closeHostStore, configureTemplateSource, openHostStore, startStudioHostServer } from "../../src/mcp-host/index.ts"
import { createLocalStudioApi } from "../../src/mcp-host/local-api/router.ts"
import { LOCAL_ROUTES } from "../../src/mcp-host/local-api/routes.ts"
import { resetStudioEnvCache } from "../../vendor/src/lib/studio/contract/env"
import { resetRenderRateLimiter } from "../../vendor/src/lib/studio/http/render-guard"
import { resetBridgePdfReadiness } from "../../vendor/src/lib/studio/services/render"
import { startRenderBridge } from "../../../desktop/src/main/datum-render/index.ts"
import { renderWebPreferences } from "../../../desktop/src/main/datum-render/pages.ts"

export type PhaseConfig = {
  phase: "A" | "B"
  pkg: string
  desktop: string
  storeRoot: string
  work: string
  out: string
  mission: string
}

type S = Record<string, any>
type OutputRec = { docKey: string; revisionNo: number; format: string; id: string; sha256: string; relPath: string }
type DocRec = { documentId: string; revisions: number[]; completeAt: number[]; rendered: Array<{ revisionNo: number; scope: S }>; via: string }
type RevRec = { docKey: string; revisionNo: number; contentSha: string; snapshotSha: string; texts: string[] }

export const PHRASE_1 = "anemometer Tanjung Priok dikalibrasi ulang"
export const PHRASE_2 = "pompa hidran Cilacap diuji tekanan"
const TEMPLATE_2 = process.env.ROW43_TEMPLATE_2 ?? "datum-nota"
const TOKEN = "4".repeat(16) + "0123456789abcdef".repeat(3)
const SECRET = "s".repeat(64)
const CHANGE = (what: string) => ({ what, why: "uji row 43 retrieval", impact: "revisi baru; revisi lama tetap" })

/** sha256 of a JSON value with sorted keys (content equality across processes). */
function canonicalSha(v: unknown): string {
  const sort = (x: unknown): unknown => (Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x as S).sort().map((k) => [k, sort((x as S)[k])])) : x)
  return createHash("sha256").update(JSON.stringify(sort(v))).digest("hex")
}
export const sha256File = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex")

// ── fake PageEngine for the row 24 bridge (same harness as test/render-pdf and test/render-port) ──────────────────
export function realPdf(n: number, wMm: number, hMm: number): Buffer {
  const w = ((wMm * 72) / 25.4).toFixed(2)
  const h = ((hMm * 72) / 25.4).toFixed(2)
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${n} >>`]
  for (let i = 0; i < n; i++) objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << >> >>`)
  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, "latin1")
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}
export function realPng(w: number, h: number, fill = 0xff): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, "latin1"), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w, fill)])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))])
}
export const sheetsOf = (html: string) => (html.match(/<section class="page[" ]/g) ?? []).length + [...html.matchAll(/<section class="(st-unit[^"]*)"/g)].filter((m) => !/\bst-flow\b/.test(m[1])).length

// ── shared host start / stop ─────────────────────────────────────────────────────────────────────────────────────

export async function startHost(cfg: Pick<PhaseConfig, "phase" | "pkg" | "storeRoot" | "work">, log: (line: string) => void) {
  const vendor = path.join(cfg.pkg, "vendor")
  const home = path.join(cfg.work, "home")
  const res = path.join(cfg.work, "Swarm.app", "Contents", "Resources")
  const project = path.join(home, "project-a")
  for (const d of [home, res, project]) mkdirSync(d, { recursive: true })
  process.env.STUDIO_WORKSPACE_ROOT = cfg.storeRoot
  process.env.STUDIO_ASSETS_ROOT = path.join(vendor, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = vendor
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  delete process.env.DATUM_RENDER_SOCKET
  delete process.env.DATUM_RENDER_TOKEN
  resetStudioEnvCache()
  resetBridgePdfReadiness()
  resetRenderRateLimiter()

  // Runner order of the desktop host (index.ts header, row 111): openHostStore -> configureTemplateSource -> start.
  const store = await openHostStore(cfg.storeRoot, { release: "1.2.0", logFile: path.join(cfg.work, "logs", `store-${cfg.phase}.jsonl`) })
  configureTemplateSource({ templatesDir: path.join(cfg.pkg, "templates"), assetRepoRoot: vendor, release: "1.2.0" })
  const host = await startStudioHostServer({
    store,
    token: TOKEN,
    hostname: "127.0.0.1",
    port: 0,
    log: () => {},
    facts: { home, resourcesPath: res, execPath: path.join(cfg.work, "Swarm.app", "Contents", "MacOS", "Swarm") },
  })
  const client = new Client({ name: `row43-${cfg.phase}`, version: "0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "claude", "x-studio-caller-cwd": encodeURIComponent(project) } },
    }),
  )
  const api = createLocalStudioApi({ baseUrl: "http://127.0.0.1:1", secret: SECRET, agentId: "claude", routes: LOCAL_ROUTES }) as unknown as {
    fetch(url: string, init?: S): Promise<{ status: number; text(): Promise<string> }>
  }
  log(`host up ${host.url} store ${cfg.storeRoot}`)

  const call = async (name: string, args: S): Promise<S> => {
    const r = await client.callTool({ name, arguments: args })
    const text = ((r.content ?? []) as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n")
    return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: text }
  }
  const local = async (method: string, route: string, body?: unknown): Promise<{ status: number; body: S }> => {
    const headers = { "x-internal-secret": SECRET, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) }
    const r = await api.fetch(`http://127.0.0.1:1${route}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: "manual" })
    const t = await r.text()
    return { status: r.status, body: t ? (JSON.parse(t) as S) : {} }
  }
  const sql = <T = S>(q: string, p: unknown[] = []): T[] => (store as unknown as { requireReader(): { all(s: string, p?: unknown[]): unknown[] } }).requireReader().all(q, p) as T[]
  const stop = async () => {
    await client.close().catch(() => undefined)
    await host.close()
    configureTemplateSource(null)
    await closeHostStore(store)
    log(`host closed; lock file present after close: ${existsSync(path.join(cfg.storeRoot, "datum-studio.lock"))}`)
  }
  return { call, local, sql, stop, url: host.url }
}

export type Host = Awaited<ReturnType<typeof startHost>>

/** Per revision: R20 content (sha of the canonical JSON) + stored snapshot sha + the paragraph texts. */
async function captureRevision(h: Host, docKey: string, documentId: string, revisionNo: number): Promise<RevRec | { docKey: string; revisionNo: number; error: string }> {
  const c = await h.call("studio_document_get", { documentId, view: "content", rev: revisionNo })
  if (c.ok === false || c._isError || c.revisionNo !== revisionNo) return { docKey, revisionNo, error: `${c.code ?? "?"} rev=${c.revisionNo ?? "-"}` }
  const p = await h.call("studio_document_get", { documentId, view: "paragraphs", rev: revisionNo })
  const snap = h.sql<{ snapshot: string }>("SELECT snapshot FROM revision WHERE document_id = ? AND revision_no = ?", [documentId, revisionNo])[0]
  return {
    docKey,
    revisionNo,
    contentSha: canonicalSha(c.content),
    snapshotSha: snap ? createHash("sha256").update(snap.snapshot).digest("hex") : "missing",
    texts: ((p.paragraphs ?? []) as Array<{ text: string }>).map((x) => x.text),
  }
}

function outputsOf(h: Host, storeRoot: string, docKey: string, revisionNo: number, outputs: S[]): OutputRec[] {
  return outputs.map((o) => {
    const row = h.sql<{ rel_path: string; sha256: string }>("SELECT rel_path, sha256 FROM output_file WHERE id = ?", [o.id])[0]
    if (row && sha256File(path.join(storeRoot, row.rel_path)) !== row.sha256) throw new Error(`output ${o.id}: disk sha differs from row`)
    return { docKey, revisionNo, format: String(o.format), id: String(o.id), sha256: String(o.sha256), relPath: row?.rel_path ?? "" }
  })
}

const realFetch = globalThis.fetch
let fetchCalls = 0

// ── phase A: write ───────────────────────────────────────────────────────────────────────────────────────────────

async function phaseA(cfg: PhaseConfig, log: (line: string) => void): Promise<S> {
  const pdfJobs: number[] = []
  const bridge = await startRenderBridge({
    fontsDir: path.join(cfg.desktop, "datum", "datum-house-style", "assets", "fonts"),
    log: () => {},
    baseDir: cfg.work,
    engine: {
      async png(job: { width: number; height: number }) {
        return realPng(Math.max(1, Math.round(job.width)), Math.max(1, Math.round(job.height)))
      },
      async pdf(job: { html: string; widthMm: number; heightMm: number }) {
        pdfJobs.push(Date.now())
        return realPdf(Math.max(1, sheetsOf(job.html)), job.widthMm, job.heightMm)
      },
      async evaluate() {
        throw new Error("layout measurement is not part of this fake")
      },
      // Same locked-down facts the row 31c harness reports (readiness checks sandbox/contextIsolation/nodeIntegration).
      info: () => {
        const raster = renderWebPreferences("raster") as S
        return { electron: "fake-row43", chrome: "fake-row43", partition: "datum-render", sandbox: raster.sandbox, contextIsolation: raster.contextIsolation, nodeIntegration: raster.nodeIntegration, javascriptContent: raster.javascript, network: "blocked" }
      },
    } as never,
  })
  const h = await startHost(cfg, log)
  // The bridge env is read at render time (services/render readiness), after the host reset its caches.
  process.env.DATUM_RENDER_SOCKET = bridge.env.DATUM_RENDER_SOCKET
  process.env.DATUM_RENDER_TOKEN = bridge.env.DATUM_RENDER_TOKEN
  resetBridgePdfReadiness()
  const steps: S = {}
  const docs: Record<string, DocRec> = {}
  const outputs: OutputRec[] = []
  const must = (label: string, r: S) => {
    steps[label] = { ok: r.ok ?? null, code: r.code ?? null, isError: r._isError, revisionNo: r.revisionNo ?? null }
    if (r.ok !== true || r._isError) throw new Error(`phase A ${label}: ${r.code ?? "?"} ${String(r._text).slice(0, 1500)}`)
    return r
  }
  const currentRev = (id: string) => Number(h.sql<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [id])[0].n)
  const completeness = async (id: string) => String(((await h.call("studio_document_get", { documentId: id, view: "summary" })).completeness as S | undefined)?.status ?? "-")
  /** Render DOCX + HTML + PDF (PDF through the row 24 bridge with the fake PageEngine); a full render needs COMPLETE, else chapter 1 (draft). */
  const render = async (docKey: string, revisionNo: number) => {
    const d = docs[docKey]
    const scope: S = d.completeAt.includes(revisionNo) ? {} : { scope: "chapter", key: "1" }
    const r = must(`render ${docKey} rev${revisionNo}`, await h.call("studio_render", { documentId: d.documentId, revisionNo, formats: ["docx", "html", "pdf"], ...scope }))
    if ((r.job as S).status !== "SUCCEEDED") throw new Error(`render ${docKey} rev${revisionNo}: ${(r.job as S).status}`)
    outputs.push(...outputsOf(h, cfg.storeRoot, docKey, revisionNo, r.outputs as S[]))
    d.rendered.push({ revisionNo, scope })
  }
  const addRevision = async (docKey: string) => {
    const d = docs[docKey]
    const n = currentRev(d.documentId)
    d.revisions.push(n)
    if ((await completeness(d.documentId)) === "COMPLETE") d.completeAt.push(n)
  }

  // Document 1: a work report through studio_write, then two studio_edit revisions.
  const w = must(
    "studio_write report",
    await h.call("studio_write", {
      mission: cfg.mission,
      docKey: "lap-retrieval",
      title: "Laporan retrieval row 43",
      sections: [
        { heading: "Ringkasan", blocks: [`Pada pekan ini ${PHRASE_1} oleh tim lapangan.`] },
        { heading: "Rincian kerja", blocks: [[["pekerjaan", "status"], ["Kalibrasi anemometer", "selesai"]]] },
        { heading: "Bukti", blocks: ["Catatan kalibrasi ada di buku log stasiun."] },
        { heading: "Isu terbuka", blocks: ["Tidak ada isu terbuka."] },
        { heading: "Langkah berikut", blocks: ["Kalibrasi berikutnya bulan depan."] },
      ],
    }),
  )
  docs["lap-retrieval"] = { documentId: String(w.documentId), revisions: [], completeAt: [], rendered: [], via: "studio_write" }
  await addRevision("lap-retrieval")
  // studio_write stores a report as several revisions (record, then one per chapter); revision 1 is the record only.
  const rev1 = await h.call("studio_render", { documentId: w.documentId, revisionNo: 1, formats: ["docx"] })
  steps.renderRevision1 = { ok: rev1.ok ?? null, code: rev1.code ?? null, revisionsWrittenByStudioWrite: currentRev(String(w.documentId)) }
  await render("lap-retrieval", docs["lap-retrieval"].revisions[0])
  must("studio_edit report append", await h.call("studio_edit", { documentId: w.documentId, edits: [{ section: "Bukti", append: ["Revisi kedua: foto segel kalibrasi dilampirkan."] }] }))
  await addRevision("lap-retrieval")
  must("studio_edit report replace", await h.call("studio_edit", { documentId: w.documentId, edits: [{ find: "Kalibrasi berikutnya bulan depan.", replace: "Kalibrasi berikutnya dijadwalkan awal Desember." }] }))
  await addRevision("lap-retrieval")
  await render("lap-retrieval", docs["lap-retrieval"].revisions[2])

  // Document 2: studio_document_create + studio_chapter_submit (body from the importer, check only), then two edits.
  const created = must("studio_document_create", await h.call("studio_document_create", { template: TEMPLATE_2, mission: cfg.mission, docKey: "nota-retrieval", title: "Catatan uji hidran row 43" }))
  const id2 = String(created.documentId)
  docs["nota-retrieval"] = { documentId: id2, revisions: [], completeAt: [], rendered: [], via: "studio_document_create + studio_chapter_submit" }
  steps.created = { revisionNo: currentRev(id2), completeness: await completeness(id2) }
  const md = `# Uji hidran\n\nPada uji bulanan ${PHRASE_2} sampai sepuluh bar.\n\nTidak ditemukan kebocoran pada sambungan.\n`
  const check = must("studio_chapter_import_markdown check", await h.call("studio_chapter_import_markdown", { documentId: id2, chapterKey: "1", markdown: md, submit: false, detail: true }))
  const body = check.submission as S
  if (!body) throw new Error(`importer check returned no submission: ${JSON.stringify({ ...check, _text: String(check._text).slice(0, 1500) }).slice(0, 4000)}`)
  const base = currentRev(id2)
  must(
    "studio_chapter_submit",
    await h.call("studio_chapter_submit", { submission: { $schema: body.$schema, agentId: body.agentId, target: { documentId: id2 }, chapter: body.chapter, ...(base > 0 ? { baseRevisionNo: base } : {}), change: CHANGE("Bab 1 ditulis") } }),
  )
  await addRevision("nota-retrieval")
  must("studio_edit doc2 replace", await h.call("studio_edit", { documentId: id2, edits: [{ find: "Tidak ditemukan kebocoran pada sambungan.", replace: "Tidak ditemukan kebocoran pada sambungan flens." }] }))
  await addRevision("nota-retrieval")
  must("studio_edit doc2 append", await h.call("studio_edit", { documentId: id2, edits: [{ after: "Tidak ditemukan kebocoran pada sambungan flens.", insert: "Revisi ketiga: tekanan dicatat tiap lima menit." }] }))
  await addRevision("nota-retrieval")
  await render("nota-retrieval", docs["nota-retrieval"].revisions[0])
  await render("nota-retrieval", docs["nota-retrieval"].revisions[2])

  const revisions: Array<RevRec | S> = []
  for (const [docKey, d] of Object.entries(docs)) for (const n of d.revisions) revisions.push(await captureRevision(h, docKey, d.documentId, n))
  const searchA = {
    p1: ((await h.call("studio_search", { q: `"${PHRASE_1}"` })).hits ?? []).map((x: S) => x.documentId),
    p2: ((await h.call("studio_search", { q: `"${PHRASE_2}"` })).hits ?? []).map((x: S) => x.documentId),
  }
  // Every stored output (explicit renders plus the HTML that studio_write / studio_edit render themselves).
  const storedOutputs = h.sql<{ id: string; format: string; sha256: string; rel_path: string; revision_no: number; doc_key: string; scope_kind: string }>(
    "SELECT o.id, o.format, o.sha256, o.rel_path, r.revision_no, d.mission_doc_key AS doc_key, o.scope_kind FROM output_file o JOIN revision r ON r.id = o.revision_id JOIN document d ON d.id = o.document_id ORDER BY o.time_created, o.id",
  ).map((o) => {
    if (sha256File(path.join(cfg.storeRoot, o.rel_path)) !== o.sha256) throw new Error(`output ${o.id}: disk sha differs from row`)
    return { docKey: o.doc_key, revisionNo: o.revision_no, format: o.format, id: o.id, sha256: o.sha256, relPath: o.rel_path }
  })
  const counts = Object.fromEntries(["document", "revision", "output_file", "render_job"].map((t) => [t, Number(h.sql<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)[0].n)]))
  await h.stop()
  await bridge.close()
  return { docs, outputs, storedOutputs, revisions, steps, searchA, counts, pdfJobs: pdfJobs.length }
}

// ── phase B: read back after the restart ─────────────────────────────────────────────────────────────────────────

async function phaseB(cfg: PhaseConfig, log: (line: string) => void): Promise<S> {
  const a = JSON.parse(readFileSync(path.join(path.dirname(cfg.out), "phaseA.json"), "utf8")) as S
  const docsA = a.docs as Record<string, DocRec>
  const h = await startHost(cfg, log)
  const out: S = { storeFiles: existsSync(cfg.storeRoot) ? readdirSync(cfg.storeRoot).sort() : [] }

  // List: R04 GET (the documents list route of LocalStudioApi) + studio_contracts_query (work reports) + summary.
  const list = await h.local("GET", "/api/studio/documents?take=100")
  const listed = ((list.body.documents ?? list.body.items ?? []) as S[]).map((d) => String(d.id ?? d.documentId))
  const contracts = await h.call("studio_contracts_query", { mission: cfg.mission })
  out.list = {
    r04Status: list.status,
    r04Ids: listed,
    contractsIds: ((contracts.contracts ?? []) as S[]).map((c) => String(c.documentId)),
    contractsCode: contracts.code ?? null,
  }
  out.summaries = {}
  for (const [docKey, d] of Object.entries(docsA)) {
    const s = await h.call("studio_document_get", { documentId: d.documentId, view: "summary" })
    out.summaries[docKey] = { ok: s.ok ?? null, code: s.code ?? null, currentRevisionNo: (s.document as S | undefined)?.currentRevisionNo ?? null, title: (s.document as S | undefined)?.title ?? null }
  }

  // Fetch every revision's content.
  out.revisions = []
  for (const [docKey, d] of Object.entries(docsA)) for (const n of d.revisions) out.revisions.push(await captureRevision(h, docKey, d.documentId, n))

  // Stored outputs: R10 through studio_file_verify with the sha phase A recorded, and the disk sha.
  out.verify = []
  for (const o of a.storedOutputs as OutputRec[]) {
    const v = await h.call("studio_file_verify", { fileId: o.id, expectedSha256: o.sha256 })
    const disk = existsSync(path.join(cfg.storeRoot, o.relPath)) ? sha256File(path.join(cfg.storeRoot, o.relPath)) : null
    out.verify.push({ id: o.id, docKey: o.docKey, revisionNo: o.revisionNo, format: o.format, ok: v.ok ?? null, code: v.code ?? null, verified: v.verified ?? null, sha256: v.sha256 ?? null, expected: o.sha256, diskSha: disk })
  }

  // Re-render the first rendered revision of each document as DOCX, with the scope phase A used (no PDF bridge in B).
  out.rerender = []
  for (const [docKey, d] of Object.entries(docsA)) {
    const first = d.rendered[0]
    const r = await h.call("studio_render", { documentId: d.documentId, revisionNo: first.revisionNo, formats: ["docx"], ...first.scope })
    // Row 154: the studio_render wrapper adds the measured HTML to a docx render (spec §6.1); compare the DOCX.
    const o = ((r.outputs ?? []) as S[]).find((x) => x.format === "DOCX")
    const row = o ? h.sql<{ rel_path: string; sha256: string; render_job_id: string }>("SELECT rel_path, sha256, render_job_id FROM output_file WHERE id = ?", [o.id])[0] : undefined
    const before = (a.outputs as OutputRec[]).find((x) => x.docKey === docKey && x.revisionNo === first.revisionNo && x.format === "DOCX")
    out.rerender.push({
      docKey,
      revisionNo: first.revisionNo,
      scope: first.scope,
      ok: r.ok ?? null,
      code: r.code ?? null,
      status: (r.job as S | undefined)?.status ?? null,
      jobId: (r.job as S | undefined)?.id ?? null,
      rowJob: row?.render_job_id ?? null,
      id: o?.id ?? null,
      sha256: o?.sha256 ?? null,
      path: row ? path.join(cfg.storeRoot, row.rel_path) : null,
      phaseA: before ? { id: before.id, sha256: before.sha256, path: path.join(String(a.storeRoot), before.relPath) } : null,
    })
  }

  // Search: a phrase from each document.
  out.search = {}
  for (const [k, phrase] of [["p1", PHRASE_1], ["p2", PHRASE_2]] as const) {
    const s = await h.call("studio_search", { q: `"${phrase}"` })
    out.search[k] = { ok: s.ok ?? null, code: s.code ?? null, ids: ((s.hits ?? []) as S[]).map((x) => String(x.documentId)), snippets: ((s.hits ?? []) as S[]).map((x) => String(x.snippet ?? "")) }
  }
  out.counts = Object.fromEntries(["document", "revision", "output_file", "render_job"].map((t) => [t, Number(h.sql<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)[0].n)]))
  // Row 154: HTML rows made by phase B's re-renders (the wrapper's added measured source), not phase A outputs.
  const jobs = (out.rerender as S[]).map((x) => x.jobId).filter((x): x is string => typeof x === "string")
  out.counts.output_file_added_html = jobs.length === 0 ? 0 : Number(h.sql<{ n: number }>(`SELECT count(*) AS n FROM output_file WHERE format = 'HTML' AND render_job_id IN (${jobs.map(() => "?").join(",")})`, jobs)[0].n)
  await h.stop()
  return out
}

// ── entry ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function runPhase(cfg: PhaseConfig): Promise<void> {
  const lines: string[] = []
  const log = (l: string) => {
    lines.push(l)
    console.log(`[row43 ${cfg.phase}] ${l}`)
  }
  globalThis.fetch = (async () => {
    fetchCalls++
    throw new Error("row43: globalThis.fetch must not be called by the host")
  }) as unknown as typeof fetch
  const runtime = { node: process.versions.node, electron: process.versions.electron ?? null, bun: (process.versions as S).bun ?? null, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, pid: process.pid }
  log(`runtime ${JSON.stringify(runtime)}`)
  mkdirSync(path.dirname(cfg.out), { recursive: true })
  try {
    const result = cfg.phase === "A" ? await phaseA(cfg, log) : await phaseB(cfg, log)
    writeFileSync(cfg.out, JSON.stringify({ phase: cfg.phase, runtime, storeRoot: cfg.storeRoot, fetchCalls, log: lines, ...result }, null, 2))
  } catch (e) {
    writeFileSync(cfg.out, JSON.stringify({ phase: cfg.phase, runtime, storeRoot: cfg.storeRoot, fetchCalls, log: lines, error: String((e as Error)?.stack ?? e) }, null, 2))
    throw e
  }
}
