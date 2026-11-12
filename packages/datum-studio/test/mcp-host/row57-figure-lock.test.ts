// Row 57 (1.2.6, S-02, register N-024): per-figure lock for studio_figure_revise in the MCP host.
// A second concurrent figure_revise on the same {documentId, pid} is refused FIGURE_LOCKED (naming the figure and
// that another call holds it), without a Studio call; the lock is released when the first call ends (success,
// error envelope or throw); different figures run concurrently. Two host MCP sessions (two createHostMcpServer
// instances over InMemoryTransport, the shape of two subagents) share the process-wide registry. No network.
// Only public entry points are imported (createHostMcpServer), so the BASE run reaches the assertions (red class A).
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { HttpFetch } from "../../vendor/scripts/studio/_http-client"
import { loadConfig } from "../../vendor/scripts/studio/mcp/config"
import { BASE, memNodeFs, reply, ROOT, SECRET } from "../ported/mcp/mcp-harness"
import { createHostMcpServer } from "../../src/mcp-host/mcp-server.ts"
import type { HostToolExtension } from "../../src/mcp-host/tool-table.ts"

const DOC = "cmvdoc0000000000000row57a"
const AGENT = "cod-row57"
const PID = "fig-chart-1"
const PID2 = "fig-chart-2"
const CHANGE = { what: "label dipendekkan", why: "label bertumpuk", impact: "grafik Gambar 1.1" }
const VENDOR = path.resolve(import.meta.dir, "..", "..", "vendor")

type Deferred = { promise: Promise<void>; resolve: () => void }
const deferred = (): Deferred => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/**
 * Studio mock for figure_revise (R05 owner, GET/PATCH R16, preview). While `hold` is set, the first `holdN` R05
 * calls wait for it (later ones pass, so an unlocked BASE run fails on assertions, not on a timeout); `arrivals` counts R05 calls. `r05Status` lets a test make the held call end in an error envelope.
 */
function studio() {
  const calls: Array<{ method: string; path: string }> = []
  const s = { hold: null as Deferred | null, holdN: 1, arrivals: [] as Deferred[], r05Status: 200 }
  const waitArrivals = async (n: number) => {
    while (s.arrivals.length < n) await new Promise((r) => setTimeout(r, 2))
  }
  const f: HttpFetch = async (url, init) => {
    const p = new URL(url).pathname
    calls.push({ method: init.method, path: p })
    const m = p.match(/^\/api\/studio\/documents\/([^/]+)(?:\/paragraphs\/([^/]+)|\/figures\/preview)?$/)
    if (!m) return reply({ status: 404, body: { code: "ROUTE_NOT_FOUND" } })
    const [, doc, pid] = m
    if (init.method === "GET" && !pid && !p.endsWith("/preview")) {
      s.arrivals.push(deferred())
      if (s.hold && s.arrivals.length <= s.holdN) await s.hold.promise
      if (s.r05Status !== 200) return reply({ status: s.r05Status, body: { error: "galat uji", code: "INTERNAL_ERROR" } })
      return reply({ status: 200, body: { document: { id: doc, docNumber: "012/GSP/KT/XI/2026", createdBy: `agent:${AGENT}`, currentRevisionNo: 3 }, revision: { revisionNo: 3 } } })
    }
    if (init.method === "GET" && pid) {
      const block = { id: pid, type: "chart", code: "P-02", data: { shape: "categorical", points: [{ label: "A", value: 1 }] }, caption: { text: "Beban" }, source: { text: "Uji" } }
      return reply({ status: 200, body: { pid, kind: "BLOCK", address: "1.1.2", type: "chart", content: block, revisionNo: 3 } })
    }
    if (init.method === "PATCH" && pid) {
      return reply({ status: 200, body: { revision: { revisionNo: 4, changeScope: `pid:${pid}` }, pid, address: "1.1.2", addressMap: {}, rebased: false, baseRevisionNo: 3, appliedOnRevisionNo: 3, completeness: { status: "INCOMPLETE", revisionNo: 4, missingRequired: [] } } })
    }
    if (init.method === "POST" && p.endsWith("/figures/preview")) {
      const body = init.body ? JSON.parse(init.body) : {}
      return reply({ status: 200, body: { documentId: doc, revisionNo: 4, currentRevisionNo: 4, rendered: true, figure: { type: "chart", code: "P-02", pid: body.pid, address: "1.1.2", label: "Gambar 1.1", inline: false, size: { widthMm: 166, heightMm: 63.6, svgBytes: 100 }, issues: [], issueCount: 0, layoutIssueCount: 0, checksRun: 9 } } })
    }
    return reply({ status: 404, body: { code: "ROUTE_NOT_FOUND" } })
  }
  return { f, calls, s, waitArrivals }
}

const logs: string[] = []
async function session(sessionId: string, f: HttpFetch, extensions: HostToolExtension[] = []) {
  const config = loadConfig({ INTERNAL_API_SECRET: SECRET, STUDIO_BASE_URL: BASE, STUDIO_MCP_FILE_ROOTS: ROOT, STUDIO_AGENT_ID: AGENT }, ROOT)
  const server = createHostMcpServer({ config, fetchImpl: f, session: { sessionId, agentId: AGENT, fileRoot: ROOT }, extensions, repoRoot: VENDOR, log: (l) => logs.push(l), nfs: memNodeFs().nfs })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: "uji-row57", version: "0.0.1" })
  await client.connect(ct)
  return async (args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name: "studio_figure_revise", arguments: args })
    return { ...r, data: r.structuredContent, text: r.content?.[0]?.text as string }
  }
}
/** Host log lines of a session (the lock is internal; its state shows as refusals and log records). */
const lockedLogs = (sessionId: string) => logs.filter((l) => l.includes('"code":"FIGURE_LOCKED"') && l.includes(`"sessionId":"${sessionId}"`))
const revise = (pid: string, doc = DOC) => ({ documentId: doc, pid, baseRevisionNo: 3, change: CHANGE, patch: { caption: "Beban unit" } })

describe("row 57 S-02: FIGURE_LOCKED on a concurrent figure_revise of one {documentId, pid}", () => {
  test("second call on the same figure is refused FIGURE_LOCKED without a Studio call; released after success", async () => {
    const m = studio()
    const a = await session("ses-row57-a", m.f)
    const b = await session("ses-row57-b", m.f)
    m.s.hold = deferred()
    const first = a(revise(PID))
    await m.waitArrivals(1)
    const before = m.calls.length
    const second = await b(revise(PID))
    expect(m.calls.length).toBe(before) // refused before any Studio call (0 writes)
    expect(second.data).toMatchObject({ ok: false, tool: "studio_figure_revise", code: "FIGURE_LOCKED", error: { code: "FIGURE_LOCKED", httpStatus: 409, details: { documentId: DOC, pid: PID } } })
    expect(second.text).toStartWith("galat FIGURE_LOCKED:")
    expect(second.text).toContain(`pid ${PID}`)
    expect(second.text).toContain(DOC)
    expect(second.text).toContain("panggilan studio_figure_revise lain yang masih berjalan")
    expect(logs.some((l) => l.includes('"code":"FIGURE_LOCKED"') && l.includes('"heldBySession":"ses-row57-a"'))).toBe(true)

    m.s.hold.resolve()
    m.s.hold = null
    const r1 = await first
    expect(r1.isError).toBeFalsy()
    expect(r1.data).toMatchObject({ documentId: DOC, pid: PID, revisionNo: 4 })

    const again = await b(revise(PID))
    expect(again.data?.code).not.toBe("FIGURE_LOCKED")
    expect(again.data).toMatchObject({ pid: PID, revisionNo: 4 })
  })

  test("the lock is released when the first call ends in an error envelope", async () => {
    const m = studio()
    const a = await session("ses-row57-c", m.f)
    const b = await session("ses-row57-d", m.f)
    m.s.hold = deferred()
    m.s.r05Status = 500
    const first = a(revise(PID))
    await m.waitArrivals(1)
    expect((await b(revise(PID))).data.code).toBe("FIGURE_LOCKED")
    m.s.hold.resolve()
    m.s.hold = null
    const r1 = await first
    expect(r1.data.ok).toBe(false)
    expect(r1.data.code).not.toBe("FIGURE_LOCKED")
    m.s.r05Status = 200
    const r2 = await b(revise(PID))
    expect(r2.data).toMatchObject({ pid: PID, revisionNo: 4 })
  })

  test("different figures (other pid, other document) run concurrently", async () => {
    const m = studio()
    const a = await session("ses-row57-e", m.f)
    const b = await session("ses-row57-f", m.f)
    const c = await session("ses-row57-g", m.f)
    m.s.hold = deferred()
    m.s.holdN = 3
    const p1 = a(revise(PID))
    const p2 = b(revise(PID2))
    const p3 = c(revise(PID, "cmvdoc0000000000000row57b"))
    await m.waitArrivals(3) // all three are in flight at once
    m.s.hold.resolve()
    m.s.hold = null
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1.data).toMatchObject({ pid: PID, revisionNo: 4 })
    expect(r2.data).toMatchObject({ pid: PID2, revisionNo: 4 })
    expect(r3.data).toMatchObject({ documentId: "cmvdoc0000000000000row57b", pid: PID, revisionNo: 4 })
    for (const sid of ["ses-row57-e", "ses-row57-f", "ses-row57-g"]) expect(lockedLogs(sid)).toEqual([])
  })

  test("the lock is released when the first call throws (wrapper error -> internal error)", async () => {
    const m = studio()
    const gate = deferred()
    let entered = false
    // Row 119b seam: a wrapper on the kept tool; this one blocks, then throws (the host maps it to InternalError).
    const throwing: HostToolExtension = {
      name: "studio_figure_revise",
      title: "uji",
      description: "uji",
      inputSchema: { type: "object" },
      toolsets: ["documents"],
      wraps: true,
      async call() {
        entered = true
        await gate.promise
        throw new Error("galat uji row 57")
      },
    }
    const a = await session("ses-row57-h", m.f, [throwing])
    const b = await session("ses-row57-i", m.f)
    const first = a(revise(PID)).then(
      () => "resolved",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    while (!entered) await new Promise((r) => setTimeout(r, 2))
    const locked = await b(revise(PID))
    expect(locked.data?.code).toBe("FIGURE_LOCKED")
    gate.resolve()
    expect(await first).toContain("galat internal")
    const after = await b(revise(PID))
    expect(after.data).toMatchObject({ pid: PID, revisionNo: 4 })
  })

})
