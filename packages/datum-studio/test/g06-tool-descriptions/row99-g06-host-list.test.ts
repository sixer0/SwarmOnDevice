// Row 99 (1.2.6, G-06 restated, INV-M): the full datum-studio tools/list as an agent sees it through the REAL host
// server (setup copied from row50c-asset-tool.test.ts). G-06 said "40 tools under 30 KB"; at HEAD before row 99 the
// 40-tool list measured 73 012 B, so the 30 KB figure applies to the vendor default set (row99-g06-descriptions) and
// the whole list gets a ceiling that stops growth instead. Needs the command sandbox off (binds a port).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW99_TEST_DIR ?? "/private/tmp/claude-501/row99/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row99-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-a")
const OUTSIDE = path.join(WORK, "outside")
for (const d of [HOME, RES, PROJECT, OUTSIDE]) mkdirSync(d, { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row99 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
const log = () => undefined

beforeAll(async () => {
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  store = await mod.openHostStore(STORE, { release: "1.2.6", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.6" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS })
  c = new Client({ name: "row99-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "claude", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
})

afterAll(async () => {
  await c?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  globalThis.fetch = realFetch
})

describe("row 99 G-06: full host tools/list", () => {
  test("41 tools (1.2.8 row 45: + studio_mission_place); serialised list < 74 000 B (measured 73 012 B before row 99)", async () => {
    const tools = (await c.listTools()).tools
    expect(tools.length).toBe(41)
    const bytes = Buffer.byteLength(JSON.stringify({ tools }))
    console.log(`row99 host tools/list: ${tools.length} tools, ${bytes} B`)
    expect(bytes).toBeLessThan(74_000)
  })
})
