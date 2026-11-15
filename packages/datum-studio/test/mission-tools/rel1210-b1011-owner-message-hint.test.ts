// N10-201 AC-B1011 (Swarm 1.2.10). Row 73 writes case O1 (the owner-message refusal text, N10-006, N10-007);
// row 74 extends this file with O2-O4 (the per-tool hint, OWNER_ONLY, parity with nextCall). Synthetic fixtures only (syn1210).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

type S = any // eslint-disable-line @typescript-eslint/no-explicit-any

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.REL1210_TEST_DIR ?? path.join(tmpdir(), "rel1210-tests")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "b1011-syn1210-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "syn1210-project")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const KEY = "8b".repeat(16) + "fedcba9876543210".repeat(2)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const HEADER = "x-swarm-mission-control-key"
const MISSION = "2026-11-15_syn1210-b1011-owner"
/** N10-006: the owner-message refusal text (row 73). */
const OWNER_REFUSAL = "only the person writes an owner message, from Mission Control in the Swarm app (this request is not attested)"
const ROW1 = { id: "1", phase: "implementation", kind: "implementation", title: "Row 1", agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: "implementation/1.md", verification: "tests pass" }

let mod: S
let store: S
let host: S
const clients: Client[] = []

async function client(agent: string, key?: string): Promise<Client> {
  const c = new Client({ name: "b1011-test", version: "0" })
  const t = new StreamableHTTPClientTransport(new URL(host.url), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": agent, "x-studio-caller-cwd": encodeURIComponent(PROJECT), ...(key !== undefined ? { [HEADER]: key } : {}) } },
  })
  await c.connect(t)
  clients.push(c)
  return c
}
async function call(c: Client, name: string, args: S): Promise<S> {
  const r = await c.callTool({ name, arguments: args })
  return (r.structuredContent ?? {}) as S
}
async function snapshot(): Promise<S> {
  return store.transaction(async (tx: S) => ({
    mission: tx.all("SELECT id, status, project_dir FROM mission ORDER BY id"),
    message: tx.all("SELECT mission_id, seq, from_party FROM mission_message ORDER BY seq"),
    events: (tx.get("SELECT COUNT(*) AS n FROM mission_event") as S).n,
  }))
}

beforeAll(async () => {
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetBridgePdfReadiness()
  resetRenderRateLimiter()
  mod = await import("../../src/mcp-host/index.ts")
  store = await mod.openHostStore(STORE, { release: "1.2.10", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.10" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, missionControlKey: KEY, hostname: "127.0.0.1", port: 0, log: () => undefined, facts: FACTS } as never)
})

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
})

describe("N10-201 AC-B1011 row 73: the owner-message refusal has its own text (O1)", () => {
  test("setup: an attested session creates the mission", async () => {
    const mc = await client("swarm", KEY)
    const r = await call(mc, "studio_mission_create", { mission: { id: MISSION, title: "Syn1210 owner message", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [ROW1] } })
    expect(r.ok, JSON.stringify(r.error)).toBe(true)
  })

  test("O1 update_row with one from: owner message from an unattested session: refused SESSION_NOT_ATTESTED with the N10-006 text, dry run too, store unchanged", async () => {
    const c = await client("claude")
    const before = await snapshot()
    for (const dryRun of [false, true]) {
      const r = await call(c, "studio_mission_update_row", {
        mission: MISSION,
        messages: [{ from: "agent", to: "controller", kind: "report", text: "ok" }, { from: "owner", to: "controller", kind: "instruction", text: "stop the release" }],
        ...(dryRun ? { dryRun } : {}),
      })
      const why = `dryRun=${dryRun}`
      expect(r.ok, why).toBe(false)
      expect(r.code, why).toBe("SESSION_NOT_ATTESTED")
      expect(r.error.message, why).toBe(OWNER_REFUSAL)
      expect(r.error.message.includes("owner message"), why).toBe(true)
      expect(r.error.message.includes("answers as the person"), why).toBe(false)
      // Detail stays path-free: { mission, agent } only.
      expect(r.error.details, why).toEqual({ mission: MISSION, agent: "claude" })
    }
    expect(await snapshot()).toEqual(before)
  })

  test("the answer, record and create refusals keep the 1.2.9 message (only the owner caller changed)", async () => {
    const c = await client("claude")
    const mc = await client("swarm", KEY)
    expect((await call(mc, "studio_mission_request_decision", { mission: MISSION, request: { id: "D-1", question: "Which one?", options: [{ id: "A", label: "A", consequence: "a" }, { id: "B", label: "B", consequence: "b" }] } })).ok).toBe(true)
    const old = "only the person answers as the person, from Mission Control in the Swarm app (this request is not attested)"
    const ans = await call(c, "studio_mission_answer_decision", { mission: MISSION, request: "D-1", option: "A", by: "user", decisionId: "U1" })
    const rec = await call(c, "studio_mission_record_decision", { mission: MISSION, decision: { id: "U2", by: "user", date: "2026-11-15", text: "go" } })
    const cr = await call(c, "studio_mission_create", { mission: { id: "2026-11-15_syn1210-b1011-create", title: "Syn1210 create", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [ROW1], decisions: [{ id: "U1", by: "user", date: "2026-11-15", text: "go" }] } })
    for (const [why, r] of [["answer", ans], ["record", rec], ["create", cr]] as const) {
      expect(r.code, why).toBe("SESSION_NOT_ATTESTED")
      expect(r.error.message, why).toBe(old)
    }
  })
})
