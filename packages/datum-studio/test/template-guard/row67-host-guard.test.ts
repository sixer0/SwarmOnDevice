// Row 67: `startStudioHostServer` (row 31) installs the Rev A template guard before it serves, so the row 66
// service can save user templates; `close()` removes it again (only if it is still this server's guard).
// Runner order as row 111: openHostStore -> configureTemplateSource -> startStudioHostServer. Real store, real
// endpoint on 127.0.0.1 (needs the command sandbox off: it binds a port). The render bridge transport is the
// row 108 test seam (see row67-template-guard.test.ts); no network, no model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW67_TEST_DIR ?? "/private/tmp/claude-501/row67/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row67-host-")))
const STORE = path.join(WORK, "datum-studio")
const LOG = path.join(WORK, "logs", "store.jsonl")
const TPL_LOG = path.join(WORK, "logs", "templates.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
for (const d of [HOME, RES, path.dirname(TPL_LOG)]) mkdirSync(d, { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR

const PORT = 47367
const TOKEN = "b".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const caller = { kind: "INTERNAL_AGENT" as const, requester: "agent:row67-host", agentId: "row67-host", canWriteClassK: false }

let mod: typeof import("../../src/mcp-host/index.ts")
let service: typeof import("../../vendor/src/lib/studio/services/templates/service")
let templates: typeof import("../../vendor/src/lib/studio/services/templates")
let runtime: typeof import("../../vendor/src/lib/studio/engine/browser/runtime")
let store: Awaited<ReturnType<typeof mod.openHostStore>>
const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = []

beforeAll(async () => {
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache() // I-2 (C66): host start now refuses a stale cached root
  mod = await import("../../src/mcp-host/index.ts")
  service = await import("../../vendor/src/lib/studio/services/templates/service")
  templates = await import("../../vendor/src/lib/studio/services/templates")
  runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")
  runtime.setRenderBridgeTransport(async (req) => {
    if (req.op === "hello") return { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
    if (req.op === "checkPage") return { ok: true, electron: "42.3.3", script: "studio.measure", result: { paged: true, pageCount: 6, truncated: false, elements: [] } }
    return { ok: false, code: "UNKNOWN_OP", message: req.op }
  })
  store = await mod.openHostStore(STORE, { release: "1.2.0", logFile: LOG })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" })
  templates.setTemplatesLogSink((e) => appendFileSync(TPL_LOG, `${JSON.stringify(e)}\n`))
  service.configureTemplateGuard(null)
})

afterAll(async () => {
  service.configureTemplateGuard(null)
  runtime.setRenderBridgeTransport(null)
  templates.setTemplatesLogSink(null)
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
})

describe("row 67: the host installs the template guard at start", () => {
  test("before start every save is GUARD_NOT_CONFIGURED; after start a copy of datum-gsp is guarded and saved; close removes the guard", async () => {
    expect(service.installedTemplateGuard()).toBeNull()
    const refused = await service.createUserTemplateV2({ slug: "user-host-sebelum", name: "Sebelum", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } }, caller).then(
      () => null,
      (e) => ({ code: service.templateErrorCode(e), reason: (e as { details?: { reason?: string } }).details?.reason }),
    )
    expect(refused).toEqual({ code: "GUARD_UNAVAILABLE", reason: "GUARD_NOT_CONFIGURED" })

    const host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: PORT, log: (level, _s, message, context) => logs.push({ level, message, context }), facts: FACTS })
    try {
      expect(host.url).toBe(`http://127.0.0.1:${PORT}/mcp`)
      const installed = service.installedTemplateGuard()
      expect(typeof installed).toBe("function")
      expect(logs.find((l) => l.message === "Studio MCP server listening")?.context?.templateGuard).toBe("installed")
      const r = await service.createUserTemplateV2({ slug: "user-host-salinan", name: "Salinan host", kind: "DOCUMENT", changeNote: "Salinan datum-gsp lewat host", from: { slug: "datum-gsp" } }, caller)
      expect(r.guard.verdict).toBe("pass")
      const row = (store as unknown as { requireReader(): { get(s: string, p?: unknown[]): Record<string, unknown> | undefined } })
        .requireReader()
        .get("SELECT v.guard_verdict, v.guard_skill_sha, length(v.guard_report) AS n FROM template_version v JOIN template t ON t.id = v.template_id WHERE t.slug = ?", ["user-host-salinan"])!
      console.log(`row67: host guard installed; copy saved guard_verdict=${row.guard_verdict} guard_skill_sha=${row.guard_skill_sha} guard_report chars=${row.n}`)
      expect(row.guard_verdict).toBe("pass")
      expect(String(row.guard_skill_sha)).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await host.close()
    }
    expect(service.installedTemplateGuard()).toBeNull()
    // I-2 (C72): while the host runs, the template log goes to the host's sink <store>/logs/datum-studio-templates.jsonl (code in context).
    const codes = readFileSync(path.join(STORE, "logs", "datum-studio-templates.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { context?: { code?: string } }).context?.code)
    expect(codes).toContain("GUARD_DONE")
  })

  test("close() leaves a guard alone that another owner installed after start", async () => {
    const host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: PORT, log: () => undefined, facts: FACTS })
    const other: Parameters<typeof service.configureTemplateGuard>[0] = async () => ({ verdict: "unavailable", reason: "OTHER" })
    service.configureTemplateGuard(other)
    await host.close()
    expect(service.installedTemplateGuard()).toBe(other)
    service.configureTemplateGuard(null)
  })
})
