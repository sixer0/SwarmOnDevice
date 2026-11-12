// TH-01 (1.2.6 row 90): probe kinds http, http-unix, file (spec 01c 11.3 items 1-5). The render-bridge kind (item 6)
// belongs to row 93. Red class B at e363918a69 (the module is new); behaviour through runProbe.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runProbe } from "./probe"
import { createToolHealthRegistry } from "./registry"

let dir: string
beforeEach(() => {
  // Short base: Unix socket paths are limited to ~104 bytes on macOS.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "thp-")))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

type Call = { url: string; init: RequestInit }
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
  return { fn, calls }
}

const fluxProbe = {
  kind: "http" as const,
  url: "http://127.0.0.1:7863/health",
  expectStatus: 200,
  expectJson: { weights_downloaded: true },
}

describe("http probe (01c 11.3 items 1-3)", () => {
  test("1: 200 with weights_downloaded true and model_loaded false is healthy", async () => {
    const f = fakeFetch(() => Response.json({ weights_downloaded: true, model_loaded: false }))
    const r = await runProbe(fluxProbe, { fetch: f.fn })
    expect(r).toMatchObject({ healthy: true, reason: "OK" })
  })

  test("1: weights_downloaded false is HTTP_BODY_MISMATCH", async () => {
    const f = fakeFetch(() => Response.json({ weights_downloaded: false, model_loaded: false }))
    const r = await runProbe(fluxProbe, { fetch: f.fn })
    expect(r.healthy).toBe(false)
    expect(r.reason).toBe("HTTP_BODY_MISMATCH")
    expect(r.detail).toContain("weights_downloaded is false")
  })

  test("1: 503 is HTTP_STATUS, 403 is HTTP_HOST_REFUSED", async () => {
    const s503 = await runProbe(fluxProbe, { fetch: fakeFetch(() => new Response("", { status: 503 })).fn })
    expect(s503).toMatchObject({ healthy: false, reason: "HTTP_STATUS" })
    expect(s503.detail).toContain("503")
    const s403 = await runProbe(fluxProbe, { fetch: fakeFetch(() => new Response("", { status: 403 })).fn })
    expect(s403).toMatchObject({ healthy: false, reason: "HTTP_HOST_REFUSED" })
  })

  test("1: no answer within timeoutMs is HTTP_UNREACHABLE", async () => {
    const f = fakeFetch(() => new Promise<Response>(() => undefined))
    const started = Date.now()
    const r = await runProbe({ ...fluxProbe, timeoutMs: 50 }, { fetch: f.fn })
    expect(r).toMatchObject({ healthy: false, reason: "HTTP_UNREACHABLE" })
    expect(r.detail).toContain("timed out after 50 ms")
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("1: connection refused is HTTP_UNREACHABLE", async () => {
    const f = fakeFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })
    })
    const r = await runProbe(fluxProbe, { fetch: f.fn })
    expect(r).toMatchObject({ healthy: false, reason: "HTTP_UNREACHABLE" })
    expect(r.detail).toContain("ECONNREFUSED")
  })

  test("2: fetch gets redirect manual and no Host header", async () => {
    const f = fakeFetch(() => Response.json({ weights_downloaded: true }))
    await runProbe(fluxProbe, { fetch: f.fn })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:7863/health")
    expect(f.calls[0]!.init.redirect).toBe("manual")
    const headers = new Headers(f.calls[0]!.init.headers)
    expect(headers.has("host")).toBe(false)
  })

  test("3: firecrawl 401 is healthy; an unlisted redirect is dead", async () => {
    const reg = createToolHealthRegistry({ home: dir, platform: "darwin", isPackaged: true, resourcesPath: dir, appPath: dir })
    const fc = reg.find((c) => c.id === "firecrawl")!.probe
    const r401 = await runProbe(fc, { fetch: fakeFetch(() => new Response("", { status: 401 })).fn })
    expect(r401).toMatchObject({ healthy: true, reason: "OK" })
    const redirectOnly = { kind: "http" as const, url: "http://127.0.0.1:9/", expectStatus: [200, 204] }
    const r302 = await runProbe(redirectOnly, {
      fetch: fakeFetch(() => new Response("", { status: 302, headers: { location: "http://example.invalid/" } })).fn,
    })
    expect(r302).toMatchObject({ healthy: false, reason: "HTTP_STATUS" })
  })

  test("a non-loopback URL is never fetched", async () => {
    const f = fakeFetch(() => new Response(""))
    const r = await runProbe({ kind: "http", url: "http://10.0.0.5/health", expectStatus: 200 }, { fetch: f.fn })
    expect(r).toMatchObject({ healthy: false, reason: "PROBE_URL_NOT_LOOPBACK" })
    expect(f.calls).toHaveLength(0)
  })

  test("detail never carries the query string", async () => {
    const f = fakeFetch(() => new Response("", { status: 500 }))
    const r = await runProbe({ kind: "http", url: "http://127.0.0.1:9/x?token=secret123", expectStatus: 200 }, { fetch: f.fn })
    expect(r.detail).not.toContain("secret123")
  })
})

describe("http-unix probe (01c 11.3 item 4)", () => {
  let server: Server | undefined
  afterEach(async () => {
    if (server) await new Promise<void>((done) => server!.close(() => done()))
    server = undefined
  })

  test("a socket server answering 200 on /_ping is healthy; another status is dead", async () => {
    const socketPath = join(dir, "d.sock")
    server = createServer((req, res) => {
      res.statusCode = req.url === "/_ping" ? 200 : 404
      res.end("OK")
    })
    await new Promise<void>((done) => server!.listen(socketPath, () => done()))
    const ok = await runProbe({ kind: "http-unix", socketPath, path: "/_ping", expectStatus: 200 })
    expect(ok).toMatchObject({ healthy: true, reason: "OK" })
    const other = await runProbe({ kind: "http-unix", socketPath, path: "/other", expectStatus: 200 })
    expect(other).toMatchObject({ healthy: false, reason: "SOCKET_UNREACHABLE" })
  })

  test("a missing socket is SOCKET_UNREACHABLE", async () => {
    const r = await runProbe({ kind: "http-unix", socketPath: join(dir, "none.sock"), path: "/_ping", expectStatus: 200 })
    expect(r).toMatchObject({ healthy: false, reason: "SOCKET_UNREACHABLE" })
    // Node (Electron main) reports ENOENT; bun reports FailedToOpenSocket. Either way the detail names the socket.
    expect(r.detail).toContain("none.sock")
  })
})

describe("file probe (01c 11.3 item 5)", () => {
  test("present is healthy, absent FILE_MISSING, a directory is dead", async () => {
    const file = join(dir, "elk.bundled.js")
    writeFileSync(file, "x")
    expect(await runProbe({ kind: "file", path: file })).toMatchObject({ healthy: true, reason: "OK" })
    expect(await runProbe({ kind: "file", path: join(dir, "gone.js") })).toMatchObject({ healthy: false, reason: "FILE_MISSING" })
    const sub = join(dir, "sub")
    mkdirSync(sub)
    expect(await runProbe({ kind: "file", path: sub })).toMatchObject({ healthy: false, reason: "FILE_MISSING" })
  })

  test("TH-06 shape: the shipped layout-runtime probe follows its file", async () => {
    const res = join(dir, "res")
    const reg = createToolHealthRegistry({ home: dir, platform: "darwin", isPackaged: true, resourcesPath: res, appPath: dir })
    const lr = reg.find((c) => c.id === "layout-runtime")!.probe
    expect(await runProbe(lr)).toMatchObject({ healthy: false, reason: "FILE_MISSING" })
    mkdirSync(join(res, "datum-studio", "third_party", "elkjs"), { recursive: true })
    writeFileSync(join(res, "datum-studio", "third_party", "elkjs", "elk.bundled.js"), "x")
    expect(await runProbe(lr)).toMatchObject({ healthy: true, reason: "OK" })
  })
})

describe("process probe seam", () => {
  test("without a wired bridge probe the render-bridge kind is dead BRIDGE_NOT_STARTED; with one it delegates", async () => {
    const probe = { kind: "process" as const, check: "render-bridge" as const }
    expect(await runProbe(probe)).toMatchObject({ healthy: false, reason: "BRIDGE_NOT_STARTED" })
    const r = await runProbe(probe, { processProbe: async () => ({ healthy: true, reason: "OK", detail: "busy" }) })
    expect(r).toEqual({ healthy: true, reason: "OK", detail: "busy" })
  })
})
