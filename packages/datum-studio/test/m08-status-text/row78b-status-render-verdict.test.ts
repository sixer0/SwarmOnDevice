// Swarm 1.2.6 row 78b (decision C16): after a studio_render timeout the agent reads studio_document_status, so the
// status text must carry the stored U24 page verdict of every output (row 149 output_verification record, written by
// studio_render's wrapper): RENDER_VERIFIED(U24) / RENDER_UNVERIFIED(U24) fail=… unknown=… with the OVERLAP_CLIP
// coverage line, and RENDER_VERIFY_PENDING when no record is stored. Within the row 78 cap (8192 bytes).
// Before (HEAD 8a06f12c57): the status output line ended at the sha and the file name; R05 had no verification field.
// Part 1: MCP harness with a stubbed R05 body (vendor doc-tools.ts). Part 2: REAL host server over a temp store
// (local R05 route reads output_verification); needs the command sandbox off (ephemeral port).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import path from "node:path"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { connect, reply } from "../ported/mcp/mcp-harness"

const MAX = 8192 // DOCUMENT_STATUS_TEXT_MAX_BYTES (register N-042)
const PENDING = "RENDER_VERIFY_PENDING" // literal so the red run fails on assertions
const DOC = "cmvdoc00000000000000078b0"
const hex = (i: number) => (i.toString(16).padStart(2, "0") + "0123456789abcdef".repeat(4)).slice(0, 64)
const cuid = (i: number) => `cmvout${String(i).padStart(19, "0")}`

function output(i: number, renderVerification?: unknown) {
  return {
    id: cuid(i),
    format: i % 2 === 0 ? "PDF" : "HTML",
    role: "PRIMARY",
    scope: { kind: "DOCUMENT" },
    draft: false,
    lintVerdict: "PASS",
    finalFileName: `Laporan 078b-GSP RevA rev3.${i % 2 === 0 ? "pdf" : "html"}`,
    sha256: hex(i),
    ...(renderVerification === undefined ? {} : { renderVerification }),
  }
}

async function status(outs: unknown[]) {
  const body = {
    document: { id: DOC, docNumber: "078b/GSP/KT/XI/2026", title: "Laporan 78b", currentRevisionNo: 3, releaseStatus: "PENDING" },
    revision: { revisionNo: 3 },
    completeness: { status: "COMPLETE" },
    outputs: outs,
    lint: { tier: "NOTA", releaseStatus: "PASS", checks: [{ checkId: "D01", status: "PASS", detail: "ok" }] },
  }
  const f = async (url: string) =>
    reply(
      new URL(url).pathname.endsWith("/completeness")
        ? { status: 200, body: { documentId: DOC, completeness: { status: "COMPLETE", revisionNo: 3, fullRenderAllowed: true, slots: [], missingRequired: [], nextSteps: [] } } }
        : { status: 200, body },
    )
  const { call } = await connect({ fetch: f as never, env: { STUDIO_AGENT_ID: "cod-078b" } })
  return call("studio_document_status", { documentId: DOC })
}

const unverified = {
  state: "unverified",
  reason: "CHECK_FAILED",
  fail: ["LINT", "OVERLAP_CLIP"],
  unknown: ["FONT_EMBED:SOURCE_MISSING"],
  overlapClip: { status: "FAIL", reason: null, measuredPages: 40, totalPages: 60 },
  attempt: 1,
}

describe("row 78b: studio_document_status prints the stored U24 page verdict per output", () => {
  test("stored UNVERIFIED verdict (fail=, unknown=, OVERLAP_CLIP coverage) on the output line; VERIFIED; pending", async () => {
    const outs = [output(0, unverified), output(1, { state: "verified", reason: null, fail: [], unknown: [], overlapClip: null, attempt: 2 }), output(2, { state: "pending", reason: "NOT_CHECKED", fail: [], unknown: [], overlapClip: null, attempt: null })]
    const r = await status(outs)
    console.log(`[row78b] text:\n${r.text}`)
    expect(r.text).toContain(`${cuid(0)} PDF DOCUMENT lint PASS sha256 ${hex(0)} RENDER_UNVERIFIED(U24) fail=LINT,OVERLAP_CLIP unknown=FONT_EMBED:SOURCE_MISSING Laporan`)
    expect(r.text).toContain(`sha256 ${hex(0)} RENDER_UNVERIFIED(U24) fail=LINT,OVERLAP_CLIP unknown=FONT_EMBED:SOURCE_MISSING Laporan 078b-GSP RevA rev3.pdf\n    OVERLAP_CLIP FAIL diukur 40/60 halaman`)
    expect(r.text).toContain(`${cuid(1)} HTML DOCUMENT lint PASS sha256 ${hex(1)} RENDER_VERIFIED(U24) Laporan`)
    expect(r.text).toContain(`${cuid(2)} PDF DOCUMENT lint PASS sha256 ${hex(2)} ${PENDING} Laporan`)
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(MAX)
  })

  test("no renderVerification field (older or remote server) -> pending; STALE record named", async () => {
    const r = await status([output(0), output(1, { ...unverified, reason: "STALE", fail: [], unknown: [], overlapClip: null })])
    expect(r.text).toContain(`sha256 ${hex(0)} ${PENDING} Laporan`)
    expect(r.text).toContain(`sha256 ${hex(1)} RENDER_UNVERIFIED(U24) STALE fail=- unknown=- Laporan`)
  })

  test("50 outputs with verdict and coverage lines stay within 8192 bytes; every listed line carries a verdict", async () => {
    const outs = Array.from({ length: 50 }, (_, i) => output(i, unverified))
    const r = await status(outs)
    const bytes = Buffer.byteLength(r.text, "utf8")
    console.log(`[row78b] 50 outputs: ${bytes} bytes`)
    expect(bytes).toBeLessThanOrEqual(MAX)
    const lines = r.text.split("\n").filter((l: string) => l.includes(" sha256 "))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).toMatch(/sha256 [0-9a-f]{64} RENDER_UNVERIFIED\(U24\) fail=/)
    expect(r.text).toMatch(/\+\d+ berkas lain; detail=true/)
  })
})

// ── Part 2: real host, local R05 route over the store ───────────────────────────────────────────────────────────
const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW78B_TEST_DIR ?? "/private/tmp/claude-501/row78b/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row78b-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-78b")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })
const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const M = "2026-11-12_m78b-status"

type Mod = typeof import("../../src/mcp-host/index.ts")
type S = Record<string, any>
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: import("@modelcontextprotocol/sdk/client/index.js").Client
const realFetch = globalThis.fetch
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => {
  if (level === "error") console.log(`[row78b] host error ${source}: ${message} ${JSON.stringify(context ?? {}).slice(0, 300)}`)
}

async function resetEnvCache() {
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetRenderRateLimiter()
}

async function callFull(name: string, args: Record<string, unknown>): Promise<{ sc: S; text: string }> {
  const r = await c.callTool({ name, arguments: args })
  const text = ((r.content ?? []) as Array<{ type: string; text?: string }>).filter((x) => x.type === "text").map((x) => x.text ?? "").join("\n")
  return { sc: (r.structuredContent ?? {}) as S, text }
}

describe("row 78b: real host — status shows the verdict studio_render stored", () => {
  beforeAll(async () => {
    process.env.STUDIO_WORKSPACE_ROOT = STORE
    process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
    process.env.STUDIO_VENDOR_ROOT = VENDOR
    delete process.env.STUDIO_MCP_FILE_ROOTS
    delete process.env.INTERNAL_API_SECRET
    globalThis.fetch = (async () => {
      throw new Error("row78b test: globalThis.fetch must not be called by the host")
    }) as unknown as typeof fetch
    mod = (await import("../../src/mcp-host/index.ts")) as Mod
    await resetEnvCache()
    store = await mod.openHostStore(STORE, { release: "1.2.6", logFile: LOG, missionGuard: true })
    mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.6" })
    host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
    c = new Client({ name: "row78b-test", version: "0" })
    await c.connect(
      new StreamableHTTPClientTransport(new URL(host.url), {
        fetch: realFetch as never,
        requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
      }),
    )
    const row = { id: "1", phase: "implementation", kind: "implementation", title: "Row 1", agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: "implementation/1.md", verification: "tests pass", review: "gate" }
    const cr = await callFull("studio_mission_create", { mission: { id: M, title: "Row 78b mission", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row], decisions: [{ id: "U1", by: "user", date: "2026-11-12", text: "go" }] } })
    expect(cr.sc.ok).toBe(true)
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

  test("render html: the status output line carries the same per-output verdict the render result printed; a new output without a record is pending", async () => {
    const d = await callFull("studio_document_create", { template: "datum-nota", mission: M, docKey: "row-1-kajian", title: "Kajian row 78b" })
    expect(d.sc.ok).toBe(true)
    const id = String(d.sc.documentId)
    expect((await callFull("studio_chapter_import_markdown", { documentId: id, chapterKey: "1", markdown: "# Uji\n\nPengukuran titik uji dicatat tiap bulan.\n", submit: true, baseRevisionNo: 1 })).sc.ok).toBe(true)
    const set = await store.revisionVerification(id, "latest")
    const r = await callFull("studio_render", { documentId: id, revisionNo: set.revisionNo, formats: ["html"] })
    expect(r.sc.ok).toBe(true)
    // the render result's per-output verdict lines (row 77 labels)
    const renderLines = r.text.split("\n").filter((l) => /^ {2}\S+ \S+ RENDER_(UN)?VERIFIED\(U24\)/.test(l))
    console.log(`[row78b] render lines:\n${renderLines.join("\n")}`)
    expect(renderLines.length).toBeGreaterThan(0)

    const st = await callFull("studio_document_status", { documentId: id })
    console.log(`[row78b] status text:\n${st.text}`)
    for (const l of renderLines) {
      // 1.2.7 row 35d (INTENT, AC-M03/N7-065): render lines end with ` sha256=<64 hex>`; the verdict is what precedes it
      const [, outId, verdict] = /^ {2}\S+ (\S+) (.+?)(?: sha256=[0-9a-f]{64})?$/.exec(l)!
      const line = st.text.split("\n").find((x) => x.startsWith(`berkas ${outId} `))
      expect(line).toBeDefined()
      expect(line!).toContain(` ${verdict} `)
    }
    // the OVERLAP_CLIP coverage lines of the render result appear the same in the status text
    for (const cov of r.text.split("\n").filter((x) => /^ {4}OVERLAP_CLIP /.test(x))) expect(st.text).toContain(`\n${cov}\n`)
    expect(Buffer.byteLength(st.text, "utf8")).toBeLessThanOrEqual(MAX)

    // stored UNVERIFIED record with a FAIL check and an OVERLAP_CLIP coverage -> shown on the status line
    const html = (await store.revisionVerification(id, "latest")).outputs.find((o) => o.format === "HTML")!
    await store.transaction((tx) =>
      store.putOutputVerification(tx, {
        outputFileId: html.outputId,
        outputSha256: html.sha256,
        state: "unverified",
        checksVersion: 1,
        failCount: 1,
        unknownCount: 1,
        report: { state: "unverified", checks: [{ id: "OVERLAP_CLIP", status: "FAIL", coverage: { measuredPages: 2, totalPages: 3 } }, { id: "FONT_EMBED", status: "UNKNOWN", reason: "SOURCE_MISSING" }, { id: "LINT", status: "PASS" }] },
        verifiedBy: "row78b-test",
      }),
    )
    const st2 = await callFull("studio_document_status", { documentId: id })
    expect(st2.text).toContain(`berkas ${html.outputId} HTML DOCUMENT`)
    expect(st2.text).toContain(`sha256 ${html.sha256} RENDER_UNVERIFIED(U24) fail=OVERLAP_CLIP unknown=FONT_EMBED:SOURCE_MISSING `)
    expect(st2.text).toContain("\n    OVERLAP_CLIP FAIL diukur 2/3 halaman")

    // an output row without a verification record (render finished after the timeout, wrapper never ran) -> pending
    const extra = `row78b-pending-${html.outputId.slice(-6)}`
    await store.transaction(async (tx) => {
      tx.run(
        `INSERT INTO output_file (id, kind, document_id, revision_id, template_version_id, render_job_id, format, role, figure_label, rel_path, file_name, bytes, sha256, mime, lint_verdict, scope_kind, scope_key, draft, time_created)
         SELECT ?, kind, document_id, revision_id, template_version_id, render_job_id, format, role, figure_label, rel_path || '.p', file_name, bytes, ?, mime, lint_verdict, scope_kind, scope_key, draft, time_created + 1000
           FROM output_file WHERE id = ?`,
        [extra, "c".repeat(64), html.outputId],
      )
    })
    const st3 = await callFull("studio_document_status", { documentId: id })
    const pendingLine = st3.text.split("\n").find((x) => x.startsWith(`berkas ${extra} `))
    expect(pendingLine).toBeDefined()
    expect(pendingLine!).toContain(`sha256 ${"c".repeat(64)} ${PENDING} `)
  }, 120_000)
})

describe("row 78b: STUDIO-AGENT-GUIDE §8.3 timeout procedure", () => {
  test("status shows the page verdict (incl. RENDER_VERIFY_PENDING); then file_verify for the sha", async () => {
    const { readFileSync } = await import("node:fs")
    const guide = readFileSync(path.join(VENDOR, "docs", "STUDIO-AGENT-GUIDE.md"), "utf8")
    const s = guide.slice(guide.indexOf("### 8.3 "), guide.indexOf("### 8.4 "))
    const flat = s.replace(/\s+/g, " ")
    const doc = await import("../../vendor/scripts/studio/mcp/doc-tools")
    expect((doc as Record<string, unknown>).RENDER_VERIFY_PENDING).toBe(PENDING)
    expect(flat).toContain("Tiap baris berkas memuat vonis halaman yang tersimpan: `RENDER_VERIFIED(U24)` atau `RENDER_UNVERIFIED(U24) fail=… unknown=…`")
    expect(flat).toContain(`\`${PENDING}\` bila belum ada vonis tersimpan`)
    expect(flat).toContain("Status menunjukkan vonis halaman (U24); `studio_file_verify` memberi `FILE_VERIFIED(sha256)` untuk sha berkas")
    expect(flat).not.toContain("hanya dicetak di hasil `studio_render`")
  })
})
