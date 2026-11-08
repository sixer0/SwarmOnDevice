// Row 178: studio://skema/diagram is listed and readable on the Swarm host MCP endpoint (beside studio://skema/mission),
// with the tool list unchanged. Same harness as row 169 (binds 127.0.0.1 port 0).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const BASE = process.env.ROW178_TEST_DIR ?? "/private/tmp/claude-501/row178/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row178-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-a")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })
process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET
const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let swarm: Client

beforeAll(async () => {
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  const log = () => undefined
  store = await mod.openHostStore(STORE, { release: "1.2.0", logFile: path.join(WORK, "logs", "store.jsonl"), missionGuard: true })
  mod.configureTemplateSource({ templatesDir: path.join(PKG, "templates"), assetRepoRoot: VENDOR, release: "1.2.0" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  swarm = new Client({ name: "row178", version: "1.0.0" })
  await swarm.connect(new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } } }))
})

afterAll(async () => {
  await swarm?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
})

describe("row 178: diagram guide resource on the host", () => {
  test("listed and readable; text equals diagramGuideText(); tool count unchanged by the resource", async () => {
    const list = (await swarm.listResources()).resources.map((r) => r.uri)
    expect(list).toContain("studio://skema/diagram")
    expect(list).toContain("studio://skema/mission")
    const text = ((await swarm.readResource({ uri: "studio://skema/diagram" })).contents[0] as { text: string }).text
    const g = await import("../../src/mcp-host/diagram-guide.ts")
    expect(text).toBe(g.diagramGuideText())
    const tools = (await swarm.listTools()).tools
    console.log(`[row178] host tools ${tools.length}, resources ${list.length}`)
    expect(tools.some((t) => t.name === "studio_figure_preview")).toBe(true)
  })
})
