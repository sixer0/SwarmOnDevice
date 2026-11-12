// Row 51 (1.2.6, W-13, 01f §4.3 / §5 / T7): probe that an uploaded raster asset referenced by sha256 from a
// document block reaches the rendered DOCX and HTML byte for byte. Through the REAL host server
// (startStudioHostServer, streamable HTTP on 127.0.0.1 port 0, MCP SDK client), a real store in a temp folder, the
// vendored services and engines; no render bridge (DOCX and HTML are assembled in process; PDF is not asked for).
// Fixture: test/fixtures/anon126/w13_k1.png (row 24, D2). Two reference forms are probed:
//   - Markdown `![caption](sha256:<hex> "Sumber: …")` through studio_chapter_import_markdown;
//   - a direct v2 block `{ type:"image", asset:"sha256:<hex>", caption, source }` through R14 PATCH insert.
// Acceptance (01f §5): DOCX part word/media/fig-<sha[0:32]>.png whose sha256 == asset sha; HTML
// <figure data-block-type="image" data-graphic-source="asset"> with a data URI whose decoded sha256 == asset sha.
// Upload is studio_asset_put (row 50c), so this file is red at e363918a69 at the upload step (tool absent).
// Needs the command sandbox off (binds a port).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const FIXTURE = path.join(PKG, "test", "fixtures", "anon126", "w13_k1.png")
const BASE = process.env.ROW51_TEST_DIR ?? "/private/tmp/claude-501/row51/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row51-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-a")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET
delete process.env.DATUM_RENDER_SOCKET
delete process.env.DATUM_RENDER_TOKEN

const TOKEN = "f".repeat(16) + "0123456789abcdef".repeat(3)
const SECRET = "s".repeat(64)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const BYTES = new Uint8Array(readFileSync(FIXTURE))
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
const SHA = sha(BYTES)
const CHANGE = (what: string) => ({ what, why: "uji row 51", impact: "revisi baru; revisi lama tetap" })

const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row51 test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
type S = Record<string, any>
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
let api: { fetch: (url: string, init?: Record<string, unknown>) => Promise<{ status: number; text(): Promise<string> }> }

async function call(name: string, args: Record<string, unknown>): Promise<S> {
  try {
    const r = await c.callTool({ name, arguments: args })
    return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n") }
  } catch (e) {
    return { ok: false, code: "CALL_THREW", _text: String(e) }
  }
}
async function local(method: string, route: string, body?: unknown): Promise<{ status: number; body: S }> {
  const r = await api.fetch(`http://127.0.0.1:1${route}`, {
    method,
    headers: { "x-internal-secret": SECRET, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
  })
  const text = await r.text()
  return { status: r.status, body: text ? (JSON.parse(text) as S) : {} }
}
function q<T = S>(sql: string, params: unknown[] = []): T[] {
  return (store as unknown as { requireReader(): { all(s: string, p?: unknown[]): unknown[] } }).requireReader().all(sql, params) as T[]
}
function outputBytes(id: string): Uint8Array {
  const row = q<{ rel_path: string; sha256: string }>("SELECT rel_path, sha256 FROM output_file WHERE id = ?", [id])[0]
  expect(row).toBeDefined()
  const b = new Uint8Array(readFileSync(path.join(STORE, row.rel_path)))
  expect(sha(b)).toBe(row.sha256)
  return b
}

/** Renders `formats` for the chapter scope through R17 and returns the bytes per format. */
async function renderChapter(documentId: string, key: string, formats: string[]): Promise<{ res: { status: number; body: S }; out: Record<string, Uint8Array> }> {
  const res = await local("POST", `/api/studio/documents/${documentId}/render`, { scope: "chapter", key, formats })
  const out: Record<string, Uint8Array> = {}
  for (const o of (res.body.outputs ?? []) as Array<{ id: string; format: string }>) out[o.format] = outputBytes(o.id)
  return { res, out }
}

/** The acceptance checks of 01f §5 on one DOCX and one HTML output. */
function assertEmbedded(out: Record<string, Uint8Array>): { media: string; dataUris: number } {
  expect(Object.keys(out).sort()).toEqual(["DOCX", "HTML"])
  const zip = unzipSync(out.DOCX)
  const media = Object.keys(zip).filter((p) => p.startsWith("word/media/"))
  const part = `word/media/fig-${SHA.slice(0, 32)}.png`
  expect(media).toContain(part)
  expect(sha(zip[part])).toBe(SHA)
  expect(strFromU8(zip["word/_rels/document.xml.rels"])).toContain(`Target="media/fig-${SHA.slice(0, 32)}.png"`)
  const html = strFromU8(out.HTML)
  const figures = [...html.matchAll(/<figure\b[^>]*data-block-type="image"[^>]*>[\s\S]*?<\/figure>/g)].map((m) => m[0])
  const asset = figures.filter((f) => /data-graphic-source="asset"/.test(f))
  expect(asset.length).toBeGreaterThanOrEqual(1)
  const uris = asset.flatMap((f) => [...f.matchAll(/src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g)].map((m) => m[1]))
  expect(uris.length).toBeGreaterThanOrEqual(1)
  for (const u of uris) expect(sha(new Uint8Array(Buffer.from(u, "base64")))).toBe(SHA)
  return { media: part, dataUris: uris.length }
}

let documentId = ""
let chapterKey = "1"

beforeAll(async () => {
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  store = await mod.openHostStore(STORE, { release: "1.2.6", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.6" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log: () => undefined, facts: FACTS })
  c = new Client({ name: "row51-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "claude", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
  const { createLocalStudioApi } = await import("../../src/mcp-host/local-api/router.ts")
  const { LOCAL_ROUTES } = await import("../../src/mcp-host/local-api/routes.ts")
  api = createLocalStudioApi({ baseUrl: "http://127.0.0.1:1", secret: SECRET, agentId: "claude", routes: LOCAL_ROUTES }) as unknown as typeof api
}, 60_000)

afterAll(async () => {
  await c?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  globalThis.fetch = realFetch
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetRenderRateLimiter()
})

describe("row 51: W-13 sha256 asset reference reaches DOCX and HTML", () => {
  test("upload the fixture through studio_asset_put (path inside the session root)", async () => {
    const p = path.join(PROJECT, "w13_k1.png")
    copyFileSync(FIXTURE, p)
    const r = await call("studio_asset_put", { path: p })
    expect(r._isError).toBe(false)
    expect(r).toMatchObject({ ok: true, sha256: SHA, ref: `sha256:${SHA}`, mime: "image/png", widthPx: 64, heightPx: 48 })
  })

  test("Markdown ![caption](sha256:… \"Sumber: …\") imports, commits and renders: DOCX media part and HTML data URI decode to the asset sha", async () => {
    const create = await call("studio_document_create", { template: "datum-gsp", mission: "2026-11-12_row51", docKey: "row51-doc", title: "Dokumen uji row 51" })
    expect(create.ok).toBe(true)
    documentId = String(create.documentId)
    const md = `# Alur verifikasi\n\nParagraf pengantar untuk gambar uji.\n\n![Alur uji dari Graphviz](sha256:${SHA} "Sumber: diolah dengan Graphviz 16.1.0 dari w13_k1.dot")\n`
    const imp = await call("studio_chapter_import_markdown", { documentId, chapterKey, markdown: md, submit: true, change: CHANGE("Bab 1 dengan gambar aset") })
    expect(imp.ok).toBe(true)
    // The importer keeps the image (nothing dropped) and raises no IMAGE_* warning (01f §9 step 2).
    expect(JSON.stringify(imp)).not.toMatch(/IMAGE_[A-Z_]+|ASSET_NOT_FOUND/)
    expect(imp._text).toContain("0 dibuang")
    const { res, out } = await renderChapter(documentId, chapterKey, ["docx", "html"])
    expect(res.status).toBeLessThan(300)
    assertEmbedded(out)
  }, 120_000)

  test("direct v2 image block { asset: \"sha256:<hex>\" } inserted through R14 PATCH renders the same bytes", async () => {
    const doc2 = await call("studio_document_create", { template: "datum-gsp", mission: "2026-11-12_row51", docKey: "row51-doc-2", title: "Dokumen uji row 51 blok" })
    expect(doc2.ok).toBe(true)
    const id2 = String(doc2.documentId)
    const imp = await call("studio_chapter_import_markdown", { documentId: id2, chapterKey, markdown: "# Bab blok\n\nParagraf jangkar.\n", submit: true, change: CHANGE("Bab 1") })
    expect(imp.ok).toBe(true)
    const rv = await import("../../vendor/src/lib/studio/services/revisions/index.ts")
    const { localStudioCaller } = await import("../../vendor/src/lib/studio/contract/auth.ts")
    const rev = Number(q<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [id2])[0].n)
    const st = await call("studio_document_structure", { documentId: id2, op: "get" })
    const slot = Object.keys((st.outlines ?? {}) as object)[0] ?? ""
    const content = await local("GET", `/api/studio/documents/${id2}/content?slot=${slot}&chapter=${chapterKey}`)
    expect(content.status).toBe(200)
    const pid = findParagraphId(content.body.content)
    expect(pid).toBeTruthy()
    const g = await local("GET", `/api/studio/documents/${id2}/paragraphs/${pid}`)
    expect(g.status).toBe(200)
    const addr = String(g.body.address)
    const block = { type: "image", asset: `sha256:${SHA}`, caption: { text: "Alur uji blok langsung" }, source: { text: "diolah dengan Graphviz 16.1.0 dari w13_k1.dot" } }
    const patched = await (rv as S).patchBlock(id2, addr, { baseRevisionNo: rev, op: "insertAfter", block, change: CHANGE("Gambar aset") } as never, localStudioCaller("claude"))
    expect(patched.revision.revisionNo).toBe(rev + 1)
    const { res, out } = await renderChapter(id2, chapterKey, ["docx", "html"])
    expect(res.status).toBeLessThan(300)
    assertEmbedded(out)
  }, 120_000)

  test("unknown sha reference (64 x 0) is refused with ASSET_NOT_FOUND at commit (T8, unchanged)", async () => {
    const md = `# Bab\n\n![Tidak ada](sha256:${"0".repeat(64)} "Sumber: uji")\n`
    const r = await call("studio_chapter_import_markdown", { documentId, chapterKey, markdown: md, submit: true, change: CHANGE("Rujukan tak dikenal") })
    expect(r.ok).not.toBe(true)
    expect(JSON.stringify(r)).toContain("ASSET_NOT_FOUND")
  })
})

/** Id of the first paragraph block in a projected chapter. */
function findParagraphId(node: unknown): string {
  let hit = ""
  const walk = (o: unknown): void => {
    if (hit || !o || typeof o !== "object") return
    if (Array.isArray(o)) return o.forEach(walk)
    const r = o as S
    if (r.type === "paragraph" && typeof r.id === "string") hit = r.id
    for (const v of Object.values(r)) walk(v)
  }
  walk(node)
  return hit
}
