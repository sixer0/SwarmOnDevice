// Row 143a (decision C177, F143-1): re-run the row 143 case renders (cases 01, 05 and B-FIX from the row 55b adapted
// material, copied to test/engine-rev-a/row143a/fixtures) through the REAL dev Studio host (startStudioHostServer +
// missionHostExtension, so studio_render carries the production verification wrapper) and the REAL render bridge
// (repo Electron 42, row 157's harness: fixture HOME, --use-mock-keychain, dead proxy). Each case is built with the
// same tool calls as row 143's driveA.ts (studio_document_create, studio_chapter_submit, studio_slot_fill), rendered
// DOCX + HTML + PDF (B-FIX: DOCX, as row 143), and the verification report is checked:
//   - FIDELITY passes on every output (faults (a) and (c) were FIDELITY failures);
//   - OVERLAP_CLIP passes on case 01 (fault (b): Table 3.1 BOX_CLIP / TABLE_OVERFLOW) and case 05;
//   - every remaining FAIL is LINT with only the content codes of C142.
// OPT-IN: runs only with ROW143A_E2E=1 and the command sandbox off (ephemeral port, Unix socket, Electron), like
// row 157. Reports are written to $ROW143A_ROOT/w/<run>/verification_<case>.json.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { realBridgeRunnable, startRealBridge, type RealBridge } from "../verify-gate-e2e/real-bridge"

const E2E = process.env.ROW143A_E2E === "1"
const e2e = E2E ? describe : describe.skip
const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const FIXTURES = path.join(PKG, "test", "engine-rev-a", "row143a", "fixtures")
const ROOT = process.env.ROW143A_ROOT ?? "/private/tmp/claude-501/row143a"
const RUN = `run-${Date.now()}`
const WORK = path.join(ROOT, "w", RUN)
if (E2E) mkdirSync(WORK, { recursive: true })
const W = E2E ? realpathSync(WORK) : WORK
const STORE = path.join(W, "datum-studio")
const LOG = path.join(W, "logs", "store.jsonl")
const FIXTURE_HOME = process.env.HOME?.startsWith("/private/tmp/claude-501/") ? process.env.HOME : path.join(ROOT, "h")
const HOME = path.join(W, "home")
const RES = path.join(W, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-143a")
if (E2E) for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

/** C142: the content LINT codes the row 55c/143 case documents correctly fail at TERBIT. */
const C142_LINT = new Set(["D09", "P1-labels_verified", "D16", "D17", "D18", "DATUM-17", "C-27"])

const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET", "DATUM_RENDER_SOCKET", "DATUM_RENDER_TOKEN", "STUDIO_VERIFY_BUDGET_MS"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const TOKEN = "f".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(W, "Swarm.app", "Contents", "MacOS", "Swarm") }
const M = "2026-11-08_row143a"

const realFetch = globalThis.fetch
if (E2E)
  globalThis.fetch = (async () => {
    throw new Error("row143a test: globalThis.fetch must not be called by the host")
  }) as unknown as typeof fetch

type S = Record<string, any>
type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let runtime: typeof import("../../vendor/src/lib/studio/engine/browser/runtime")
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: import("@modelcontextprotocol/sdk/client/index.js").Client
let bridge: RealBridge | undefined
const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => {
  if (level === "error") console.log(`[row143a] host error ${source}: ${message} ${JSON.stringify(context ?? {}).slice(0, 300)}`)
}
const quote = (label: string, v: unknown) => console.log(`[row143a] ${label}: ${JSON.stringify(v)}`)

async function call(name: string, args: Record<string, unknown>): Promise<S> {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })
  return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: ((r.content ?? []) as S[]).map((x) => x.text).join("\n") }
}
const ok = (r: S) => r._isError !== true && r.ok !== false

/** Row 143 driveA.ts build(): create, outline when chapter keys do not start at 1, chapters, then the other slots. */
async function build(tag: string, file: string): Promise<string> {
  const doc = JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8"))
  const meta = { ...doc.meta }
  delete meta.title
  const cr = await call("studio_document_create", { template: doc.template.slug, mission: M, docKey: doc.docKey, title: doc.meta.title, meta, detail: true })
  expect({ tag, step: "create", ok: ok(cr), text: ok(cr) ? "" : cr._text.slice(0, 400) }).toEqual({ tag, step: "create", ok: true, text: "" })
  const id = String(cr.document.id)
  const outline = (doc.sections.content?.chapters ?? []).map((ch: S) => ({ key: ch.key, title: ch.title.text }))
  if (outline.length && outline[0].key !== "1") {
    const so = await call("studio_document_structure", { documentId: id, op: "setOutline", outline, baseRevisionNo: cr.revision?.revisionNo ?? 1, change: { what: "daftar bab dari bahan", why: "kunci bab bahan Rev A dimulai bukan dari 1", impact: "kelengkapan mengikuti bab bahan" } })
    expect({ tag, step: "setOutline", ok: ok(so) }).toEqual({ tag, step: "setOutline", ok: true })
  }
  for (const [slot, payload] of Object.entries<S>(doc.sections)) {
    if (payload.type === "chapter") {
      for (const ch of payload.chapters) {
        const sub = { $schema: "studio.chapter/v2", target: { documentId: id }, slot, chapter: ch, ...(doc.register ? { register: doc.register } : {}) }
        const r = await call("studio_chapter_submit", { submission: sub, detail: true })
        expect({ tag, step: `chapter ${ch.key}`, ok: ok(r), text: ok(r) ? "" : r._text.slice(0, 600) }).toEqual({ tag, step: `chapter ${ch.key}`, ok: true, text: "" })
      }
    } else {
      const r = await call("studio_slot_fill", { documentId: id, slot, payload, detail: true })
      expect({ tag, step: `slot ${slot}`, ok: ok(r), text: ok(r) ? "" : r._text.slice(0, 600) }).toEqual({ tag, step: `slot ${slot}`, ok: true, text: "" })
    }
  }
  return id
}

const reports: Record<string, S> = {}
async function render(tag: string, id: string, formats: string[]): Promise<S> {
  const r = await call("studio_render", { documentId: id, formats })
  expect({ tag, ok: ok(r), text: ok(r) ? "" : r._text.slice(0, 800) }).toEqual({ tag, ok: true, text: "" })
  const v = r.verification as S
  writeFileSync(path.join(W, `verification_${tag}.json`), JSON.stringify({ verification: v, text: r._text }, null, 1))
  reports[tag] = v
  quote(`${tag} render`, {
    overall: v.overall,
    bridgeJobs: v.bridgeJobs,
    outputs: (v.outputs as S[]).map((o) => ({
      format: o.format,
      state: o.state,
      checks: (o.checks as S[]).map((k) => `${k.id}:${k.status}${k.reason ? `/${k.reason}` : ""}${k.findings?.length ? `[${(k.findings as S[]).map((f) => (k.id === "LINT" ? f.detail : f.code)).join(",")}]` : ""}`),
    })),
  })
  return v
}
const check = (v: S, format: string, id: string) => ((v.outputs as S[]).find((o) => o.format === format)!.checks as S[]).find((k) => k.id === id)!

beforeAll(async () => {
  if (!E2E) return
  if (!realBridgeRunnable) throw new Error("row143a e2e needs the repo Electron binary on darwin")
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  delete process.env.STUDIO_VERIFY_BUDGET_MS
  bridge = await startRealBridge(path.join(ROOT, "w", `bridge-${RUN}`), FIXTURE_HOME)
  quote("bridge", { scripts: bridge.info.scripts, electronPid: bridge.info.pid })
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")
  process.env.DATUM_RENDER_SOCKET = bridge.info.DATUM_RENDER_SOCKET
  process.env.DATUM_RENDER_TOKEN = bridge.info.DATUM_RENDER_TOKEN
  runtime.setRenderBridgeTransport(null)
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetRenderRateLimiter()
  store = await mod.openHostStore(STORE, { release: "1.2.1", logFile: LOG, missionGuard: true })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.1" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS, extensions: mod.missionHostExtension(store, { log, exporter: null }) })
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
  c = new Client({ name: "row143a-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
  const row = { id: "1", phase: "implementation", kind: "implementation", title: "Row 1", agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: "implementation/1.md", verification: "tests pass", review: "gate" }
  const cr = await call("studio_mission_create", { mission: { id: M, title: "Row 143a cases", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row], decisions: [{ id: "U1", by: "user", date: "2026-11-08", text: "go" }] } })
  expect(ok(cr)).toBe(true)
  expect(ok(await call("studio_mission_approve", { mission: M, decision: "U1" }))).toBe(true)
  expect(ok(await call("studio_mission_set_status", { mission: M, to: "running" }))).toBe(true)
}, 180_000)

afterAll(async () => {
  if (!E2E) return
  await c?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  runtime?.setRenderBridgeTransport(null)
  globalThis.fetch = realFetch
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  if (bridge?.owned) {
    const { result } = await bridge.stop()
    quote("electron result", { windowsAfter: result?.windowsAfter, error: result?.error ?? null })
  }
}, 120_000)

e2e("row 143a: cases 01, 05 and B-FIX through the dev host verifier", () => {
  for (const [tag, file, formats] of [
    ["case01", "case01.json", ["docx", "html", "pdf"]],
    ["case05", "case05.json", ["docx", "html", "pdf"]],
    ["bfix", "bfix-datum-kanonik-ID.studio.json", ["docx"]],
  ] as const) {
    test(`${tag}: FIDELITY passes on every output; OVERLAP_CLIP passes where imaged; other FAILs are only C142 LINT codes`, async () => {
      const id = await build(tag, file)
      const v = await render(tag, id, [...formats])
      for (const o of v.outputs as S[]) {
        for (const k of o.checks as S[]) {
          if (k.id === "FIDELITY") expect({ tag, format: o.format, FIDELITY: k.status, findings: k.findings }).toEqual({ tag, format: o.format, FIDELITY: k.status === "NOT_APPLICABLE" ? "NOT_APPLICABLE" : "PASS", findings: [] })
          else if (k.status === "FAIL") {
            expect({ tag, format: o.format, failing: k.id }).toEqual({ tag, format: o.format, failing: "LINT" })
            for (const f of k.findings as S[]) expect({ tag, lint: f.detail, c142: C142_LINT.has(String(f.detail)) }).toEqual({ tag, lint: f.detail, c142: true })
          }
        }
      }
      if (tag !== "bfix") {
        const oc = check(v, "HTML", "OVERLAP_CLIP")
        expect({ tag, OVERLAP_CLIP: oc.status, findings: oc.findings }).toEqual({ tag, OVERLAP_CLIP: "PASS", findings: [] })
        expect(check(v, "PDF", "OVERLAP_CLIP").status).toBe("PASS")
      }
    }, 600_000)
  }
})
