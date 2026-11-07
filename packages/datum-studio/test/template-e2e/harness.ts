// Row 69 (test-expert): shared harness for the template end-to-end scenarios. Not a test file itself.
//
// Real: a temp DATUM Studio store, the row 31 host server (`startStudioHostServer`) with the row 68
// `templateHostExtension()` passed through the `extensions` seam, the row 67 guard that the host installs at start,
// the row 66 service, the vendored ingest / renderSnapshot / lint, and MCP over the host's streamable-HTTP endpoint
// (one session per agent, as the bridge opens them: `X-Studio-Agent`, `X-Studio-Caller-Cwd`, bearer token).
// Stand-in: ONLY the render-bridge transport (`setRenderBridgeTransport`, the row 108 seam), because Electron cannot
// run under bun. It answers `hello`, `checkPage` (paged, no elements) and `pdf`.
// globalThis.fetch is a trap for the host; the test's MCP clients use the fetch captured before the trap.
// Port: 127.0.0.1:<ephemeral>; run with the command sandbox off.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export const PKG = path.resolve(import.meta.dir, "..", "..")
export const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")

export type Rec = Record<string, unknown>
export type Reply = Rec & { ok?: boolean; code?: string; isError?: boolean }

export interface Harness {
  work: string
  store: string
  port: number
  token: string
  clientOf(agent: "claude" | "swarm"): Promise<Client>
  call(c: Client, name: string, args: Rec): Promise<Reply>
  q<T = Rec>(sql: string, params?: unknown[]): T[]
  raw(o: { body: string | Buffer; headers?: Record<string, string> }): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>
  bridgeOps: string[]
  fetchCalls(): number
  services: {
    service: typeof import("../../vendor/src/lib/studio/services/templates/service")
    guard: typeof import("../../vendor/src/lib/studio/services/templates/guard")
    templates: typeof import("../../vendor/src/lib/studio/services/templates")
  }
  close(): Promise<void>
}

export async function startHarness(name: string): Promise<Harness> {
  const base = process.env.ROW69_TEST_DIR ?? "/private/tmp/claude-501/row69/tests"
  mkdirSync(base, { recursive: true })
  const work = realpathSync(mkdtempSync(path.join(base, `${name}-`)))
  const store = path.join(work, "datum-studio")
  const home = path.join(work, "home")
  const res = path.join(work, "Swarm.app", "Contents", "Resources")
  const projects = { claude: path.join(home, "proyek-claude"), swarm: path.join(home, "proyek-swarm") }
  for (const d of [home, res, projects.claude, projects.swarm, path.join(work, "logs")]) mkdirSync(d, { recursive: true })

  process.env.STUDIO_WORKSPACE_ROOT = store
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  delete process.env.DATUM_RENDER_SOCKET
  delete process.env.DATUM_RENDER_TOKEN

  const realFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    throw new Error("row69 harness: globalThis.fetch must not be called by the host")
  }) as unknown as typeof fetch

  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  const resetCaches = () => {
    resetStudioEnvCache()
    resetBridgePdfReadiness()
    resetRenderRateLimiter()
  }
  resetCaches()
  const runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")
  const bridgeOps: string[] = []
  runtime.setRenderBridgeTransport(async (req) => {
    bridgeOps.push(req.op)
    if (req.op === "hello") return { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
    if (req.op === "checkPage") return { ok: true, electron: "42.3.3", script: "studio.measure", result: { paged: true, pageCount: 6, truncated: false, elements: [] } }
    if (req.op === "pdf") {
      writeFileSync(String(req.dst), Buffer.from("%PDF-1.7\n1 0 obj<</Type /Pages /Count 6>>endobj\n%%EOF\n", "latin1"))
      return { ok: true, electron: "42.3.3", dst: req.dst }
    }
    return { ok: false, code: "UNKNOWN_OP", message: req.op }
  })

  // Host pieces from their own modules (not the src/mcp-host barrel, which also loads row 119b's mission module).
  const start = await import("../../src/mcp-host/start.ts")
  const bridge = await import("../../src/store-bridge/index.ts")
  const ext = await import("../../src/mcp-host/templates/index.ts")
  const templates = await import("../../vendor/src/lib/studio/services/templates")
  const service = await import("../../vendor/src/lib/studio/services/templates/service")
  const guard = await import("../../vendor/src/lib/studio/services/templates/guard")
  const st = await bridge.openHostStore(store, { release: "1.2.0", logFile: path.join(work, "logs", "store.jsonl") })
  templates.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" })
  const token = "9".repeat(16) + "0123456789abcdef".repeat(3)
  const host = await start.startStudioHostServer({
    store: st,
    token,
    hostname: "127.0.0.1",
    port: 0,
    log: () => undefined,
    facts: { home, resourcesPath: res, execPath: path.join(work, "Swarm.app", "Contents", "MacOS", "Swarm") },
    extensions: ext.templateHostExtension(),
  })
  const clients: Client[] = []

  const q = <T = Rec>(sql: string, params: unknown[] = []): T[] => (st as unknown as { requireReader(): { all(s: string, p?: unknown[]): unknown[] } }).requireReader().all(sql, params) as T[]

  return {
    work,
    store,
    port: host.port,
    token,
    bridgeOps,
    fetchCalls: () => fetchCalls,
    services: { service, guard, templates },
    q,
    async clientOf(agent) {
      const c = new Client({ name: `row69-${agent}`, version: "0" })
      const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${host.port}/mcp`), {
        fetch: realFetch as never,
        requestInit: { headers: { authorization: `Bearer ${token}`, "x-studio-agent": agent, "x-studio-caller-cwd": encodeURIComponent(projects[agent]) } },
      })
      await c.connect(t)
      clients.push(c)
      return c
    },
    async call(c, name, args) {
      const r = await c.callTool({ name, arguments: args })
      return { ...((r.structuredContent ?? {}) as Rec), ...(r.isError ? { isError: true } : {}) } as Reply
    },
    raw(o) {
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: host.port,
            agent: false,
            path: "/mcp",
            method: "POST",
            headers: { host: `127.0.0.1:${host.port}`, authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...o.headers },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on("data", (b: Buffer) => chunks.push(b))
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }))
          },
        )
        // The host answers 413 before reading the body and drops the socket; a write error after that is expected.
        req.on("error", (e: NodeJS.ErrnoException) => (e.code === "EPIPE" || e.code === "ECONNRESET" ? undefined : reject(e)))
        req.end(o.body)
      })
    },
    async close() {
      for (const c of clients) await c.close().catch(() => undefined)
      await host.close()
      templates.configureTemplateSource(null)
      await bridge.closeHostStore(st)
      runtime.setRenderBridgeTransport(null)
      globalThis.fetch = realFetch
      resetCaches()
    },
  }
}

/** Template and version counts, for "nothing saved" assertions. */
export function counts(h: Harness): { templates: number; versions: number } {
  return {
    templates: Number(h.q<{ n: number }>("SELECT count(*) AS n FROM template")[0].n),
    versions: Number(h.q<{ n: number }>("SELECT count(*) AS n FROM template_version")[0].n),
  }
}

export function versionRow(h: Harness, slug: string, no: number): Rec {
  return h.q("SELECT v.* FROM template_version v JOIN template t ON t.id = v.template_id WHERE t.slug = ? AND v.version_no = ?", [slug, no])[0]
}

export function latestNo(h: Harness, slug: string): number {
  return Number(h.q<{ n: number }>("SELECT latest_version_no AS n FROM template WHERE slug = ?", [slug])[0]?.n ?? 0)
}
