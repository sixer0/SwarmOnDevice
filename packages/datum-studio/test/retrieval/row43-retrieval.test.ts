// Row 43 (decision U6: documents stay retrievable at any time from the SQLite store): retrieval after a restart.
//
// Phase A (its own process): host A on a store root, two documents with revisions and rendered outputs through the
// MCP tools, then host A and the store are closed. Phase B (a NEW process, by default Electron 42's Node through
// ELECTRON_RUN_AS_NODE=1 on a bundle of phase.ts): host B on the same root lists, fetches every revision, verifies
// every stored output by sha (R10 / studio_file_verify), re-renders the first rendered revision of each document as
// DOCX and compares the sha, and searches a phrase from each document. The assertions below run on what phase B saw.
//
// Knobs (env): ROW43_A_RUNTIME / ROW43_B_RUNTIME = bun | electron (defaults bun / electron);
// ROW43_MUTATION=fresh-root gives phase B a new empty store root (the "store is not kept" mutation: this file must
// then FAIL); ROW43_BASE (default /private/tmp/claude-501/row43); ROW43_ELECTRON (default: the repo's
// packages/desktop/node_modules/electron binary, never an installed app).
// Needs the command sandbox off (the hosts bind 127.0.0.1 ports, the bridge a Unix socket). No network, no model.
import { beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { unzipSync } from "fflate"
import { PHRASE_1, PHRASE_2 } from "./scenario.ts"

const PKG = path.resolve(import.meta.dir, "..", "..")
const DESKTOP = path.resolve(PKG, "..", "desktop")
const BASE = process.env.ROW43_BASE ?? "/private/tmp/claude-501/row43"
const RUN = `run-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${process.pid}`
const WORK = path.join(BASE, "runs", RUN)
const ROOT = path.join(BASE, "store", RUN, "datum-studio")
const MUTATION = process.env.ROW43_MUTATION ?? ""
const ROOT_B = MUTATION === "fresh-root" ? path.join(BASE, "store", `${RUN}-fresh`, "datum-studio") : ROOT
const ELECTRON = process.env.ROW43_ELECTRON ?? path.join(DESKTOP, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
const RUNTIME_A = process.env.ROW43_A_RUNTIME ?? "bun"
const RUNTIME_B = process.env.ROW43_B_RUNTIME ?? "electron"
const MISSION = "2026-11-07_row43"
const PHASE_SRC = path.join(import.meta.dir, "phase.ts")
const BUNDLE_DIR = path.join(WORK, "bundle")

type S = Record<string, any>
let A: S
let B: S
const quoted: string[] = []
const quote = (label: string, v: unknown) => {
  const line = `${label}: ${JSON.stringify(v)}`
  quoted.push(line)
  console.log(`[row43] ${line}`)
}

function runPhase(phase: "A" | "B", runtime: string, storeRoot: string): Promise<S> {
  if (ELECTRON.startsWith("/Applications/")) throw new Error("row43: never run the installed app")
  const out = path.join(WORK, `phase${phase}.json`)
  const cfg = { phase, pkg: PKG, desktop: DESKTOP, storeRoot, work: WORK, out, mission: MISSION }
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ROW43_CFG: JSON.stringify(cfg) }
  delete env.ELECTRON_RUN_AS_NODE
  const [cmd, args] = runtime === "electron" ? [ELECTRON, [path.join(BUNDLE_DIR, "phase.js")]] : [process.execPath, [PHASE_SRC]]
  if (runtime === "electron") env.ELECTRON_RUN_AS_NODE = "1"
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: PKG, env, stdio: ["ignore", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    child.stdout.on("data", (b: Buffer) => chunks.push(b))
    child.stderr.on("data", (b: Buffer) => chunks.push(b))
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000)
    child.on("error", reject)
    child.on("close", (code) => {
      clearTimeout(timer)
      writeFileSync(path.join(WORK, `phase${phase}.stdout`), Buffer.concat(chunks))
      const result = JSON.parse(readFileSync(out, "utf8")) as S
      quote(`phase ${phase} process`, { runtime: result.runtime, exit: code, storeRoot, error: result.error ? String(result.error).split("\n")[0] : null })
      resolve({ ...result, exit: code })
    })
  })
}

beforeAll(async () => {
  mkdirSync(WORK, { recursive: true })
  // The Electron run takes a bundle, as the desktop build does (electron.vite.config.ts: `#sqlite` by the `node`
  // condition -> sqlite.node.ts; `@/` -> vendor/src through the package tsconfig paths).
  const built = await Bun.build({ entrypoints: [PHASE_SRC], target: "node", format: "esm", outdir: BUNDLE_DIR })
  if (!built.success) throw new Error(`bundle failed: ${built.logs.map(String).join("\n")}`)
  const bundle = readFileSync(path.join(BUNDLE_DIR, "phase.js"), "utf8")
  quote("bundle", { bytes: bundle.length, nodeSqlite: bundle.includes('"node:sqlite"'), bunSqlite: bundle.includes('"bun:sqlite"') })
  A = await runPhase("A", RUNTIME_A, ROOT)
  if (A.exit !== 0) throw new Error(`phase A failed: ${A.error}`)
  // Keep phase A's DOCX bytes aside: a re-render with other bytes would replace the stored file (storage/files.ts).
  for (const o of A.storedOutputs as S[]) if (o.format === "DOCX") copyFileSync(path.join(ROOT, o.relPath), path.join(WORK, `phaseA-${o.id}.docx`))
  B = await runPhase("B", RUNTIME_B, ROOT_B)
  writeFileSync(path.join(WORK, "quoted.txt"), quoted.join("\n") + "\n")
}, 600_000)

describe("row 43: the restart", () => {
  test("phase A wrote two documents (2 further revisions each) with outputs, then closed host and store", () => {
    const docs = A.docs as Record<string, S>
    quote("phase A documents", Object.fromEntries(Object.entries(docs).map(([k, d]) => [k, { id: d.documentId, via: d.via, revisions: d.revisions, rendered: d.rendered.map((r: S) => r.revisionNo) }])))
    quote("phase A revision 1 of the studio_write report", A.steps.renderRevision1)
    quote("phase A counts", { ...A.counts, pdfJobsThroughBridge: A.pdfJobs, storedOutputs: (A.storedOutputs as S[]).length })
    expect(Object.keys(docs).sort()).toEqual(["lap-retrieval", "nota-retrieval"])
    for (const d of Object.values(docs)) expect(d.revisions.length).toBe(3)
    expect(A.storedOutputs.map((o: S) => o.format).sort()).toEqual(expect.arrayContaining(["DOCX", "HTML", "PDF"]))
    // Wave 165 row 165A (C188 F113-3/F113-6, pin by delta 4 -> 6): a TERBIT report whose cover HALAMAN and register
    // "DARI N" need pagination prints twice (numbered pass + final, services/render/pdf.ts); the two lap-retrieval
    // PDF renders add one bridge job each, the NOTA renders still print once.
    expect(A.pdfJobs).toBe(6)
    expect(A.log).toContain("host closed; lock file present after close: false")
    expect(A.fetchCalls).toBe(0)
  })

  test(`phase B is a new process under ${RUNTIME_B}`, () => {
    expect(B.exit).toBe(0)
    expect(B.error ?? null).toBeNull()
    expect(B.runtime.pid).not.toBe(A.runtime.pid)
    if (RUNTIME_B === "electron") {
      expect(B.runtime.electron).toBe("42.3.3")
      expect(B.runtime.runAsNode).toBe("1")
      expect(B.runtime.bun).toBeNull()
    }
    expect(B.fetchCalls).toBe(0)
  })
})

describe("row 43: retrieval in phase B", () => {
  test("list: both documents in R04 GET; the report in studio_contracts_query; summaries at the latest revision", () => {
    const docs = A.docs as Record<string, S>
    quote("phase B list", { ...B.list, summaries: B.summaries })
    expect(B.list.r04Status).toBe(200)
    expect([...B.list.r04Ids].sort()).toEqual(Object.values(docs).map((d) => d.documentId).sort())
    expect(B.list.contractsIds).toContain(docs["lap-retrieval"].documentId)
    for (const [k, d] of Object.entries(docs)) expect(B.summaries[k]).toMatchObject({ ok: true, currentRevisionNo: d.revisions.at(-1) })
  })

  test("fetch: every revision's content equals what phase A read (R20 content sha, stored snapshot sha, paragraph text)", () => {
    const a = A.revisions as S[]
    const b = B.revisions as S[]
    quote("phase B revisions", b.map((r) => ({ doc: r.docKey, rev: r.revisionNo, contentSha: r.contentSha?.slice(0, 12) ?? null, error: r.error ?? null })))
    expect(a.length).toBe(6)
    expect(a.every((r) => !r.error)).toBe(true)
    expect(b).toEqual(a)
    expect(b.flatMap((r) => r.texts ?? []).join("\n")).toContain(PHRASE_1)
    expect(b.flatMap((r) => r.texts ?? []).join("\n")).toContain("sambungan flens")
  })

  test("outputs: every stored output verifies through studio_file_verify (R10) with phase A's sha, and on disk", () => {
    const v = B.verify as S[]
    quote("phase B verify", v.map((x) => `${x.docKey} rev${x.revisionNo} ${x.format} verified=${x.verified} code=${x.code} sha=${String(x.sha256).slice(0, 12)}`))
    expect(v.length).toBe((A.storedOutputs as S[]).length)
    for (const x of v) {
      expect(x.verified).toBe(true)
      expect(x.sha256).toBe(x.expected)
      expect(x.diskSha).toBe(x.expected)
    }
  })

  test("re-render: the first rendered revision of each document, DOCX, has the sha phase A stored (K14)", () => {
    const r = B.rerender as S[]
    expect(r.length).toBe(2)
    for (const x of r) {
      expect(x.ok).toBe(true)
      expect(x.status).toBe("SUCCEEDED")
      const before = readFileSync(path.join(WORK, `phaseA-${x.phaseA.id}.docx`))
      const after = readFileSync(x.path)
      // K14: per-run fields would be here; quote the core dates of both files and every entry that differs.
      const za = unzipSync(new Uint8Array(before))
      const zb = unzipSync(new Uint8Array(after))
      const differing = [...new Set([...Object.keys(za), ...Object.keys(zb)])].filter((n) => Buffer.compare(Buffer.from(za[n] ?? []), Buffer.from(zb[n] ?? [])) !== 0)
      const core = (z: Record<string, Uint8Array>) => (Buffer.from(z["docProps/core.xml"] ?? []).toString("utf8").match(/<dcterms:(created|modified)[^>]*>[^<]*/g) ?? []).map((m) => m.replace(/<dcterms:(\w+)[^>]*>/, "$1="))
      quote(`re-render ${x.docKey} rev${x.revisionNo}`, { scope: x.scope, jobId: x.jobId, rowJob: x.rowJob, phaseA: x.phaseA.sha256, phaseB: x.sha256, equal: x.sha256 === x.phaseA.sha256, entries: Object.keys(zb).length, differing, coreA: core(za), coreB: core(zb) })
      expect(differing).toEqual([])
      expect(x.sha256).toBe(x.phaseA.sha256)
      // The bytes were rendered again (not served from the old row): the output row now points at phase B's job.
      expect(x.rowJob).toBe(x.jobId)
    }
  })

  test("search: studio_search finds a phrase from each document", () => {
    const docs = A.docs as Record<string, S>
    quote("phase B search", B.search)
    expect(B.search.p1.ids).toEqual([docs["lap-retrieval"].documentId])
    expect(B.search.p2.ids).toEqual([docs["nota-retrieval"].documentId])
    expect(B.search.p1.snippets[0]).toContain(`[[${PHRASE_1}]]`)
    expect(B.search.p2.snippets[0]).toContain(`[[${PHRASE_2}]]`)
  })

  test("store rows after the restart: documents, revisions and outputs as phase A left them", () => {
    quote("phase B counts", { a: A.counts, b: B.counts, mutation: MUTATION || null })
    expect(B.counts.document).toBe(A.counts.document)
    expect(B.counts.revision).toBe(A.counts.revision)
    // Row 154: phase B's docx re-renders also store the HTML the studio_render wrapper adds (spec §6.1); phase A rows are unchanged.
    expect(B.counts.output_file - (B.counts.output_file_added_html ?? 0)).toBe(A.counts.output_file)
  })
})
