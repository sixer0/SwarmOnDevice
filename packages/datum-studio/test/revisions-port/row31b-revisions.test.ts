// Row 31b: services/revisions (+ v2) vendored with the row 109 Prisma cut, and the host routes R14 (GET/PATCH)
// and R16 (GET/PATCH) wired in the LocalStudioApi (decision C60). Real store in a temp folder, the real host
// server (src/mcp-host) on 127.0.0.1, the real MCP SDK client; globalThis.fetch is a trap for the whole file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const BASE = process.env.ROW31B_TEST_DIR ?? "/private/tmp/claude-501/row31b/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "row31b-")))
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

const PORT = Number(process.env.ROW31B_PORT ?? 47321)
const TOKEN = "b".repeat(16) + "0123456789abcdef".repeat(3)
const FACTS = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
const SECRET = "r".repeat(64)

const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = (async () => {
  fetchCalls++
  throw new Error("row31b test: globalThis.fetch must not be called by the host")
}) as unknown as typeof fetch

type Mod = typeof import("../../src/mcp-host/index.ts")
let mod: Mod
let store: Awaited<ReturnType<Mod["openHostStore"]>>
let host: Awaited<ReturnType<Mod["startStudioHostServer"]>>
let c: Client
let api: { fetch: (url: string, init?: Record<string, unknown>) => Promise<{ status: number; text(): Promise<string> }> }
const CHANGE = (what: string) => ({ what, why: "uji row 31b", impact: "revisi baru; revisi lama tetap" })

type Structured = Record<string, unknown> & { ok?: boolean; code?: string }
async function call(name: string, args: Record<string, unknown>): Promise<Structured> {
  const r = await c.callTool({ name, arguments: args })
  return (r.structuredContent ?? {}) as Structured
}

/** Direct LocalStudioApi request (same router and routes the MCP tools use). */
async function local(method: string, route: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await api.fetch(`http://127.0.0.1:1${route}`, {
    method,
    headers: { "x-internal-secret": SECRET, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
  })
  const text = await r.text()
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

/** First paragraph block `{ id, type, text }` found in a projected chapter. */
function firstParagraph(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = firstParagraph(n)
      if (hit) return hit
    }
    return null
  }
  const o = node as Record<string, unknown>
  if (o.type === "paragraph" && typeof o.id === "string") return o
  for (const v of Object.values(o)) {
    const hit = firstParagraph(v)
    if (hit) return hit
  }
  return null
}

let documentId = ""
let chapterSlot = ""
let paraAddress = ""
const revs: number[] = []

beforeAll(async () => {
  ;(await import("../../vendor/src/lib/studio/contract/env")).resetStudioEnvCache() // I-2 (C66): host start now refuses a stale cached root
  mod = await import("../../src/mcp-host/index.ts")
  store = await mod.openHostStore(STORE, { release: "1.2.0", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.0" })
  host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: PORT, log: () => {}, facts: FACTS })
  c = new Client({ name: "row31b-test", version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "claude", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
  const { createLocalStudioApi } = await import("../../src/mcp-host/local-api/router.ts")
  const { LOCAL_ROUTES } = await import("../../src/mcp-host/local-api/routes.ts")
  api = createLocalStudioApi({ baseUrl: "http://127.0.0.1:1", secret: SECRET, agentId: "claude", routes: LOCAL_ROUTES }) as unknown as typeof api
})

afterAll(async () => {
  await c?.close()
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  globalThis.fetch = realFetch
  // T-2 (C71): do not leave this suite's cached root or its render-bucket charges for the next suite.
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  const { resetRenderRateLimiter } = await import("../../vendor/src/lib/studio/http/render-guard")
  resetStudioEnvCache()
  resetRenderRateLimiter()
})

describe("row 31b: no Prisma in the ported files", () => {
  test("no import of @prisma/client or @/lib/prisma in services/revisions or the R14/R16 route files", () => {
    const roots = [path.join(VENDOR, "src/lib/studio/services/revisions"), path.join(PKG, "src/mcp-host/local-api")]
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (p.endsWith(".ts")) files.push(p)
      }
    }
    roots.forEach(walk)
    const re = /(?:import|export)[^;]*?from\s*["'](?:@prisma\/client|@\/lib\/prisma)["']|import\(\s*["'](?:@prisma\/client|@\/lib\/prisma)["']\s*\)/
    expect(files.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => path.relative(PKG, f))).toEqual([])
    expect(files.length).toBeGreaterThan(12)
  })
})

describe("row 31b: R14 / R16 over the real host server and store", () => {
  test("create a document with one chapter of two paragraphs", async () => {
    const create = await call("studio_document_create", { template: "datum-gsp", mission: "2026-11-07_row31b", docKey: "row31b-doc", title: "Dokumen uji row 31b" })
    expect(create.ok).toBe(true)
    documentId = String(create.documentId)
    const md = "# Pendahuluan\n\nKalibrasi sensor dilakukan setiap bulan oleh tim lapangan.\n\nHasil kalibrasi dicatat di buku log stasiun.\n"
    const sub = await call("studio_chapter_import_markdown", { documentId, chapterKey: "1", markdown: md, submit: true, change: CHANGE("Bab 1 ditulis") })
    expect(sub.ok).toBe(true)
    const st = await call("studio_document_structure", { documentId, op: "get" })
    expect(st.ok).toBe(true)
    expect(Array.isArray(st.order) && (st.order as unknown[]).length).toBeGreaterThan(0)
    revs.push(Number(st.revisionNo))
    chapterSlot = Object.keys((st.outlines ?? {}) as object)[0] ?? ""
    expect(chapterSlot).not.toBe("")
  })

  test("R14 GET: 200 with skeleton, order, meta, template version and completeness", async () => {
    const r = await local("GET", `/api/studio/documents/${documentId}/structure`)
    expect(r.status).toBe(200)
    expect(r.body.revisionNo).toBe(revs[0])
    expect((r.body.templateVersion as Record<string, unknown>).slug).toBe("datum-gsp")
    expect(Array.isArray((r.body.skeleton as Record<string, unknown>).slots)).toBe(true)
    expect((r.body.meta as Record<string, unknown>).title).toBe("Dokumen uji row 31b")
    expect(typeof (r.body.completeness as Record<string, unknown>).status).toBe("string")
  })

  test("studio_document_structure setMeta: new revision, document title mirrored, the old revision stays readable", async () => {
    const base = revs[0]
    const r = await call("studio_document_structure", { documentId, op: "setMeta", baseRevisionNo: base, change: CHANGE("Judul diganti"), meta: { title: "Judul baru row 31b" } })
    expect(r.ok).toBe(true)
    expect(r.revisionNo).toBe(base + 1)
    expect(r.changeScope).toBe("meta")
    revs.push(base + 1)
    const now = await call("studio_document_structure", { documentId, op: "get" })
    expect((now.meta as Record<string, unknown>).title).toBe("Judul baru row 31b")
    const old = await call("studio_document_structure", { documentId, op: "get", rev: base })
    expect(old.revisionNo).toBe(base)
    expect((old.meta as Record<string, unknown>).title).toBe("Dokumen uji row 31b")
    const doc = await local("GET", `/api/studio/documents/${documentId}`)
    expect(doc.status).toBe(200)
    expect(JSON.stringify(doc.body)).toContain("Judul baru row 31b")
  })

  test("studio_document_structure setOutline / omitSlot / restoreSlot / reorder / templateVersion / renumberChapters reach the revisions service", async () => {
    const out: Record<string, string> = {}
    let base = revs[revs.length - 1]
    const step = async (name: string, args: Record<string, unknown>) => {
      const r = await call("studio_document_structure", { documentId, baseRevisionNo: base, change: CHANGE(name), ...args })
      out[name] = r.ok === true ? `rev ${String(r.revisionNo)}` : String(r.code)
      if (r.ok === true) {
        expect(r.revisionNo).toBe(base + 1)
        base = Number(r.revisionNo)
        revs.push(base)
      }
      return r
    }
    await step("setOutline", { op: "setOutline", slot: chapterSlot, outline: [{ key: "1", title: "Pendahuluan" }, { key: "2", title: "Metode" }] })
    const sk = (await local("GET", `/api/studio/documents/${documentId}/structure`)).body.skeleton as { slots: Array<{ slotKey: string; required: boolean; active: boolean; omitted: boolean; position: number }> }
    const optional = sk.slots.find((s) => !s.required && s.active && !s.omitted && s.position > 0 && s.slotKey !== chapterSlot)
    if (optional) {
      await step("omitSlot", { op: "omitSlot", slot: optional.slotKey })
      await step("restoreSlot", { op: "restoreSlot", slot: optional.slotKey })
    }
    const order = ((await call("studio_document_structure", { documentId, op: "get" })).order ?? []) as string[]
    await step("reorderSame", { op: "reorder", order })
    // Swap the 2nd and 3rd slots (datum-gsp: controlSheet, signature; neither is position-locked).
    await step("reorder", { op: "reorder", order: [order[0], order[2], order[1], ...order.slice(3)] })
    // Moving the locked last slot (appendices) is refused by the compose rule (422), nothing written.
    await step("reorderLocked", { op: "reorder", order: [order[order.length - 1], ...order.slice(0, -1)] })
    // Row 213 (1.2.4): datum-gsp ships as v2, so a fresh store pins v2 only; the document already uses it.
    await step("templateVersion", { op: "templateVersion", versionNo: 3 })
    await step("renumberChapters", { op: "renumberChapters", map: { "1": "9" } })
    // Every op reached the service: either a new revision or a service rule code, never the old 501.
    expect(Object.values(out).some((v) => v.includes("ROUTE_NOT_AVAILABLE") || v === "undefined")).toBe(false)
    expect(out.setOutline).toMatch(/^rev \d+$/)
    expect(out.renumberChapters).toBe("FORBIDDEN")
    expect(out.reorderSame).toBe("SCHEMA_INVALID")
    expect(out.reorder).toMatch(/^rev \d+$/)
    expect(out.reorderLocked).toBe("SLOT_POSITION_LOCKED")
    // datum-gsp has one pinned version (v3, 1.2.5): moving to it is "no change" (400), not an error of the port.
    expect(out.templateVersion).toBe("SCHEMA_INVALID")
    if (optional) {
      expect(out.omitSlot).toMatch(/^rev \d+$/)
      expect(out.restoreSlot).toMatch(/^rev \d+$/)
    }
    console.log(JSON.stringify({ structureOps: out, optionalSlot: optional?.slotKey ?? null }))
    // Every earlier revision still answers R14 GET with its own revision number.
    for (const n of revs) {
      const r = await local("GET", `/api/studio/documents/${documentId}/structure?rev=${n}`)
      expect(r.status).toBe(200)
      expect(r.body.revisionNo).toBe(n)
    }
  })

  test("R16 GET/PATCH: a paragraph edit is a new revision; the old revision keeps the old text; history lists both", async () => {
    const content = await local("GET", `/api/studio/documents/${documentId}/content?slot=${chapterSlot}&chapter=1`)
    expect(content.status).toBe(200)
    const para = firstParagraph(content.body.content)
    expect(para).not.toBeNull()
    const pid = String(para!.id)
    const before = revs[revs.length - 1]

    const g = await local("GET", `/api/studio/documents/${documentId}/paragraphs/${pid}`)
    expect(g.status).toBe(200)
    expect(g.body.kind).toBe("BLOCK")
    expect(g.body.revisionNo).toBe(before)
    paraAddress = String(g.body.address)
    expect(paraAddress).toMatch(/^1\.\d+\.\d+$/)
    const oldText = JSON.stringify(g.body.content)
    expect(oldText).toContain("Kalibrasi sensor")

    const block = { ...(g.body.content as Record<string, unknown>) }
    delete block.id
    const replaced = JSON.parse(JSON.stringify(block).replace("Kalibrasi sensor dilakukan setiap bulan", "Kalibrasi sensor dilakukan setiap minggu")) as Record<string, unknown>
    const p = await local("PATCH", `/api/studio/documents/${documentId}/paragraphs/${pid}`, { op: "replace", baseRevisionNo: before, block: replaced, change: CHANGE("Frekuensi kalibrasi") })
    expect(p.status).toBe(200)
    expect((p.body.revision as Record<string, unknown>).revisionNo).toBe(before + 1)
    expect(p.body.pid).toBe(pid)
    revs.push(before + 1)

    const now = await local("GET", `/api/studio/documents/${documentId}/paragraphs/${pid}?history=1`)
    expect(now.status).toBe(200)
    expect(JSON.stringify(now.body.content)).toContain("setiap minggu")
    const history = now.body.history as Array<{ revisionNo: number; retired: boolean }>
    expect(history.length).toBeGreaterThanOrEqual(2)
    expect(history[history.length - 1].revisionNo).toBe(before + 1)

    const old = await local("GET", `/api/studio/documents/${documentId}/paragraphs/${pid}?rev=${before}`)
    expect(old.status).toBe(200)
    expect(JSON.stringify(old.body.content)).toBe(oldText)

    // Stale base on the same pid -> 409 SCOPE_CONFLICT (pid scope check of §9.2), nothing written.
    const stale = await local("PATCH", `/api/studio/documents/${documentId}/paragraphs/${pid}`, { op: "replace", baseRevisionNo: before, block: replaced, change: CHANGE("basi") })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe("SCOPE_CONFLICT")
    const unknown = await local("GET", `/api/studio/documents/${documentId}/paragraphs/b-ZZZZZZZZZZZZ`)
    expect(unknown.status).toBe(404)
  })

  test("studio_edit meta goes through R14 PATCH setMeta and writes a new revision", async () => {
    const before = revs[revs.length - 1]
    const r = await call("studio_edit", { documentId, meta: { title: "Judul lewat studio_edit" } })
    expect(r.ok).toBe(true)
    const st = await call("studio_document_structure", { documentId, op: "get" })
    expect(st.revisionNo).toBe(before + 1)
    expect((st.meta as Record<string, unknown>).title).toBe("Judul lewat studio_edit")
    revs.push(before + 1)
  })

  test("services/revisions index (v1 API over the store): listRevisions, getBlock, patchBlock -> pid path, render seam", async () => {
    const rv = await import("../../vendor/src/lib/studio/services/revisions/index.ts")
    const list = await rv.listRevisions(documentId)
    const latest = revs[revs.length - 1]
    expect(list.map((r) => r.revisionNo)).toEqual(Array.from({ length: latest }, (_, i) => latest - i))
    // KD-10: a v2 edit keeps the base revision's request schema (here the chapter submission's).
    expect(list[0].schemaId).toBe("studio.chapter/v2")
    expect(list[0].changeScope).toBe("meta")
    const blk = await rv.getBlock(documentId, paraAddress)
    expect(blk.revisionNo).toBe(revs[revs.length - 1])
    expect(JSON.stringify(blk.content)).toContain("setiap minggu")
    const { localStudioCaller } = await import("../../vendor/src/lib/studio/contract/auth.ts")
    const before = revs[revs.length - 1]
    const patched = await rv.patchBlock(documentId, paraAddress, { baseRevisionNo: before, op: "replace", block: { type: "paragraph", text: "Kalibrasi sensor dicatat di buku log digital." }, change: CHANGE("Buku log") } as never, localStudioCaller("claude"))
    expect(patched.revision.revisionNo).toBe(before + 1)
    revs.push(before + 1)
    expect(JSON.stringify((await rv.getBlock(documentId, paraAddress)).content)).toContain("log digital")
    expect(JSON.stringify((await rv.getBlock(documentId, paraAddress, before)).content)).toContain("setiap minggu")
    const err = await rv.rerenderRevision(documentId, before, ["DOCX"]).catch((e: Error) => e)
    // Row 31c: the seam is the real services/render now; this datum-gsp document is INCOMPLETE -> 409, no job.
    expect([(err as Error).name, (err as { code?: string }).code]).toEqual(["StudioEngineError", "DOCUMENT_INCOMPLETE"])
  })

  test("R14 / R16 errors: bad rev, unknown document, missing change", async () => {
    expect((await local("GET", `/api/studio/documents/${documentId}/structure?rev=999`)).body.code).toBe("REVISION_NOT_FOUND")
    expect((await local("GET", `/api/studio/documents/cnotadoc0000000000000000/structure`)).status).toBe(404)
    const noChange = await local("PATCH", `/api/studio/documents/${documentId}/structure`, { op: "setMeta", baseRevisionNo: revs[revs.length - 1], meta: { title: "x" } })
    expect(noChange.status).toBe(400)
    expect(noChange.body.code).toBe("CHANGE_FIELDS_REQUIRED")
    expect(fetchCalls).toBe(0)
  })
})
