// @ts-nocheck rel128-probe-ht17: mcp-harness is a vitest-typed ported helper run under bun:test (same as row70); checked at run time.
// Swarm 1.2.8 row 36b (AC-HT17, H-T17 PROBE; register N8-384 rel128-probe-<id>; N-055 BACKUP_DIR_NAME, N-056 BACKUP_KEEP,
// N-057 backupResidue). The 1.2.7 audit measured T-17 on one surface only (mission export) and did not test retention
// or the refresh / file_verify paths. This probe enumerates every tool that reaches the guarded write
// (vendor/scripts/studio/mcp/safety.ts writeFileGuarded, result field backupResidue) and checks each one on the REAL
// filesystem (mkdtemp roots, REAL_NODE_FS, as the host wires it: src/mcp-host/mcp-server.ts:83):
//   S1 studio_report_refresh  outPath + overwrite     vendor/scripts/studio/mcp/tools.ts:605
//   S2 studio_file_verify     downloadDir + overwrite vendor/scripts/studio/mcp/tools.ts:991
//   S3 studio_mission_export  write + overwrite       src/mcp-host/mission/mission-tools.ts:574
//   S4 studio_figure_preview  downloadDir + overwrite vendor/scripts/studio/mcp/figure-tools.ts:214 (third surface, declared by row 36b)
// Per surface: after 1 fresh write and 7 overwrites only the 5 newest backups stay in <dir>/.bak/ (the 6th removes the
// oldest), the kept ones are the newest by content, nothing named *.bak-* sits beside the target, and the paths that
// must not write (refresh without outPath, verify without downloadDir, identical re-download) leave .bak/ unchanged.
// Synthetic inputs only (filler text written here; no fixture, no workspace content).
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { connect, logs, reply } from "../ported/mcp/mcp-harness"
import { DOC, MD, statefulServer } from "../ported/draft/r3-stateful-harness"
import * as safety from "../../vendor/scripts/studio/mcp/safety"
import { safeFinalName } from "../../vendor/scripts/studio/studio-report"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

const STAMP = /\.bak-\d{8}T\d{6}Z(-\d+)?$/
const KEEP = 5
const tmpDirs: string[] = []

beforeEach(() => {
  logs.length = 0
})
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

function tmpRoot(tag: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `r128-ht17-${tag}-`)))
  tmpDirs.push(d)
  return d
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")

/** Backups of `name` in `<dir>/.bak/`, in creation order (stamp, then numeric -n; no suffix = 1). */
function backupsOf(dir: string, name: string): string[] {
  const bak = path.join(dir, safety.BACKUP_DIR_NAME)
  if (!fs.existsSync(bak)) return []
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`^${esc}\\.bak-(\\d{8}T\\d{6}Z)(?:-(\\d+))?$`)
  return fs
    .readdirSync(bak)
    .map((n) => ({ n, m: re.exec(n) }))
    .filter((x) => x.m !== null)
    .sort((a, b) => (a.m![1] < b.m![1] ? -1 : a.m![1] > b.m![1] ? 1 : Number(a.m![2] ?? 1) - Number(b.m![2] ?? 1)))
    .map((x) => fs.readFileSync(path.join(bak, x.n), "utf8"))
}

/** Entries beside the target that look like a backup (the pre-1.2.6 residue). */
const siblingResidue = (dir: string) => fs.readdirSync(dir).filter((n) => STAMP.test(n))
const bakListing = (dir: string) => {
  const bak = path.join(dir, safety.BACKUP_DIR_NAME)
  return fs.existsSync(bak) ? fs.readdirSync(bak).sort() : []
}

/** Seeds 1..7 overwritten 7 times keep the backups of seeds 3..7. */
const SEEDS = Array.from({ length: 7 }, (_, i) => `isi lama ${i + 1}\n`)
const KEPT = SEEDS.slice(-KEEP)

describe("rel128 probe HT17: BACKUP_KEEP is the registered 5", () => {
  it("BACKUP_KEEP = 5 and BACKUP_DIR_NAME = .bak", () => {
    expect(safety.BACKUP_KEEP).toBe(KEEP)
    expect(safety.BACKUP_DIR_NAME).toBe(".bak")
    expect(typeof safety.REAL_NODE_FS.lstat).toBe("function")
    expect(typeof safety.REAL_NODE_FS.unlink).toBe("function")
  })
})

describe("rel128 probe HT17 S1: studio_report_refresh outPath + overwrite (tools.ts:605)", () => {
  it("7 overwrites keep 5 backups (6th removes the oldest), residue 1..5,5,5, no sibling .bak-*", async () => {
    const root = tmpRoot("s1")
    const out = path.join(root, "laporan.md")
    const s = statefulServer(MD())
    const { call } = await connect({ fetch: s.f, nfs: safety.REAL_NODE_FS, config: { fileRoots: [root], fileWriteEnabled: true } })
    const first = await call("studio_report_refresh", { documentId: DOC, markdown: MD(), outPath: out })
    expect(first.isError).toBeFalsy()
    expect(first.data.backup ?? null).toBeNull()
    const residue: number[] = []
    const removed: number[] = []
    for (const seed of SEEDS) {
      fs.writeFileSync(out, seed)
      const r = await call("studio_report_refresh", { documentId: DOC, markdown: MD(), outPath: out, overwrite: true })
      expect(r.isError).toBeFalsy()
      expect(path.dirname(r.data.backup)).toBe(path.join(root, ".bak"))
      residue.push(r.data.backupResidue)
      removed.push(r.data.backupRemoved ?? 0)
      expect(r.text).toContain(`backupResidue ${r.data.backupResidue}`)
    }
    expect(residue).toEqual([1, 2, 3, 4, 5, 5, 5])
    expect(removed).toEqual([0, 0, 0, 0, 0, 1, 1])
    expect(backupsOf(root, "laporan.md")).toEqual(KEPT)
    expect(siblingResidue(root)).toEqual([])
  })

  it("refresh without outPath/write, and a refused refresh (no overwrite), leave .bak/ untouched", async () => {
    const root = tmpRoot("s1b")
    const out = path.join(root, "laporan.md")
    const s = statefulServer(MD())
    const { call } = await connect({ fetch: s.f, nfs: safety.REAL_NODE_FS, config: { fileRoots: [root], fileWriteEnabled: true } })
    fs.writeFileSync(out, "isi lama\n")
    const merge = await call("studio_report_refresh", { documentId: DOC, markdown: MD() })
    expect(merge.isError).toBeFalsy()
    const refused = await call("studio_report_refresh", { documentId: DOC, markdown: MD(), outPath: out })
    expect(refused.data.error.code).toBe("OUT_EXISTS")
    expect(fs.existsSync(path.join(root, ".bak"))).toBe(false)
    expect(fs.readdirSync(root)).toEqual(["laporan.md"])
  })
})

describe("rel128 probe HT17 S2: studio_file_verify downloadDir + overwrite (tools.ts:991)", () => {
  const FILE_ID = "cmvvfile0000000000000ht17a"
  const BYTES = Buffer.from("<html><body>berkas uji ht17</body></html>", "utf8")
  const SHA = sha(BYTES)
  const NAME = `002-UJI-NT-XI-2026_rev1_20261114T010000Z_${SHA.slice(0, 8)}.html`
  const route = `/api/studio/files/${FILE_ID}`
  const mk = () => {
    const calls: string[] = []
    const f = async (url: string, init: { method: string }) => {
      const u = new URL(url)
      calls.push(`${init.method} ${u.search}`)
      if (u.pathname !== route) return reply({ status: 404, body: { code: "ROUTE_NOT_FOUND" } })
      const headers = { "x-studio-final-filename": NAME, "x-studio-sha256-verified": "true", "x-studio-sha256": SHA }
      return init.method === "HEAD" ? reply({ status: 200, headers }) : reply({ status: 200, headers, bytes: BYTES })
    }
    return { f, calls }
  }

  it("synthetic final name passes C51", () => {
    expect(safeFinalName(NAME)).toBe(true)
  })

  it("7 overwrites keep 5 backups (6th removes the oldest), residue 1..5,5,5, no sibling .bak-*", async () => {
    const root = tmpRoot("s2")
    const dir = path.join(root, "unduhan")
    fs.mkdirSync(dir)
    const m = mk()
    const { call } = await connect({ fetch: m.f, nfs: safety.REAL_NODE_FS, config: { fileRoots: [root], fileWriteEnabled: true } })
    const residue: number[] = []
    const removed: number[] = []
    for (const seed of SEEDS) {
      fs.writeFileSync(path.join(dir, NAME), seed)
      const r = await call("studio_file_verify", { fileId: FILE_ID, downloadDir: dir, overwrite: true })
      expect(r.isError).toBeFalsy()
      expect(path.dirname(r.data.backup)).toBe(path.join(dir, ".bak"))
      residue.push(r.data.backupResidue)
      removed.push(r.data.backupRemoved ?? 0)
      expect(r.text).toContain(`backupResidue ${r.data.backupResidue}`)
    }
    expect(residue).toEqual([1, 2, 3, 4, 5, 5, 5])
    expect(removed).toEqual([0, 0, 0, 0, 0, 1, 1])
    expect(backupsOf(dir, NAME)).toEqual(KEPT)
    expect(fs.readFileSync(path.join(dir, NAME))).toEqual(BYTES)
    expect(siblingResidue(dir)).toEqual([])
  })

  it("verify without downloadDir and an identical re-download leave .bak/ untouched", async () => {
    const root = tmpRoot("s2b")
    const dir = path.join(root, "unduhan")
    fs.mkdirSync(dir)
    const m = mk()
    const { call } = await connect({ fetch: m.f, nfs: safety.REAL_NODE_FS, config: { fileRoots: [root], fileWriteEnabled: true } })
    fs.writeFileSync(path.join(dir, NAME), "isi lama\n")
    const one = await call("studio_file_verify", { fileId: FILE_ID, downloadDir: dir, overwrite: true })
    expect(one.data.backupResidue).toBe(1)
    const before = bakListing(dir)
    const headOnly = await call("studio_file_verify", { fileId: FILE_ID })
    expect(headOnly.isError).toBeFalsy()
    expect(headOnly.data.savedTo).toBeNull()
    const same = await call("studio_file_verify", { fileId: FILE_ID, downloadDir: dir, overwrite: true })
    expect(same.isError).toBeFalsy()
    expect(same.data.alreadyPresent).toBe(true)
    expect(same.data.backup).toBeNull()
    expect(same.data.backupResidue).toBe(1)
    expect(bakListing(dir)).toEqual(before)
    expect(siblingResidue(dir)).toEqual([])
  })
})

describe("rel128 probe HT17 S3: studio_mission_export write + overwrite (mission-tools.ts:574)", () => {
  it("7 overwrites keep 5 backups of the export file (6th removes the oldest), residue 1..5,5,5, no sibling .bak-*", async () => {
    const run = tmpRoot("s3")
    const project = path.join(run, "project")
    fs.mkdirSync(project)
    let tick = 1_800_000_000_000
    const store = new SqliteStudioStore()
    await store.open(path.join(run, "store"), { release: "1.2.8", log: () => {}, agentClock: () => ++tick })
    try {
      const M = store.missions
      const MI = "2026-11-14_r128-ht17"
      let n = 0
      const exporter = async ({ files }: { files: readonly string[] }) => files.map((f) => ({ path: f === "status" ? "status_tasks.md" : `x/${f}.md`, markdown: `# status ht17 versi ${++n}\n` }))
      let t = Date.UTC(2026, 10, 14, 1, 0, 0)
      const tools = missionTools(store, { log: () => {}, exporter: exporter as never, now: () => (t += 1000) })
      const exp = tools.find((x) => x.name === "studio_mission_export")!
      const session = { sessionId: "mcp-ht17", agentId: "swarm", fileRoot: project }
      const row = { id: "1", phase: "implementation", kind: "implementation", title: "Row 1", agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: "implementation/1.md", verification: "tests pass" }
      await store.transaction(async (tx) => M.create(tx, { id: MI, title: "Mission ht17", type: "feature-release", owner: "master-controller", project: { dir: project }, rows: [row], decisions: [{ id: "U1", by: "user", date: "2026-11-14", text: "approve" }] } as never))
      await store.transaction(async (tx) => M.approve(tx, MI, "U1"))
      await store.transaction(async (tx) => M.setStatus(tx, MI, "running"))
      const data = (res) => res.structuredContent?.data ?? res.structuredContent
      const first = await exp.call({ mission: MI, files: ["status"], write: true }, session)
      expect(first.isError).not.toBe(true)
      const dir = path.dirname(path.join(project, data(first).files[0].path))
      const name = path.basename(data(first).files[0].path)
      const residue: number[] = []
      for (let i = 0; i < 7; i++) {
        const r = await exp.call({ mission: MI, files: ["status"], write: true, overwrite: true }, session)
        expect(r.isError).not.toBe(true)
        residue.push(data(r).files[0].backupResidue)
        expect(r.content[0].text).toContain(`backupResidue ${data(r).files[0].backupResidue}`)
      }
      expect(residue).toEqual([1, 2, 3, 4, 5, 5, 5])
      // backups hold versions 1..7 (the file before each overwrite); the newest five are 3..7
      expect(backupsOf(dir, name)).toEqual([3, 4, 5, 6, 7].map((v) => `# status ht17 versi ${v}\n`))
      expect(fs.readFileSync(path.join(dir, name), "utf8")).toBe("# status ht17 versi 8\n")
      expect(siblingResidue(dir)).toEqual([])
    } finally {
      await store.close()
    }
  })
})

describe("rel128 probe HT17 S4: studio_figure_preview downloadDir + overwrite (figure-tools.ts:214)", () => {
  const FDOC = "cmvdoc0000000000000ht17fg"
  const PID = "fig-ht17-1"
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="2"/></svg>'
  const PREVIEW = { documentId: FDOC, revisionNo: 3, currentRevisionNo: 3, rendered: true, figure: { type: "chart", code: "P-01", pid: PID, address: "1.1.1", label: "Gambar 1.1", inline: false, size: { widthMm: 160, heightMm: 60, svgBytes: SVG.length }, issues: [], issueCount: 0, layoutIssueCount: 0, svg: SVG } }
  const f = async (url: string, init: { method: string }) =>
    init.method === "POST" && new URL(url).pathname === `/api/studio/documents/${FDOC}/figures/preview` ? reply({ status: 200, body: PREVIEW }) : reply({ status: 404, body: { code: "ROUTE_NOT_FOUND" } })
  const NAME = `${FDOC}-${PID}-rev3.svg`

  it("7 overwrites keep 5 backups (6th removes the oldest), no sibling .bak-*; identical re-run writes nothing", async () => {
    const root = tmpRoot("s4")
    const dir = path.join(root, "figur")
    fs.mkdirSync(dir)
    const { call } = await connect({ fetch: f, nfs: safety.REAL_NODE_FS, config: { fileRoots: [root], fileWriteEnabled: true }, env: { STUDIO_AGENT_ID: "cod-ht17" } })
    for (const seed of SEEDS) {
      fs.writeFileSync(path.join(dir, NAME), seed)
      const r = await call("studio_figure_preview", { documentId: FDOC, pid: PID, downloadDir: dir, overwrite: true })
      expect(r.isError).toBeFalsy()
      expect(r.data.savedTo).toBe(path.join(dir, NAME))
      expect(path.dirname(r.data.backup)).toBe(path.join(dir, ".bak"))
    }
    expect(backupsOf(dir, NAME)).toEqual(KEPT)
    expect(fs.readFileSync(path.join(dir, NAME), "utf8")).toBe(SVG)
    expect(siblingResidue(dir)).toEqual([])
    const before = bakListing(dir)
    const same = await call("studio_figure_preview", { documentId: FDOC, pid: PID, downloadDir: dir, overwrite: true })
    expect(same.isError).toBeFalsy()
    expect(same.data.alreadyPresent).toBe(true)
    expect(same.data.backup).toBeNull()
    expect(bakListing(dir)).toEqual(before)
  })
})
