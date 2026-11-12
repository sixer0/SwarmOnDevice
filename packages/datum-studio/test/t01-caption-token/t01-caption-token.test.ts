// Swarm 1.2.6 row 27 (T-01, register N-011..N-014, flow F2 C 6/6): a figure caption whose plain text starts with a
// figure-label token ("Gambar 1.1 ...") is refused CAPTION_TOKEN_DUPLICATE at chapter submit (R12 submitChapter over
// the host store), at figure_revise (R16 patchPid, the route studio_figure_revise calls) and on an image block; the
// message names the rule and the caption limit 100 (CAPTION_GUIDE_MAX_CHARS). The same block without the token is
// accepted, so the refusal is the token and nothing else. Page render is not gated (compose still maps the block).
// Constant names are not imported here on purpose: they are new in 1.2.6, and the red run at BASE must fail on the
// assertions, not on a missing export.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { validateBlockV2, validateChapterV2 } from "../../vendor/src/lib/studio/services/revisions/v2/body"
import { validateV2Against } from "../../vendor/src/lib/studio/services/ingest/validate"
import { naskahToBlockV2, type NaskahBlock } from "./naskah-map"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const FIX = path.join(PKG, "test", "fixtures", "anon126")
const CHECK = "CAPTION_TOKEN_DUPLICATE"
// Register N-013, restated (see the header): used only to build the token-free control caption.
const TOKEN_RE = /^\s*(gambar|figure|fig\.|grafik|bagan|diagram)\s*[A-Z]?\d+(?:[.\-]\d+)*\b/i

const NASKAH: Array<[string, NaskahBlock]> = [1, 2, 3, 4, 5, 6].map((i) => [`t01_k${i}`, JSON.parse(readFileSync(path.join(FIX, `t01_k${i}.json`), "utf8"))])
const stripped = (c: string) => c.replace(TOKEN_RE, "").trim()

type Issue = { pointer: string; keyword: string; message: string; checkId?: string }
const tokenIssues = (issues: Issue[]) => issues.filter((i) => i.checkId === CHECK)

describe("T-01 validator: the six F2 fixtures (C 6/6)", () => {
  for (const [name, n] of NASKAH) {
    test(`${name}: token-led caption refused ${CHECK} with the limit; token-free caption accepted`, () => {
      const issues = validateBlockV2(naskahToBlockV2(n), "/block") as Issue[]
      const hit = tokenIssues(issues)
      expect(hit.length).toBe(1)
      expect(hit[0].pointer).toBe("/block/caption")
      expect(hit[0].message).toContain("100")
      expect(hit[0].message).toContain("GAMBAR n.m")
      // the token is the only reason: without it the mapped block validates clean
      expect(validateBlockV2(naskahToBlockV2(n, stripped(n.caption)), "/block")).toEqual([])
    })
  }

  test("chapter submit schema (studio.chapter/v2, R12) refuses each fixture at its block pointer", () => {
    const blocks = NASKAH.map(([, n]) => naskahToBlockV2(n))
    const body = { $schema: "studio.chapter/v2", target: { documentId: "x" }, chapter: { key: "1", title: { text: "Uji" }, sections: [{ title: { text: "Uji" }, blocks }] } }
    const hit = tokenIssues(validateV2Against("studio.chapter/v2", body) as Issue[])
    expect(hit.map((i) => i.pointer)).toEqual(blocks.map((_, i) => `/chapter/sections/0/blocks/${i}/caption`))
  })

  test("image, symbolSheet, artifactId diagram and a runs caption are refused too", () => {
    const cap = { text: "Gambar 2.3. Denah ruang server." }
    const src = { text: "Uji." }
    for (const block of [
      { type: "image", asset: "foto-1", caption: cap, source: src },
      { type: "symbolSheet", dialect: "iec", caption: cap, source: src },
      { type: "diagram", artifactId: "art-1", caption: cap, source: src },
      { type: "image", asset: "foto-1", caption: { runs: [{ t: "Figure 4-2 " }, { t: "Topologi", b: true }] }, source: src },
    ]) {
      expect(tokenIssues(validateChapterV2({ key: "1", title: { text: "x" }, sections: [{ title: { text: "x" }, blocks: [block] }] }) as Issue[]).length).toBe(1)
    }
  })

  test("captions that only mention a figure, or a keyword without a number, are accepted", () => {
    for (const text of ["Topologi jaringan, lihat Gambar 1.1.", "Diagram alir pengadaan.", "Gambaran umum sistem 1.1.", "Grafik beban harian."]) {
      expect(tokenIssues(validateBlockV2({ type: "image", asset: "foto-1", caption: { text }, source: { text: "Uji." } }, "/block") as Issue[])).toEqual([])
    }
  })
})

// row 27b (C12, N-013 amended to \s*): the separator between keyword and number may be absent; a word that merely
// starts with a keyword ("Gambaran", "Diagramnya") is not a token because a digit must follow.
describe("T-01 row 27b: token without a space (C12)", () => {
  const img = (text: string) => ({ type: "image", asset: "foto-1", caption: { text }, source: { text: "Uji." } })
  test("no-space and mixed-case token captions are refused", () => {
    for (const text of ["Gambar1.1 Topologi jaringan.", "GAMBAR 2-3 Denah ruang.", "Figure 4.1 Arsitektur.", "Gambar2.3. Denah.", "Fig.5 Alur.", "grafik7 Beban harian."]) {
      expect(tokenIssues(validateBlockV2(img(text), "/block") as Issue[]).length).toBe(1)
    }
  })
  test("words that only start with a keyword are accepted", () => {
    for (const text of ["Gambaran umum sistem.", "Gambaran umum 1.1 sistem.", "Diagramnya memuat 3 lapis.", "Figurehead 2 tim."]) {
      expect(tokenIssues(validateBlockV2(img(text), "/block") as Issue[])).toEqual([])
    }
  })
})

// ── host store: the LocalStudioApi routes the MCP tools call (R12 chapter submit, R16 PATCH = studio_figure_revise) ──
const WORK = realpathSync(mkdtempSync(path.join(tmpdir(), "row27-")))
const ROOT = path.join(WORK, "datum-studio")
for (const d of ["structure", "submit", "revisions"]) mkdirSync(path.join(ROOT, "logs", d), { recursive: true })
const SECRET = "t".repeat(64)
const CHANGE = { what: "caption diperbarui", why: "uji T-01", impact: "Bab 1" }

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let api: { fetch: (url: string, init?: Record<string, unknown>) => Promise<{ status: number; text(): Promise<string> }> }
let documentId = ""

async function local(method: string, route: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const r = await api.fetch(`http://127.0.0.1:1${route}`, {
    method,
    headers: { "x-internal-secret": SECRET, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
  })
  const text = await r.text()
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, text }
}

/** Every issue object with a `checkId` anywhere in a response body. */
function bodyIssues(v: unknown, out: Issue[] = []): Issue[] {
  if (Array.isArray(v)) for (const x of v) bodyIssues(x, out)
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    if (typeof o.checkId === "string" && typeof o.pointer === "string") out.push(o as unknown as Issue)
    for (const x of Object.values(o)) bodyIssues(x, out)
  }
  return out
}

beforeAll(() => setup())
async function setup() {
  process.env.STUDIO_WORKSPACE_ROOT = ROOT
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
  mod = await import("../../src/mcp-host/index.ts")
  store = await mod.openHostStore(ROOT, { release: "1.2.6", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.6" })
  const { createLocalStudioApi } = await import("../../src/mcp-host/local-api/router.ts")
  const { LOCAL_ROUTES } = await import("../../src/mcp-host/local-api/routes.ts")
  api = createLocalStudioApi({ baseUrl: "http://127.0.0.1:1", secret: SECRET, agentId: "row27", routes: LOCAL_ROUTES }) as unknown as typeof api
  const r = await local("POST", "/api/studio/documents", {
    $schema: "studio.doc/v2",
    template: { slug: "datum-gsp" },
    meta: { title: "Uji caption", typeCode: "KT", tier: "NOTA", classification: "BIASA", language: "ID", author: "Row 27", issueDate: "2026-11-12", rev: "A" },
    mission: { folder: "2026-11-12_row27-caption" },
    sections: { content: { type: "chapter", chapters: [{ key: "1", title: { text: "Uji" }, sections: [{ title: { text: "Uji" }, blocks: [{ type: "paragraph", text: "Paragraf awal uji." }] }] }] } },
  })
  expect(r.status).toBe(201)
  documentId = String((r.body.document as Record<string, unknown>).id)
}

afterAll(async () => {
  mod?.configureTemplateSource(null as never)
  if (store) await mod.closeHostStore(store)
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
  rmSync(WORK, { recursive: true, force: true })
})

const chapterBody = (base: number, blocks: unknown[]) => ({
  $schema: "studio.chapter/v2",
  target: { documentId },
  baseRevisionNo: base,
  chapter: { key: "1", title: { text: "Uji" }, sections: [{ title: { text: "Uji" }, blocks }] },
  change: CHANGE,
})

async function current(): Promise<number> {
  return Number((await store.getDocument(documentId))?.document.current_revision_no)
}

describe("T-01 entry points over the host routes (flow F2 C 6/6)", () => {
  test("chapter submit (R12): every fixture is refused 400 SCHEMA_INVALID / CAPTION_TOKEN_DUPLICATE and writes nothing", async () => {
    for (const [name, n] of NASKAH) {
      const before = await current()
      const r = await local("POST", "/api/studio/chapters", chapterBody(before, [naskahToBlockV2(n)]))
      expect({ name, status: r.status, code: r.body.code }).toEqual({ name, status: 400, code: "SCHEMA_INVALID" })
      const hit = tokenIssues(bodyIssues(r.body))
      expect(hit.length).toBe(1)
      expect(hit[0].message).toContain("100")
      expect(await current()).toBe(before)
    }
  })

  test("chapter submit (R12) of the six token-free blocks is accepted", async () => {
    const before = await current()
    const r = await local("POST", "/api/studio/chapters", chapterBody(before, NASKAH.map(([, n]) => naskahToBlockV2(n, stripped(n.caption)))))
    expect(r.status).toBe(201)
    expect(await current()).toBe(before + 1)
  })

  test("figure_revise (R16 PATCH replace): token caption refused, token-free caption accepted", async () => {
    const rev = await store.getRevision(documentId, await current())
    const fig = (rev!.blocks as Array<Record<string, unknown>>).find((b) => /diagram|chart/.test(String(b.type ?? b.block_type ?? b.kind ?? "")))
    const pid = String(fig?.pid)
    expect(pid).toMatch(/^p-/)
    const route = `/api/studio/documents/${documentId}/paragraphs/${pid}`
    for (const [name, n] of NASKAH) {
      const base = await current()
      const r = await local("PATCH", route, { op: "replace", baseRevisionNo: base, block: naskahToBlockV2(n), change: CHANGE })
      expect({ name, status: r.status, code: r.body.code }).toEqual({ name, status: 400, code: "SCHEMA_INVALID" })
      const hit = tokenIssues(bodyIssues(r.body))
      expect(hit.map((i) => i.pointer)).toEqual(["/block/caption"])
      expect(hit[0].message).toContain("100")
      expect(await current()).toBe(base)
    }
    // a caption the first block does not already carry (k3 without its token)
    const [, k3] = NASKAH[2]
    const base = await current()
    const ok = await local("PATCH", route, { op: "replace", baseRevisionNo: base, block: naskahToBlockV2(k3, stripped(k3.caption)), change: CHANGE })
    expect(ok.status).toBe(200)
    expect(await current()).toBe(base + 1)
  })

  test("page render is not gated: compose maps a stored token-led caption without refusing", async () => {
    const compose = await import(path.join(VENDOR, "src", "lib", "studio", "services", "compose", "index.ts"))
    const block = naskahToBlockV2(NASKAH[0][1])
    expect(() => compose.mapBlock(structuredClone(block), "fig-diagram-11", { glyphs: compose.glyphSet(undefined), params: {}, classification: "TERBATAS", artifactLabel: "Gambar 1.1" })).not.toThrow()
  })
})
