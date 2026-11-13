// Swarm 1.2.7 row 45 (N7-114, CHAR-VERIFY): regression test committed from the row 9 engine probe
// ($T/test/probes/datum-studio/probe9_engine.test.ts). Must pass at BASE 04067a9d02 and at HEAD; no code change for
// this item. Synthetic inputs only: every figure and chart below is built in-test from filler words.
// AC-M04 (01_specs §4): a label-heavy engine-built figure reaches the render bridge's png op with an adaptive limit
// above the old fixed 30000 ms (44750 at row 9). Fake bridge, no Electron: real Electron timing is row 58's, not gated.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"

type S = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const E = path.join(PKG, "vendor", "src", "lib", "studio", "engine")
const build = await import(path.join(E, "diagram", "build", "index.ts"))
const runtime = await import(path.join(E, "browser", "runtime.ts"))
const browser = await import(path.join(E, "browser", "index.ts"))
const HELLO = { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (const x of b) {
    c ^= x
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, "latin1"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** Header-only PNG of the requested pixel size (the raster path reads IHDR and chunks only). */
function fakePng(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1])), chunk("IEND", Buffer.alloc(0))])
}
/** Fake render bridge (no Electron): answers hello and png at once, recording each op and its per-op limit. */
function fakeBridge(seen: S[] = []) {
  return async (req: S, opts?: { timeoutMs?: number }) => {
    seen.push({ op: req.op, timeoutMs: opts?.timeoutMs })
    if (req.op === "hello") return HELLO
    if (req.op === "png") {
      writeFileSync(String(req.dst), fakePng(Number(req.width), Number(req.height)))
      return { ok: true, electron: "42.3.3", dst: req.dst, width: req.width, height: req.height }
    }
    return { ok: false, code: "UNKNOWN_OP", message: "?" }
  }
}
const spec = (family: string, extra: S, width = 166): S => ({ $schema: "studio.diagram/v1", family, id: "9.1", title: "Uji sintetis.", classification: "BIASA", width_mm: width, apparatus: "page", labels_verified: true, sources: ["Uji sintetis"], ...extra })

describe("rel127 VERIFY M-04: raster limit for a label-heavy figure", () => {
  afterEach(() => runtime.setRenderBridgeTransport(null))
  test("graph with 20 labelled nodes and 19 labelled edges: the png op reaches the bridge with a limit above 30000 ms", async () => {
    const n = 20
    const s = spec("graph", {
      nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `Simpul ${i}`, sub: `rinci ${i}`, class: { col: i % 5, row: Math.floor(i / 5) } })),
      edges: Array.from({ length: n - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, kind: "data", label: `e${i}` })),
    })
    let svg: string
    try {
      svg = build.buildDiagramSvg(structuredClone(s), { release: true }).svg
    } catch {
      svg = build.buildDiagramSvgRaw(structuredClone(s), { release: false }).svg
    }
    expect((svg.match(/<text\b/g) ?? []).length).toBeGreaterThan(40)
    const seen: S[] = []
    runtime.setRenderBridgeTransport(fakeBridge(seen))
    await browser.rasterizeSvg(svg, { widthMm: 166, heightMm: 80, dpi: 300 })
    const op = seen.find((x) => x.op === "png")
    console.log(`[rel127-verify] M-04 png op timeoutMs ${op?.timeoutMs ?? null}`)
    expect(op?.timeoutMs ?? 0).toBeGreaterThan(30000)
  }, 60_000)
})
