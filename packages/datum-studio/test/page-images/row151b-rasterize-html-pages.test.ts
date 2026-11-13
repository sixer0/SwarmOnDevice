// Row 151b (decision C130 GAP-1): the engine-side caller of the render bridge `pagePng` op, vendored
// engine/browser/runtime.ts `rasterizeHtmlPages`. The bridge itself (and its real-Electron behaviour) is tested in
// packages/desktop (src/main/datum-render/*.test.ts, test/datum-render-electron/row151b-page-png.test.ts). Here the
// only stand-in is the bridge transport (`setRenderBridgeTransport`), as rows 67/68/70a/108: Electron cannot run under bun.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import {
  type BridgeReply,
  type BridgeRequest,
  rasterizeHtmlPages,
  setBrowserLogSink,
  setRenderBridgeTransport,
} from "../../vendor/src/lib/studio/engine/browser/runtime"

const HELLO = { ok: true, electron: "42.3.3", chrome: "x", sandbox: true, contextIsolation: true, nodeIntegration: false, network: "blocked" }
const sent: BridgeRequest[] = []
let reply: (req: BridgeRequest) => BridgeReply
const logs: Array<{ level: string; message: string; code?: string }> = []

beforeEach(() => {
  sent.length = 0
  logs.length = 0
  setBrowserLogSink((e) => logs.push(e))
  setRenderBridgeTransport(async (req) => {
    sent.push(req)
    return req.op === "hello" ? (HELLO as BridgeReply) : reply(req)
  })
})
afterAll(() => {
  setRenderBridgeTransport(null)
  setBrowserLogSink(null)
})

const sha = "a".repeat(64)
const page = (n: number, dir = "/s/verify/o1") => ({ n, dst: `${dir}/witness-p00${n}.png`, width: 1239, height: 1753, bytes: 10, sha256: sha })

describe("rasterizeHtmlPages over the render bridge", () => {
  test("sends one pagePng with only the given fields and maps the reply to pages[].png paths", async () => {
    reply = () => ({
      ok: true,
      layout: "paged",
      media: "print",
      pageCount: 3,
      pageSizeMm: { wMm: 210, hMm: 297 },
      pageSizeSource: "css",
      dpi: 150,
      pages: [page(1), page(3)],
    })
    const r = await rasterizeHtmlPages({ src: "/s/out/doc.html", dstDir: "/s/verify/o1", pages: [1, 3] })
    expect(sent.map((q) => q.op)).toEqual(["hello", "pagePng"])
    expect(sent[1]).toEqual({ op: "pagePng", src: "/s/out/doc.html", dstDir: "/s/verify/o1", pages: [1, 3] })
    expect(r).toEqual({
      layout: "paged",
      pageCount: 3,
      pageSizeMm: { wMm: 210, hMm: 297 },
      pageSizeSource: "css",
      dpi: 150,
      pages: [
        { n: 1, png: "/s/verify/o1/witness-p001.png", width: 1239, height: 1753, sha256: sha },
        { n: 3, png: "/s/verify/o1/witness-p003.png", width: 1239, height: 1753, sha256: sha },
      ],
    })
  })

  test("dpi and fallback page size are passed through; the token is never added by the caller", async () => {
    reply = () => ({ ok: true, layout: "flow", pageCount: 1, pageSizeMm: { wMm: 148, hMm: 210 }, pageSizeSource: "fallback", dpi: 96, pages: [page(1)] })
    await rasterizeHtmlPages({ src: "/s/out/doc.html", dstDir: "/s/verify/o1", dpi: 96, widthMm: 148, heightMm: 210 })
    const q = sent.find((x) => x.op === "pagePng")!
    expect(q).toEqual({ op: "pagePng", src: "/s/out/doc.html", dstDir: "/s/verify/o1", dpi: 96, widthMm: 148, heightMm: 210 })
    expect("token" in q).toBe(false)
  })

  test("a bridge refusal becomes a Studio error without the bridge text; the code is logged", async () => {
    reply = () => ({ ok: false, code: "PATH_REFUSED", message: "dst is inside a protected folder" })
    const err = await rasterizeHtmlPages({ src: "/s/out/doc.html", dstDir: "/Users/x/.ssh" }).catch((e) => e)
    expect(err.code).toBe("BY_CONSTRUCTION_FAILED")
    expect(String(err.message)).toContain("PATH_REFUSED")
    expect(String(err.message)).not.toContain(".ssh")
    expect(logs.some((l) => l.code === "PATH_REFUSED")).toBe(true)
  })

  test("a reply naming a file outside dstDir or a page beyond the count is refused as malformed", async () => {
    for (const bad of [
      { ok: true, layout: "paged", pageCount: 3, pageSizeMm: { wMm: 210, hMm: 297 }, dpi: 150, pages: [page(1, "/elsewhere")] },
      { ok: true, layout: "paged", pageCount: 1, pageSizeMm: { wMm: 210, hMm: 297 }, dpi: 150, pages: [page(2)] },
      { ok: true, layout: "paged", pageCount: 0, pageSizeMm: { wMm: 210, hMm: 297 }, dpi: 150, pages: [] },
      { ok: true, layout: "paged", pageCount: 1, pageSizeMm: { wMm: 210, hMm: 297 }, dpi: 150, pages: [{ ...page(1), sha256: "x" }] },
    ]) {
      reply = () => bad as BridgeReply
      const err = await rasterizeHtmlPages({ src: "/s/out/doc.html", dstDir: "/s/verify/o1" }).catch((e) => e)
      expect(err.code).toBe("BROWSER_UNAVAILABLE")
      expect(String(err.message)).toContain("malformed")
    }
  })
})
