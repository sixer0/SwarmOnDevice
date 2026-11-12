// Row 50c (1.2.6, W-13 N-106, 01f §4.1 / T1-T4, SEC-10, SEC-11): the MCP tool `studio_asset_put` through the REAL
// host server (startStudioHostServer, streamable HTTP on 127.0.0.1 port 0, MCP SDK client), real store in a temp folder.
// Red at e363918a69: the host has no `studio_asset_put`, so it is not listed and every call is refused as unknown.
// Needs the command sandbox off (binds a port).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW50C_TEST_DIR ?? "/private/tmp/claude-501/row50c/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row50c-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-a")
const OUTSIDE = path.join(WORK, "outside")
for (const d of [HOME, RES, PROJECT, OUTSIDE]) mkdirSync(d, { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const TOOL = "studio_asset_put"
const MIB = 1024 * 1024
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
const JPEG_GPS = new Uint8Array(readFileSync(path.join(PKG, "test", "fixtures", "row50a", "gps-1x1.jpg")))

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
/** w x h RGBA PNG (grey level `g`); `rows: false` = header-only claim. */
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

const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error("row50c test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
const log = () => undefined

type S = Record<string, any>
async function call(args: Record<string, unknown>): Promise<S> {
  try {
    const r = await c.callTool({ name: TOOL, arguments: args })
    return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n") }
  } catch (e) {
    return { ok: false, code: "CALL_THREW", _text: String(e) }
  }
}

beforeAll(async () => {
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache()
  mod = (await import("../../src/mcp-host/index.ts")) as Mod
  store = await mod.openHostStore(STORE, { release: "1.2.6", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.6" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts: FACTS })
  c = new Client({ name: "row50c-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "claude", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
})

afterAll(async () => {
  await c?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  globalThis.fetch = realFetch
})

describe("row 50c: studio_asset_put is listed", () => {
  test("tools/list has studio_asset_put last, 40 tools, write hints, a description that teaches the sha256 reference; own entry < 2 KB", async () => {
    const tools = (await c.listTools()).tools
    const names = tools.map((t) => t.name)
    expect(names.length).toBe(40)
    expect(names[names.length - 1]).toBe(TOOL)
    const t = tools.find((x) => x.name === TOOL)!
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true })
    expect(Object.keys((t.inputSchema as S).properties).sort()).toEqual(["dataBase64", "documentId", "path"])
    expect((t.inputSchema as S).additionalProperties).toBe(false)
    expect(t.description).toContain('"asset":"sha256:<hex>"')
    expect(t.description).toContain('![caption](sha256:<hex> "Sumber:')
    expect(t.description).toContain("~6 MiB use `path`")
    // G-06's "< 30 KB for the whole list" is row 99's acceptance (the 39-tool list is already above it); this row
    // bounds its own entry.
    expect(JSON.stringify(t).length).toBeLessThan(2 * 1024)
  })
})

describe("row 50c: uploads (T1, dedupe, SEC-10, SEC-11)", () => {
  test("dataBase64 1x1 PNG -> created:true with the full result; the same bytes again -> created:false, same sha", async () => {
    const bytes = png(1, 1, 33)
    const r1 = await call({ dataBase64: b64(bytes) })
    expect(r1._isError).toBe(false)
    expect(r1).toMatchObject({ ok: true, sha256: sha(bytes), ref: `sha256:${sha(bytes)}`, mime: "image/png", widthPx: 1, heightPx: 1, bytes: bytes.length, created: true })
    expect(r1.metadata).toEqual({ gps: false, exifTags: [], pngTextKeys: [] })
    expect(r1.warning).toBeUndefined()
    expect(r1._text).toContain(`asset sha256:${sha(bytes)} (1×1 px`)
    expect(r1._text).toContain(`](sha256:${sha(bytes)} "Sumber:`)
    const r2 = await call({ dataBase64: `data:image/png;base64,${b64(bytes)}` })
    expect(r2).toMatchObject({ ok: true, sha256: sha(bytes), created: false })
  })

  test("path inside the session root -> stored; the text names the basename only (SEC-11, no /Users/ or full path); same bytes by another name -> created:false", async () => {
    const bytes = png(3, 2, 77)
    const p = path.join(PROJECT, "gambar-uji.png")
    writeFileSync(p, bytes)
    const r = await call({ path: p })
    expect(r).toMatchObject({ ok: true, sha256: sha(bytes), widthPx: 3, heightPx: 2, created: true })
    expect(r._text).toContain("dari gambar-uji.png")
    expect(r._text).not.toContain("/Users/")
    expect(r._text).not.toContain(PROJECT)
    writeFileSync(path.join(PROJECT, "salinan.jpeg"), bytes) // extension is a pre-filter only; type comes from content
    const again = await call({ path: path.join(PROJECT, "salinan.jpeg") })
    expect(again).toMatchObject({ ok: true, sha256: sha(bytes), mime: "image/png", created: false })
  })

  test("JPEG with a GPS IFD -> metadata.gps true and the warning line (SEC-10); bytes stored as is", async () => {
    const r = await call({ dataBase64: b64(JPEG_GPS) })
    expect(r).toMatchObject({ ok: true, mime: "image/jpeg", sha256: sha(JPEG_GPS) })
    expect(r.metadata.gps).toBe(true)
    expect(r.warning).toContain("GPS location")
    expect(r._text).toContain("sips --deleteProperty all")
  })

  test("documentId: unknown -> DOCUMENT_NOT_FOUND, nothing stored", async () => {
    const r = await call({ dataBase64: b64(png(1, 1, 200)), documentId: "cdocnotthere0000000000000" })
    expect(r._isError).toBe(true)
    expect(r.code).toBe("DOCUMENT_NOT_FOUND")
  })
})

describe("row 50c: refusals (T2-T4)", () => {
  const codeOf = async (args: Record<string, unknown>) => {
    const r = await call(args)
    expect(r._isError).toBe(true)
    expect(r._text).not.toContain("    at ") // no stack trace
    return r.code
  }

  test("type: SVG and GIF -> ASSET_TYPE_UNSUPPORTED; truncated PNG -> refused by the decoder; bad base64 -> SCHEMA_INVALID", async () => {
    expect(await codeOf({ dataBase64: b64(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')) })).toBe("ASSET_TYPE_UNSUPPORTED")
    expect(await codeOf({ dataBase64: b64(new TextEncoder().encode("GIF89a\x01\x00\x01\x00")) })).toBe("ASSET_TYPE_UNSUPPORTED")
    // The vendored decoder classes a truncated PNG header as ASSET_TYPE_UNSUPPORTED (reason corrupt_header), as on R18.
    expect(await codeOf({ dataBase64: b64(png(4, 4).subarray(0, 40)) })).toBe("ASSET_TYPE_UNSUPPORTED")
    expect(await codeOf({ dataBase64: "iVBO!!!not-base64" })).toBe("SCHEMA_INVALID")
    writeFileSync(path.join(PROJECT, "vektor.png"), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    expect(await codeOf({ path: path.join(PROJECT, "vektor.png") })).toBe("ASSET_TYPE_UNSUPPORTED")
  })

  test("size: a 20 MiB + 1 B file -> ASSET_TOO_LARGE; a header of 20,001 x 1 px -> ASSET_TOO_LARGE", async () => {
    const big = path.join(PROJECT, "besar.png")
    writeFileSync(big, new Uint8Array(20 * MIB + 1))
    expect(await codeOf({ path: big })).toBe("ASSET_TOO_LARGE")
    expect(await codeOf({ dataBase64: b64(png(20_001, 1, 0, false)) })).toBe("ASSET_TOO_LARGE")
  })

  test("path: outside, .. escape, symlink out -> PATH_OUTSIDE_ROOTS; symlink inside -> ok; .txt and relative -> PATH_INVALID; directory -> FILE_UNREADABLE", async () => {
    writeFileSync(path.join(OUTSIDE, "luar.png"), png(1, 1, 5))
    expect(await codeOf({ path: "/etc/hosts" })).toBe("PATH_OUTSIDE_ROOTS")
    expect(await codeOf({ path: path.join(OUTSIDE, "luar.png") })).toBe("PATH_OUTSIDE_ROOTS")
    expect(await codeOf({ path: path.join(PROJECT, "..", "..", "outside", "luar.png") })).toBe("PATH_OUTSIDE_ROOTS")
    symlinkSync(path.join(OUTSIDE, "luar.png"), path.join(PROJECT, "tautan-luar.png"))
    expect(await codeOf({ path: path.join(PROJECT, "tautan-luar.png") })).toBe("PATH_OUTSIDE_ROOTS")
    writeFileSync(path.join(PROJECT, "dalam.png"), png(2, 2, 9))
    symlinkSync(path.join(PROJECT, "dalam.png"), path.join(PROJECT, "tautan-dalam.png"))
    expect(await call({ path: path.join(PROJECT, "tautan-dalam.png") })).toMatchObject({ ok: true, widthPx: 2 })
    writeFileSync(path.join(PROJECT, "a.txt"), "x")
    expect(await codeOf({ path: path.join(PROJECT, "a.txt") })).toBe("PATH_INVALID")
    expect(await codeOf({ path: "relatif/x.png" })).toBe("PATH_INVALID")
    mkdirSync(path.join(PROJECT, "folder.png"))
    expect(await codeOf({ path: path.join(PROJECT, "folder.png") })).toBe("FILE_UNREADABLE")
  })

  test("arguments: both, neither, an unknown key -> INVALID_ARGUMENT", async () => {
    const one = b64(png(1, 1))
    expect(await codeOf({ path: path.join(PROJECT, "dalam.png"), dataBase64: one })).toBe("INVALID_ARGUMENT")
    expect(await codeOf({})).toBe("INVALID_ARGUMENT")
    expect(await codeOf({ dataBase64: one, mission: "x" })).toBe("INVALID_ARGUMENT")
  })
})
