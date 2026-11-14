// 1.2.9 row 39, AC-A13 (B9-A13, N9-115; consts N9-052, N9-053; security rule S9-17): every tool description in the
// host tools/list an agent reads (REAL host server on loopback, setup from row99-g06-host-list.test.ts) is at most
// 450 characters, `studio_render` included (its vendor text is trimmed, C10(c)), and the whole list stays at or under
// the BASE size. The clauses S9-17 names stay verbatim. The existing `< 74_000` pins stay where they are.
// Red at BASE (d4282fcfd8): 8 descriptions over 450 (studio_mission_update_row 971 the longest).
// Needs the command sandbox off (binds a port).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

/** N9-052: characters per host tool description. */
const HOST_DESCRIPTION_MAX = 450
/** N9-053: host tools/list bytes at BASE (d4282fcfd8); the list never grows past it. */
const HOST_TOOLS_LIST_BASE_BYTES = 73_748

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.REL129_TEST_DIR ?? path.join(os.tmpdir(), "rel129-a13")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "a13-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-syn129")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

const TOKEN = "f".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("rel129 A13 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
type Tool = { name: string; description?: string }
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
let tools: Tool[] = []
const log = () => undefined

beforeAll(async () => {
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  store = await mod.openHostStore(STORE, { release: "1.2.9", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.9" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS })
  c = new Client({ name: "rel129-a13-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "claude", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
  tools = (await c.listTools()).tools as Tool[]
})

afterAll(async () => {
  await c?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  globalThis.fetch = realFetch
})

const desc = (name: string): string => String(tools.find((t) => t.name === name)?.description ?? "")

describe("1.2.9 AC-A13: host tool descriptions", () => {
  test(`41 tools, every description <= ${HOST_DESCRIPTION_MAX} characters (N9-052)`, () => {
    expect(tools.length).toBe(41)
    const lengths = tools.map((t) => [t.name, String(t.description ?? "").length] as const).sort((a, b) => b[1] - a[1])
    console.log(`rel129 A13 longest descriptions: ${lengths.slice(0, 10).map(([n, l]) => `${n} ${l}`).join(", ")}`)
    expect(lengths.filter(([, l]) => l > HOST_DESCRIPTION_MAX)).toEqual([])
  })

  test(`serialised host tools/list <= ${HOST_TOOLS_LIST_BASE_BYTES} B (N9-053)`, () => {
    const bytes = Buffer.byteLength(JSON.stringify({ tools }))
    console.log(`rel129 A13 host tools/list: ${tools.length} tools, ${bytes} B`)
    expect(bytes).toBeLessThanOrEqual(HOST_TOOLS_LIST_BASE_BYTES)
  })

  test("S9-17: the kept clauses stay verbatim", () => {
    const upd = desc("studio_mission_update_row")
    expect(upd).toContain("is never executed")
    expect(upd).toContain("done still passes the output gate (OUTPUT_UNVERIFIED)")
    const put = desc("studio_asset_put")
    expect(put).toContain("inside the project folder of this session")
    expect(put).toContain("The result reports embedded metadata (GPS, EXIF, PNG text); Studio stores the bytes unchanged.")
    const st = desc("studio_mission_set_status")
    expect(st).toContain("cancelled (needs decision)")
    expect(st).toContain("MEMORY_INDEX_MISSING")
  })
})
