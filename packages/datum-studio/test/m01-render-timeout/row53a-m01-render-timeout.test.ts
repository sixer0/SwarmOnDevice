// Row 53a (Swarm 1.2.6, item M-01, decision U1; masterplan/01d_spec_config.md L1 + F3, register N-044).
// studio_render gives R17 its own budget, STUDIO_RENDER_CALL_TIMEOUT_MS (540000), passed as `timeoutMs` through the
// tool-kit `http()` to `studioRequest`; every other Studio call keeps STUDIO_HTTP_TIMEOUT_MS (60000). When the render
// budget runs out, the error says the render may still finish and names studio_document_status (F3).
// The stub R17 answers after a delay measured on bun fake timers (AbortSignal.timeout is faked too), and aborts on the
// request signal like a real fetch. Public entry point: executeTool (the same path the MCP server uses).
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import path from "node:path"
import type { HttpFetch, HttpResponseLike } from "../../vendor/scripts/studio/_http-client"
import * as httpClient from "../../vendor/scripts/studio/_http-client"
import { loadConfig } from "../../vendor/scripts/studio/mcp/config"
import { executeTool } from "../../vendor/scripts/studio/mcp/tools"
import type { NodeFs } from "../../vendor/scripts/studio/mcp/safety"

const SECRET = "rahasia-uji-row53a-JANGAN-TERCETAK-91c4"
const BASE = "http://127.0.0.1:9021"
const ROOT = path.resolve("/row53a-root")
const DOC = "cmvvdoc00000000000000r53a"

const noFs = new Proxy({} as NodeFs, {
  get: () => () => {
    throw new Error("row53a: no filesystem access expected")
  },
})

function deps(fetchImpl: HttpFetch) {
  return { config: loadConfig({ INTERNAL_API_SECRET: SECRET, STUDIO_BASE_URL: BASE, STUDIO_MCP_FILE_ROOTS: ROOT }, ROOT), fetchImpl, nfs: noFs }
}

function jsonReply(status: number, body: unknown): HttpResponseLike {
  const h = new Headers({ "content-type": "application/json", "x-correlation-id": "cid-row53a" })
  return { status, headers: { get: (n: string) => h.get(n) }, text: async () => JSON.stringify(body) }
}

const RENDER_OK = {
  job: { id: "job-row53a", status: "succeeded" },
  outputs: [{ id: "out-row53a", role: "final", format: "html", scope: "document", sha256: "a".repeat(64), byteSize: 10 }],
  completeness: { revisionNo: 3 },
  partial: false,
}

/** A stub server that answers every request after `delayMs` (fake time) unless the request signal aborts first. */
function slowStub(delayMs: number, seen: string[]): HttpFetch {
  return (url, init) =>
    new Promise<HttpResponseLike>((resolve, reject) => {
      seen.push(`${init.method} ${new URL(url).pathname}`)
      const t = setTimeout(() => resolve(jsonReply(200, url.includes("/render") ? RENDER_OK : { documentId: DOC, status: "COMPLETE" })), delayMs)
      init.signal?.addEventListener("abort", () => {
        clearTimeout(t)
        reject(init.signal?.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }))
      })
    })
}

/** Run `p` while fake time advances in 1 s steps (microtasks flushed between steps) until it settles or `maxMs`. */
async function drive<T>(p: Promise<T>, maxMs: number): Promise<{ settled: boolean; value?: T; elapsedMs: number }> {
  let settled = false
  let value: T | undefined
  p.then((v) => {
    settled = true
    value = v
  })
  let elapsed = 0
  for (let i = 0; i < 20; i++) await Promise.resolve()
  while (!settled && elapsed < maxMs) {
    jest.advanceTimersByTime(1000)
    elapsed += 1000
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return { settled, value, elapsedMs: elapsed }
}

beforeEach(() => {
  jest.useFakeTimers()
})
afterEach(() => {
  jest.useRealTimers()
})

describe("row 53a M-01: studio_render has its own R17 budget", () => {
  test("the constant is exported beside STUDIO_HTTP_TIMEOUT_MS with the registered value (N-044)", () => {
    expect((httpClient as Record<string, unknown>).STUDIO_RENDER_CALL_TIMEOUT_MS).toBe(540_000)
    expect(httpClient.STUDIO_HTTP_TIMEOUT_MS).toBe(60_000)
  })

  test("a stub R17 that answers after 61 s completes through studio_render without REMOTE_UNREACHABLE", async () => {
    const seen: string[] = []
    const run = drive(executeTool("studio_render", { documentId: DOC, formats: ["html"] }, deps(slowStub(61_000, seen))), 600_000)
    const r = await run
    expect(r.settled).toBe(true)
    const env = r.value as { ok: boolean; text: string; data: Record<string, any> }
    expect(env.data.error?.code).toBeUndefined()
    expect(env.ok).toBe(true)
    expect(env.text).not.toContain("REMOTE_UNREACHABLE")
    expect(env.data.job?.id).toBe("job-row53a")
    expect(seen).toEqual([`POST /api/studio/documents/${DOC}/render`])
    expect(r.elapsedMs).toBe(61_000)
  })

  test("other Studio calls keep the 60 s budget: studio_document_status against the same 61 s stub is REMOTE_UNREACHABLE", async () => {
    const seen: string[] = []
    const r = await drive(executeTool("studio_document_status", { documentId: DOC }, deps(slowStub(61_000, seen))), 600_000)
    expect(r.settled).toBe(true)
    const env = r.value as { ok: boolean; text: string; data: Record<string, any> }
    expect(env.ok).toBe(false)
    expect(env.data.error.code).toBe("REMOTE_UNREACHABLE")
    expect(r.elapsedMs).toBe(60_000)
  })

  test("when the render budget runs out the error says the render may still finish and names studio_document_status (F3)", async () => {
    const seen: string[] = []
    const r = await drive(executeTool("studio_render", { documentId: DOC, formats: ["html"] }, deps(slowStub(700_000, seen))), 700_000)
    expect(r.settled).toBe(true)
    const env = r.value as { ok: boolean; text: string; data: Record<string, any> }
    expect(env.ok).toBe(false)
    expect(env.data.error.code).toBe("REMOTE_UNREACHABLE")
    expect(r.elapsedMs).toBe(540_000)
    expect(env.data.error.message).toContain("STUDIO_RENDER_CALL_TIMEOUT_MS")
    expect(env.data.error.message).toContain("render mungkin masih selesai")
    expect(env.data.error.message).toContain("studio_document_status")
    expect(env.text).not.toContain(SECRET)
  })
})
