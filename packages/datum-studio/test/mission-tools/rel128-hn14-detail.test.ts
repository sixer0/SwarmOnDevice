// 1.2.8 row 31, N8-329 (AT-HN14, H-N14): `detail` works on studio_mission_get and on the registry.
// (a) studio_mission_get {mission, detail: true} is accepted (N8-204) and its text lists every row; detail: false
//     (the default) keeps the compact text.
// (b) studio_registry: detail applies to every kind (VS/tools.ts, 128-31-hn14). A kind whose items carry aliases or
//     labels differs between detail true and false; a kind with neither is equal, and the field description says
//     detail has no effect there.
// Through the REAL host server (port 0 on 127.0.0.1: needs the command sandbox off), like row 188.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.REL128_TEST_DIR ?? path.join(os.tmpdir(), "rel128-tests")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "hn14-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-hn14")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const M = "2026-11-14_hn14-detail"
type S = Record<string, any>

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let swarm: Client

async function call(name: string, args: S): Promise<S & { text: string }> {
  const r = await swarm.callTool({ name, arguments: args })
  return { ...(r.structuredContent as S), text: (r.content as Array<{ text: string }>).map((c) => c.text).join("\n") }
}
const row = (id: string) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id} title`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })

beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  const log = () => undefined
  store = await mod.openHostStore(STORE, { release: "1.2.8", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.8" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  swarm = new Client({ name: "rel128-hn14", version: "1.0.0" })
  await swarm.connect(new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } } }))
  const c = await call("studio_mission_create", { mission: { id: M, title: "Rel 1.2.8 HN14", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1"), row("2")] } })
  expect(c.ok).toBe(true)
}, 60_000)

afterAll(async () => {
  await swarm?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
})

describe("N8-329 AT-HN14 (a): studio_mission_get detail", () => {
  test("detail: true is accepted and lists every row; the default text stays compact", async () => {
    const full = await call("studio_mission_get", { mission: M, detail: true })
    expect(full.code).toBeUndefined()
    expect(full.ok).toBe(true)
    expect(full.text).toContain("  row 1 [implementation/implementation] pending: Row 1 title")
    expect(full.text).toContain("  row 2 [implementation/implementation] pending: Row 2 title")
    const compact = await call("studio_mission_get", { mission: M })
    expect(compact.ok).toBe(true)
    expect(compact.text).not.toContain("  row 1 [")
    expect((await call("studio_mission_get", { mission: M, detail: false })).text).toBe(compact.text)
    expect(full.text.startsWith(compact.text)).toBe(true)
  })
})

describe("N8-329 AT-HN14 (b): studio_registry detail applies to every kind", () => {
  const KINDS = ["contracts", "sections", "params", "charts", "diagram", "symbols", "lint", "roles", "presets", "essentials", "slots", "paramScopes"]
  const carries = (items: unknown[]) => items.some((it) => it !== null && typeof it === "object" && ("aliases" in (it as S) || "labels" in (it as S)))

  test("aliases/labels kinds differ with detail; the others are equal and the description says detail has no effect there", async () => {
    const seen: Array<{ kind: string; carries: boolean; differs: boolean }> = []
    for (const kind of KINDS) {
      const off = await call("studio_registry", { kind, detail: false })
      const on = await call("studio_registry", { kind, detail: true })
      expect(off.ok, kind).not.toBe(false)
      const c = carries(on.items ?? [])
      const differs = JSON.stringify(on.items) !== JSON.stringify(off.items)
      seen.push({ kind, carries: c, differs })
      expect(differs, kind).toBe(c)
      expect(carries(off.items ?? []), kind).toBe(false)
    }
    console.log(`[rel128-hn14] registry detail per kind: ${JSON.stringify(seen)}`)
    expect(seen.some((s) => s.carries)).toBe(true)
    const tools = (await swarm.listTools()).tools
    const desc = String((tools.find((t) => t.name === "studio_registry")!.inputSchema.properties as S).detail.description)
    expect(desc).toContain("Semua kind")
    expect(desc).toContain("tanpa efek bila butir tanpa alias/label")
  }, 60_000)
})
