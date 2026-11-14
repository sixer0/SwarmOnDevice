// Swarm 1.2.8 row 34c (H-T18, AC-HT18, N8-338; ruling D-H4 host-only): an agent (non-admin) session reads the
// per-document figure quota. Both kept tools, studio_document_get and studio_figure_preview, print N8-211
// `kuota gambar: <n>/<max>` (n = chart, diagram and image blocks of the revision, the set lint D22 counts; max = the
// resolved template parameter figure.quota.maxPerDocument, P7-37). With no quota (null, every built-in template) no
// line is printed. The file that prints it: src/mcp-host/figure-quota.ts (wrappers registered by missionHostExtension).
// Red at e1f9673772: the module does not exist, the tool texts have no quota line.
// Not touched (CHAR, pinned elsewhere): V/registry/lint.ts, V/engine/lint/structure/checks-d.ts (closure),
// V/params/figure.ts, V/registry/slots.ts (template lock).
// What runs for real: the host MCP server (createHostMcpServer, in-memory transport, agent session), the vendored
// tools, the wrappers, the D22 walk over a normalised synthetic document, and the store reader on a temp store. The
// Studio HTTP of the vendored tools is mocked; the quota reader of the host-server cases is the pure figureQuotaOf
// over a synthetic snapshot (a template with a quota cannot be made without touching the template lock).
// The new module is imported dynamically on purpose: the red run at BASE fails on the assertions.
import { useStudioEnv } from "../ported/_env"
const { workspaceRoot } = useStudioEnv()
import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { HttpFetch } from "../../vendor/scripts/studio/_http-client"
import { loadConfig } from "../../vendor/scripts/studio/mcp/config"
import { createHostMcpServer } from "../../src/mcp-host/mcp-server"
import { BASE, memNodeFs, reply, ROOT, SECRET } from "../ported/mcp/mcp-harness"
import { canonicalTemplate, makeDoc, snapshotOf, withParams } from "../ported/engine-core/fixtures"

const PKG = path.resolve(import.meta.dir, "..", "..")
const QUOTA = "figure.quota.maxPerDocument"
const DOC = "cmvdoc0000000000000r34c18"
const AGENT = "cod-row34c"
const quotaMod: any = await import(path.join(PKG, "src", "mcp-host", "figure-quota.ts")).catch(() => null)

/** A synthetic document: 3 figures (diagram, chart, image) and one paragraph. */
function snapshot3() {
  const fig = (type: string, i: number) => ({ type, ...(type === "image" ? { asset: `sha256:${"a".repeat(64)}` } : { spec: { artifactId: `fig-${i}` } }), caption: { inline: { text: `Gambar uji sintetis ${i}.` } } })
  return snapshotOf(makeDoc({ tier: "TERBIT", blocks: [{ type: "paragraph", text: "Paragraf uji sintetis." }, fig("diagram", 1), fig("chart", 2), fig("image", 3)] as never }))
}

// ── mocked Studio HTTP for the vendored tools (R05 summary, R20 content, figure preview) ─────────────────────────
const mock: HttpFetch = async (url, init) => {
  const p = new URL(url).pathname
  if (init.method === "POST" && p === `/api/studio/documents/${DOC}/figures/preview`)
    return reply({ status: 200, body: { documentId: DOC, revisionNo: 3, currentRevisionNo: 3, rendered: true, figure: { issueCount: 0, layoutIssueCount: 0, issues: [], notices: [] } } })
  if (init.method === "GET" && p === `/api/studio/documents/${DOC}/content`)
    return reply({ status: 200, body: { document: { id: DOC, docNumber: "SYN-34C" }, revisionNo: 3, content: {} } })
  if (init.method === "GET" && p === `/api/studio/documents/${DOC}`)
    return reply({ status: 200, body: { document: { id: DOC, docNumber: "SYN-34C", title: "Dokumen sintetis", currentRevisionNo: 3 }, completeness: { status: "COMPLETE" }, outputs: [] } })
  return reply({ status: 404, body: { code: "ROUTE_NOT_FOUND" } })
}

const warns: Array<{ level: string; message: string; context?: Record<string, unknown> }> = []
const log = (level: "info" | "warn" | "error", _source: string, message: string, context?: Record<string, unknown>) => void warns.push({ level, message, context })

/** The host server for one agent session; the wrappers when the module exists (none at BASE). */
async function hostClient(read: (documentId: string, rev: number | undefined) => Promise<unknown>) {
  const config = loadConfig({ INTERNAL_API_SECRET: SECRET, STUDIO_BASE_URL: BASE, STUDIO_MCP_FILE_ROOTS: ROOT, STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: "reports,documents,query,write" }, ROOT)
  const extensions = quotaMod ? quotaMod.figureQuotaWrappers({ log, read }) : []
  const server = createHostMcpServer({ config, fetchImpl: mock, session: { sessionId: "ses-row34c", agentId: AGENT, fileRoot: ROOT }, extensions, repoRoot: path.join(PKG, "vendor"), log: () => undefined, nfs: memNodeFs().nfs })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: "row34c", version: "0" })
  await client.connect(ct)
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args })
    return { isError: r.isError === true, text: String(r.content?.[0]?.text ?? "") }
  }
  return { client, call }
}

const withQuota = async (_d: string, _r: number | undefined) => (quotaMod ? quotaMod.figureQuotaOf(snapshot3(), withParams(canonicalTemplate(), { [QUOTA]: 5 }).params) : null)
const noQuota = async (_d: string, _r: number | undefined) => (quotaMod ? quotaMod.figureQuotaOf(snapshot3(), canonicalTemplate().params) : null)

describe("AC-HT18: the figure quota is computed as lint D22 counts it", () => {
  test("3 figures, quota 5 -> {count 3, max 5}; the line is `kuota gambar: 3/5` (N8-211)", () => {
    expect(quotaMod).not.toBeNull()
    const q = quotaMod.figureQuotaOf(snapshot3(), withParams(canonicalTemplate(), { [QUOTA]: 5 }).params)
    expect(q).toEqual({ count: 3, max: 5 })
    expect(quotaMod.figureQuotaLine(q)).toBe("kuota gambar: 3/5")
  })

  test("no quota (template default null) -> null, so no line", () => {
    expect(quotaMod).not.toBeNull()
    expect(canonicalTemplate().params[QUOTA] ?? null).toBeNull()
    expect(quotaMod.figureQuotaOf(snapshot3(), canonicalTemplate().params)).toBeNull()
  })
})

describe("AC-HT18: an agent session reads the quota in both tool texts", () => {
  for (const [name, args] of [
    ["studio_document_get", { documentId: DOC, view: "summary" }],
    ["studio_document_get", { documentId: DOC }],
    ["studio_document_get", { id: DOC, view: "content" }],
    ["studio_figure_preview", { documentId: DOC, pid: "fig-diagram-1" }],
  ] as const) {
    test(`${name} ${JSON.stringify(args)} prints \`kuota gambar: 3/5\` as its last line`, async () => {
      const { call, client } = await hostClient(withQuota)
      const r = await call(name, { ...args })
      await client.close()
      console.log(`row34c HT18 ${name}: ${JSON.stringify(r.text.split("\n").slice(-1)[0])}`)
      expect(r.isError).toBe(false)
      expect(r.text.split("\n").at(-1)).toBe("kuota gambar: 3/5")
      expect(r.text.match(/kuota gambar:/g)?.length).toBe(1)
    })
  }

  test("no quota set: neither tool prints a quota line", async () => {
    const { call, client } = await hostClient(noQuota)
    const a = await call("studio_document_get", { documentId: DOC, view: "summary" })
    const b = await call("studio_figure_preview", { documentId: DOC, pid: "fig-diagram-1" })
    await client.close()
    expect(quotaMod).not.toBeNull()
    expect(a.isError || b.isError).toBe(false)
    expect(a.text).not.toContain("kuota gambar")
    expect(b.text).not.toContain("kuota gambar")
  })

  test("a failed quota read leaves the tool result as it was and logs a warn", async () => {
    warns.length = 0
    const { call, client } = await hostClient(async () => {
      throw new Error("uji: baca kuota gagal")
    })
    const r = await call("studio_document_get", { documentId: DOC, view: "summary" })
    await client.close()
    expect(quotaMod).not.toBeNull()
    expect(r.isError).toBe(false)
    expect(r.text).not.toContain("kuota gambar")
    expect(warns.map((w) => [w.level, w.context?.tool, w.context?.documentId])).toEqual([["warn", "studio_document_get", DOC]])
  })

  test("CHAR: tools/list is byte-identical with and without the wrappers (names, titles, descriptions, schemas)", async () => {
    expect(quotaMod).not.toBeNull()
    const config = loadConfig({ INTERNAL_API_SECRET: SECRET, STUDIO_BASE_URL: BASE, STUDIO_MCP_FILE_ROOTS: ROOT, STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: "reports,documents,query,write" }, ROOT)
    const plain = createHostMcpServer({ config, fetchImpl: mock, session: { sessionId: "ses-row34c-plain", agentId: AGENT, fileRoot: ROOT }, extensions: [], repoRoot: path.join(PKG, "vendor"), log: () => undefined, nfs: memNodeFs().nfs })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await plain.connect(st)
    const pc = new Client({ name: "row34c-plain", version: "0" })
    await pc.connect(ct)
    const { client } = await hostClient(withQuota)
    const a = JSON.stringify(await pc.listTools())
    const b = JSON.stringify(await client.listTools())
    await pc.close()
    await client.close()
    expect(b).toBe(a)
  })

  test("rev is passed to the reader (current revision when absent)", async () => {
    const seen: Array<[string, number | undefined]> = []
    const { call, client } = await hostClient(async (d, rev) => (seen.push([d, rev]), withQuota(d, rev)))
    await call("studio_document_get", { documentId: DOC, view: "summary", rev: 2 })
    await call("studio_figure_preview", { documentId: DOC, pid: "fig-diagram-1" })
    await client.close()
    expect(seen).toEqual([[DOC, 2], [DOC, undefined]])
  })
})

// ── production wiring and the store reader (temp store, no port) ──────────────────────────────────────────────────
type Mod = typeof import("../../src/mcp-host/index.ts")
let hostMod: Mod | undefined
let store: Awaited<ReturnType<Mod["openHostStore"]>> | undefined
afterAll(async () => {
  if (store && hostMod) await hostMod.closeHostStore(store)
})

describe("AC-HT18: production path", () => {
  test("missionHostExtension wraps studio_document_get and studio_figure_preview; the store reader reads the store", async () => {
    hostMod = (await import("../../src/mcp-host/index.ts")) as Mod
    store = await hostMod.openHostStore(workspaceRoot, { release: "1.2.8", logFile: path.join(workspaceRoot, "logs", "store.jsonl") })
    const ext = hostMod.missionHostExtension(store, { log, exporter: null })
    for (const name of ["studio_document_get", "studio_figure_preview"]) expect(ext.filter((e) => e.name === name && e.wraps === true).length).toBe(1)
    expect(quotaMod).not.toBeNull()
    await expect(quotaMod.readFigureQuota("cmvdoc000000000000nosuch00", undefined)).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" })
  })
})
