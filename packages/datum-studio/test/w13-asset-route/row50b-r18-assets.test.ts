// Row 50b (1.2.6, W-13 N-107, 01f §4.2 / T6 + the route side of T2-T4): R18 POST /api/studio/assets
// (multipart `file`, JSON dataBase64, JSON path inside the session file root) and GET ?sha256=.
// Real store in a temp folder, the real LocalStudioApi router with LOCAL_ROUTES; no network.
// Red at e363918a69: LOCAL_ROUTES has no R18, so every request answers 404 ROUTE_NOT_FOUND.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { deflateSync } from "node:zlib"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const BASE = process.env.ROW50B_TEST_DIR ?? "/private/tmp/claude-501/row50b/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row50b-")))
const STORE = path.join(WORK, "datum-studio")
const ROOT = path.join(WORK, "project")
const OUTSIDE = path.join(WORK, "outside")
for (const d of [ROOT, OUTSIDE]) mkdirSync(d, { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR

const SECRET = "a".repeat(64)
const MIB = 1024 * 1024
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
const JPEG = new Uint8Array(readFileSync(path.join(PKG, "test", "fixtures", "row50a", "gps-1x1.jpg")))

function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (const x of b) {
    c ^= x
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** w x h RGBA PNG (grey level `g`); `rows: false` gives a header-only claim (no matching IDAT). */
function png(w: number, h: number, g = 10, rows = true): Uint8Array {
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, w)
  new DataView(ihdr.buffer).setUint32(4, h)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = new Uint8Array(rows ? h * (1 + 4 * w) : 5).fill(g)
  if (rows) for (let y = 0; y < h; y++) raw[y * (1 + 4 * w)] = 0
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((o, p) => (out.set(p, o), o + p.length), 0)
  return out
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")

type Api = { fetch: (url: string, init: Record<string, unknown>) => Promise<{ status: number; headers: { get(n: string): string | null }; text(): Promise<string> }> }
type Mod = typeof import("../../src/mcp-host/index.ts")
type RouteDef = { id: string; methods: Record<string, ((req: Request, rc: unknown) => Promise<Response>) | undefined> }
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let api: Api
let routes: readonly RouteDef[]
let rcBase: Record<string, unknown>

async function makeApi(agentId: string, fileRoot?: string): Promise<Api> {
  const { createLocalStudioApi } = await import("../../src/mcp-host/local-api/router.ts")
  return createLocalStudioApi({ baseUrl: "http://127.0.0.1:1", secret: SECRET, agentId, routes: routes as never, ...(fileRoot ? { fileRoot } : {}) } as never) as unknown as Api
}

async function call(a: Api, method: string, route: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await a.fetch(`http://127.0.0.1:1${route}`, {
    method,
    headers: { "x-internal-secret": SECRET, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    redirect: "manual",
  })
  const text = await r.text()
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

/** Multipart goes to the R18 handler directly: the in-process HttpFetch body is a string (binary-unsafe). */
async function multipart(bytes: Uint8Array, name = "x.png", type = "image/png", extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const def = routes.find((r) => r.id === "R18")
  expect(def?.methods.POST).toBeDefined()
  const fd = new FormData()
  fd.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), name)
  const enc = new Response(fd)
  const req = new Request("http://127.0.0.1:1/api/studio/assets", {
    method: "POST",
    headers: { "content-type": enc.headers.get("content-type") ?? "", "x-studio-agent": "claude", ...extraHeaders },
    body: new Uint8Array(await enc.arrayBuffer()),
  })
  const res = await def!.methods.POST!(req, rcBase)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeAll(async () => {
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
  mod = await import("../../src/mcp-host/index.ts")
  store = await mod.openHostStore(STORE, { release: "1.2.6", logFile: path.join(WORK, "logs", "store.jsonl") })
  routes = (await import("../../src/mcp-host/local-api/routes.ts")).LOCAL_ROUTES as unknown as readonly RouteDef[]
  const { localStudioCaller } = await import("../../vendor/src/lib/studio/contract/auth")
  rcBase = { params: {}, agentId: "claude", caller: localStudioCaller("claude"), fileRoot: ROOT }
  api = await makeApi("claude", ROOT)
})

afterAll(async () => {
  if (store) await mod.closeHostStore(store)
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
})

describe("row 50b: R18 accepts PNG and JPEG by content, dedupes by sha", () => {
  const p1 = png(3, 2, 40)

  test("JSON dataBase64 PNG -> 201 created:true, then 200 created:false with the same sha", async () => {
    const first = await call(api, "POST", "/api/studio/assets", { mime: "image/png", dataBase64: b64(p1) })
    expect(first.status).toBe(201)
    const asset = first.body.asset as Record<string, unknown>
    expect(asset).toMatchObject({ sha256: sha(p1), mime: "image/png", widthPx: 3, heightPx: 2, bytes: p1.length })
    expect(asset).not.toHaveProperty("relPath")
    expect(first.body.created).toBe(true)
    expect(first.body.ref).toBe(`sha256:${sha(p1)}`)
    expect(first.body.metadata).toEqual({ gps: false, exifTags: [], pngTextKeys: [] })
    expect(first.body).not.toHaveProperty("warning")

    const again = await call(api, "POST", "/api/studio/assets", { dataBase64: b64(p1) })
    expect(again.status).toBe(200)
    expect(again.body.created).toBe(false)
    expect((again.body.asset as Record<string, unknown>).sha256).toBe(sha(p1))
  })

  test("multipart file JPEG -> 201 image/jpeg; GPS metadata reported with a warning, bytes unchanged", async () => {
    const r = await multipart(JPEG, "photo.jpg", "image/jpeg")
    expect(r.status).toBe(201)
    expect(r.body.asset).toMatchObject({ sha256: sha(JPEG), mime: "image/jpeg", widthPx: 1, heightPx: 1, bytes: JPEG.length })
    expect((r.body.metadata as Record<string, unknown>).gps).toBe(true)
    expect(String(r.body.warning)).toContain("GPS")
    expect(String(r.body.warning)).toContain("upload it again")
  })

  test("path inside the session file root -> stored; same bytes by another name -> created:false", async () => {
    const p2 = png(5, 4, 99)
    writeFileSync(path.join(ROOT, "fig.png"), p2)
    writeFileSync(path.join(ROOT, "copy-of-fig.PNG"), p2)
    const first = await call(api, "POST", "/api/studio/assets", { path: path.join(ROOT, "fig.png") })
    expect(first.status).toBe(201)
    expect(first.body.asset).toMatchObject({ sha256: sha(p2), widthPx: 5, heightPx: 4 })
    const dup = await call(api, "POST", "/api/studio/assets", { path: path.join(ROOT, "copy-of-fig.PNG") })
    expect(dup.status).toBe(200)
    expect(dup.body.created).toBe(false)
    expect((dup.body.asset as Record<string, unknown>).sha256).toBe(sha(p2))
  })

  test("GET ?sha256= -> 200 { asset }; unknown -> 404 FILE_NOT_FOUND; bad format -> 400 SCHEMA_INVALID", async () => {
    const hit = await call(api, "GET", `/api/studio/assets?sha256=${sha(p1)}`)
    expect(hit.status).toBe(200)
    expect(hit.body.asset).toMatchObject({ sha256: sha(p1), mime: "image/png" })
    const miss = await call(api, "GET", `/api/studio/assets?sha256=${"0".repeat(64)}`)
    expect(miss.status).toBe(404)
    expect(miss.body.code).toBe("FILE_NOT_FOUND")
    const bad = await call(api, "GET", "/api/studio/assets?sha256=xyz")
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe("SCHEMA_INVALID")
  })
})

describe("row 50b: R18 refuses SVG and other types (415 ASSET_TYPE_UNSUPPORTED)", () => {
  test("SVG text as dataBase64", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')
    const r = await call(api, "POST", "/api/studio/assets", { mime: "image/svg+xml", dataBase64: b64(svg) })
    expect(r.status).toBe(415)
    expect(r.body.code).toBe("ASSET_TYPE_UNSUPPORTED")
  })

  test("SVG as multipart file, and a GIF89a header", async () => {
    const svg = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')
    const r = await multipart(svg, "x.svg", "image/svg+xml")
    expect(r.status).toBe(415)
    expect(r.body.code).toBe("ASSET_TYPE_UNSUPPORTED")
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b])
    const g = await call(api, "POST", "/api/studio/assets", { dataBase64: b64(gif) })
    expect(g.status).toBe(415)
    expect(g.body.code).toBe("ASSET_TYPE_UNSUPPORTED")
  })

  test("an SVG renamed .png inside the root is judged by content", async () => {
    writeFileSync(path.join(ROOT, "fake.png"), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const r = await call(api, "POST", "/api/studio/assets", { path: path.join(ROOT, "fake.png") })
    expect(r.status).toBe(415)
    expect(r.body.code).toBe("ASSET_TYPE_UNSUPPORTED")
  })
})

describe("row 50b: R18 size and pixel limits (20 MiB, 20,000 px, 5 MiB JSON)", () => {
  test("path file of 20 MiB + 1 B -> 413 ASSET_TOO_LARGE", async () => {
    writeFileSync(path.join(ROOT, "huge.png"), new Uint8Array(20 * MIB + 1))
    const r = await call(api, "POST", "/api/studio/assets", { path: path.join(ROOT, "huge.png") })
    expect(r.status).toBe(413)
    expect(r.body.code).toBe("ASSET_TOO_LARGE")
  })

  test("multipart file of 20 MiB + 1 B -> 413 ASSET_TOO_LARGE; Content-Length above 21 MiB -> 413 before parsing", async () => {
    const big = new Uint8Array(20 * MIB + 1)
    big.set(png(1, 1))
    const r = await multipart(big)
    expect(r.status).toBe(413)
    expect(r.body.code).toBe("ASSET_TOO_LARGE")
    const declared = await multipart(png(1, 1), "x.png", "image/png", { "content-length": String(21 * MIB + 1) })
    expect(declared.status).toBe(413)
    expect(declared.body.code).toBe("ASSET_TOO_LARGE")
  })

  test("PNG header declaring 20,001 x 1 px -> 413 ASSET_TOO_LARGE", async () => {
    const r = await call(api, "POST", "/api/studio/assets", { dataBase64: b64(png(20001, 1, 0, false)) })
    expect(r.status).toBe(413)
    expect(r.body.code).toBe("ASSET_TOO_LARGE")
  })

  test("JSON body above 5 MiB -> 413 PAYLOAD_TOO_LARGE", async () => {
    const r = await call(api, "POST", "/api/studio/assets", JSON.stringify({ dataBase64: "A".repeat(5 * MIB + 16) }))
    expect(r.status).toBe(413)
    expect(r.body.code).toBe("PAYLOAD_TOO_LARGE")
  })
})

describe("row 50b: R18 path rules (session file root only, symlinks resolved)", () => {
  const out = path.join(OUTSIDE, "outside.png")

  test("absolute path outside the root -> 403 PATH_OUTSIDE_ROOTS", async () => {
    writeFileSync(out, png(2, 2, 7))
    const r = await call(api, "POST", "/api/studio/assets", { path: out })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe("PATH_OUTSIDE_ROOTS")
  })

  test("<root>/../outside/outside.png -> 403 PATH_OUTSIDE_ROOTS", async () => {
    const r = await call(api, "POST", "/api/studio/assets", { path: `${ROOT}/../outside/outside.png` })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe("PATH_OUTSIDE_ROOTS")
  })

  test("symlink inside the root pointing outside -> 403 PATH_OUTSIDE_ROOTS; inside -> inside is accepted", async () => {
    symlinkSync(out, path.join(ROOT, "link-out.png"))
    const r = await call(api, "POST", "/api/studio/assets", { path: path.join(ROOT, "link-out.png") })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe("PATH_OUTSIDE_ROOTS")
    const target = png(2, 3, 55)
    writeFileSync(path.join(ROOT, "real-in.png"), target)
    symlinkSync(path.join(ROOT, "real-in.png"), path.join(ROOT, "link-in.png"))
    const ok = await call(api, "POST", "/api/studio/assets", { path: path.join(ROOT, "link-in.png") })
    expect(ok.status).toBe(201)
    expect((ok.body.asset as Record<string, unknown>).sha256).toBe(sha(target))
  })

  test("a session without a file root refuses every path with PATH_OUTSIDE_ROOTS", async () => {
    const noRoot = await makeApi("claude")
    writeFileSync(path.join(ROOT, "plain.png"), png(1, 2, 3))
    const r = await call(noRoot, "POST", "/api/studio/assets", { path: path.join(ROOT, "plain.png") })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe("PATH_OUTSIDE_ROOTS")
  })

  test("wrong extension, relative path, directory, both or neither source", async () => {
    writeFileSync(path.join(ROOT, "a.txt"), "x")
    expect((await call(api, "POST", "/api/studio/assets", { path: path.join(ROOT, "a.txt") })).body.code).toBe("PATH_INVALID")
    expect((await call(api, "POST", "/api/studio/assets", { path: "fig.png" })).body.code).toBe("PATH_INVALID")
    mkdirSync(path.join(ROOT, "dir.png"))
    const dir = await call(api, "POST", "/api/studio/assets", { path: path.join(ROOT, "dir.png") })
    expect(dir.status).toBe(422)
    expect(dir.body.code).toBe("FILE_UNREADABLE")
    const both = await call(api, "POST", "/api/studio/assets", { path: path.join(ROOT, "fig.png"), dataBase64: b64(png(1, 1)) })
    expect(both.status).toBe(400)
    expect(both.body.code).toBe("SCHEMA_INVALID")
    const neither = await call(api, "POST", "/api/studio/assets", { mime: "image/png" })
    expect(neither.status).toBe(400)
    expect(neither.body.code).toBe("SCHEMA_INVALID")
  })
})

describe("row 50b: R18 rate limit", () => {
  test("the 61st upload in one minute from one caller -> 429 RATE_LIMITED with Retry-After", async () => {
    const own = await makeApi("rate-bot", ROOT)
    const one = { dataBase64: b64(png(1, 1, 200)) }
    for (let i = 0; i < 60; i++) expect((await call(own, "POST", "/api/studio/assets", one)).status).toBeLessThan(300)
    const r = await own.fetch("http://127.0.0.1:1/api/studio/assets", { method: "POST", headers: { "x-internal-secret": SECRET, "content-type": "application/json" }, body: JSON.stringify(one), redirect: "manual" })
    expect(r.status).toBe(429)
    expect(JSON.parse(await r.text()).code).toBe("RATE_LIMITED")
    expect(r.headers.get("retry-after")).not.toBeNull()
  })
})
