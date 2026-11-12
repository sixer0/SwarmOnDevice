// Row 24: op dispatch and the socket protocol, end to end, with a fake page engine.
// The real Electron engine (byte-equal rasters, network and script canaries) is the later smoke row.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { EngineInfo, PageEngine } from "./dispatch"
import { startRenderBridge, type RenderBridge } from "./index"
import { renderWebPreferences } from "./pages"
import { extractRenderPyCheckScript, sha256 } from "./scripts"
import { createHostEnv } from "../datum-studio-host/lifecycle"
import { socketTransport } from "../../../../datum-studio/vendor/src/lib/studio/engine/browser/runtime"

const DESKTOP = resolve(import.meta.dir, "../../..")
const FONTS = join(DESKTOP, "datum/datum-house-style/assets/fonts")
const RENDER_PY = join(DESKTOP, "datum/datum-house-style/scripts/datum_render.py")
const MEASURE_TS = resolve(DESKTOP, "../datum-studio/vendor/src/lib/studio/engine/browser/measure.ts")

/** Read Studio's MEASURE_SCRIPT as text (data only; the vendored engine is not imported here). */
function studioMeasureScript(): string | undefined {
  if (!existsSync(MEASURE_TS)) return undefined
  const m = /export const MEASURE_SCRIPT = String\.raw`([\s\S]*?)`;/.exec(readFileSync(MEASURE_TS, "utf8"))
  return m?.[1]
}
const MEASURE = studioMeasureScript() ?? "(function (o) { return { fixture: true, o: o }; })"

type Job = { kind: string; [k: string]: unknown }
const jobs: Job[] = []
const raster = renderWebPreferences("raster")
const fakeEngine: PageEngine = {
  async png(job) {
    jobs.push({ kind: "png", ...job })
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), createHash("sha256").update(job.html).digest()])
  },
  async pdf(job) {
    jobs.push({ kind: "pdf", ...job })
    return Buffer.from(`%PDF-1.7 fake ${job.preferCSSPageSize}`)
  },
  async evaluate(job) {
    jobs.push({ kind: "evaluate", ...job })
    return { measured: true }
  },
  // Row 151b: a 3-page document; one tiny PNG per selected page.
  async pagePngs(job) {
    jobs.push({ kind: "pagePngs", ...job })
    const sel = job.pages ?? [1, 2, 3]
    const png = (n: number) => {
      const b = Buffer.alloc(33)
      b.writeUInt32BE(0x89504e47, 0)
      b.writeUInt32BE(0x0d0a1a0a, 4)
      b.writeUInt32BE(13, 8)
      b.write("IHDR", 12, "latin1")
      b.writeUInt32BE(10 * n, 16)
      b.writeUInt32BE(14 * n, 20)
      return b
    }
    return {
      layout: "paged",
      media: "print",
      pageCount: 3,
      pageSizeMm: job.fallback,
      pageSizeSource: "fallback",
      images: sel.filter((n) => n <= 3).map((n) => ({ n, png: png(n), width: 10 * n, height: 14 * n })),
    }
  },
  info: (): EngineInfo => ({
    electron: "fake",
    chrome: "fake",
    partition: "datum-render",
    sandbox: raster.sandbox,
    contextIsolation: raster.contextIsolation,
    nodeIntegration: raster.nodeIntegration,
    javascriptContent: raster.javascript,
    network: "blocked",
  }),
}

const work = realpathSync(mkdtempSync(join(tmpdir(), "row24-bridge-")))
const logs: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []
let bridge: RenderBridge

const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="166mm" height="100mm" viewBox="0 0 166 100"><text font-family="IBM Plex Sans">A</text></svg>'
const HTML = '<!doctype html><html><head><style>@page{size:210mm 297mm}</style></head><body><div class="page">x</div></body></html>'

function call(socketPath: string, lines: unknown[]): Promise<any[]> {
  return new Promise((resolveP, reject) => {
    const sock = createConnection(socketPath)
    const out: any[] = []
    let buf = ""
    sock.on("data", (d) => {
      buf += d.toString("utf8")
      let nl
      while ((nl = buf.indexOf("\n")) >= 0) {
        out.push(JSON.parse(buf.slice(0, nl)))
        buf = buf.slice(nl + 1)
        if (out.length === lines.length) sock.end()
      }
    })
    sock.on("end", () => resolveP(out))
    sock.on("error", reject)
    sock.write(lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n")
  })
}

beforeAll(async () => {
  writeFileSync(join(work, "fig.svg"), SVG)
  writeFileSync(join(work, "sheet.html"), HTML)
  bridge = await startRenderBridge({
    fontsDir: FONTS,
    renderScriptPath: RENDER_PY,
    extraScripts: { "studio.MEASURE_SCRIPT": MEASURE },
    log: (level, source, message, context) => logs.push({ level, source, message, context }),
    policy: { roots: [work], deny: [], maxInputBytes: 1 << 20 },
    engine: fakeEngine,
    baseDir: work,
  })
})

afterAll(async () => {
  await bridge?.close()
})

describe("render bridge over the socket", () => {
  test("socket folder is 0700, socket 0600, token is 32 random bytes", () => {
    const { DATUM_RENDER_SOCKET, DATUM_RENDER_TOKEN } = bridge.env
    expect(DATUM_RENDER_SOCKET.endsWith("/render.sock")).toBe(true)
    expect(DATUM_RENDER_SOCKET).toContain("/swarm-datum-")
    expect(statSync(join(DATUM_RENDER_SOCKET, "..")).mode & 0o777).toBe(0o700)
    expect(statSync(DATUM_RENDER_SOCKET).mode & 0o777).toBe(0o600)
    expect(DATUM_RENDER_TOKEN).toMatch(/^[0-9a-f]{64}$/)
  })

  test("png of one SVG with the token: written atomically, Plex inlined, size kept", async () => {
    const dst = join(work, "fig.png")
    const [res] = await call(bridge.env.DATUM_RENDER_SOCKET, [
      { token: bridge.env.DATUM_RENDER_TOKEN, id: 1, op: "png", src: join(work, "fig.svg"), dst, width: 1961, height: 1181 },
    ])
    expect(res).toMatchObject({ id: 1, ok: true, dst, width: 1961, height: 1181 })
    const bytes = readFileSync(dst)
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(res.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    const job = jobs.findLast((j) => j.kind === "png")!
    expect(job.html as string).toContain('font-family:"IBM Plex Sans"')
    expect(job.html as string).toContain("<svg")
    expect(job.html as string).not.toContain("<?xml")
  })

  test("png without height keeps the SVG aspect (rsvg-convert -w W shape)", async () => {
    const [res] = await call(bridge.env.DATUM_RENDER_SOCKET, [
      { token: bridge.env.DATUM_RENDER_TOKEN, op: "png", src: join(work, "fig.svg"), dst: join(work, "fig2.png"), width: 1660 },
    ])
    expect(res).toMatchObject({ ok: true, width: 1660, height: 1000 })
  })

  test("same SVG twice gives byte-equal page input (the engine sees identical HTML)", async () => {
    const before = jobs.filter((j) => j.kind === "png").length
    for (const name of ["r1.png", "r2.png"]) {
      await call(bridge.env.DATUM_RENDER_SOCKET, [
        { token: bridge.env.DATUM_RENDER_TOKEN, op: "png", src: join(work, "fig.svg"), dst: join(work, name), width: 400, height: 241 },
      ])
    }
    const [a, b] = jobs.filter((j) => j.kind === "png").slice(before)
    expect(sha256(a.html as string)).toBe(sha256(b.html as string))
    expect(readFileSync(join(work, "r1.png"))).toEqual(readFileSync(join(work, "r2.png")))
  })

  test("pdf of one HTML file with preferCSSPageSize true", async () => {
    const dst = join(work, "sheet.pdf")
    const [res] = await call(bridge.env.DATUM_RENDER_SOCKET, [
      { token: bridge.env.DATUM_RENDER_TOKEN, id: "p", op: "pdf", src: join(work, "sheet.html"), dst, preferCSSPageSize: true },
    ])
    expect(res).toMatchObject({ id: "p", ok: true, preferCSSPageSize: true })
    expect(readFileSync(dst, "utf8")).toStartWith("%PDF-")
    const job = jobs.findLast((j) => j.kind === "pdf")!
    expect(job.preferCSSPageSize).toBe(true)
    expect((job.html as string).indexOf("@font-face")).toBeLessThan((job.html as string).indexOf("@page{size:210mm"))
  })

  test("pdf of an SVG sizes the sheet from its mm attributes", async () => {
    const [res] = await call(bridge.env.DATUM_RENDER_SOCKET, [
      { token: bridge.env.DATUM_RENDER_TOKEN, op: "pdf", src: join(work, "fig.svg"), dst: join(work, "fig.pdf") },
    ])
    expect(res.ok).toBe(true)
    const job = jobs.findLast((j) => j.kind === "pdf")!
    expect(job).toMatchObject({ widthMm: 166, heightMm: 100 })
    expect(job.html as string).toContain("@page{size:166mm 100mm;margin:0}")
  })

  test("checkPage runs Studio's MEASURE_SCRIPT as an allow-listed fixed script", async () => {
    const arg = { pageWidthMm: 210, pageHeightMm: 297, maxElements: 4000 }
    const [res] = await call(bridge.env.DATUM_RENDER_SOCKET, [
      { token: bridge.env.DATUM_RENDER_TOKEN, op: "checkPage", src: join(work, "sheet.html"), wMm: 210, hMm: 297, script: MEASURE, arg },
    ])
    expect(res).toMatchObject({ ok: true, script: "studio.MEASURE_SCRIPT", result: { measured: true } })
    const job = jobs.findLast((j) => j.kind === "evaluate")!
    // Same expression as Studio's measureExpression (measure.ts: `${MEASURE_SCRIPT}(${JSON.stringify(args)})`), wrapped once.
    expect(job.expression).toBe(`(${MEASURE})(${JSON.stringify(arg)})`)
    expect(job).toMatchObject({ viewportWidth: 794, viewportHeight: 1123 })
  })

  test("checkPage accepts datum_render.py's check-page function, with render.py's {w,h} argument", async () => {
    const script = extractRenderPyCheckScript(readFileSync(RENDER_PY, "utf8"))!
    expect(script).toContain("document.querySelectorAll('.page')")
    const [res] = await call(bridge.env.DATUM_RENDER_SOCKET, [
      { token: bridge.env.DATUM_RENDER_TOKEN, op: "checkPage", html: HTML, wMm: 210, hMm: 297, script, viewportWidth: 1240, viewportHeight: 1754 },
    ])
    expect(res).toMatchObject({ ok: true, script: "datum_render.check_page" })
    expect(jobs.findLast((j) => j.kind === "evaluate")!.expression).toBe(`(${script})({"w":210,"h":297})`)
  })

  test("row 106 shim shapes: checkPage html=<abs path> with width/height, png floats, reply has electron and error", async () => {
    const script = extractRenderPyCheckScript(readFileSync(RENDER_PY, "utf8"))!
    const sock = bridge.env.DATUM_RENDER_SOCKET
    const tok = bridge.env.DATUM_RENDER_TOKEN
    // Exactly the dicts the shim builds (sync_api/__init__.py:126,139,152; rsvg_convert.py parse).
    const [check] = await call(sock, [{ op: "checkPage", html: join(work, "sheet.html"), wMm: 210.0, hMm: 297.0, script, width: 1240, height: 1754, token: tok }])
    expect(check).toMatchObject({ ok: true, electron: "fake", result: { measured: true } })
    const ev = jobs.findLast((j) => j.kind === "evaluate")!
    expect(ev).toMatchObject({ viewportWidth: 1240, viewportHeight: 1754 })
    expect(ev.html as string).toContain('<div class="page">x</div>')
    const [noVp] = await call(sock, [{ op: "checkPage", html: join(work, "sheet.html"), wMm: 210, hMm: 297, script, width: null, height: null, token: tok }])
    expect(noVp.ok).toBe(true)
    const [png] = await call(sock, ['{"op":"png","src":"' + join(work, "fig.svg") + '","dst":"' + join(work, "s.png") + '","width":1961.0,"height":1181.0,"token":"' + tok + '"}'])
    expect(png).toMatchObject({ ok: true, electron: "fake" })
    const [pdf] = await call(sock, [{ op: "pdf", src: join(work, "fig.svg"), dst: join(work, "s.pdf"), widthMm: 166.0, heightMm: 100.0, token: tok }])
    expect(pdf).toMatchObject({ ok: true, electron: "fake" })
    const [bad] = await call(sock, [{ op: "png", src: join(work, "fig.svg"), dst: "rel.png", width: 10, height: 10, token: tok }])
    expect(bad).toMatchObject({ ok: false, code: "PATH_REFUSED" })
    expect(typeof bad.error).toBe("string")
  })

  test("checkPage refuses any other script", async () => {
    const [res] = await call(bridge.env.DATUM_RENDER_SOCKET, [
      { token: bridge.env.DATUM_RENDER_TOKEN, op: "checkPage", html: HTML, wMm: 210, hMm: 297, script: "() => fetch('http://x')" },
    ])
    expect(res).toMatchObject({ ok: false, code: "SCRIPT_NOT_ALLOWED" })
  })

  test("missing or wrong token is refused before any work", async () => {
    const n = jobs.length
    const res = await call(bridge.env.DATUM_RENDER_SOCKET, [
      { op: "png", src: join(work, "fig.svg"), dst: join(work, "x.png"), width: 10 },
      { token: "0".repeat(64), op: "hello" },
    ])
    expect(res.map((r) => r.code)).toEqual(["UNAUTHORIZED", "UNAUTHORIZED"])
    expect(jobs.length).toBe(n)
    expect(existsSync(join(work, "x.png"))).toBe(false)
    expect(JSON.stringify(logs)).not.toContain(bridge.env.DATUM_RENDER_TOKEN)
  })

  test("relative dst and out-of-root src are refused", async () => {
    const res = await call(bridge.env.DATUM_RENDER_SOCKET, [
      { token: bridge.env.DATUM_RENDER_TOKEN, op: "png", src: join(work, "fig.svg"), dst: "fig.png", width: 10 },
      { token: bridge.env.DATUM_RENDER_TOKEN, op: "pdf", src: "/etc/hosts.html", dst: join(work, "h.pdf") },
    ])
    expect(res.map((r) => r.code)).toEqual(["PATH_REFUSED", "PATH_REFUSED"])
  })

  test("malformed line and unknown op get a coded error; the connection keeps working", async () => {
    const res = await call(bridge.env.DATUM_RENDER_SOCKET, [
      "{oops",
      { token: bridge.env.DATUM_RENDER_TOKEN, op: "shell", cmd: "id" },
      { token: bridge.env.DATUM_RENDER_TOKEN, id: 9, op: "hello" },
    ])
    expect(res[0].code).toBe("BAD_REQUEST")
    expect(res[1].code).toBe("UNKNOWN_OP")
    expect(res[2]).toMatchObject({
      id: 9,
      ok: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascriptContent: false,
      network: "blocked",
      fonts: 20,
    })
    expect(res[2].scripts).toEqual(["datum_render.check_page", "studio.MEASURE_SCRIPT"])
  })

  test("pagePng (row 151b): one file per page in dstDir, fonts + CSP prepended, A4 fallback, 150 dpi default", async () => {
    const out = join(work, "pages")
    mkdirSync(out)
    const [res] = await call(bridge.env.DATUM_RENDER_SOCKET, [
      { token: bridge.env.DATUM_RENDER_TOKEN, id: "pp", op: "pagePng", src: join(work, "sheet.html"), dstDir: out },
    ])
    expect(res).toMatchObject({ id: "pp", ok: true, layout: "paged", media: "print", pageCount: 3, dpi: 150 })
    expect(res.pageSizeMm).toEqual({ wMm: 210, hMm: 297 })
    expect(res.pages.map((p: any) => [p.n, p.dst, p.width, p.height])).toEqual([
      [1, join(out, "p001.png"), 10, 14],
      [2, join(out, "p002.png"), 20, 28],
      [3, join(out, "p003.png"), 30, 42],
    ])
    for (const p of res.pages) expect(p.sha256).toBe(createHash("sha256").update(readFileSync(p.dst)).digest("hex"))
    const job = jobs.findLast((j) => j.kind === "pagePngs")!
    expect(job).toMatchObject({ dpi: 150, pages: null, fallback: { wMm: 210, hMm: 297 } })
    expect(job.html as string).toContain("Content-Security-Policy")
    expect(job.html as string).toContain('font-family:"IBM Plex Sans"')
  })

  test("pagePng: selected pages, dpi and fallback size are passed through; refusals happen before any render", async () => {
    const out = join(work, "pages2")
    mkdirSync(out)
    const tok = bridge.env.DATUM_RENDER_TOKEN
    const before = jobs.filter((j) => j.kind === "pagePngs").length
    const res = await call(bridge.env.DATUM_RENDER_SOCKET, [
      { token: tok, op: "pagePng", src: join(work, "sheet.html"), dstDir: out, pages: [2], dpi: 96, widthMm: 148, heightMm: 210 },
      { token: tok, op: "pagePng", src: join(work, "sheet.html"), dstDir: "/etc" },
      { token: tok, op: "pagePng", src: join(work, "sheet.html"), dstDir: join(work, "absent") },
      { token: tok, op: "pagePng", src: join(work, "sheet.html"), dstDir: `${out}/` },
      { token: tok, op: "pagePng", src: join(work, "fig.svg"), dstDir: out },
      { op: "pagePng", src: join(work, "sheet.html"), dstDir: out },
    ])
    expect(res[0]).toMatchObject({ ok: true, dpi: 96, pageSizeMm: { wMm: 148, hMm: 210 } })
    expect(res[0].pages.map((p: any) => p.dst)).toEqual([join(out, "p002.png")])
    expect(res.slice(1).map((r) => r.code)).toEqual(["PATH_REFUSED", "PATH_REFUSED", "PATH_REFUSED", "BAD_REQUEST", "UNAUTHORIZED"])
    expect(existsSync(join(out, "p001.png"))).toBe(false)
    expect(jobs.filter((j) => j.kind === "pagePngs").length - before).toBe(1)
  })

  test("failures are written to the persistent log sink with code, not content", () => {
    const refused = logs.filter((l) => l.source === "datum-render.request")
    expect(refused.length).toBeGreaterThan(0)
    expect(refused.every((l) => typeof l.context?.code === "string")).toBe(true)
    expect(JSON.stringify(refused)).not.toContain("<svg")
  })

  test("close removes the socket folder", async () => {
    const extra = await startRenderBridge({
      fontsDir: FONTS,
      log: () => {},
      policy: { roots: [work], deny: [], maxInputBytes: 1024 },
      engine: fakeEngine,
      baseDir: work,
    })
    const dir = join(extra.env.DATUM_RENDER_SOCKET, "..")
    expect(existsSync(dir)).toBe(true)
    await extra.close()
    expect(existsSync(dir)).toBe(false)
  })

  test("MEASURE_SCRIPT came from the vendored Studio engine (not the fixture)", () => {
    expect(studioMeasureScript()).toBeDefined()
    expect(MEASURE.startsWith("(function (o) {")).toBe(true)
  })
})

// 1.2.6 row 93 (TH-04, DP-1; spec 01c 11.7): same-endpoint restart. Consumers read the pair per request, so after a
// restart with `reuse` the old env keeps working without a respawn or an env refresh.
describe("row 93: render bridge restart on the same endpoint (01c 11.7)", () => {
  const start = (reuse?: { token: string; socketPath: string }) =>
    startRenderBridge({
      fontsDir: FONTS,
      log: () => {},
      policy: { roots: [work], deny: [], maxInputBytes: 1024 },
      engine: fakeEngine,
      baseDir: work,
      reuse,
    })
  const hello = (env: RenderBridge["env"]) => call(env.DATUM_RENDER_SOCKET, [{ op: "hello", token: env.DATUM_RENDER_TOKEN, id: 1 }])

  test("1: a restart with reuse keeps DATUM_RENDER_SOCKET and DATUM_RENDER_TOKEN byte-identical", async () => {
    const first = await start()
    const before = Buffer.from(JSON.stringify(first.env))
    await first.close()
    const second = await start({ token: first.env.DATUM_RENDER_TOKEN, socketPath: first.env.DATUM_RENDER_SOCKET })
    try {
      expect(Buffer.from(JSON.stringify(second.env)).equals(before)).toBe(true)
      const [res] = await hello(first.env)
      expect(res.ok).toBe(true)
    } finally {
      await second.close()
    }
  })

  test("2: socket folder deleted, then restart: folder 0700, socket 0600, hello with the old token succeeds", async () => {
    const first = await start()
    const dir = join(first.env.DATUM_RENDER_SOCKET, "..")
    rmSync(dir, { recursive: true, force: true })
    expect(existsSync(dir)).toBe(false)
    await first.close()
    const second = await start({ token: first.env.DATUM_RENDER_TOKEN, socketPath: first.env.DATUM_RENDER_SOCKET })
    try {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(first.env.DATUM_RENDER_SOCKET).mode & 0o777).toBe(0o600)
      const [res] = await hello(first.env)
      expect(res).toMatchObject({ id: 1, ok: true })
      const [wrong] = await call(first.env.DATUM_RENDER_SOCKET, [{ op: "hello", token: "0".repeat(64), id: 2 }])
      expect(wrong).toMatchObject({ ok: false, code: "UNAUTHORIZED" })
    } finally {
      await second.close()
    }
  })

  test("3: the host env object from start is untouched; socketTransport with the old env succeeds after the restart", async () => {
    const first = await start()
    const hostEnv = createHostEnv({
      baseEnv: { HOME: "/h" },
      renderEnv: first.env,
      layout: { assetsRoot: "/a", vendorRoot: "/v" } as never,
      storeRoot: "/s",
    })
    const frozen = JSON.stringify(hostEnv)
    rmSync(join(first.env.DATUM_RENDER_SOCKET, ".."), { recursive: true, force: true })
    await first.close()
    const second = await start({ token: first.env.DATUM_RENDER_TOKEN, socketPath: first.env.DATUM_RENDER_SOCKET })
    const saved = { s: process.env.DATUM_RENDER_SOCKET, t: process.env.DATUM_RENDER_TOKEN }
    try {
      expect(JSON.stringify(hostEnv)).toBe(frozen)
      process.env.DATUM_RENDER_SOCKET = hostEnv.DATUM_RENDER_SOCKET
      process.env.DATUM_RENDER_TOKEN = hostEnv.DATUM_RENDER_TOKEN
      const reply = await socketTransport({ op: "hello" } as never, { timeoutMs: 2000 })
      expect(reply.ok).toBe(true)
    } finally {
      if (saved.s === undefined) delete process.env.DATUM_RENDER_SOCKET
      else process.env.DATUM_RENDER_SOCKET = saved.s
      if (saved.t === undefined) delete process.env.DATUM_RENDER_TOKEN
      else process.env.DATUM_RENDER_TOKEN = saved.t
      await second.close()
    }
  })

  test("close of a server whose folder was already deleted resolves (the revive closes the old server first)", async () => {
    const first = await start()
    rmSync(join(first.env.DATUM_RENDER_SOCKET, ".."), { recursive: true, force: true })
    await first.close()
    expect(existsSync(join(first.env.DATUM_RENDER_SOCKET, ".."))).toBe(false)
  })

  test("a regular file at the socket path is refused, never deleted", async () => {
    const dir = mkdtempSync(join(work, "swarm-datum-"))
    const socketPath = join(dir, "render.sock")
    writeFileSync(socketPath, "not a socket")
    await expect(start({ token: "a".repeat(64), socketPath })).rejects.toThrow(/not a socket/)
    expect(readFileSync(socketPath, "utf8")).toBe("not a socket")
  })
})
