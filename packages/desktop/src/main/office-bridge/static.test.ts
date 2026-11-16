import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OFFICE_PANE_CSP } from "@swarm/office-addin/constants"
import {
  BRIDGE_SECURITY_HEADERS,
  errorResponse,
  isStaticRequest,
  paneRootFor,
  sendBridgeResponse,
  serveStatic,
  type BridgeResponse,
} from "./static"

// Row 48 (plan M2-02): static branch of the office bridge. SD §9.4, register rev 5 §4 and §4.1, SC-07, SC-41.

// Register rev 5 §4.1, copied verbatim from masterplan/00_register.md (not from constants.ts), so a drift in either
// place fails here. D4 / C22: `frame-ancestors 'none'` is part of it.
const REGISTER_CSP =
  "default-src 'self'; script-src 'self' https://officeapis.public.onecdn.static.microsoft; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const base = mkdtempSync(join(tmpdir(), "office-bridge-static-"))
const resources = join(base, "resources")
const root = paneRootFor(resources)
const html = "<!doctype html><title>pane</title>"

beforeAll(() => {
  mkdirSync(join(root, "icons"), { recursive: true })
  mkdirSync(join(root, "assets", "nested"), { recursive: true })
  writeFileSync(join(root, "index.html"), html)
  writeFileSync(join(root, "pane.js"), "console.log(1)")
  writeFileSync(join(root, "assets", "app.css"), "body{}")
  writeFileSync(join(root, "assets", "nested", "a b.js"), "1")
  writeFileSync(join(root, "icons", "icon-32.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(root, ".env"), "SECRET=1")
  writeFileSync(join(root, "notes.txt"), "no mime")
  writeFileSync(join(root, "index.html.bak"), "no mime")
  writeFileSync(join(resources, "office-addin", "secret.html"), "outside")
  mkdirSync(join(resources, "office-addin", "pane-evil"), { recursive: true })
  writeFileSync(join(resources, "office-addin", "pane-evil", "x.html"), "sibling")
  symlinkSync(join(resources, "office-addin", "secret.html"), join(root, "link-out.html"))
  symlinkSync(join(root, "index.html"), join(root, "link-in.html"))
  symlinkSync(join(resources, "office-addin"), join(root, "dir-out"))
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

const get = (url: string) => serveStatic({ method: "GET", url }, root)
const text = (response: BridgeResponse | null) => new TextDecoder().decode(response?.body ?? new Uint8Array())
const expectNotFound = (response: BridgeResponse | null) => {
  expect(response?.status).toBe(404)
  expect(JSON.parse(text(response))).toEqual({ error: "ROUTE_NOT_ALLOWED" })
  expect(response?.headers["Content-Security-Policy"]).toBeUndefined()
}

describe("paneRootFor", () => {
  test("resourcesDir holds office-addin/pane (protocol.ts BridgeStartConfig)", () => {
    expect(paneRootFor("/r")).toBe(join("/r", "office-addin", "pane"))
  })
})

describe("isStaticRequest (SD §9.1 stage 5)", () => {
  test("GET and HEAD on / and /pane/* only", () => {
    expect(isStaticRequest({ method: "GET", url: "/" })).toBe(true)
    expect(isStaticRequest({ method: "HEAD", url: "/pane/index.html" })).toBe(true)
    expect(isStaticRequest({ method: "GET", url: "/pane" })).toBe(true)
    expect(isStaticRequest({ method: "GET", url: "/?x=1" })).toBe(true)
    expect(isStaticRequest({ method: "POST", url: "/pane/index.html" })).toBe(false)
    expect(isStaticRequest({ method: "OPTIONS", url: "/pane/index.html" })).toBe(false)
    expect(isStaticRequest({ method: "GET", url: "/panes/x.html" })).toBe(false)
    expect(isStaticRequest({ method: "GET", url: "/swarm/session" })).toBe(false)
    expect(isStaticRequest({ method: "GET", url: "/bridge/health" })).toBe(false)
    expect(isStaticRequest({ method: "GET", url: "https://localhost:46317/pane/index.html" })).toBe(false)
  })

  test("serveStatic returns null for a non-static request so the pipeline continues", async () => {
    expect(await serveStatic({ method: "POST", url: "/pane/index.html" }, root)).toBeNull()
    expect(await serveStatic({ method: "GET", url: "/bridge/health" }, root)).toBeNull()
  })
})

describe("/ redirect", () => {
  test("302 to /pane/index.html with the security headers and no body", async () => {
    const response = await get("/")
    expect(response?.status).toBe(302)
    expect(response?.headers.Location).toBe("/pane/index.html")
    expect(response?.body).toBeNull()
    expect(response?.headers).toMatchObject(BRIDGE_SECURITY_HEADERS)
  })

  test("HEAD / redirects the same way", async () => {
    const response = await serveStatic({ method: "HEAD", url: "/" }, root)
    expect(response?.status).toBe(302)
    expect(response?.headers.Location).toBe("/pane/index.html")
  })
})

describe("served files", () => {
  test("index.html: 200, fixed MIME, exact length, body", async () => {
    const response = await get("/pane/index.html")
    expect(response?.status).toBe(200)
    expect(response?.headers["Content-Type"]).toBe("text/html; charset=utf-8")
    expect(response?.headers["Content-Length"]).toBe(String(Buffer.byteLength(html)))
    expect(text(response)).toBe(html)
  })

  test("the /pane/* CSP header is present and equals the register rev 5 §4.1 literal, frame-ancestors included (SC-41, D4)", async () => {
    const response = await get("/pane/index.html")
    expect(response?.headers["Content-Security-Policy"]).toBe(REGISTER_CSP)
    expect(OFFICE_PANE_CSP).toBe(REGISTER_CSP)
    expect(response?.headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'")
  })

  test("every served file carries the CSP, nosniff, no-referrer and no-store, and never CORS or HSTS", async () => {
    const urls = ["/pane/index.html", "/pane/pane.js", "/pane/assets/app.css", "/pane/icons/icon-32.png"]
    const responses = await Promise.all(urls.map(get))
    responses.forEach((response) => {
      expect(response?.status).toBe(200)
      expect(response?.headers["Content-Security-Policy"]).toBe(REGISTER_CSP)
      expect(response?.headers["X-Content-Type-Options"]).toBe("nosniff")
      expect(response?.headers["Referrer-Policy"]).toBe("no-referrer")
      expect(response?.headers["Cache-Control"]).toBe("no-store")
      const names = Object.keys(response?.headers ?? {}).map((name) => name.toLowerCase())
      expect(names.some((name) => name.startsWith("access-control-"))).toBe(false)
      expect(names).not.toContain("strict-transport-security")
    })
    expect(responses.map((response) => response?.headers["Content-Type"])).toEqual([
      "text/html; charset=utf-8",
      "text/javascript; charset=utf-8",
      "text/css; charset=utf-8",
      "image/png",
    ])
  })

  test("HEAD: same headers and length, no body", async () => {
    const response = await serveStatic({ method: "HEAD", url: "/pane/index.html" }, root)
    expect(response?.status).toBe(200)
    expect(response?.body).toBeNull()
    expect(response?.headers["Content-Length"]).toBe(String(Buffer.byteLength(html)))
    expect(response?.headers["Content-Security-Policy"]).toBe(REGISTER_CSP)
  })

  test("a query (Office appends _host_Info) is ignored", async () => {
    const response = await get("/pane/index.html?_host_Info=Word$Mac$16.01$en-US")
    expect(response?.status).toBe(200)
    expect(text(response)).toBe(html)
  })

  test("a percent-encoded plain name is decoded; a symlink that stays inside the root is served", async () => {
    expect((await get("/pane/assets/nested/a%20b.js"))?.status).toBe(200)
    expect(text(await get("/pane/link-in.html"))).toBe(html)
  })
})

describe("no listing, unknown types, dot files", () => {
  test("directories are never listed", async () => {
    for (const url of ["/pane", "/pane/", "/pane/icons", "/pane/icons/", "/pane/assets/nested/"]) expectNotFound(await get(url))
  })

  test("an extension outside the fixed MIME map is 404, even when the file exists", async () => {
    for (const url of ["/pane/notes.txt", "/pane/index.html.bak", "/pane/icons"]) expectNotFound(await get(url))
  })

  test("dot files and missing files are 404", async () => {
    for (const url of ["/pane/.env", "/pane/%2eenv", "/pane/missing.html", "/pane/icons/icon-99.png"]) expectNotFound(await get(url))
  })

  test("a missing pane root is 404, not an error", async () => {
    expectNotFound(await serveStatic({ method: "GET", url: "/pane/index.html" }, join(base, "nope")))
  })
})

describe("traversal (SD §9.4 realpath prefix check)", () => {
  const cases = [
    "/pane/../secret.html",
    "/pane/./index.html",
    "/pane/icons/../index.html",
    "/pane/..%2fsecret.html",
    "/pane/%2e%2e/secret.html",
    "/pane/%2E%2E/secret.html",
    "/pane/%2e%2e%2fsecret.html",
    "/pane/.%2e/secret.html",
    "/pane/..%5csecret.html",
    "/pane/..\\secret.html",
    "/pane/%252e%252e/secret.html",
    "/pane/icons%2f..%2f..%2fsecret.html",
    "/pane//index.html",
    "/pane/index.html%00.png",
    "/pane/%E0%A4%A.html",
    "/pane/link-out.html",
    "/pane/dir-out/secret.html",
    "/pane/../pane-evil/x.html",
    "/pane/dir-out/pane-evil/x.html",
  ]
  for (const url of cases) {
    test(`${url} -> 404`, async () => {
      const response = await get(url)
      expectNotFound(response)
      expect(text(response)).not.toContain("outside")
      expect(text(response)).not.toContain("sibling")
    })
  }
})

describe("errorResponse and sendBridgeResponse", () => {
  test("error bodies are { error } JSON with the four security headers and a Content-Length", () => {
    const response = errorResponse(404, "ROUTE_NOT_ALLOWED")
    expect(response.headers).toMatchObject(BRIDGE_SECURITY_HEADERS)
    expect(response.headers["Content-Type"]).toBe("application/json; charset=utf-8")
    expect(response.headers["Content-Length"]).toBe(String(response.body?.byteLength))
    expect(BRIDGE_SECURITY_HEADERS).toEqual({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
    })
  })

  test("writes status, headers and body; end() without a body for HEAD and redirects", async () => {
    const calls: unknown[][] = []
    const target = {
      writeHead: (status: number, headers: Record<string, string>) => calls.push(["writeHead", status, headers]),
      end: (body?: Uint8Array) => calls.push(["end", body]),
    }
    sendBridgeResponse(target, errorResponse(404, "ROUTE_NOT_ALLOWED"))
    sendBridgeResponse(target, (await get("/"))!)
    expect(calls[0][1]).toBe(404)
    expect(new TextDecoder().decode(calls[1][1] as Uint8Array)).toBe('{"error":"ROUTE_NOT_ALLOWED"}')
    expect(calls[2][1]).toBe(302)
    expect(calls[3]).toEqual(["end", undefined])
  })
})
