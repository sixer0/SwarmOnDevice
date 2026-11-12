// Row 31: the Studio MCP server of the datum-studio-host process (studio spec §3.2, §5, §9.1, §9.4; U13, U19).
// Real store (row 30/109) in a temp folder, real streamable-HTTP endpoint on 127.0.0.1, real MCP SDK client.
// globalThis.fetch is replaced by a trap for the whole file: the host must never call it. The test's own MCP
// client reaches the endpoint with the fetch captured before the trap (that is the bridge's side, not the host).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { connect } from "node:net"
import { networkInterfaces } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { HostServer, StudioHostModule } from "../../../desktop/src/main/datum-studio-host/protocol.ts"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW31_TEST_DIR ?? "/private/tmp/claude-501/row31/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row31-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-a")
const OTHER = path.join(HOME, "project-b")
for (const d of [HOME, RES, PROJECT, OTHER]) mkdirSync(d, { recursive: true })

// Host env exactly as row 111 sets it (no STUDIO_MCP_FILE_ROOTS, no INTERNAL_API_SECRET).
process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

const PORT = 47311
const PORT_EXT = 47312
const TOKEN = "a".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }

const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = (async () => {
  fetchCalls++
  throw new Error("row31 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

const EXPECTED_TOOLS = [
  "studio_registry",
  "studio_templates_list",
  "studio_template_get",
  "studio_document_create",
  "studio_chapter_import_markdown",
  "studio_chapter_submit",
  "studio_slot_fill",
  "studio_document_structure",
  "studio_document_status",
  "studio_document_get",
  "studio_render",
  "studio_file_verify",
  "studio_search",
  "studio_contracts_query",
  "studio_figure_preview",
  "studio_figure_revise",
  "studio_write",
  "studio_edit",
  "studio_report_template",
  "studio_report_check",
  "studio_report_submit",
  "studio_report_update",
  "studio_report_refresh",
]
// I-2 (C76, C77): start.ts registers the template tools (row 68) and the mission tools (row 119b) by default.
const TEMPLATE_TOOLS = ["studio_template_create", "studio_template_update", "studio_template_check", "studio_template_preview", "studio_template_archive"]
const MISSION_TOOLS = [
  "studio_mission_create",
  "studio_mission_get",
  "studio_mission_list",
  "studio_mission_approve",
  "studio_mission_set_status",
  "studio_mission_update_row",
  "studio_mission_record_decision",
  "studio_mission_record_finding",
  "studio_mission_export",
  "studio_mission_request_decision",
  "studio_mission_answer_decision",
]
// Row 50c (1.2.6, W-13 N-106, INTENT 39 -> 40): mcp-server.ts adds the host built-in studio_asset_put after the extensions.
const ASSET_TOOLS = ["studio_asset_put"]
const HOST_TOOLS = [...EXPECTED_TOOLS, ...TEMPLATE_TOOLS, ...MISSION_TOOLS, ...ASSET_TOOLS]

let mod: StudioHostModule & typeof import("../../src/mcp-host/index.ts")
let store: Awaited<ReturnType<StudioHostModule["openHostStore"]>>
let host: HostServer & { port: number; sessionCount(): number }
const logs: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => logs.push({ level, source, message, ...(context ? { context } : {}) })

interface RawReply {
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}

function raw(o: { headers?: Record<string, string>; path?: string; method?: string; body?: string | Buffer; port?: number; host?: string }): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const port = o.port ?? PORT
    const req = httpRequest(
      { host: "127.0.0.1", port, agent: false, path: o.path ?? "/mcp", method: o.method ?? "POST", headers: { host: o.host ?? `127.0.0.1:${port}`, ...o.headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }))
      },
    )
    req.on("error", reject)
    if (o.body !== undefined) req.write(o.body)
    req.end()
  })
}

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "row31", version: "0" } } })
const initHeaders = (cwd: string | null, agent = "claude"): Record<string, string> => ({
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "x-studio-agent": agent,
  ...(cwd !== null ? { "x-studio-caller-cwd": encodeURIComponent(cwd) } : {}),
})

async function client(cwd: string, agent = "claude", port = PORT): Promise<Client> {
  const c = new Client({ name: "row31-test", version: "0" })
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    fetch: realFetch as never,
    requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": agent, "x-studio-caller-cwd": encodeURIComponent(cwd) } },
  })
  await c.connect(t)
  return c
}

type Structured = Record<string, unknown> & { ok?: boolean; code?: string }
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<Structured> {
  const r = await c.callTool({ name, arguments: args })
  return (r.structuredContent ?? {}) as Structured
}

/** I-2 (C73, as T-2): own the process-wide caches (env root, PDF readiness, render limiter, render bridge env). */
async function resetProcessCaches() {
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetBridgePdfReadiness()
  resetRenderRateLimiter()
  delete process.env.DATUM_RENDER_SOCKET
  delete process.env.DATUM_RENDER_TOKEN
}

beforeAll(async () => {
  // I-2: start.ts now refuses a store whose root differs from the cached env root (C66), so start from a clean cache.
  await resetProcessCaches()
  mod = (await import("../../src/mcp-host/index.ts")) as typeof mod
  // Runner order of row 111: openHostStore -> configureTemplateSource -> startStudioHostServer.
  store = await mod.openHostStore(STORE, { release: "1.2.0", logFile: LOG })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" })
  host = (await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: PORT, log, facts: FACTS })) as typeof host
})

afterAll(async () => {
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  globalThis.fetch = realFetch
  await resetProcessCaches()
})

describe("row 31: endpoint binds 127.0.0.1 only and refuses missing/wrong credentials", () => {
  test("url is http://127.0.0.1:<port>/mcp", () => {
    expect(host.url).toBe(`http://127.0.0.1:${PORT}/mcp`)
  })

  test("not reachable on a non-loopback interface address", async () => {
    const ext = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)
    if (!ext) return // no external interface on this machine: nothing to probe
    const outcome = await new Promise<string>((resolve) => {
      const s = connect({ host: ext.address, port: PORT })
      s.once("connect", () => (s.destroy(), resolve("connected")))
      s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"))
    })
    expect(outcome).not.toBe("connected")
  })

  test("no token, wrong token, wrong scheme -> 401 with empty body", async () => {
    for (const auth of [undefined, `Bearer ${"b".repeat(64)}`, `Basic ${TOKEN}`, `Bearer ${TOKEN.slice(1)}`]) {
      const r = await raw({ headers: { ...initHeaders(PROJECT), ...(auth ? { authorization: auth } : {}) }, body: INIT })
      if (auth === undefined) {
        const r2 = await raw({ headers: { "content-type": "application/json", "x-studio-agent": "claude" }, body: INIT })
        expect(r2.status).toBe(401)
        expect(r2.body).toBe("")
      }
      expect(r.status).toBe(auth === undefined ? 200 : 401)
      if (auth !== undefined) expect(r.body).toBe("")
    }
  })

  test("wrong Host (DNS rebinding) or any Origin -> 403; other path -> 404; > 8 MiB -> 413", async () => {
    expect((await raw({ headers: initHeaders(PROJECT), body: INIT, host: `localhost:${PORT}` })).status).toBe(403)
    expect((await raw({ headers: initHeaders(PROJECT), body: INIT, host: "evil.example:80" })).status).toBe(403)
    expect((await raw({ headers: { ...initHeaders(PROJECT), origin: "http://127.0.0.1:3000" }, body: INIT })).status).toBe(403)
    expect((await raw({ headers: initHeaders(PROJECT), body: INIT, path: "/other" })).status).toBe(404)
    const big = Buffer.alloc(8 * 1024 * 1024 + 16, 0x20)
    expect((await raw({ headers: initHeaders(PROJECT), body: big })).status).toBe(413)
  })
})

describe("row 31: per-session file root (spec §9.4)", () => {
  test("refused roots: missing, relative, /, HOME, inside Res/, inside the store, containing the store, missing dir, symlink into Res/", async () => {
    const link = path.join(PROJECT, "link-to-res")
    symlinkSync(RES, link)
    const bad: Array<string | null> = [null, "relative/dir", "/", HOME, path.join(RES, "datum-studio"), STORE, path.join(STORE, "tmp"), WORK, path.join(WORK, "nope"), link]
    mkdirSync(path.join(RES, "datum-studio"), { recursive: true })
    mkdirSync(path.join(STORE, "tmp"), { recursive: true })
    for (const cwd of bad) {
      const r = await raw({ headers: initHeaders(cwd), body: INIT })
      expect({ cwd, status: r.status }).toEqual({ cwd, status: 403 })
      expect(r.body).toContain("FILE_ROOT_FORBIDDEN")
    }
    const noAgent = await raw({ headers: { ...initHeaders(PROJECT), "x-studio-agent": "" }, body: INIT })
    expect(noAgent.status).toBe(400)
    expect(host.sessionCount()).toBe(1) // only the 200 initialize of the 401 test opened a session
  })

  test("a path outside the session root is refused; inside it is read; another session's root is not this one's", async () => {
    writeFileSync(path.join(PROJECT, "bab.md"), "# Ruang lingkup\n\nKalibrasi sensor dilakukan setiap bulan.\n")
    writeFileSync(path.join(OTHER, "bab.md"), "# Lain\n\nTeks lain.\n")
    const a = await client(PROJECT)
    const b = await client(OTHER)
    try {
      const args = (p: string) => ({ path: p, chapterKey: "1", mission: "2026-11-07_row31", docKey: "row31-path", template: "datum-gsp", docTitle: "Uji akar" })
      const outside = await call(a, "studio_chapter_import_markdown", args(path.join(OTHER, "bab.md")))
      expect(outside.ok).toBe(false)
      expect(outside.code).toBe("PATH_OUTSIDE_ROOTS")
      const etc = await call(a, "studio_chapter_import_markdown", args("/etc/hosts"))
      expect(etc.code).toBe("PATH_OUTSIDE_ROOTS")
      const dotdot = await call(a, "studio_chapter_import_markdown", args(path.join(PROJECT, "..", "project-b", "bab.md")))
      expect(dotdot.code).toBe("PATH_OUTSIDE_ROOTS")
      const inside = await call(a, "studio_chapter_import_markdown", args(path.join(PROJECT, "bab.md")))
      expect(inside.code).not.toBe("PATH_OUTSIDE_ROOTS")
      expect(inside.ok).toBe(true)
      const crossB = await call(b, "studio_chapter_import_markdown", args(path.join(PROJECT, "bab.md")))
      expect(crossB.code).toBe("PATH_OUTSIDE_ROOTS")
      const dl = await call(a, "studio_file_verify", { fileId: "cnotafile000000000000000", downloadDir: path.join(OTHER, "out") })
      expect(dl.ok).toBe(false)
      expect(dl.code === "PATH_OUTSIDE_ROOTS" || dl.code === "FILE_NOT_FOUND").toBe(true)
    } finally {
      await a.close()
      await b.close()
    }
  })
})

describe("row 31: tool list = studio spec §5 as amended by U19", () => {
  test("exactly the 40 names (23 kept + 5 template + 11 mission + studio_asset_put), in order; studio_draft_check absent and not callable", async () => {
    const c = await client(PROJECT)
    try {
      const names = (await c.listTools()).tools.map((t) => t.name)
      expect(names).toEqual(HOST_TOOLS)
      expect(names.length).toBe(40)
      expect([...mod.HOST_KEPT_TOOLS] as string[]).toEqual(EXPECTED_TOOLS)
      expect(names).not.toContain("studio_draft_check")
      await expect(c.callTool({ name: "studio_draft_check", arguments: { markdown: "x" } })).rejects.toThrow()
    } finally {
      await c.close()
    }
  })

  test("registration seam: an extension (rows 68 / 119-121) is listed and called; a duplicate name is refused", async () => {
    const ext = {
      name: "studio_mission_get",
      title: "seam probe",
      description: "row 31 seam probe",
      inputSchema: { type: "object", properties: {} },
      toolsets: ["missions"] as const,
      call: async (_a: Record<string, unknown>, s: { agentId: string; fileRoot: string }) => ({ content: [{ type: "text" as const, text: `${s.agentId}:${s.fileRoot}` }] }),
    }
    await expect(mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: PORT_EXT, log, facts: FACTS, extensions: [{ ...ext, name: "studio_render" }] })).rejects.toThrow(/duplicates/)
    const h2 = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: PORT_EXT, log, facts: FACTS, extensions: [ext] })
    const c = await client(PROJECT, "swarm", PORT_EXT)
    try {
      const names = (await c.listTools()).tools.map((t) => t.name)
      // I-2: the caller's studio_mission_get replaces the default mission group (no name registered twice).
      expect(names).toEqual([...EXPECTED_TOOLS, ...TEMPLATE_TOOLS, "studio_mission_get", ...ASSET_TOOLS])
      const r = await c.callTool({ name: "studio_mission_get", arguments: {} })
      expect((r.content as Array<{ text: string }>)[0].text).toBe(`swarm:${PROJECT}`)
    } finally {
      await c.close()
      await h2.close()
    }
  })

  test("host start refuses a bad token, a non-loopback hostname, and a store that is not the installed one", async () => {
    await expect(mod.startStudioHostServer({ store, token: "short", hostname: "127.0.0.1", port: 0, log })).rejects.toThrow(/token/)
    await expect(mod.startStudioHostServer({ store, token: TOKEN, hostname: "0.0.0.0" as "127.0.0.1", port: 0, log })).rejects.toThrow(/hostname/)
    await expect(mod.startStudioHostServer({ store: { close: async () => {} }, token: TOKEN, hostname: "127.0.0.1", port: 0, log })).rejects.toThrow(/installed store/)
  })
})

describe("row 31: tools run over LocalStudioApi and the real store; globalThis.fetch is never called", () => {
  test("templates, registry, create, import+submit, get, status, search, contracts, report template", async () => {
    const c = await client(PROJECT)
    try {
      const results: Record<string, Structured> = {}
      results.templates = await call(c, "studio_templates_list", {})
      results.template = await call(c, "studio_template_get", { slug: "datum-gsp" })
      results.registry = await call(c, "studio_registry", { kind: "slots" })
      results.create = await call(c, "studio_document_create", { template: "datum-gsp", mission: "2026-11-07_row31", docKey: "row31-doc", title: "Dokumen uji row 31" })
      const documentId = String(results.create.documentId ?? "")
      expect(documentId).toMatch(/^c[a-z0-9]{20,40}$/)
      results.importCheck = await call(c, "studio_chapter_import_markdown", { documentId, chapterKey: "1", markdown: "# Pendahuluan\n\nKalibrasi sensor dilakukan setiap bulan oleh tim lapangan.\n" })
      results.importSubmit = await call(c, "studio_chapter_import_markdown", {
        documentId,
        chapterKey: "1",
        markdown: "# Pendahuluan\n\nKalibrasi sensor dilakukan setiap bulan oleh tim lapangan.\n",
        submit: true,
        change: { what: "Bab 1 ditulis", why: "uji row 31", impact: "dokumen bertambah satu bab" },
      })
      results.get = await call(c, "studio_document_get", { documentId })
      results.status = await call(c, "studio_document_status", { documentId })
      results.search = await call(c, "studio_search", { q: "kalibrasi sensor" })
      results.contracts = await call(c, "studio_contracts_query", { mission: "2026-11-07_row31" })
      results.reportTemplate = await call(c, "studio_report_template", {})
      const summary = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.ok === true ? "ok" : `${v.code}`]))
      expect(summary).toEqual(Object.fromEntries(Object.keys(results).map((k) => [k, "ok"])))
      expect(JSON.stringify(results.search)).toContain(documentId)
      expect(fetchCalls).toBe(0)
    } finally {
      await c.close()
    }
  })

  test("studio_render reaches R17 (row 31c): an unknown document is DOCUMENT_NOT_FOUND, never a network call", async () => {
    const c = await client(PROJECT)
    try {
      const r = await call(c, "studio_render", { documentId: "cnotadoc0000000000000000", formats: ["docx"] })
      expect(r.ok).toBe(false)
      expect(r.code).toBe("DOCUMENT_NOT_FOUND")
      expect(fetchCalls).toBe(0)
    } finally {
      await c.close()
    }
  })
})

describe("row 31: LocalStudioApi router", () => {
  test("secret, origin, route and method checks", async () => {
    const { createLocalStudioApi } = await import("../../src/mcp-host/local-api/router.ts")
    const { LOCAL_ROUTES } = await import("../../src/mcp-host/local-api/routes.ts")
    const api = createLocalStudioApi({ baseUrl: "http://127.0.0.1:1", secret: "s".repeat(64), agentId: "claude", routes: LOCAL_ROUTES })
    const req = (url: string, secret: string, method = "GET") => api.fetch(url, { method, headers: { "x-internal-secret": secret, accept: "application/json" }, redirect: "manual" })
    expect((await req("http://127.0.0.1:1/api/studio/templates", "wrong")).status).toBe(401)
    expect((await req("http://127.0.0.1:1/api/studio/templates", "")).status).toBe(401)
    await expect(req("http://127.0.0.1:9021/api/studio/templates", "s".repeat(64))).rejects.toThrow(/serves only/)
    expect((await req("http://127.0.0.1:1/api/studio/nope", "s".repeat(64))).status).toBe(404)
    expect((await req("http://127.0.0.1:1/api/studio/templates", "s".repeat(64), "PATCH")).status).toBe(405)
    const r17 = await req("http://127.0.0.1:1/api/studio/documents/x/render", "s".repeat(64), "POST")
    expect(r17.status).toBe(400)
    expect(JSON.parse(await r17.text()).code).toBe("JSON_MALFORMED")
    const ok = await req("http://127.0.0.1:1/api/studio/templates?kind=DOCUMENT", "s".repeat(64))
    expect(ok.status).toBe(200)
    expect(fetchCalls).toBe(0)
  })

  test("no token or secret value appears in the host log lines", () => {
    const text = JSON.stringify(logs)
    expect(text).not.toContain(TOKEN)
    expect(logs.some((l) => l.message === "Studio MCP server listening")).toBe(true)
  })
})

describe("row 31: control (runs last) - the fetch trap does catch a fetch-based Studio call", () => {
  test("a vendored tool given globalThis.fetch hits the trap (so fetchCalls = 0 above is meaningful)", async () => {
    const { executeTool, McpSession } = await import("../../vendor/scripts/studio/mcp/tools")
    const { loadConfig } = await import("../../vendor/scripts/studio/mcp/config")
    const config = loadConfig({ INTERNAL_API_SECRET: "x".repeat(32), STUDIO_MCP_FILE_ROOTS: PROJECT, STUDIO_AGENT_ID: "claude" }, PROJECT)
    const before = fetchCalls
    const env = await executeTool("studio_templates_list", {}, { config, fetchImpl: globalThis.fetch as never, nfs: (await import("../../vendor/scripts/studio/mcp/safety")).REAL_NODE_FS, session: new McpSession() })
    expect(env.ok).toBe(false)
    expect(fetchCalls).toBeGreaterThan(before)
  })
})
