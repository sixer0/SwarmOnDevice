// 1.2.9 row 52, N9-130 (AC-C03, B9-C03; spec 01c §3.3, C13 OP-15-2): studio_mission_create never links an invented
// session ref given in `mission.sessions`. The H-N12 rule of the single `session` argument (1.2.8 row 31) now holds per
// entry, except that an entry the host cannot check is dropped with a SESSION_REF_IGNORED note instead of refused:
// (1) own client, ref = caller -> linked; (2) own client, another ref, caller known -> the caller is linked, one note;
// (3) own client, well formed, caller unknown -> dropped, one note, the create succeeds; (4) another link client
// (`claude` from a `swarm` session), well formed -> dropped, one note; (5) two entries that both become the caller ->
// one link, notes not doubled; (6) ill-formed refs keep the BASE (row 188) handling.
// Every case reads the mission's session links after the create. Through the REAL host server (port 0 on 127.0.0.1:
// needs the command sandbox off), like rel128-hn12. Synthetic refs only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.REL129_TEST_DIR ?? path.join(os.tmpdir(), "rel129-tests")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "c03-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-c03")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

const TOKEN = "c".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const CALLER = "ses_0123456789abSYN129CALLER01" // the calling session (well formed, 30 characters, synthetic)
const INVENTED = "ses_0123456789abSYN129INVENT01" // well formed, a different id
const CLAUDE_REF = "syn129-claude-session-0001" // well formed for client claude
const IGNORED = "SESSION_REF_IGNORED"
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
const mission = (id: string, sessions: S[]) => ({ id, title: "Rel 1.2.9 C03", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1")], sessions })
const linksOf = async (id: string) => ((await call("studio_mission_get", { mission: id })).mission.sessions as S[]).map((s) => `${s.client}:${s.ref}`).sort()
const notesOf = (r: S) => (r.sessionNotes ?? []) as string[]
const ignoredOf = (r: S) => notesOf(r).filter((n) => n.startsWith(IGNORED))

async function create(id: string, sessions: S[], meta?: S) {
  const r = await call("studio_mission_create", { mission: mission(id, sessions) }, meta)
  expect(r.ok).toBe(true)
  for (const n of notesOf(r)) expect(n).not.toContain(WORK) // notes carry refs and client ids, never a path
  return r
}

beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  const log = () => undefined
  store = await mod.openHostStore(STORE, { release: "1.2.9", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.9" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  swarm = new Client({ name: "rel129-c03", version: "1.0.0" })
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

describe("N9-130 AC-C03: studio_mission_create never links an invented session ref in mission.sessions", () => {
  test("(1) own client, ref = the calling session: linked, no note", async () => {
    const r = await create("2026-11-14_c03-one", [{ client: "swarm", ref: CALLER }], withCaller)
    expect(r.sessionNotes).toBeUndefined()
    expect(await linksOf("2026-11-14_c03-one")).toEqual([`swarm:${CALLER}`])
  })

  test("(2) own client, another well-formed ref, caller known: the caller is linked, one SESSION_REF_IGNORED note", async () => {
    const r = await create("2026-11-14_c03-two", [{ client: "swarm", ref: INVENTED }], withCaller)
    expect(await linksOf("2026-11-14_c03-two")).toEqual([`swarm:${CALLER}`])
    expect(ignoredOf(r)).toEqual([`${IGNORED}: mission.sessions ref ${INVENTED} is not the calling session; linked the calling session ${CALLER} instead`])
    expect(r.text).toContain(IGNORED)
  })

  test("(3) own client, well formed, caller unknown: the entry is dropped with one note, the create succeeds", async () => {
    const r = await create("2026-11-14_c03-three", [{ client: "swarm", ref: INVENTED }])
    expect(await linksOf("2026-11-14_c03-three")).toEqual([])
    expect(ignoredOf(r)).toEqual([`${IGNORED}: mission.sessions ref ${INVENTED} cannot be checked (the calling session is unknown); that entry was dropped`])
  })

  test("(4) another link client (claude from a swarm session), well formed: dropped with one note, caller known or not", async () => {
    const note = `${IGNORED}: mission.sessions entry of client claude was dropped (only the calling session is linked)`
    const known = await create("2026-11-14_c03-four-a", [{ client: "claude", ref: CLAUDE_REF }], withCaller)
    expect(await linksOf("2026-11-14_c03-four-a")).toEqual([`swarm:${CALLER}`])
    expect(ignoredOf(known)).toEqual([note])
    const unknown = await create("2026-11-14_c03-four-b", [{ client: "claude", ref: CLAUDE_REF }])
    expect(await linksOf("2026-11-14_c03-four-b")).toEqual([])
    expect(ignoredOf(unknown)).toEqual([note])
  })

  test("(5) two entries that both become the caller: one link, one note per replaced entry, not doubled", async () => {
    const r = await create("2026-11-14_c03-five", [{ client: "swarm", ref: CALLER }, { client: "swarm", ref: INVENTED }], withCaller)
    expect(await linksOf("2026-11-14_c03-five")).toEqual([`swarm:${CALLER}`])
    expect(ignoredOf(r)).toHaveLength(1)
    expect(new Set(notesOf(r)).size).toBe(notesOf(r).length)
    expect(r.text.split(IGNORED).length - 1).toBe(1)
  })

  test("(6) ill-formed refs keep the BASE handling: own entry -> the caller (or dropped), no SESSION_REF_IGNORED", async () => {
    const known = await create("2026-11-14_c03-six-a", [{ client: "swarm", ref: "ses_invented" }], withCaller)
    expect(await linksOf("2026-11-14_c03-six-a")).toEqual([`swarm:${CALLER}`])
    expect(notesOf(known)).toEqual([`mission.sessions: ref is not a swarm session id; the calling session ${CALLER} is linked instead`])
    const unknown = await create("2026-11-14_c03-six-b", [{ client: "swarm", ref: "ses_invented" }, { client: "claude", ref: "not a ref" }])
    expect(await linksOf("2026-11-14_c03-six-b")).toEqual([])
    expect(notesOf(unknown)).toEqual([
      "mission.sessions: ref is not a swarm session id; that entry was dropped (omit sessions; Swarm links the calling session)",
      "mission.sessions: ref is not a claude session id; that entry was dropped (omit sessions; Swarm links the calling session)",
    ])
  })
})
