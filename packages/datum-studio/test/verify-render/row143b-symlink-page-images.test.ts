// Row 143b (C177, F143-2): a store root reached through a symlink still reports the written page images.
// The real bridge replies the RESOLVED path (datum-render/paths.ts checkOutputPath: join(realpathSync(parent), base));
// the host's sanity check compared it with the unresolved dstDir and threw "reply is malformed". The only stand-in
// here is the bridge transport, which behaves like the real one (writes the file, replies the resolved path).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { rasterizeHtmlPages, setRenderBridgeTransport } from "../../vendor/src/lib/studio/engine/browser/runtime"

const BASE = process.env.ROW143B_TEST_DIR ?? "/private/tmp/claude-501/row143b/tests"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(join(BASE, "link-")))
const REAL = join(WORK, "real-store")
const LINK = join(WORK, "link-store")
const SHA = "a".repeat(64)

beforeAll(() => {
  mkdirSync(join(REAL, "verify", "o1"), { recursive: true })
  symlinkSync(REAL, LINK)
  setRenderBridgeTransport(async (req) => {
    if (req.op === "hello") return { ok: true, electron: "42", chrome: "142", sandbox: true, contextIsolation: true, nodeIntegration: false, network: "blocked" }
    if (req.op === "pagePng") {
      const dstDir = realpathSync(String(req.dstDir)) // what checkOutputPath does
      const dst = join(dstDir, "witness-p001.png")
      writeFileSync(dst, "png")
      return { ok: true, layout: "paged", pageCount: 1, pageSizeMm: { wMm: 210, hMm: 297 }, pageSizeSource: "css", dpi: 150, pages: [{ n: 1, dst, width: 10, height: 10, sha256: SHA }] }
    }
    return { ok: false, code: "UNKNOWN_OP" }
  })
})
afterAll(() => setRenderBridgeTransport(null))

describe("row 143b: page images through a symlinked store path", () => {
  it("reports the written page image when dstDir contains a symlink", async () => {
    const dstDir = join(LINK, "verify", "o1")
    const r = await rasterizeHtmlPages({ src: join(REAL, "x.html"), dstDir })
    expect(r.pages).toHaveLength(1)
    expect(existsSync(r.pages[0]!.png)).toBe(true)
    expect(r.pages[0]!.png).toBe(join(REAL, "verify", "o1", "witness-p001.png"))
  })

  it("a reply path outside dstDir is still refused", async () => {
    setRenderBridgeTransport(async (req) => {
      if (req.op === "hello") return { ok: true, electron: "42", chrome: "142", sandbox: true, contextIsolation: true, nodeIntegration: false, network: "blocked" }
      return { ok: true, layout: "paged", pageCount: 1, pageSizeMm: { wMm: 1, hMm: 1 }, pageSizeSource: "css", dpi: 150, pages: [{ n: 1, dst: join(WORK, "elsewhere", "witness-p001.png"), width: 1, height: 1, sha256: SHA }] }
    })
    await expect(rasterizeHtmlPages({ src: join(REAL, "x.html"), dstDir: join(LINK, "verify", "o1") })).rejects.toThrow()
  })
})
