// @ts-nocheck rel129-a12a: mcp-harness is a vitest-typed ported helper run under bun:test (same as rel128-probe-ht17).
// Swarm 1.2.9 row 37 (AC-A12a, N9-113; N9-061 backupResidue/backupRemoved, N9-062 pngBackupResidue/pngBackupRemoved
// shipped as separate counters per C12 D-5; N9-063 texts). studio_figure_preview wrote its SVG/PNG through
// writeFileGuarded (vendor/scripts/studio/mcp/safety.ts) but dropped the residue and retention counters that
// studio_report_refresh and studio_file_verify already return, and the agent texts (recipe resource and server
// instructions) did not name the `.bak/` folder. This test overwrites one stand-alone figure (SVG + PNG) on the REAL
// filesystem and checks: the four counters equal what writeFileGuarded did (per file, the two files rotate their 5
// backups independently), the result text names `.bak/` with the counters, MCP_RECIPE and instructionsFor name
// `.bak/`, and the vendor default tools/list did not grow (budget <= 29,997 B; A12a adds 0 B to tools/list).
// Red at d4282fcfd8: counters absent from the result; texts lack `.bak/`.
// Synthetic inputs only (syn129 style: filler written here; no fixture, no workspace content).
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { connect, reply } from "../ported/mcp/mcp-harness"
import * as safety from "../../vendor/scripts/studio/mcp/safety"
import { MCP_RECIPE } from "../../vendor/scripts/studio/mcp/resources"
import { instructionsFor } from "../../vendor/scripts/studio/mcp/server"

const KEEP = 5
const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

function tmpRoot(tag: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `r129-a12a-${tag}-`)))
  tmpDirs.push(d)
  return d
}

/** Backups of `name` now in `<dir>/.bak/`. */
const bakCount = (dir: string, name: string) => {
  const bak = path.join(dir, safety.BACKUP_DIR_NAME)
  if (!fs.existsSync(bak)) return 0
  return fs.readdirSync(bak).filter((n) => n.startsWith(`${name}.bak-`)).length
}

const FDOC = "cmvdoc0000000000000syn129a"
const PID = "fig-syn129-a12a"
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="2"/></svg>'
// 1x1 transparent PNG (synthetic bytes).
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const SVG_NAME = "Gambar 1.1 Uji syn129.svg"
const PNG_NAME = "Gambar 1.1 Uji syn129.png"
const figure = (standalone: boolean) => ({
  type: "chart",
  code: "P-01",
  pid: PID,
  address: "1.1.1",
  label: "Gambar 1.1",
  inline: false,
  size: { widthMm: 160, heightMm: 60, svgBytes: SVG.length },
  issues: [],
  issueCount: 0,
  layoutIssueCount: 0,
  svg: SVG,
  ...(standalone ? { png: PNG_B64, standalone: { fileName: { svg: SVG_NAME, png: PNG_NAME } } } : {}),
})
const server = (standalone: boolean) => async (url: string, init: { method: string }) =>
  init.method === "POST" && new URL(url).pathname === `/api/studio/documents/${FDOC}/figures/preview`
    ? reply({ status: 200, body: { documentId: FDOC, revisionNo: 3, currentRevisionNo: 3, rendered: true, figure: figure(standalone) } })
    : reply({ status: 404, body: { code: "ROUTE_NOT_FOUND" } })

describe("rel129 A12a: studio_figure_preview reports backup counters (row 37, N9-113)", () => {
  it("stand-alone SVG + PNG overwritten 7 times: separate SVG and PNG counters equal the .bak/ state; text names .bak/", async () => {
    const root = tmpRoot("sa")
    const dir = path.join(root, "figur")
    fs.mkdirSync(dir)
    const { call } = await connect({ fetch: server(true), nfs: safety.REAL_NODE_FS, config: { fileRoots: [root], fileWriteEnabled: true }, env: { STUDIO_AGENT_ID: "cod-syn129" } })
    const first = await call("studio_figure_preview", { documentId: FDOC, pid: PID, standalone: true, png: true, downloadDir: dir })
    expect(first.isError).toBeFalsy()
    expect(first.data.backup).toBeNull()
    expect(first.data.backupResidue).toBe(0)
    expect(first.data.backupRemoved).toBe(0)
    expect(first.data.pngBackupResidue).toBe(0)
    expect(first.data.pngBackupRemoved).toBe(0)
    const got = { residue: [], removed: [], pngResidue: [], pngRemoved: [] }
    // The SVG is overwritten 7 times, the PNG only on the first 3 runs (then left identical): the two counters must
    // differ, which a summed or shared counter could not show.
    for (let i = 1; i <= 7; i++) {
      fs.writeFileSync(path.join(dir, SVG_NAME), `isi lama svg ${i}\n`)
      if (i <= 3) fs.writeFileSync(path.join(dir, PNG_NAME), `isi lama png ${i}\n`)
      const r = await call("studio_figure_preview", { documentId: FDOC, pid: PID, standalone: true, png: true, downloadDir: dir, overwrite: true })
      expect(r.isError).toBeFalsy()
      expect(path.dirname(r.data.backup)).toBe(path.join(dir, ".bak"))
      // Counters equal what writeFileGuarded left in <dir>/.bak/ for each file.
      expect(r.data.backupResidue).toBe(bakCount(dir, SVG_NAME))
      expect(r.data.pngBackupResidue).toBe(bakCount(dir, PNG_NAME))
      got.residue.push(r.data.backupResidue)
      got.removed.push(r.data.backupRemoved)
      got.pngResidue.push(r.data.pngBackupResidue)
      got.pngRemoved.push(r.data.pngBackupRemoved)
      expect(r.text).toContain(`(backupResidue ${r.data.backupResidue} di .bak/`)
      if (i <= 3) expect(r.text).toContain(`(backupResidue ${r.data.pngBackupResidue} di .bak/`)
      if (r.data.backupRemoved > 0) expect(r.text).toContain(`; backupRemoved ${r.data.backupRemoved})`)
    }
    expect(got.residue).toEqual([1, 2, 3, 4, 5, 5, 5])
    expect(got.removed).toEqual([0, 0, 0, 0, 0, 1, 1])
    expect(got.pngResidue).toEqual([1, 2, 3, 3, 3, 3, 3])
    expect(got.pngRemoved).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(bakCount(dir, SVG_NAME)).toBe(KEEP)
  })

  it("plain SVG download (no standalone) carries backupResidue / backupRemoved and the .bak/ line outside any block", async () => {
    const root = tmpRoot("svg")
    const dir = path.join(root, "figur")
    fs.mkdirSync(dir)
    const name = `${FDOC}-${PID}-rev3.svg`
    const { call } = await connect({ fetch: server(false), nfs: safety.REAL_NODE_FS, config: { fileRoots: [root], fileWriteEnabled: true }, env: { STUDIO_AGENT_ID: "cod-syn129" } })
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(dir, name), `isi lama ${i}\n`)
      const r = await call("studio_figure_preview", { documentId: FDOC, pid: PID, downloadDir: dir, overwrite: true })
      expect(r.isError).toBeFalsy()
      expect(r.data.backupResidue).toBe(i)
      expect(r.data.backupRemoved).toBe(0)
      expect(r.data.pngBackupResidue).toBeUndefined()
      expect(r.text).toContain(`  SVG disimpan ke: ${path.join(dir, name)}`)
      expect(r.text).toContain(`(backupResidue ${i} di .bak/)`)
    }
  })

  it("agent texts name the .bak/ folder: MCP_RECIPE resource and the server instructions", () => {
    expect(MCP_RECIPE).toContain("cadangan `.bak/<nama>.bak-<waktu>`")
    expect(instructionsFor(["reports", "documents", "query"])).toContain("(cadangan di .bak/)")
  })

  it("vendor default tools/list (reports,documents,query) not above 29,997 B: A12a adds 0 B to tools/list", async () => {
    const all = await connect({ env: { STUDIO_MCP_TOOLSETS: "reports,documents,query" } })
    const bytes = Buffer.byteLength(JSON.stringify(await all.client.listTools()))
    console.log(`rel129-a12a vendor tools/list: ${bytes} B`)
    expect(bytes).toBeLessThanOrEqual(29_997)
  })
})
