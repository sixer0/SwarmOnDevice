// 1.2.8 row 31, N8-328 (AT-HN12, H-N12): an invented but well-formed session ref is never linked.
// (a) caller session known (_meta "studio/callerSession"), a different well-formed ref: the link is the caller's ref
//     and the result carries N8-203 SESSION_REF_IGNORED naming both refs.
// (b) no caller session known, the same ref: refused N8-202 SESSION_UNKNOWN, next step "omit session; Swarm links the
//     calling session itself"; nothing stored.
// (c) a malformed ref keeps the 1.2.7 row 188 behaviour (skip with a note); (d) studio_mission_list's session is a filter.
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
const WORK = realpathSync(mkdtempSync(path.join(BASE, "hn12-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-hn12")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const CALLER = "ses_0123456789abABCDEFGHIJ0123" // the real calling session (well-formed, 30 characters)
const INVENTED = "ses_0123456789abINVENTEDxxxxxx" // well-formed, a different id (AT-HN12)
const NEXT_STEP = "omit session; Swarm links the calling session itself"
type S = Record<string, any>

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let swarm: Client

async function call(name: string, args: S, meta?: S): Promise<S & { text: string }> {
  const r = await swarm.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })
  return { ...(r.structuredContent as S), text: (r.content as Array<{ text: string }>).map((c) => c.text).join("\n") }
}
const withCaller = { "studio/callerSession": CALLER }
const row = (id: string) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const mission = (id: string) => ({ id, title: "Rel 1.2.8 HN12", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1")] })
const sessionsOf = async (id: string) => ((await call("studio_mission_get", { mission: id })).mission.sessions as S[]).map((s) => `${s.client}:${s.ref}`)

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
  swarm = new Client({ name: "rel128-hn12", version: "1.0.0" })
  await swarm.connect(new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } } }))
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

describe("N8-328 AT-HN12: an invented well-formed session ref is not linked", () => {
  test("(a) caller known, different ref: linked to the caller, SESSION_REF_IGNORED names both refs", async () => {
    const r = await call("studio_mission_create", { mission: mission("2026-11-14_hn12-a"), session: { ref: INVENTED, role: "controller" } }, withCaller)
    expect(r.ok).toBe(true)
    expect(await sessionsOf("2026-11-14_hn12-a")).toEqual([`swarm:${CALLER}`])
    const notes = (r.sessionNotes ?? []) as string[]
    const ignored = notes.find((n) => n.startsWith("SESSION_REF_IGNORED"))
    expect(ignored).toBeDefined()
    expect(ignored).toContain(INVENTED)
    expect(ignored).toContain(CALLER)
    expect(r.text).toContain("SESSION_REF_IGNORED")
  })

  test("(a') caller known, the caller's own ref: linked as given, no note", async () => {
    const r = await call("studio_mission_create", { mission: mission("2026-11-14_hn12-own"), session: { ref: CALLER } }, withCaller)
    expect(r.ok).toBe(true)
    expect(r.sessionNotes).toBeUndefined()
    expect(await sessionsOf("2026-11-14_hn12-own")).toEqual([`swarm:${CALLER}`])
  })

  test("(b) no caller known, well-formed ref: refused SESSION_UNKNOWN with the next step, nothing stored", async () => {
    const r = await call("studio_mission_create", { mission: mission("2026-11-14_hn12-b"), session: { ref: INVENTED } })
    expect(r.ok).toBe(false)
    expect(r.code).toBe("SESSION_UNKNOWN")
    expect(String(r.next).startsWith(NEXT_STEP)).toBe(true)
    expect(r.text.trim().split("\n").at(-1)).toBe(`next: ${r.next}`)
    expect((await call("studio_mission_get", { mission: "2026-11-14_hn12-b" })).code).toBe("MISSION_NOT_FOUND")
    // the same holds for a write on an existing mission
    const f = await call("studio_mission_record_finding", { mission: "2026-11-14_hn12-a", finding: { id: "1-X", severity: "low", title: "t", sourceRow: "1", ownerRow: "1", status: "open" }, session: { ref: INVENTED } })
    expect(f.code).toBe("SESSION_UNKNOWN")
  })

  test("(c) a malformed ref keeps the row 188 behaviour: no refusal, no link, a note", async () => {
    const r = await call("studio_mission_create", { mission: mission("2026-11-14_hn12-c"), session: { ref: "ses_invented" } })
    expect(r.ok).toBe(true)
    expect(r.text).toContain("omit session; Swarm fills it")
    expect(await sessionsOf("2026-11-14_hn12-c")).toEqual([])
  })

  test("(d) studio_mission_list: session is a filter, an unknown ref is not refused", async () => {
    const l = await call("studio_mission_list", { session: { ref: INVENTED } })
    expect(l.ok).toBe(true)
    expect(l.items).toEqual([])
  })
})
