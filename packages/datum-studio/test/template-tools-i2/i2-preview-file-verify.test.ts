// Integration pass I-2 (C76; file_requests row68 line 87): studio_file_verify (R10) on a template preview output.
// Before I-2 vendor services/storage/files.ts finalFileNameOfRow threw TypeError for output_file rows of kind
// 'preview' (no revision, no artifact), so R10 HEAD/GET answered HTTP 500. Rule since I-2: a preview row's final
// name is the C51 form `GSP-Pratinjau-Templat_rev0_<YYYYMMDDTHHMMSSZ>_<sha8>.<ext>`.
// Path: MCP streamable-HTTP client -> startStudioHostServer (template tools registered by default) -> R10. Real
// store in a temp folder, render bridge faked (no Electron), globalThis.fetch trapped, no network, no model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.I2_TEST_DIR ?? "/private/tmp/claude-501/i2/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "i2-preview-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-i2")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })
const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const FINAL_RE = /^GSP-Pratinjau-Templat_rev0_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8}\.docx$/

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET
delete process.env.DATUM_RENDER_SOCKET
delete process.env.DATUM_RENDER_TOKEN

const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = (async () => {
  fetchCalls++
  throw new Error("i2 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let runtime: typeof import("../../vendor/src/lib/studio/engine/browser/runtime")
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let client: Client

type S = Record<string, unknown> & { ok?: boolean; code?: string }
async function call(name: string, args: Record<string, unknown>): Promise<S & { _isError: boolean; _text: string }> {
  const r = await client.callTool({ name, arguments: args })
  return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n") }
}

async function resetProcessCaches() {
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetBridgePdfReadiness } = await import("../../vendor/src/lib/studio/services/render")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetBridgePdfReadiness()
  resetRenderRateLimiter()
}

beforeAll(async () => {
  await resetProcessCaches()
  runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")
  runtime.setRenderBridgeTransport(async (req) => {
    if (req.op === "hello") return { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
    if (req.op === "checkPage") return { ok: true, electron: "42.3.3", script: "studio.measure", result: { paged: true, pageCount: 6, truncated: false, elements: [] } }
    return { ok: false, code: "UNKNOWN_OP", message: req.op }
  })
  mod = await import("../../src/mcp-host/index.ts")
  store = await mod.openHostStore(STORE, { release: "1.2.0", logFile: path.join(STORE, "logs", "datum-studio-store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log: () => undefined, facts: FACTS })
  client = new Client({ name: "i2-test", version: "0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "claude", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
})

afterAll(async () => {
  await client?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  runtime?.setRenderBridgeTransport(null)
  globalThis.fetch = realFetch
  await resetProcessCaches()
})

describe("I-2: studio_file_verify on a template preview output", () => {
  test("verify + download of a DOCX preview succeed with the C51 preview name (was HTTP 500)", async () => {
    const pv = await call("studio_template_preview", { slug: "datum-gsp", formats: ["docx"], lint: false })
    expect(pv.ok).toBe(true)
    const out = (pv.outputs as Array<{ id: string; format: string; sha256: string; bytes: number }>).find((o) => o.format === "DOCX")!
    expect(out).toBeDefined()

    const head = await call("studio_file_verify", { fileId: out.id, expectedSha256: out.sha256 })
    expect(head._isError).toBe(false)
    expect(head.ok).not.toBe(false)
    expect(head.verified).toBe(true)
    expect(head.finalNameValid).toBe(true)
    expect(String(head.finalFileName)).toMatch(FINAL_RE)
    expect(String(head.finalFileName)).toContain(`_${out.sha256.slice(0, 8)}.docx`)

    const dl = path.join(PROJECT, "unduhan")
    mkdirSync(dl, { recursive: true })
    const got = await call("studio_file_verify", { fileId: out.id, downloadDir: dl })
    expect(got.ok).not.toBe(false)
    expect(got.savedTo).toBe(path.join(dl, String(head.finalFileName)))
    expect(createHash("sha256").update(readFileSync(String(got.savedTo))).digest("hex")).toBe(out.sha256)
    expect(fetchCalls).toBe(0)
  })

  test("a row of any other kind without revision or artifact still throws (programming error kept)", async () => {
    const files = await import("../../vendor/src/lib/studio/services/storage/files")
    const row = { id: "x", kind: "document", revisionId: null, artifactId: null, createdAt: new Date(), sha256: "a".repeat(64), format: "DOCX" } as never
    expect(() => files.finalFileNameOfRow(row)).toThrow(TypeError)
  })
})
