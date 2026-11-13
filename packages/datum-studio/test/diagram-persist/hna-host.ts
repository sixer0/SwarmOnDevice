// Swarm 1.2.8 row 33 (AC-HNA): shared harness of N8-332..334. The REAL host server (startStudioHostServer, streamable
// HTTP on 127.0.0.1, MCP SDK client) over a temp store, so "stored" means what the store and studio_document_get
// return, not a mock (rel127-n10 pattern; needs the command sandbox off, it binds an ephemeral port).
// Fixture: test/fixtures/syn128/hna_flow_v2.json (row 25b, synthetic).
import { expect } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")

export type S = Record<string, any>
export const FIXTURE = JSON.parse(readFileSync(path.join(PKG, "test", "fixtures", "syn128", "hna_flow_v2.json"), "utf8")) as { block: S; writeBlock: S; chapter: S }
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
export const CHANGE = { what: "uji sintetis", why: "uji persistensi diagram", impact: "tidak ada" }
export const META = { title: "Nota uji diagram", author: "Alfa Bravo", source: "Sumber sintetis meta." }

/** The six orders of three keys (each key first, middle and last twice). */
export function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]]
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]))
}
/** Same object, top-level keys in the given order (values untouched). */
export const reorder = (o: S, keys: readonly string[]): S => Object.fromEntries(keys.map((k) => [k, o[k]]))
/** Canonical JSON (keys sorted at every level) for deep-equal checks independent of key order. */
export function canon(v: unknown): string {
  const walk = (x: unknown): unknown => (Array.isArray(x) ? x.map(walk) : x !== null && typeof x === "object" ? Object.fromEntries(Object.keys(x as S).sort().map((k) => [k, walk((x as S)[k])])) : x)
  return JSON.stringify(walk(v))
}

/** Every diagram block of a document content (any chapter, intro or section). */
export function diagramsOf(content: S): S[] {
  const out: S[] = []
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk)
    else if (x !== null && typeof x === "object") {
      if ((x as S).type === "diagram") out.push(x as S)
      else Object.values(x as S).forEach(walk)
    }
  }
  walk(content)
  return out
}
/** Stored block without the server-given id (pid), for comparisons across writes. */
export const withoutId = (b: S): S => {
  const { id: _id, ...rest } = b
  return rest
}

export interface Host {
  call(name: string, args: unknown): Promise<S>
  /** Serialised host tools/list size (the row99 / rel128-vis0 measure). */
  toolsBytes(): Promise<number>
  content(documentId: string): Promise<S>
  close(): Promise<void>
}

/** Start the real host on a fresh temp store. */
export async function startHost(tag: string): Promise<Host> {
  const WORK = realpathSync(mkdtempSync(path.join(tmpdir(), `hna-${tag}-`)))
  const STORE = path.join(WORK, "datum-studio")
  const HOME = path.join(WORK, "home")
  const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
  const PROJECT = path.join(HOME, "project-hna")
  for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })
  const KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_VENDOR_ROOT", "STUDIO_MCP_FILE_ROOTS", "INTERNAL_API_SECRET", "STUDIO_RENDER_RATE_LIMIT"] as const
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  const reset = async () => {
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
  await reset()
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  // The key-order loops write ~20 times a minute; the render bucket (30/min per caller) is raised for this store only.
  process.env.STUDIO_RENDER_RATE_LIMIT = "1000"
  await reset()
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error("hna test: globalThis.fetch must not be called by the host")
  }) as unknown as typeof fetch
  const mod = await import("../../src/mcp-host/index.ts")
  const store = await mod.openHostStore(STORE, { release: "1.2.8", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.2.8" })
  const TOKEN = "e".repeat(16) + "0123456789abcdef".repeat(3)
  const log = (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => {
    if (level === "error") console.log(`[hna-${tag}] host error ${source}: ${message} ${JSON.stringify(context ?? {})}`)
  }
  const facts = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
  const host = await mod.startStudioHostServer({ store, token: TOKEN, hostname: "127.0.0.1", port: 0, log, facts })
  const c = new Client({ name: `hna-${tag}`, version: "0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(host.url), {
      fetch: realFetch as never,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
    }),
  )
  const call = async (name: string, args: unknown): Promise<S> => {
    const r = await c.callTool({ name, arguments: args as Record<string, unknown> })
    const text = ((r.content ?? []) as Array<{ type: string; text?: string }>).filter((x) => x.type === "text").map((x) => x.text ?? "").join("\n")
    return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: text }
  }
  const content = async (documentId: string): Promise<S> => {
    const g = await call("studio_document_get", { documentId, view: "content" })
    expect(g.ok, g._text).not.toBe(false)
    return g.content as S
  }
  return {
    call,
    content,
    toolsBytes: async () => Buffer.byteLength(JSON.stringify({ tools: (await c.listTools()).tools })),
    async close() {
      await c.close().catch(() => undefined)
      await host.close()
      mod.configureTemplateSource(null)
      await mod.closeHostStore(store)
      globalThis.fetch = realFetch
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      await reset()
      rmSync(WORK, { recursive: true, force: true })
    },
  }
}

/** A client document (template datum-nota) with one paragraph chapter; returns its id. */
export async function newClientDoc(h: Host, docKey: string): Promise<string> {
  const w = await h.call("studio_write", { mission: "2026-11-14_hna", docKey, template: "datum-nota", meta: META, sections: [{ heading: "Pendahuluan", blocks: ["Paragraf pembuka sintetis alfa bravo charlie."] }] })
  expect(w.ok, w._text).not.toBe(false)
  expect(typeof w.documentId).toBe("string")
  return String(w.documentId)
}

/** Round trip on a stored diagram: get -> figure_revise (direction LR) -> get shows the revised spec. */
export async function reviseRoundTrip(h: Host, documentId: string): Promise<void> {
  const before = diagramsOf(await h.content(documentId))
  expect(before).toHaveLength(1)
  const pid = String(before[0].id)
  const r = await h.call("studio_figure_revise", { documentId, pid, patch: { spec: { direction: "LR" } }, change: CHANGE, preview: false })
  expect(r.ok, r._text).not.toBe(false)
  const after = diagramsOf(await h.content(documentId))
  expect(after).toHaveLength(1)
  expect(after[0].spec.direction).toBe("LR")
  expect(after[0].spec.nodes).toEqual(before[0].spec.nodes)
}
