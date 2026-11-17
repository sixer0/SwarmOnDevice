// Swarm 1.3.3 row 77 (controller routing of row 69's request, MC-8 item 2): the two `downloadDir` call sites
// (studio_file_verify in tools.ts, studio_figure_preview in figure-tools.ts) pass the project folder of the mission
// that owns the file or document to row 69's safety rule. With project context a relative path lands inside the
// project; without it the relative path is refused before any network call and nothing is created.
// Real file system under $TMPDIR; HTTP is a stub (no port). The host resolver is checked against a stub store.
import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { downloadProjectDirOf } from "../../src/mcp-host/download-project-dir.ts"
import { loadConfig } from "../../vendor/scripts/studio/mcp/config"
import { REAL_NODE_FS } from "../../vendor/scripts/studio/mcp/safety"
import { executeTool } from "../../vendor/scripts/studio/mcp/tools"

type S = Record<string, any>
const BASE = realpathSync(mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "row77-dl-")))
afterAll(() => rmSync(BASE, { recursive: true, force: true }))

const FILE_ID = "cmvvfile0000000000000r3f2a"
const DOC = "cmvdoc0000000000000fig03b"
const PID = "fig-chart-1"
const FINAL = "001-GSP-KT-XI-2026_rev1_20261102T000000Z_abcdef01.docx"
const BYTES = Buffer.from("isi berkas uji row 77")
const SHA = createHash("sha256").update(BYTES).digest("hex")
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'

function world(name: string) {
  const root = path.join(BASE, name, "sesi")
  const project = path.join(root, "proyek")
  mkdirSync(project, { recursive: true })
  return { root, project }
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}, bytes?: Buffer): Response {
  return new Response(bytes ? new Uint8Array(bytes) : body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": bytes ? "application/octet-stream" : "application/json", "x-correlation-id": "cid-row77", ...headers } })
}

function run(tool: string, args: S, w: { root: string }, projectDirOf?: (ref: S) => string | null) {
  const calls: string[] = []
  const seen: S[] = []
  const fetchImpl = async (url: string, init: S) => {
    const p = new URL(url).pathname
    calls.push(`${init.method} ${p}`)
    if (p === `/api/studio/files/${FILE_ID}`) {
      const h = { "x-studio-final-filename": FINAL, "x-studio-sha256-verified": "true", "x-studio-sha256": SHA }
      return init.method === "HEAD" ? reply(200, undefined, h) : reply(200, undefined, h, BYTES)
    }
    if (p === `/api/studio/documents/${DOC}/figures/preview`) return reply(200, { documentId: DOC, revisionNo: 3, currentRevisionNo: 3, rendered: true, figure: { type: "chart", code: "P-02", pid: PID, label: "Gambar 1.1", svg: SVG, issues: [], issueCount: 0 } })
    return reply(404, { error: "tidak ada", code: "ROUTE_NOT_FOUND" })
  }
  const config = loadConfig({ INTERNAL_API_SECRET: "rahasia-uji-row77-JANGAN-TERCETAK", STUDIO_BASE_URL: "http://127.0.0.1:9021", STUDIO_MCP_FILE_ROOTS: w.root }, w.root)
  const deps: S = { config, fetchImpl, nfs: REAL_NODE_FS, ...(projectDirOf ? { projectDirOf: (ref: S) => (seen.push(ref), projectDirOf(ref)) } : {}) }
  return executeTool(tool, args, deps as never).then((r) => ({ r: r as S, calls, seen }))
}

describe("row 77: studio_file_verify passes the mission's project folder to the downloadDir rule", () => {
  test("relative downloadDir with project context: the file lands inside the project", async () => {
    const w = world("verify-in")
    const { r, seen } = await run("studio_file_verify", { fileId: FILE_ID, downloadDir: "keluaran/rev-1" }, w, () => w.project)
    expect(r.ok).toBe(true)
    expect(seen).toEqual([{ fileId: FILE_ID }])
    const dir = path.join(w.project, "keluaran", "rev-1")
    expect(readdirSync(dir)).toEqual([FINAL])
    expect(readFileSync(path.join(dir, FINAL)).equals(BYTES)).toBe(true)
    expect(existsSync(path.join(w.root, "keluaran"))).toBe(false)
  })

  test("relative downloadDir without project context: refused before the network, nothing created", async () => {
    const w = world("verify-none")
    for (const of of [undefined, () => null]) {
      const { r, calls } = await run("studio_file_verify", { fileId: FILE_ID, downloadDir: "keluaran" }, w, of)
      expect(r.ok).toBe(false)
      expect(r.data.error.code).toBe("PATH_INVALID")
      expect(r.data.error.message).toContain("folder proyek")
      expect(calls).toEqual([])
    }
    expect(readdirSync(w.root)).toEqual(["proyek"])
    expect(readdirSync(w.project)).toEqual([])
  })

  test("an absolute downloadDir never asks for the project folder (pre-1.3.3 rule unchanged)", async () => {
    const w = world("verify-abs")
    const { r, seen } = await run("studio_file_verify", { fileId: FILE_ID, downloadDir: path.join(w.root, "unduhan") }, w, () => w.project)
    expect(r.ok).toBe(true)
    expect(seen).toEqual([])
    expect(readdirSync(path.join(w.root, "unduhan"))).toEqual([FINAL])
  })

  test("a project folder outside the session folder is refused, nothing created", async () => {
    const w = world("verify-out")
    const outside = path.join(BASE, "verify-out", "luar")
    mkdirSync(outside, { recursive: true })
    const { r, calls } = await run("studio_file_verify", { fileId: FILE_ID, downloadDir: "keluaran" }, w, () => outside)
    expect(r.data.error.code).toBe("PATH_OUTSIDE_ROOTS")
    expect(calls).toEqual([])
    expect(readdirSync(outside)).toEqual([])
  })
})

describe("row 77: studio_figure_preview passes the mission's project folder to the downloadDir rule", () => {
  test("relative downloadDir with project context: the SVG lands inside the project", async () => {
    const w = world("preview-in")
    const { r, seen } = await run("studio_figure_preview", { documentId: DOC, pid: PID, downloadDir: "figur" }, w, () => w.project)
    expect(r.ok).toBe(true)
    expect(seen).toEqual([{ documentId: DOC }])
    const dir = path.join(w.project, "figur")
    expect(r.data.savedTo).toBe(path.join(dir, `${DOC}-${PID}-rev3.svg`))
    expect(readFileSync(r.data.savedTo, "utf8")).toBe(SVG)
    expect(existsSync(path.join(w.root, "figur"))).toBe(false)
  })

  test("relative downloadDir without project context: refused before the network, nothing created", async () => {
    const w = world("preview-none")
    for (const of of [undefined, () => null]) {
      const { r, calls } = await run("studio_figure_preview", { documentId: DOC, pid: PID, downloadDir: "figur" }, w, of)
      expect(r.ok).toBe(false)
      expect(r.data.error.code).toBe("PATH_INVALID")
      expect(r.data.error.message).toContain("folder proyek")
      expect(calls).toEqual([])
    }
    expect(readdirSync(w.root)).toEqual(["proyek"])
    expect(readdirSync(w.project)).toEqual([])
  })
})

describe("row 77: host resolver (document or rendered file -> mission.project_dir)", () => {
  const rows: Record<string, S> = {
    "output_file:f1": { document_id: "d1" },
    "output_file:f2": { document_id: null },
    "document:d1": { mission_folder: "2026-11-17_m" },
    "document:d2": { mission_folder: null },
    "document:d3": { mission_folder: "2026-11-17_hilang" },
    "mission:2026-11-17_m": { project_dir: "/proyek/satu" },
  }
  const store = {
    transaction: async <T>(fn: (tx: any) => Promise<T>) =>
      fn({ get: (sql: string, p: unknown[]) => rows[`${/FROM (\w+)/.exec(sql)?.[1]}:${String(p[0])}`] }),
  }
  const of = downloadProjectDirOf(store as never)

  test("a document of a mission and a file of that document give the mission's project folder", async () => {
    expect(await of({ documentId: "d1" })).toBe("/proyek/satu")
    expect(await of({ fileId: "f1" })).toBe("/proyek/satu")
  })

  test("no mission, unknown id, a file without a document, an empty reference or a store error give null", async () => {
    for (const ref of [{ documentId: "d2" }, { documentId: "d3" }, { documentId: "tidak-ada" }, { fileId: "f2" }, { fileId: "tidak-ada" }, {}]) expect(await of(ref)).toBeNull()
    const broken = downloadProjectDirOf({ transaction: async () => Promise.reject(new Error("store closed")) } as never)
    expect(await broken({ documentId: "d1" })).toBeNull()
  })
})
