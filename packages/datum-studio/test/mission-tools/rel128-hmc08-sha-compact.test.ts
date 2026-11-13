// 1.2.8 row 31, N8-330 (AT-HMC08, H-MC08): the compact studio_mission_get text prints the full deliverable sha256.
// A mission with 2 verified deliverables: one line per deliverable output "  deliverable <path> sha256 <64 hex>",
// the sha equal to the stored output's, no truncation. A mission without deliverables prints no such line.
// Harness after rows 126/136b: REAL host server (port 0 on 127.0.0.1: needs the command sandbox off), temp store.
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
const WORK = realpathSync(mkdtempSync(path.join(BASE, "hmc08-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-hmc08")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

async function resetEnvCache() {
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  const { resetQueryRateLimiter } = await import("../../vendor/src/lib/studio/http/quota")
  const { resetImportRateLimiter } = await import("../../src/mcp-host/local-api/routes/import-rate.ts")
  const { resetValidateRateLimiter } = await import("../../src/mcp-host/local-api/routes/validate-rate.ts")
  resetStudioEnvCache()
  resetRenderRateLimiter()
  resetQueryRateLimiter()
  resetImportRateLimiter()
  resetValidateRateLimiter()
}

const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const M = "2026-11-14_hmc08-two"
const M_EMPTY = "2026-11-14_hmc08-none"
const LINE = /^ {2}deliverable (\S+) sha256 ([0-9a-f]{64})$/
type S = Record<string, any>

const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("rel128-hmc08 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => {
  if (level === "error") console.log(`[rel128-hmc08] host error ${source}: ${message} ${JSON.stringify(context ?? {})}`)
}

async function call(name: string, args: Record<string, unknown>): Promise<S & { text: string }> {
  const r = await c.callTool({ name, arguments: args })
  return { ...((r.structuredContent ?? {}) as S), text: (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n") }
}
const row = (id: string) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate" })

async function startMission(id: string) {
  const cr = await call("studio_mission_create", { mission: { id, title: "Rel 1.2.8 HMC08", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: ["1", "2"].map(row), decisions: [{ id: "U1", by: "user", date: "2026-11-14", text: "go" }] } })
  expect(cr.ok).toBe(true)
  expect((await call("studio_mission_approve", { mission: id, decision: "U1" })).ok).toBe(true)
  expect((await call("studio_mission_set_status", { mission: id, to: "running" })).ok).toBe(true)
}

/** A rendered (html) mission document whose current outputs all carry a verified record. */
async function verifiedDeliverable(docKey: string, title: string): Promise<Array<{ id: string; sha256: string }>> {
  const d = await call("studio_document_create", { template: "datum-nota", mission: M, docKey, title })
  expect(d.ok).toBe(true)
  const documentId = String(d.documentId)
  expect((await call("studio_chapter_import_markdown", { documentId, chapterKey: "1", markdown: `# ${title}\n\nPengukuran titik uji dicatat tiap bulan.\n`, submit: true, baseRevisionNo: 1 })).ok).toBe(true)
  const rev = (await store.revisionVerification(documentId, "latest")).revisionNo
  expect((await call("studio_render", { documentId, revisionNo: rev, formats: ["html"] })).ok).toBe(true)
  const set = await store.revisionVerification(documentId, "latest")
  for (const o of set.outputs) {
    await store.transaction((tx) =>
      store.putOutputVerification(tx, { outputFileId: o.outputId, outputSha256: o.sha256, state: "verified", checksVersion: 1, failCount: 0, unknownCount: 0, report: { state: "verified", checks: [{ check: "C0", status: "PASS" }] }, verifiedBy: "rel128-hmc08-test" }),
    )
  }
  return set.outputs.map((o) => ({ id: o.outputId, sha256: o.sha256 }))
}

beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  await resetEnvCache()
  store = await mod.openHostStore(STORE, { release: "1.2.8", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.8" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  c = new Client({ name: "rel128-hmc08", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
  await startMission(M)
  await startMission(M_EMPTY)
}, 120_000)

afterAll(async () => {
  await c?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  globalThis.fetch = realFetch
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await resetEnvCache()
})

describe("N8-330 AT-HMC08: full deliverable sha256 in the compact mission text", () => {
  test("2 verified deliverables: one line each, full 64-hex sha equal to the stored output", async () => {
    const a = await verifiedDeliverable("row-1-kajian", "Kajian HMC08")
    const b = await verifiedDeliverable("row-2-catatan", "Catatan HMC08")
    const want = [...a, ...b].map((o) => o.sha256).sort()
    expect(want).toHaveLength(2)
    const g = await call("studio_mission_get", { mission: M })
    expect(g.ok).toBe(true)
    const lines = g.text.split("\n").filter((l) => l.startsWith("  deliverable "))
    console.log(`[rel128-hmc08] compact deliverable lines: ${JSON.stringify(lines)}`)
    expect(lines).toHaveLength(2)
    for (const l of lines) expect(l).toMatch(LINE)
    expect(lines.map((l) => LINE.exec(l)![2]).sort()).toEqual(want)
    // the data key stays opt-in (row 126 default unchanged)
    expect(g.deliverables).toBeUndefined()
  }, 120_000)

  test("a mission without deliverables prints no deliverable line", async () => {
    const g = await call("studio_mission_get", { mission: M_EMPTY })
    expect(g.ok).toBe(true)
    expect(g.text).not.toContain("deliverable ")
    expect(g.text).not.toMatch(/[0-9a-f]{64}/)
  })
})
