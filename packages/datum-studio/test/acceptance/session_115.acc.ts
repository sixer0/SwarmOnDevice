// Swarm 1.2.6 row 115 (01g section 5, handoff section 7): the scripted acceptance session, C layer (committed,
// anonymised and synthetic fixtures only: test/fixtures/anon126). Flows F1-F6 run through the REAL Studio host
// (startStudioHostServer, streamable HTTP on 127.0.0.1, MCP SDK client, missionHostExtension so studio_render carries
// the production verification wrapper) and the REAL render bridge (the repo's Electron binary running
// startRenderBridge with the app's allow-list: packages/desktop/test/datum-render-electron/row157-harness-main.ts via
// ../verify-gate-e2e/real-bridge.ts). No bridge stub anywhere. F7 (P-01/U6/U12) runs in packages/opencode through its
// own committed pipeline drivers; this file does not cover it.
// Not a bun test (the `.acc.ts` name is outside bun's test discovery): run it on purpose, sandbox off (port, Unix
// socket, Electron):
//   cd packages/datum-studio && ACC_WORK=<short temp dir> bun run test/acceptance/session_115.acc.ts
// ACC_WORK must be outside the repository and outside any /docs folder; everything the run writes stays there.
// Output: <ACC_WORK>/result_c.json and one `[acc115] <flow> PASS|FAIL <check>` line per check; exit 1 on any FAIL.
// The harness (`AccSession`) is exported for run_local.local.ts (L layer).
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { inflateSync } from "node:zlib"
import { strFromU8, unzipSync } from "fflate"
import { realBridgeRunnable, startRealBridge, type RealBridge } from "../verify-gate-e2e/real-bridge"

export const PKG = path.resolve(import.meta.dir, "..", "..")
export const SW = path.resolve(PKG, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
export const FIX = path.join(PKG, "test", "fixtures", "anon126")
export type S = Record<string, any>

export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex")

/** The work root from `name`; refused inside the repository or a /docs folder (01g 5.1). */
export function workRoot(name = "ACC_WORK"): string {
  const w = process.env[name]
  if (!w) throw new Error(`${name} is required (a short temp dir outside the repository)`)
  mkdirSync(w, { recursive: true, mode: 0o700 })
  const real = realpathSync(w)
  if (real === SW || real.startsWith(SW + path.sep) || /\/docs(\/|$)/.test(real)) throw new Error(`${name} must lie outside the repository and outside /docs: ${real}`)
  return real
}

// ── result ledger ─────────────────────────────────────────────────────────────────────────────────────────────────
export type Check = { flow: string; name: string; pass: boolean; detail: unknown }
export class Ledger {
  readonly checks: Check[] = []
  constructor(readonly tag: string) {}
  check(flow: string, name: string, pass: boolean, detail: unknown = null) {
    this.checks.push({ flow, name, pass, detail })
    console.log(`[${this.tag}] ${flow} ${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail).slice(0, 600)}`)
    return pass
  }
  note(flow: string, name: string, detail: unknown) {
    console.log(`[${this.tag}] ${flow} NOTE ${name} ${JSON.stringify(detail).slice(0, 600)}`)
  }
  summary() {
    const flows = [...new Set(this.checks.map((c) => c.flow))]
    return Object.fromEntries(flows.map((f) => {
      const cs = this.checks.filter((c) => c.flow === f)
      return [f, { pass: cs.filter((c) => c.pass).length, fail: cs.filter((c) => !c.pass).length, verdict: cs.every((c) => c.pass) ? "PASS" : "FAIL" }]
    }))
  }
}

// ── harness: real bridge + real host + MCP client ─────────────────────────────────────────────────────────────────
type Mod = typeof import("../../src/mcp-host/index.ts")
const TOKEN = "a".repeat(16) + "0123456789abcdef".repeat(3)
const SECRET = "c".repeat(64)
const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET", "DATUM_RENDER_SOCKET", "DATUM_RENDER_TOKEN", "STUDIO_VERIFY_BUDGET_MS"] as const

export class AccSession {
  mod!: Mod
  store!: Awaited<ReturnType<Mod["openHostStore"]>>
  host!: Awaited<ReturnType<Mod["startStudioHostServer"]>>
  client!: import("@modelcontextprotocol/sdk/client/index.js").Client
  api!: { fetch: (url: string, init?: Record<string, unknown>) => Promise<{ status: number; text(): Promise<string> }> }
  bridge: RealBridge | undefined
  runtime: typeof import("../../vendor/src/lib/studio/engine/browser/runtime") | undefined
  readonly storeDir: string
  readonly home: string
  readonly project: string
  readonly mission: string
  private realFetch = globalThis.fetch
  private saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

  constructor(readonly work: string, opts: { store?: string; mission?: string } = {}) {
    this.storeDir = opts.store ?? path.join(work, "datum-studio")
    this.home = path.join(work, "home")
    this.project = path.join(this.home, "project")
    this.mission = opts.mission ?? "2026-11-13_acc115"
    for (const d of [this.home, this.project, path.join(work, "Swarm.app", "Contents", "Resources")]) mkdirSync(d, { recursive: true })
  }

  async start(o: { bridge: boolean; release?: string }) {
    if (o.bridge && !realBridgeRunnable) throw new Error("the real render bridge needs the repo Electron binary on darwin")
    process.env.STUDIO_WORKSPACE_ROOT = this.storeDir
    process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
    process.env.STUDIO_VENDOR_ROOT = VENDOR
    delete process.env.STUDIO_MCP_FILE_ROOTS
    delete process.env.INTERNAL_API_SECRET
    delete process.env.STUDIO_VERIFY_BUDGET_MS
    delete process.env.DATUM_RENDER_SOCKET
    delete process.env.DATUM_RENDER_TOKEN
    if (o.bridge) {
      this.bridge = await startRealBridge(path.join(this.work, "br"), path.join(this.work, "bh"))
      process.env.DATUM_RENDER_SOCKET = this.bridge.info.DATUM_RENDER_SOCKET
      process.env.DATUM_RENDER_TOKEN = this.bridge.info.DATUM_RENDER_TOKEN
    }
    this.mod = (await import("../../src/mcp-host/index.ts")) as Mod
    this.runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")
    this.runtime.setRenderBridgeTransport(null)
    ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
    ;(await import("../../vendor/src/lib/studio/http/render-guard")).resetRenderRateLimiter()
    const log = (level: string, source: string, message: string, context?: unknown) => {
      if (level === "error") console.log(`[acc-host] ${source}: ${message} ${JSON.stringify(context ?? {}).slice(0, 300)}`)
    }
    const release = o.release ?? "1.2.6"
    this.store = await this.mod.openHostStore(this.storeDir, { release, logFile: path.join(this.work, "logs", "store.jsonl"), missionGuard: true })
    this.mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release })
    const facts = { home: this.home, resourcesPath: path.join(this.work, "Swarm.app", "Contents", "Resources"), execPath: path.join(this.work, "Swarm.app", "Contents", "MacOS", "Swarm") }
    this.host = await this.mod.startStudioHostServer({ store: this.store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts, extensions: this.mod.missionHostExtension(this.store, { log, exporter: null }) })
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
    this.client = new Client({ name: "acc115", version: "0" })
    await this.client.connect(
      new StreamableHTTPClientTransport(new URL(this.host.url), {
        fetch: this.realFetch as never,
        requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(this.project) } },
      }),
    )
    const { createLocalStudioApi } = await import("../../src/mcp-host/local-api/router.ts")
    const { LOCAL_ROUTES } = await import("../../src/mcp-host/local-api/routes.ts")
    this.api = createLocalStudioApi({ baseUrl: "http://127.0.0.1:1", secret: SECRET, agentId: "swarm", routes: LOCAL_ROUTES }) as unknown as AccSession["api"]
  }

  /** One mission row per flow, approved by a recorded decision, running (the host's mission guard needs it). */
  async openMission(rows: string[]) {
    const row = (flow: string, i: number) => ({ id: String(i + 1), phase: "implementation", kind: "test", title: `Flow ${flow}`, agent: "test-expert", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `test/${flow}.md`, verification: "flow passes", review: "gate" })
    const ok = (r: S) => r._isError !== true && r.ok !== false
    const cr = await this.call("studio_mission_create", { mission: { id: this.mission, title: "Acceptance session 115", type: "feature-release", owner: "master-controller", project: { dir: this.project }, rows: rows.map((f, i) => row(f, i)), decisions: [{ id: "U1", by: "user", date: "2026-11-13", text: "go" }] } })
    if (!ok(cr)) throw new Error(`mission create: ${cr._text}`)
    if (!ok(await this.call("studio_mission_approve", { mission: this.mission, decision: "U1" }))) throw new Error("mission approve")
    if (!ok(await this.call("studio_mission_set_status", { mission: this.mission, to: "running" }))) throw new Error("mission running")
  }

  /**
   * Fresh rate windows between flows (as the host tests do): one session drives five flows' worth of writes and
   * renders in minutes, more than one agent's per-minute bucket; the limiter is not what these flows test.
   */
  async resetLimits() {
    ;(await import("../../vendor/src/lib/studio/http/render-guard")).resetRenderRateLimiter()
    ;(await import("../../vendor/src/lib/studio/http/quota")).resetQueryRateLimiter()
  }

  async call(name: string, args: Record<string, unknown>): Promise<S> {
    try {
      const r = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })
      return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: ((r.content ?? []) as S[]).map((x) => x.text ?? "").join("\n") }
    } catch (e) {
      return { ok: false, code: "CALL_THREW", _isError: true, _text: String(e) }
    }
  }

  async local(method: string, route: string, body?: unknown): Promise<{ status: number; body: S }> {
    const r = await this.api.fetch(`http://127.0.0.1:1${route}`, {
      method,
      headers: { "x-internal-secret": SECRET, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
    })
    const text = await r.text()
    let parsed: S = {}
    try {
      parsed = text ? (JSON.parse(text) as S) : {}
    } catch {
      parsed = { _raw: text.slice(0, 400) }
    }
    return { status: r.status, body: parsed }
  }

  async stop() {
    await this.client?.close().catch(() => undefined)
    await this.host?.close().catch(() => undefined)
    this.mod?.configureTemplateSource(null)
    if (this.store) await this.mod.closeHostStore(this.store).catch(() => undefined)
    try {
      const { closeBrowser } = (await import("../../vendor/src/lib/studio/engine/browser/index")) as S
      await closeBrowser?.()
    } catch {}
    this.runtime?.setRenderBridgeTransport(null)
    let electron: S | null = null
    if (this.bridge?.owned) electron = (await this.bridge.stop()).result
    for (const k of ENV_KEYS) {
      if (this.saved[k] === undefined) delete process.env[k]
      else process.env[k] = this.saved[k]
    }
    return { windowsAfter: electron?.windowsAfter ?? null, error: electron?.error ?? null }
  }
}

// ── shared readers ────────────────────────────────────────────────────────────────────────────────────────────────
export const okCall = (r: S) => r._isError !== true && r.ok !== false
export const errCode = (r: S): string => (okCall(r) ? "OK" : String(r.code ?? r.error?.code ?? "ERROR"))

/** Every `checkId` anywhere in a value (refusal details, issue lists). */
export function checkIdsIn(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) checkIdsIn(x, out)
  else if (v && typeof v === "object") {
    const o = v as S
    if (typeof o.checkId === "string") out.push(o.checkId)
    for (const x of Object.values(o)) checkIdsIn(x, out)
  }
  return out
}

/** Compact verification summary of a studio_render result: per format, `ID:STATUS[/reason][codes]`. */
export function verifySummary(v: S | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const o of ((v?.outputs ?? []) as S[])) {
    out[o.format] = ((o.checks ?? []) as S[]).map((k) => `${k.id}:${k.status}${k.reason ? `/${k.reason}` : ""}${k.findings?.length ? `[${[...new Set((k.findings as S[]).map((f) => (k.id === "LINT" ? f.detail : f.code)))].slice(0, 6).join(",")}]` : ""}`)
  }
  return out
}
export const checkOf = (v: S, format: string, id: string): S | undefined => ((v?.outputs ?? []) as S[]).find((o) => o.format === format)?.checks?.find((k: S) => k.id === id)

/** Image XObjects of a PDF: dictionary text, Width, Height, filter, and the inflated stream when Flate. */
export function pdfImages(pdf: Uint8Array): Array<{ width: number; height: number; filter: string; smask: boolean; bpc: number; colorSpace: string; data: Uint8Array | null }> {
  const buf = Buffer.from(pdf)
  const s = buf.toString("latin1")
  const out: ReturnType<typeof pdfImages> = []
  const re = /<<((?:(?!>>\s*stream)[\s\S]){0,2000}?\/Subtype\s*\/Image[\s\S]*?)>>\s*stream\r?\n/g
  for (const m of s.matchAll(re)) {
    const dict = m[1]
    const num = (k: string) => Number(new RegExp(`/${k}\\s+(\\d+)`).exec(dict)?.[1] ?? NaN)
    const len = num("Length")
    const start = (m.index ?? 0) + m[0].length
    const filter = /\/Filter\s*\/(\w+)/.exec(dict)?.[1] ?? "none"
    let data: Uint8Array | null = null
    if (Number.isFinite(len)) {
      const raw = buf.subarray(start, start + len)
      try {
        data = filter === "FlateDecode" ? new Uint8Array(inflateSync(raw)) : filter === "none" ? new Uint8Array(raw) : null
      } catch {
        data = null
      }
    }
    out.push({ width: num("Width"), height: num("Height"), filter, smask: /\/SMask\s+\d+/.test(dict), bpc: num("BitsPerComponent"), colorSpace: /\/ColorSpace\s*\/(\w+)/.exec(dict)?.[1] ?? (/\/ColorSpace\s+\d+/.test(dict) ? "indirect" : "?"), data })
  }
  return out
}

/** Minimal PNG decoder (8-bit, colour types 0/2/4/6, no interlace) to raw RGB rows without filter bytes. */
export function pngToRgb(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let at = 8
  let width = 0
  let height = 0
  let ct = 0
  let depth = 0
  let interlace = 0
  const idat: Uint8Array[] = []
  while (at < png.length) {
    const len = v.getUint32(at)
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8))
    const data = png.subarray(at + 8, at + 8 + len)
    if (type === "IHDR") {
      width = new DataView(data.buffer, data.byteOffset).getUint32(0)
      height = new DataView(data.buffer, data.byteOffset).getUint32(4)
      depth = data[8]
      ct = data[9]
      interlace = data[12]
    } else if (type === "IDAT") idat.push(data)
    at += 12 + len
  }
  if (depth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(ct)) throw new Error(`png: unsupported depth ${depth} colour ${ct} interlace ${interlace}`)
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct as 0 | 2 | 4 | 6]
  const total = idat.reduce((n, d) => n + d.length, 0)
  const z = new Uint8Array(total)
  let o = 0
  for (const d of idat) {
    z.set(d, o)
    o += d.length
  }
  const raw = new Uint8Array(inflateSync(z))
  const stride = width * bpp
  const px = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0
      let val = line[x]
      if (f === 1) val += a
      else if (f === 2) val += b
      else if (f === 3) val += (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        val += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[y * stride + x] = val & 0xff
    }
  }
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    if (ct === 2 || ct === 6) rgb.set(px.subarray(i * bpp, i * bpp + 3), i * 3)
    else rgb.fill(px[i * bpp], i * 3, i * 3 + 3)
  }
  return { width, height, rgb }
}

/** W-13 PDF check (01f §5 (a)-(d), C19i): image XObject size, Flate re-encode or not, decoded pixel equality. */
export function pdfImageCheck(pdf: Uint8Array, png: Uint8Array) {
  const src = pngToRgb(png)
  const imgs = pdfImages(pdf)
  const same = imgs.filter((i) => i.width === src.width && i.height === src.height)
  const pdfHasPngBytes = Buffer.from(pdf).indexOf(Buffer.from(png.subarray(8, 64))) >= 0
  let pixelsEqual: boolean | null = null
  let maxDelta: number | null = null
  const cand = same.find((i) => i.data && i.data.length === src.width * src.height * 3 && i.bpc === 8)
  if (cand?.data) {
    let d = 0
    for (let k = 0; k < cand.data.length; k++) d = Math.max(d, Math.abs(cand.data[k] - src.rgb[k]))
    maxDelta = d
    pixelsEqual = d === 0
  }
  return {
    images: imgs.map((i) => ({ w: i.width, h: i.height, filter: i.filter, smask: i.smask, bpc: i.bpc, cs: i.colorSpace, bytes: i.data?.length ?? null })),
    sizeMatch: same.length,
    pngBytesInPdf: pdfHasPngBytes,
    reencoded: same.length > 0 && !pdfHasPngBytes,
    pixelsEqual,
    maxDelta,
  }
}

// ── flows ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const CHANGE = (what: string) => ({ what, why: "sesi penerimaan 115", impact: "dokumen uji terisolasi" })
const NEW_KINDS = ["edgeEntryCollision", "stubSegment", "arrowTangent"] as const
const F1_EXPECTED: Record<string, string[]> = {
  t03_k1: ["stubSegment", "arrowTangent"],
  t03_k2: ["stubSegment", "edgeEntryCollision"],
  t03_k3: ["stubSegment", "arrowTangent"],
  t03_k4: ["stubSegment"],
  t03_k5: ["stubSegment", "arrowTangent", "edgeEntryCollision"],
  t03_k6: ["stubSegment"],
  t03_k7: ["stubSegment"],
}

/** F1 gate of one SVG: status, every FIG_GEOMETRY kind, and the new T-03 kinds that FAIL the gate. */
export async function figureFit(svg: string, pkg = PKG) {
  const sc = await import(path.join(pkg, "src", "mcp-host", "verify", "static-checks.ts"))
  const c = sc.checkFigureFit({ format: "SVG", svg, figureKind: "diagram", figureLabel: "Gambar 1.1" })
  const kinds = ((c.findings ?? []) as S[]).filter((f) => f.code === "FIG_GEOMETRY").map((f) => String(f.detail ?? "").split(":")[0])
  const failNew = kinds.filter((k) => (NEW_KINDS as readonly string[]).includes(k) && sc.DIAGRAM_FAIL_KINDS.has(k))
  return { status: String(c.status), kinds, failNew: [...new Set(failNew)], codes: [...new Set(((c.findings ?? []) as S[]).map((f) => String(f.code)))] }
}

async function flowF1(L: Ledger) {
  for (const [name, expected] of Object.entries(F1_EXPECTED)) {
    const g = await figureFit(readFileSync(path.join(FIX, `${name}.svg`), "utf8"))
    L.check("F1", `${name}: FIGURE_FIT FAIL on a designed new kind`, g.status === "FAIL" && g.failNew.some((k) => expected.includes(k)), { status: g.status, failNew: g.failNew, expected, kinds: g.kinds })
  }
  for (const name of ["t03_n1", "t03_n2"]) {
    const g = await figureFit(readFileSync(path.join(FIX, `${name}.svg`), "utf8"))
    L.check("F1", `${name}: negative control, no new-kind FAIL`, g.failNew.length === 0, { status: g.status, kinds: g.kinds })
  }
}

const TOKEN_RE = /^\s*(gambar|figure|fig\.|grafik|bagan|diagram)\s*[A-Z]?\d{1,3}(?:[.\-]\d+)*\b/i
const stripToken = (c: string) => c.replace(TOKEN_RE, "").replace(/^[\s.:\-–]+/, "").trim()

async function newDoc(s: AccSession, docKey: string, title: string, meta: S = {}, template = "datum-nota"): Promise<{ id: string; rev: number }> {
  const cr = await s.call("studio_document_create", { template, mission: s.mission, docKey, title, ...(Object.keys(meta).length ? { meta } : {}), detail: true })
  if (!okCall(cr)) throw new Error(`document create ${docKey}: ${cr._text.slice(0, 400)}`)
  return { id: String(cr.document?.id ?? cr.documentId), rev: Number(cr.revision?.revisionNo ?? 1) }
}

/** Filler cover, control sheet and signature (required at TERBIT/SERAH in datum-nota); ICAO filler only (01g 4.3). */
async function fillSealSlots(s: AccSession, id: string, tier: string): Promise<string[]> {
  const t = (text: string) => ({ text })
  const payloads: Record<string, S> = {
    cover: {
      type: "cover",
      tagline: t("Alfa Bravo \u00b7 Charlie Delta"),
      titleLines: [t("Echo Foxtrot Golf"), t("Hotel India")],
      standfirst: t("Juliett kilo lima mike november oscar papa."),
      scopeLine: t("Quebec romeo \u00b7 sierra tango"),
      addressLine: t("Uniform victor \u00b7 whiskey xray"),
      control: [
        [t("Nomor dokumen"), t("888/GSP/KT/XI/2026"), t("Revisi"), t("A \u00b7 13 November 2026")],
        [t("Penyusun"), t("Alfa Bravo"), t("Kustodian"), t("ALFA-88")],
        [t("Ditujukan kepada"), t("Charlie Delta"), t("Halaman"), t("8")],
        [t("Tingkat"), t(tier), t("Verifikasi"), t("V2 \u00b7 lulus")],
      ],
      colophon: { left: t("ALFA BRAVO \u00b7 CHARLIE"), right: t(`// 20261113 ID A \u00b7 ${tier}`) },
    },
    controlSheet: { type: "controlSheet", revisionHistory: [{ rev: "A", date: "2026-11-13", what: "Terbitan 1", by: "Alfa Bravo" }], verificationChain: [{ layer: "V2", role: "Verifikasi", name: "lulus" }] },
    signature: { type: "signatureBlock", roles: [{ role: t("Penyusun"), holder: t("Alfa Bravo"), date: t("2026-11-13") }] },
  }
  const failed: string[] = []
  for (const [slot, payload] of Object.entries(payloads)) {
    const r = await s.call("studio_slot_fill", { documentId: id, slot, payload, detail: true })
    if (!okCall(r)) failed.push(`${slot}:${errCode(r)}:${r._text.replace(/\s+/g, " ").slice(0, 200)}`)
  }
  return failed
}
const chapterSub = (documentId: string, key: string, blocks: unknown[]) => ({ $schema: "studio.chapter/v2", target: { documentId }, chapter: { key, title: { text: "Uraian alfa" }, sections: [{ title: { text: "Bagian bravo" }, blocks }] } })

async function flowF2(s: AccSession, L: Ledger) {
  const { naskahToBlockV2 } = await import("../t01-caption-token/naskah-map")
  const NASKAH = [1, 2, 3, 4, 5, 6].map((i) => [`t01_k${i}`, JSON.parse(readFileSync(path.join(FIX, `t01_k${i}.json`), "utf8"))] as const)
  const doc = await newDoc(s, "acc115-f2", "Dokumen uji F2")
  let refused = 0
  for (const [name, n] of NASKAH) {
    const r = await s.call("studio_chapter_submit", { submission: chapterSub(doc.id, "1", [{ type: "paragraph", text: "Paragraf alfa bravo." }, naskahToBlockV2(n)]), detail: true })
    const ids = checkIdsIn(r)
    const hit = !okCall(r) && (ids.includes("CAPTION_TOKEN_DUPLICATE") || r._text.includes("CAPTION_TOKEN_DUPLICATE"))
    const msgLimit = /100/.test(r._text) && /GAMBAR n\.m/.test(r._text)
    if (hit && msgLimit) refused++
    L.check("F2", `${name}: chapter submit refused CAPTION_TOKEN_DUPLICATE naming the rule and limit 100`, hit && msgLimit, { code: errCode(r), ids: [...new Set(ids)].slice(0, 5), text: r._text.replace(/\s+/g, " ").slice(0, 220) })
  }
  L.check("F2", "chapter submit: 6/6 refused", refused === 6, { refused })
  const okSub = await s.call("studio_chapter_submit", { submission: chapterSub(doc.id, "1", [{ type: "paragraph", text: "Paragraf alfa bravo." }, ...NASKAH.map(([, n]) => naskahToBlockV2(n, stripToken(n.caption)))]), detail: true })
  L.check("F2", "the same six blocks without the token are accepted (the token is the only reason)", okCall(okSub), { code: errCode(okSub), text: okCall(okSub) ? "" : okSub._text.slice(0, 300) })
  const rev = Number(okSub.revision?.revisionNo ?? okSub.revisionNo ?? NaN)
  let revRefused = 0
  for (const [name, n] of NASKAH) {
    const r = await s.call("studio_figure_revise", { documentId: doc.id, address: "Gambar 1.1", patch: { caption: { text: n.caption } }, ...(Number.isFinite(rev) ? { baseRevisionNo: rev } : {}), change: CHANGE("caption figur"), preview: false })
    const hit = !okCall(r) && (checkIdsIn(r).includes("CAPTION_TOKEN_DUPLICATE") || r._text.includes("CAPTION_TOKEN_DUPLICATE"))
    if (hit) revRefused++
    L.check("F2", `${name}: studio_figure_revise with the token caption refused CAPTION_TOKEN_DUPLICATE`, hit, { code: errCode(r), text: r._text.replace(/\s+/g, " ").slice(0, 200) })
  }
  L.check("F2", "figure_revise: 6/6 refused", revRefused === 6, { revRefused })
  // Long caption (> 100 chars once the token is gone) -> FIGURE_FIT FAIL CAPTION_WRAP with the limit, through the
  // production render wrapper and the real bridge.
  const long = NASKAH.map(([, n]) => stripToken(n.caption)).filter((c) => c.length > 100)
  L.note("F2", "captions over 100 chars after the token", { count: long.length, lengths: long.map((c) => c.length) })
  const r = await s.call("studio_render", { documentId: doc.id, formats: ["html", "pdf"] })
  const v = r.verification as S
  writeFileSync(path.join(s.work, "f2_verification.json"), JSON.stringify(v ?? null, null, 1))
  const empty = ((checkOf(v, "HTML", "EMPTY_SLOTS")?.findings ?? []) as S[]).map((f) => ({ code: f.code, address: f.address ?? null, label: f.label ?? null, detail: String(f.detail ?? "").slice(0, 160) }))
  L.note("F2", "EMPTY_SLOTS findings of the render", empty)
  for (let i = 1; i <= NASKAH.length; i++) {
    const pv = await s.call("studio_figure_preview", { documentId: doc.id, address: `Gambar 1.${i}` })
    L.note("F2", `preview Gambar 1.${i}`, { code: errCode(pv), type: pv.figure?.type ?? null, kind: pv.figure?.code ?? null, defects: ((pv.figure?.defects ?? []) as S[]).map((d) => d.checkId), error: pv.error?.code ?? null, message: String(pv.error?.message ?? "").slice(0, 300), text: okCall(pv) ? "" : pv._text.replace(/\s+/g, " ").slice(0, 200) })
  }
  // In a document page the caption is page apparatus (HTML), which the engine never wraps, so FIGURE_FIT has no
  // CAPTION_WRAP to read there (static-checks.ts captionFitOf: "a page-apparatus caption is HTML and is never wrapped
  // by the engine"). The engine-drawn caption exists in the stand-alone figure (apparatus "figure"): export it through
  // studio_figure_preview {standalone, downloadDir} and run the FIGURE_FIT check on the SVG the tool wrote.
  const fits = ["HTML", "PDF"].map((f) => checkOf(v, f, "FIGURE_FIT"))
  L.note("F2", "document render FIGURE_FIT (page apparatus)", { HTML: fits[0]?.status ?? null, PDF: fits[1]?.status ?? null, codes: fits.flatMap((k) => ((k?.findings ?? []) as S[]).map((x) => x.code)) })
  const dl = path.join(s.project, "f2_solo")
  mkdirSync(dl, { recursive: true })
  const sc = await import(path.join(PKG, "src", "mcp-host", "verify", "static-checks.ts"))
  let wraps = 0
  let diagrams = 0
  for (let i = 1; i <= NASKAH.length; i++) {
    const n = NASKAH[i - 1][1]
    if (n.jenis !== "diagram") continue
    const before = new Set(existsSync(dl) ? [...new Bun.Glob("*.svg").scanSync(dl)] : [])
    const pv = await s.call("studio_figure_preview", { documentId: doc.id, address: `Gambar 1.${i}`, standalone: true, downloadDir: dl })
    const file = [...new Bun.Glob("*.svg").scanSync(dl)].find((f) => !before.has(f))
    if (!okCall(pv) || !file) {
      L.note("F2", `stand-alone Gambar 1.${i}`, { code: errCode(pv), error: pv.error?.code ?? null, file: !!file })
      continue
    }
    diagrams++
    const svg = readFileSync(path.join(dl, file), "utf8")
    const c = sc.checkFigureFit({ format: "SVG", svg, figureKind: "diagram", figureLabel: `Gambar 1.${i}` })
    const w = ((c.findings ?? []) as S[]).find((x) => x.code === "CAPTION_WRAP")
    const hit = c.status === "FAIL" && !!w && /CAPTION_GUIDE_MAX_CHARS/.test(String(w.detail)) && /100/.test(String(w.detail))
    if (hit) wraps++
    L.check("F2", `stand-alone Gambar 1.${i} (caption ${stripToken(n.caption).length} chars): FIGURE_FIT FAIL CAPTION_WRAP citing the limit 100`, hit, { status: c.status, codes: ((c.findings ?? []) as S[]).map((x) => x.code), detail: String(w?.detail ?? "").slice(0, 160) })
  }
  L.note("F2", "stand-alone CAPTION_WRAP", { diagrams, wraps })
}

async function flowF3(s: AccSession, L: Ledger) {
  const { bigDocChapters } = await import("../fixtures/anon126/t13_k1")
  const chapters = bigDocChapters()
  const doc = await newDoc(s, "acc115-f3", "Dokumen uji F3")
  let imported = 0
  for (let i = 0; i < chapters.length; i++) {
    const md = `# ${chapters[i].title}\n\n${chapters[i].markdown}\n`
    const r = await s.call("studio_chapter_import_markdown", { documentId: doc.id, chapterKey: String(i + 1), markdown: md, submit: true, change: CHANGE(`bab ${i + 1}`) })
    if (okCall(r)) imported++
    else L.note("F3", `import chapter ${i + 1}`, { code: errCode(r), text: r._text.slice(0, 300) })
  }
  L.check("F3", "synthetic large document imported (18 chapters)", imported === chapters.length, { imported })
  const t0 = Date.now()
  const r = await s.call("studio_render", { documentId: doc.id, formats: ["html", "pdf"] })
  const ms = Date.now() - t0
  const v = r.verification as S
  const pdfPages = Number(((v?.outputs ?? []) as S[]).find((o) => o.format === "PDF")?.pageCount ?? NaN)
  for (const f of ["HTML", "PDF"]) {
    const oc = checkOf(v, f, "OVERLAP_CLIP")
    const cov = oc?.coverage as S | undefined
    const ratio = cov ? cov.measuredPages / cov.totalPages : NaN
    L.check("F3", `${f}: OVERLAP_CLIP coverage >= 0.90 of the pages`, ratio >= 0.9, { status: oc?.status, reason: oc?.reason ?? null, coverage: cov ?? null, ratio: Number.isFinite(ratio) ? +ratio.toFixed(4) : null })
  }
  const text = r._text
  L.check("F3", 'render text reads "diukur m/n halaman" (N-032)', /diukur \d+\/\d+ halaman/.test(text), { match: /diukur \d+\/\d+ halaman/.exec(text)?.[0] ?? null })
  const oc = checkOf(v, "HTML", "OVERLAP_CLIP")
  const cov = oc?.coverage as S | undefined
  if (cov && cov.measuredPages < cov.totalPages) L.check("F3", "pages left unmeasured carry MEASURE_TRUNCATED (E-14)", oc?.reason === "MEASURE_TRUNCATED" || JSON.stringify(oc).includes("MEASURE_TRUNCATED"), { reason: oc?.reason })
  L.note("F3", "render", { ms, pdfPages, verification: verifySummary(v), pageCounts: ((v?.outputs ?? []) as S[]).map((o) => [o.format, o.pageCount ?? o.pages ?? null]) })
}

const nodeBoxes = (svg: string) =>
  new Map(
    [...svg.matchAll(/<rect\b([^>]*\bdata-mark="node"[^>]*)\/>/g)].map((m) => {
      const a = Object.fromEntries([...m[1].matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)].map((x) => [x[1], x[2]]))
      return [a["data-node"], { x: +a.x, y: +a.y, w: +a.width, h: +a.height }] as const
    }),
  )

/** F4 geometry assertions on a built 14.1-shaped flow: the four parallel targets in one rank (TB: equal y). */
export function t11Geometry(svg: string, rank: string[]) {
  const b = nodeBoxes(svg)
  const boxes = rank.map((id) => b.get(id))
  const present = boxes.every(Boolean)
  const ys = boxes.map((x) => x?.y ?? NaN)
  const xs = boxes.map((x) => x?.x ?? NaN)
  const sameRank = present && ys.every((y) => Math.abs(y - ys[0]) <= 0.5)
  const distinctX = present && new Set(xs.map((x) => x.toFixed(2))).size === rank.length
  const inside = [...b.values()].every((x) => x.x >= -1e-6)
  return { nodes: b.size, sameRank, distinctX, inside, ys: ys.map((y) => +y.toFixed(2)), xs: xs.map((x) => +x.toFixed(2)) }
}

async function flowF4(s: AccSession, L: Ledger) {
  const D = path.join(VENDOR, "src", "lib", "studio", "engine", "diagram")
  const build = await import(path.join(D, "build", "index.ts"))
  const lint = await import(path.join(D, "fit", "lint.ts"))
  const K1 = JSON.parse(readFileSync(path.join(FIX, "t11_k1.json"), "utf8"))
  const spec = { ...structuredClone(K1), direction: "TB", width_mm: 128 }
  const r = build.buildDiagramSvg(spec, { release: false })
  const g = t11Geometry(r.svg, ["n2", "n3", "n4", "n5"])
  const lg = lint.lintDiagramGeometry(r.svg)
  const geomFail = ((r.report.geometry ?? []) as S[]).map((i) => i.checkId).filter((id: string) => id.startsWith("GEOM_"))
  L.check("F4", "TB at 128 mm: the four parallel targets share one rank (y within 0.5 mm), distinct x", g.sameRank && g.distinctX, g)
  L.check("F4", "TB at 128 mm: edgeCollinear 0 and zero GEOM findings", (lg.counts.edgeCollinear ?? 0) === 0 && geomFail.length === 0, { counts: lg.counts, geom: geomFail })
  const fit = await figureFit(r.svg)
  L.check("F4", "TB at 128 mm: FIGURE_FIT PASS on the built SVG", fit.status === "PASS", fit)
  // Through the host: inline preview (the machine gate, C19a) and the stand-alone PNG through the real bridge.
  const doc = await newDoc(s, "acc115-f4", "Dokumen uji F4")
  // The inline v2 spec takes no $schema/id/title, and no width_mm (display field: the template sets the width).
  const { $schema: _s, id: _i, title: _t, width_mm: _w, ...v2 } = spec as S
  const block = { type: "diagram", spec: { ...v2, direction: "TB" }, caption: { text: "Alur alfa bravo charlie" }, source: { text: "Uji." } }
  const sub = await s.call("studio_chapter_submit", { submission: chapterSub(doc.id, "1", [{ type: "paragraph", text: "Paragraf alfa." }, block]), detail: true })
  L.check("F4", "chapter with direction TB accepted", okCall(sub), { code: errCode(sub), text: okCall(sub) ? "" : sub._text.slice(0, 300) })
  const pv = await s.call("studio_figure_preview", { documentId: doc.id, block })
  const defects = ((pv.figure?.defects ?? []) as S[]).map((d) => `${d.checkId}:${d.status}`)
  L.check("F4", "inline preview (machine gate): no defect", okCall(pv) && defects.length === 0, { code: errCode(pv), defects, size: pv.figure?.size ?? null })
  const dl = path.join(s.project, "f4")
  mkdirSync(dl, { recursive: true })
  const png = await s.call("studio_figure_preview", { documentId: doc.id, address: "Gambar 1.1", standalone: true, png: true, downloadDir: dl })
  const pngFiles = existsSync(dl) ? (await Array.fromAsync(new Bun.Glob("*.png").scan(dl))).map((f) => path.join(dl, f)) : []
  L.check("F4", "stand-alone PNG rendered through the real bridge", okCall(png) && pngFiles.length >= 1, { code: errCode(png), files: pngFiles.length, sha256: pngFiles[0] ? sha256(readFileSync(pngFiles[0])) : null, bytes: pngFiles[0] ? readFileSync(pngFiles[0]).length : null })
  if (pngFiles[0]) copyFileSync(pngFiles[0], path.join(s.work, "f4_t11_k1_tb128.png"))
  // Alias: a misspelt direction key gets a refusal hint naming `direction` (N-110).
  for (const alias of ["rankdir", "arah"]) {
    const bad = { ...block, spec: { ...structuredClone(v2), [alias]: "LR" } }
    delete (bad.spec as S).direction
    const a = await s.call("studio_chapter_submit", { submission: chapterSub(doc.id, "2", [bad]), detail: true })
    L.check("F4", `alias ${alias}: refused, hint names direction`, !okCall(a) && /direction/.test(a._text), { code: errCode(a), text: a._text.replace(/\s+/g, " ").slice(0, 240) })
  }
  // LR at 128 mm is refused FIGURE_OVER_CAPACITY (row 47, 01e §4.5), not drawn badly.
  let lr: unknown = null
  try {
    build.buildDiagramSvg({ ...spec, direction: "LR" }, { release: false })
  } catch (e) {
    lr = e
  }
  L.check("F4", "LR at 128 mm: refused by construction (capacity), not drawn", lr !== null, { code: (lr as S)?.code ?? null, message: String((lr as S)?.message ?? "").slice(0, 160) })
}

async function flowF5(s: AccSession, L: Ledger) {
  const { d01Chapters } = await import("../fixtures/anon126/t14_k1")
  const doc = await newDoc(s, "acc115-f5", "Dokumen uji F5", { tier: "SERAH" })
  const slotFail = await fillSealSlots(s, doc.id, "SERAH")
  L.check("F5", "SERAH document: cover, control sheet, signature filled", slotFail.length === 0, { slotFail })
  const chapters = d01Chapters()
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i]
    const sub = { $schema: "studio.chapter/v2", target: { documentId: doc.id }, chapter: { key: String(i + 1), title: { text: c.title }, sections: [{ title: { text: "Uraian bagian" }, blocks: c.paragraphs.map((p) => ({ type: "paragraph", text: p })) }] } }
    const r = await s.call("studio_chapter_submit", { submission: sub, detail: true })
    if (!okCall(r)) L.note("F5", `chapter ${i + 1} submit`, { code: errCode(r), text: r._text.slice(0, 300) })
  }
  // The status tool reads the stored lint report, written by a render (NOT_RUN before): render once, HTML only.
  const rr = await s.call("studio_render", { documentId: doc.id, formats: ["html"] })
  L.note("F5", "render (writes the lint report)", { code: errCode(rr), verification: verifySummary(rr.verification), text: okCall(rr) ? "" : rr._text.slice(0, 300) })
  const st = (findings?: S) => s.call("studio_document_status", { documentId: doc.id, ...(findings ? { findings } : {}) })
  const p1 = await st({ checkId: "D01", offset: 0, limit: 100 })
  const p2 = await st({ checkId: "D01", offset: 100, limit: 100 })
  L.check("F5", "page 1: returned 100, total 145, nextOffset 100", JSON.stringify(p1.findingsPage) === JSON.stringify({ checkId: "D01", chapter: null, total: 145, offset: 0, returned: 100, nextOffset: 100 }), { code: errCode(p1), page: p1.findingsPage ?? null, text: okCall(p1) ? "" : p1._text.slice(0, 200) })
  L.check("F5", "page 2: returned 45, nextOffset null", p2.findingsPage?.returned === 45 && p2.findingsPage?.nextOffset === null, { page: p2.findingsPage ?? null })
  const all = [...((p1.findings ?? []) as S[]), ...((p2.findings ?? []) as S[])]
  L.check("F5", "union of finding ids = 145 distinct", new Set(all.map((f) => f.id)).size === 145, { distinct: new Set(all.map((f) => f.id)).size })
  let sum = 0
  let chapterOk = true
  for (const ch of ["1", "2", "3"]) {
    const r = await st({ checkId: "D01", chapter: ch, limit: 500 })
    sum += Number(r.findingsPage?.total ?? 0)
    chapterOk &&= ((r.findings ?? []) as S[]).every((f) => f.chapter === ch)
  }
  L.check("F5", "per-chapter filter: every finding in its chapter, totals sum to 145", chapterOk && sum === 145, { sum, chapterOk })
  const bad = await st({ checkId: "D01", limit: 501 })
  L.check("F5", "limit 501 refused (N-035 = 500)", !okCall(bad) && bad.findingsPage === undefined, { code: errCode(bad) })
  const plain = await st()
  L.check("F5", "default status unchanged (no findings page; summary capped)", okCall(plain) && plain.findingsPage === undefined, { lintFindings: (plain.lint?.findings ?? []).length })
}

async function flowF6(s: AccSession, L: Ledger, input?: { png: string; label: string }) {
  const flow = input ? "F6-L" : "F6"
  const src = input?.png ?? path.join(FIX, "w13_k1.png")
  const bytes = new Uint8Array(readFileSync(src))
  const SHA = sha256(bytes)
  const dims = pngToRgb(bytes)
  const inRoot = path.join(s.project, input ? "f6l.png" : "w13_k1.png")
  copyFileSync(src, inRoot)
  const put = await s.call("studio_asset_put", { path: inRoot })
  L.check(flow, "studio_asset_put: sha256, ref, size", okCall(put) && put.sha256 === SHA && put.ref === `sha256:${SHA}` && put.widthPx === dims.width && put.heightPx === dims.height, { code: errCode(put), sha256: put.sha256, widthPx: put.widthPx, heightPx: put.heightPx })
  const doc = await newDoc(s, input ? "acc115-f6l" : "acc115-f6", "Dokumen uji F6")
  const md = `# Alur alfa\n\nParagraf pengantar bravo charlie.\n\n![Alur uji delta](sha256:${SHA} "Sumber: diolah dari berkas uji")\n`
  const imp = await s.call("studio_chapter_import_markdown", { documentId: doc.id, chapterKey: "1", markdown: md, submit: true, change: CHANGE("gambar aset") })
  L.check(flow, "chapter with the sha256 image reference imported", okCall(imp), { code: errCode(imp), text: okCall(imp) ? "" : imp._text.slice(0, 300) })
  const r = await s.call("studio_render", { documentId: doc.id, formats: ["docx", "html", "pdf"] })
  const outs = ((r.outputs ?? r.files ?? []) as S[])
  L.note(flow, "render", { code: errCode(r), outputs: outs.map((o) => [o.format, o.bytes]), verification: verifySummary(r.verification) })
  const fileOf = (f: string) => outs.find((o) => String(o.format).toUpperCase() === f)
  // The bytes come back the way a user gets them: studio_file_verify with a downloadDir (sha checked on the way).
  const dl = path.join(s.project, input ? "f6l_out" : "f6_out")
  mkdirSync(dl, { recursive: true })
  const verified: Record<string, S> = {}
  const read = (f: string) => {
    const p = verified[f]?.savedTo
    return typeof p === "string" && existsSync(p) ? new Uint8Array(readFileSync(p)) : null
  }
  for (const f of ["DOCX", "HTML", "PDF"]) {
    const o = fileOf(f)
    if (o) verified[f] = await s.call("studio_file_verify", { fileId: o.id, downloadDir: dl, expectedSha256: o.sha256 })
  }
  const docx = read("DOCX")
  const html = read("HTML")
  const pdf = read("PDF")
  if (docx) {
    const zip = unzipSync(docx)
    const part = `word/media/fig-${SHA.slice(0, 32)}.png`
    L.check(flow, "DOCX: word/media/fig-<sha32>.png sha256 equals the source", !!zip[part] && sha256(zip[part]) === SHA, { part: zip[part] ? part.replace(SHA.slice(0, 32), "<sha32>") : null, media: Object.keys(zip).filter((p) => p.startsWith("word/media/")).length })
  } else L.check(flow, "DOCX output present", false, null)
  if (html) {
    const uris = [...strFromU8(html).matchAll(/src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g)].map((m) => sha256(new Uint8Array(Buffer.from(m[1], "base64"))))
    L.check(flow, "HTML: the data URI decodes to the source bytes", uris.includes(SHA), { dataUris: uris.length })
  } else L.check(flow, "HTML output present", false, null)
  if (pdf) {
    const pc = pdfImageCheck(pdf, bytes)
    L.check(flow, "PDF (W-13, 01f §5 c): an image XObject with the asset's width x height", pc.sizeMatch >= 1, pc)
    L.note(flow, "C19i: PDF re-encode", { reencoded: pc.reencoded, pngBytesInPdf: pc.pngBytesInPdf, pixelsEqual: pc.pixelsEqual, maxDelta: pc.maxDelta })
  } else L.check(flow, "PDF output present", false, null)
  for (const f of ["DOCX", "PDF"]) {
    const fv = verified[f]
    const b = read(f)
    if (!fv || !b) {
      L.check(flow, `studio_file_verify ${f}: output present`, false, { code: fv ? errCode(fv) : "NO_OUTPUT" })
      continue
    }
    const want = sha256(b)
    L.check(flow, `studio_file_verify ${f}: FILE_VERIFIED(sha256) with the file's sha`, okCall(fv) && fv.verified === true && fv.sha256 === want && /FILE_VERIFIED\(sha256\)/.test(fv._text), { code: errCode(fv), verified: fv.verified, shaMatch: fv.sha256 === want, sha256: want, line: (/FILE_VERIFIED\(sha256\)\s+[0-9a-f]{8}/.exec(fv._text)?.[0] ?? "") })
  }
  if (input) return
  // Refusals (01g F6 C).
  const svgBytes = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'
  const svgB64 = await s.call("studio_asset_put", { dataBase64: Buffer.from(svgBytes).toString("base64") })
  L.check(flow, "SVG content refused ASSET_TYPE_UNSUPPORTED", errCode(svgB64) === "ASSET_TYPE_UNSUPPORTED", { code: errCode(svgB64) })
  const svgPath = path.join(s.project, "w13_k1.svg")
  writeFileSync(svgPath, svgBytes)
  const svg = await s.call("studio_asset_put", { path: svgPath })
  L.check(flow, "SVG by path refused (extension check before reading)", !okCall(svg), { code: errCode(svg) })
  const outside = path.join(s.work, "outside.png")
  copyFileSync(src, outside)
  const out = await s.call("studio_asset_put", { path: outside })
  L.check(flow, "path outside the session root refused PATH_OUTSIDE_ROOT(S)", /PATH_OUTSIDE_ROOTS?/.test(`${errCode(out)} ${out._text}`), { code: errCode(out) })
  const unk = await s.call("studio_chapter_import_markdown", { documentId: doc.id, chapterKey: "1", markdown: `# Bab\n\n![Tidak ada](sha256:${"0".repeat(64)} "Sumber: uji")\n`, submit: true, change: CHANGE("rujukan tak dikenal") })
  L.check(flow, "unknown sha reference refused ASSET_NOT_FOUND", !okCall(unk) && JSON.stringify(unk).includes("ASSET_NOT_FOUND"), { code: errCode(unk) })
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function runCLayer(work: string, only?: string[]) {
  const L = new Ledger("acc115")
  const want = (f: string) => !only || only.includes(f)
  if (want("F1")) await flowF1(L)
  const s = new AccSession(work)
  await s.start({ bridge: true })
  console.log(`[acc115] bridge scripts ${JSON.stringify(s.bridge?.info.scripts ?? [])} electron pid ${s.bridge?.info.pid}`)
  try {
    await s.openMission(["F2", "F3", "F4", "F5", "F6"])
    for (const [f, fn] of [["F2", flowF2], ["F4", flowF4], ["F5", flowF5], ["F6", flowF6], ["F3", flowF3]] as const) {
      if (!want(f)) continue
      await s.resetLimits()
      try {
        await fn(s, L)
      } catch (e) {
        L.check(f, "flow ran to the end", false, { error: String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 600) })
      }
    }
  } finally {
    const st = await s.stop()
    L.note("ALL", "electron stop", st)
  }
  return L
}

export { flowF6 }

if (import.meta.main) {
  const work = workRoot()
  const only = process.env.ACC_FLOWS?.split(",").map((x) => x.trim()).filter(Boolean)
  const t0 = Date.now()
  const L = await runCLayer(work, only)
  const summary = L.summary()
  writeFileSync(path.join(work, "result_c.json"), JSON.stringify({ head: process.env.ACC_HEAD ?? null, ms: Date.now() - t0, summary, checks: L.checks }, null, 1))
  console.log(`[acc115] SUMMARY ${JSON.stringify(summary)}`)
  process.exit(L.checks.every((c) => c.pass) ? 0 : 1)
}
