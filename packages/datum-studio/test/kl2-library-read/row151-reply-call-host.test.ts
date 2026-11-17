// Swarm 1.3.3 row 151 (senior review S2 + S8), end to end on the REAL host server (loopback; setup as in
// row100-library-read-host.test.ts). The create and start replies name, per matched domain, the call that records a
// read: the tool `datum-studio_studio_library_read` with path, mission and row, said in words (never `tool_name {json}`,
// MC-1/MC-3). This test builds those calls from the replies' STRUCTURED fields (knowledge rows, first files, the
// refusal's details), checks the text names the same tool and values, makes the calls in the host (Swarm strips the
// `datum-studio_` server prefix), then closes the rows: the read is recorded and the done gate lets the row close. A row
// whose call is not made is refused KNOWLEDGE_NOT_CONSULTED, so the gate is live. The trigger index lies under the
// index base (the bank text layer), the place only the reader looked before row 151: create matches only if both
// sides load the same file.
// Needs the command sandbox off (binds a port).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { SqliteStudioStore } from "../../src/store/index.ts"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW151_TEST_DIR ?? path.join(os.tmpdir(), "row151-reply-call")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "host-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const LIB = path.join(RES, "knowledge-library")
const BANK = path.join(LIB, "4 Knowledge Bank", "ekas-lapis-teks")
const PROJECT = path.join(HOME, "project-row151")
const NET = "05_DOMAIN-KNOWLEDGE/NETWORKING/RANTAI-JAMINAN.md"
const SKILL_FIRST = "skill:gsp-diagram-standard/references/index.md"
for (const d of [HOME, RES, PROJECT, path.join(BANK, "05_DOMAIN-KNOWLEDGE", "NETWORKING")]) mkdirSync(d, { recursive: true })
writeFileSync(path.join(BANK, ...NET.split("/")), "# Rantai jaminan jaringan\n")
writeFileSync(
  path.join(BANK, "indeks_pemicu.json"),
  JSON.stringify({
    how_to_use: "-",
    domains: { NETWORKING: { terms: ["jaringan", "switch"], read_order: [NET] }, "DIAGRAM-STANDARD": { terms: ["diagram", "topologi"], read_order: [SKILL_FIRST] } },
    weak: ["data"],
  }),
)
const SKILL = path.join(RES, "gsp-diagram-standard")
mkdirSync(path.join(SKILL, "references"), { recursive: true })
writeFileSync(path.join(SKILL, "references", "index.md"), "# Indeks rujukan diagram\n")

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
process.env.STUDIO_LIBRARY_ROOT = LIB
process.env.STUDIO_SKILL_ROOTS = JSON.stringify({ "gsp-diagram-standard": SKILL })
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row151 host test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
type Reply = { content: Array<{ text: string }>; isError?: boolean; structuredContent?: Record<string, any> }
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
const MID = "2026-11-18_row151-reply-call"
const row = (id: string, title: string) => ({ id, title, phase: "implementation", kind: "implementation", agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const call = async (name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Reply
const text = (r: Reply) => r.content.map((x) => x.text).join("\n")
const READ_TOOL = "datum-studio_studio_library_read"
const CALL_SHAPED = /[a-z_]+ \{"/
type Knowledge = { rows: Array<{ row: string; domains: Array<{ domain: string; firstFile: string }> }>; mission?: Array<{ domain: string; firstFile: string }> }
/** The read calls a reply's structured knowledge stands for, one per row domain. */
const callsOf = (mission: string, k: Knowledge) => k.rows.flatMap((r) => r.domains.map((d) => ({ path: d.firstFile, mission, row: r.row })))
/** The reply text names that call in words: the tool name, then the same values, quoted. */
const named = (t: string, a: { path: string; mission?: string; row?: string }) =>
  t.includes(`call the tool ${READ_TOOL} with path ${JSON.stringify(a.path)}${a.mission ? `, mission ${JSON.stringify(a.mission)}, row ${JSON.stringify(a.row)}` : ""}`)
/** Swarm exposes Studio host tools as `datum-studio_<tool>`; the host itself knows `<tool>`. */
const hostName = (tool: string) => {
  expect(tool.startsWith("datum-studio_")).toBe(true)
  return tool.slice("datum-studio_".length)
}

beforeAll(async () => {
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  store = await mod.openHostStore(STORE, { release: "1.3.3", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.3.3" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log: () => undefined, facts: FACTS })
  c = new Client({ name: "row151-host-test", version: "0" })
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
  delete process.env.STUDIO_LIBRARY_ROOT
  delete process.env.STUDIO_SKILL_ROOTS
})

describe("row 151: the reply's example call, made as written in the real host, records the read and lets the row close", () => {
  test("create -> approve -> start (reply calls) -> make the calls -> done; the row without a read is refused", async () => {
    const created = await call("studio_mission_create", {
      mission: { id: MID, title: "Rancang jaringan kantor", type: "feature-release", project: { dir: PROJECT }, rows: [row("1", "Pilih switch inti jaringan kampus"), row("2", "Gambar diagram topologi"), row("3", "Pasang switch jaringan lantai 2")] },
    })
    const createText = text(created)
    console.log(`[row151] create reply:\n${createText}`)
    expect(created.isError, createText).not.toBe(true)
    // the index under the bank text layer is the matcher's index too (S8)
    const M = (store as unknown as SqliteStudioStore).missions
    expect(M.rowContract(MID, "1").knowledge?.domains.map((d) => d.firstFile)).toEqual([NET])
    expect(M.rowContract(MID, "2").knowledge?.domains.map((d) => d.firstFile)).toEqual([SKILL_FIRST])
    expect(createText).not.toMatch(CALL_SHAPED)
    const createData = created.structuredContent as { id: string; knowledge: Knowledge }
    expect(callsOf(createData.id, createData.knowledge)).toEqual([
      { path: NET, mission: MID, row: "1" },
      { path: SKILL_FIRST, mission: MID, row: "2" },
      { path: NET, mission: MID, row: "3" },
    ])
    for (const a of callsOf(createData.id, createData.knowledge)) expect(named(createText, a), JSON.stringify(a)).toBe(true)
    // the mission title ("jaringan") is listed too, without mission and row (nothing to record on)
    expect(createData.knowledge.mission?.map((d) => d.firstFile)).toEqual([NET])
    expect(named(createText, { path: NET })).toBe(true)

    const s = store as unknown as SqliteStudioStore
    await s.transaction(async (t) => M.recordDecision(t, MID, { id: "U1", by: "user", date: "2026-11-18", text: "User approves" } as never, { attested: true } as never))
    await s.transaction(async (t) => M.approve(t, MID, "U1"))
    const started = await call("studio_mission_update_row", { mission: MID, rows: [{ id: "1", status: "running" }, { id: "2", status: "running" }, { id: "3", status: "running" }] })
    const startText = text(started)
    console.log(`[row151] start reply:\n${startText}`)
    expect(started.isError, startText).not.toBe(true)
    expect(startText).not.toMatch(CALL_SHAPED)
    const calls = callsOf(MID, (started.structuredContent as { knowledge: Knowledge }).knowledge)
    expect(calls.map((x) => x.row)).toEqual(["1", "2", "3"])
    for (const a of calls) expect(named(startText, a), JSON.stringify(a)).toBe(true)

    // make the calls of rows 1 and 2 with the values the reply gives
    for (const a of calls.filter((k) => k.row !== "3")) {
      const r = await call(hostName(READ_TOOL), a)
      console.log(`[row151] ${READ_TOOL} ${JSON.stringify(a)} -> ${text(r).split("\n").slice(0, 2).join(" | ")}`)
      expect(r.isError, text(r)).not.toBe(true)
      expect(r.structuredContent).toMatchObject({ ok: true, recorded: true })
    }
    expect(M.rowContract(MID, "2").knowledge?.domains[0]!.consulted).toEqual([SKILL_FIRST])

    const closed = await call("studio_mission_update_row", { mission: MID, rows: [{ id: "1", status: "done", note: "switch chosen" }, { id: "2", status: "done", note: "diagram drawn" }] })
    console.log(`[row151] done reply:\n${text(closed)}`)
    expect(closed.isError, text(closed)).not.toBe(true)
    expect(closed.structuredContent?.results).toEqual([
      { id: "1", ok: true },
      { id: "2", ok: true },
    ])
    const rows = M.get(MID)!.mission.rows
    expect(rows.find((r) => r.id === "1")!.status).toBe("done")
    expect(rows.find((r) => r.id === "2")!.status).toBe("done")

    // the gate is live: row 3 had its call printed but not made
    const refused = await call("studio_mission_update_row", { mission: MID, rows: [{ id: "3", status: "done", note: "installed" }] })
    console.log(`[row151] row 3 done reply:\n${text(refused)}`)
    expect(JSON.stringify(refused.structuredContent)).toContain("KNOWLEDGE_NOT_CONSULTED")
    expect(rows.find((r) => r.id === "3")!.status).toBe("running")
    // the refusal names the same call as the replies; made as written, it lets row 3 close
    expect(text(refused)).not.toMatch(CALL_SHAPED)
    console.log(`[row151] row 3 refusal structured: ${JSON.stringify(refused.structuredContent)}`)
    const details = findDetails(refused.structuredContent)
    expect(details).toEqual({ mission: MID, row: "3", domains: [{ domain: "NETWORKING", firstFile: NET }] })
    const read3 = { path: details!.domains[0]!.firstFile, mission: details!.mission, row: details!.row }
    expect(named(text(refused), read3)).toBe(true)
    expect((await call(hostName(READ_TOOL), read3)).structuredContent).toMatchObject({ ok: true, recorded: true })
    const closed3 = await call("studio_mission_update_row", { mission: MID, rows: [{ id: "3", status: "done", note: "installed" }] })
    expect(closed3.structuredContent?.results, text(closed3)).toEqual([{ id: "3", ok: true }])
  })
})

/** The KNOWLEDGE_NOT_CONSULTED details object ({mission, row, domains}) wherever the reply carries it. */
function findDetails(v: unknown): { mission: string; row: string; domains: Array<{ domain: string; firstFile: string }> } | undefined {
  if (!v || typeof v !== "object") return undefined
  const o = v as Record<string, unknown>
  if (typeof o.mission === "string" && typeof o.row === "string" && Array.isArray(o.domains)) return { mission: o.mission, row: o.row, domains: o.domains as Array<{ domain: string; firstFile: string }> }
  for (const x of Object.values(o)) {
    const hit = findDetails(x)
    if (hit) return hit
  }
  return undefined
}
