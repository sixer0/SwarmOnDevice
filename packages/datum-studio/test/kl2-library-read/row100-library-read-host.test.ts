// Swarm 1.3.3 row 100 (KL-2): `studio_library_read` on the REAL host server (loopback; setup from
// rel129-a13-host-descriptions.test.ts). start.ts reads STUDIO_LIBRARY_ROOT (C7 item 6) and the tool is listed under the
// register name; a read with mission and row of a running row is stored in the row's `knowledge`; the tools/list size
// is printed against the 73 748 B pin (N9-053).
// Needs the command sandbox off (binds a port).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { SqliteStudioStore } from "../../src/store/index.ts"
import type { MissionRowInput } from "../../src/store/mission/index.ts"

const HOST_TOOLS_LIST_BASE_BYTES = 73_748

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW100_TEST_DIR ?? path.join(os.tmpdir(), "row100-library-read")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "host-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const LIB = path.join(RES, "knowledge-library")
const PROJECT = path.join(HOME, "project-row100")
const FIRST = "05_DOMAIN-KNOWLEDGE/NETWORKING/RANTAI-JAMINAN.md"
for (const d of [HOME, RES, PROJECT, path.join(LIB, "4 Knowledge Bank", "ekas-lapis-teks", "05_DOMAIN-KNOWLEDGE", "NETWORKING")]) mkdirSync(d, { recursive: true })
writeFileSync(path.join(LIB, "4 Knowledge Bank", "ekas-lapis-teks", ...FIRST.split("/")), "# Rantai jaminan jaringan\n")
// the trigger index at the library root, where row 101's matcher and this tool both look
writeFileSync(path.join(LIB, "indeks_pemicu.json"), JSON.stringify({ how_to_use: "-", domains: { NETWORKING: { terms: ["jaringan", "switch"], read_order: [FIRST] } }, weak: ["data"] }))
// C33: the diagram skill on disk, passed as STUDIO_SKILL_ROOTS
const SKILL = path.join(RES, "gsp-diagram-standard")
mkdirSync(path.join(SKILL, "references", "pages"), { recursive: true })
writeFileSync(path.join(SKILL, "references", "index.md"), "# Indeks rujukan diagram\n")
writeFileSync(path.join(SKILL, "references", "pages", "p028.jpg"), new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
process.env.STUDIO_LIBRARY_ROOT = LIB
process.env.STUDIO_SKILL_ROOTS = JSON.stringify({ "gsp-diagram-standard": SKILL })
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

const TOKEN = "f".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row100 host test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
type Tool = { name: string; description?: string; inputSchema?: unknown }
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
let tools: Tool[] = []
const MID = "2026-11-17_row100-host"

beforeAll(async () => {
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  store = await mod.openHostStore(STORE, { release: "1.3.3", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.3.3" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log: () => undefined, facts: FACTS })
  c = new Client({ name: "row100-host-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "claude", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
  tools = (await c.listTools()).tools as Tool[]
  // a mission whose row 1 runs with one knowledge domain (the setters are host-only; row 101 will set it at start)
  const s = store as unknown as SqliteStudioStore
  const M = s.missions
  const row = { id: "1", phase: "implementation", kind: "implementation", title: "Pasang switch jaringan", agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: "implementation/1.md", verification: "tests pass" } satisfies MissionRowInput
  await s.transaction(async (t) => M.create(t, { id: MID, title: "Row 100 host", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row], decisions: [{ id: "U1", by: "user", date: "2026-11-17", text: "User approves" }] }, { attested: true }))
  await s.transaction(async (t) => M.setRowKnowledge(t, MID, "1", { domains: [{ domain: "NETWORKING", firstFile: FIRST, consulted: [] }] }))
  await s.transaction(async (t) => M.approve(t, MID, "U1"))
  await s.transaction(async (t) => M.updateRows(t, MID, [{ id: "1", status: "running" }]))
})

afterAll(async () => {
  await c?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  globalThis.fetch = realFetch
  delete process.env.STUDIO_LIBRARY_ROOT
  delete process.env.STUDIO_SKILL_ROOTS
})

describe("row 100: studio_library_read on the host", () => {
  test("listed once under the register name; tools/list size against the pin", () => {
    expect(tools.filter((t) => t.name === "studio_library_read").length).toBe(1)
    const entry = Buffer.byteLength(JSON.stringify(tools.find((t) => t.name === "studio_library_read")))
    const bytes = Buffer.byteLength(JSON.stringify({ tools }))
    console.log(`row100 host tools/list: ${tools.length} tools, ${bytes} B (entry ${entry} B, ${HOST_TOOLS_LIST_BASE_BYTES - bytes} B left of ${HOST_TOOLS_LIST_BASE_BYTES})`)
    expect(bytes).toBeLessThanOrEqual(HOST_TOOLS_LIST_BASE_BYTES)
  })

  test("serves a library file from STUDIO_LIBRARY_ROOT and records the read on the running row", async () => {
    const plain = (await c.callTool({ name: "studio_library_read", arguments: { path: FIRST } })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(plain.isError).not.toBe(true)
    expect(plain.content[0]!.text).toContain("# Rantai jaminan jaringan")
    expect(plain.content[0]!.text).toContain("not recorded")
    expect((store as unknown as SqliteStudioStore).missions.rowContract(MID, "1").knowledge?.domains[0]!.consulted).toEqual([])
    const r = (await c.callTool({ name: "studio_library_read", arguments: { path: FIRST, mission: MID, row: "1" } })) as { content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }
    expect(r.content[0]!.text).toContain(`recorded: mission ${MID} row 1 (NETWORKING)`)
    expect(r.structuredContent).toMatchObject({ recorded: true, recordedDomains: ["NETWORKING"] })
    expect((store as unknown as SqliteStudioStore).missions.rowContract(MID, "1").knowledge?.domains[0]!.consulted).toEqual([FIRST])
    const out = (await c.callTool({ name: "studio_library_read", arguments: { path: "../../../../home/x.md" } })) as { isError?: boolean; structuredContent?: Record<string, unknown> }
    expect(out.isError).toBe(true)
    expect(out.structuredContent?.code).toBe("PATH_INVALID")
  })

  test("C33: a skill file and a skill image are served through STUDIO_SKILL_ROOTS", async () => {
    const md = (await c.callTool({ name: "studio_library_read", arguments: { path: "skill:gsp-diagram-standard/references/index.md" } })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(md.isError).not.toBe(true)
    expect(md.content[0]!.text).toContain("# Indeks rujukan diagram")
    const jpg = (await c.callTool({ name: "studio_library_read", arguments: { path: "skill:gsp-diagram-standard/references/pages/p028.jpg" } })) as { structuredContent?: Record<string, unknown> }
    expect(jpg.structuredContent).toMatchObject({ image: true, file: realpathSync(path.join(SKILL, "references", "pages", "p028.jpg")), bytes: { total: 4 } })
  })

  test("row 101 seam: studio_mission_create in the real host stores knowledge from the same root; the read tool serves that first file", async () => {
    const id = "2026-11-17_row100-host-match"
    const created = (await c.callTool({ name: "studio_mission_create", arguments: { mission: { id, title: "Rancang jaringan kantor", type: "feature-release", project: { dir: PROJECT }, rows: [{ id: "1", title: "Pilih switch inti jaringan kampus", phase: "implementation", kind: "implementation", agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: "implementation/1.md", verification: "tests pass" }] } } })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(created.isError, created.content[0]?.text).not.toBe(true)
    const k = (store as unknown as SqliteStudioStore).missions.rowContract(id, "1").knowledge
    expect(k?.domains.map((d) => [d.domain, d.firstFile])).toEqual([["NETWORKING", FIRST]])
    const r = (await c.callTool({ name: "studio_library_read", arguments: { path: k!.domains[0]!.firstFile } })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(r.isError).not.toBe(true)
    expect(r.content[0]!.text).toContain("# Rantai jaminan jaringan")
  })
})
