// Swarm 1.2.7 row 45 (N7-114, CHAR-VERIFY): regression test committed from the row 9 engine probe
// ($T/test/probes/datum-studio/probe9_engine.test.ts). Must pass at BASE 04067a9d02 and at HEAD; no code change for
// this item. Synthetic inputs only: every figure and chart below is built in-test from filler words.
// AC-T15 (01_specs §4): one defective figure gives a partial render: the good figure is drawn, the defective one
// carries FIGURE_PREPARE_FAILED and the job records exactly one error (no silent placeholder). Fake bridge raster.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"

type S = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const L = path.join(PKG, "vendor", "src", "lib", "studio")
const runtime = await import(path.join(L, "engine", "browser", "runtime.ts"))
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

describe("rel127 VERIFY T-15: partial render", () => {
  afterEach(() => runtime.setRenderBridgeTransport(null))
  test("two charts, the second over capacity: the first is built, the second carries FIGURE_PREPARE_FAILED, the job records the error", async () => {
    const { buildFigures } = await import(path.join(L, "services", "render", "figures.ts"))
    const { InlineSpecReader, createDetachedJob } = await import(path.join(L, "services", "render", "pure", "job.ts"))
    runtime.setRenderBridgeTransport(fakeBridge())
    const job = createDetachedJob(["DOCX"])
    const blocks = [
      { blockId: "b1", type: "chart", content: { spec: { artifactId: "ok-1" } }, address: "2.1.1", unitKey: "2" },
      { blockId: "b2", type: "chart", content: { spec: { artifactId: "bad-1" } }, address: "2.1.2", unitKey: "2" },
    ]
    const snapshot = { doc: { meta: { issueDate: "2026-11-13", tier: "NOTA" } }, numbering: { b1: "Gambar 2.1", b2: "Gambar 2.2" }, blocks } as never
    const good = { $schema: "studio.chart/v1", kind: "P-01", title: "t", source: "s", widthMm: 128, unit: "ton", data: { shape: "categorical", points: [{ label: "Alfa", value: 4 }, { label: "Bravo", value: 3 }, { label: "Charlie", value: 2 }, { label: "Delta", value: 1 }] } }
    const bad = { $schema: "studio.chart/v1", kind: "P-02", title: "t", source: "s", widthMm: 166, data: { shape: "categorical", points: Array.from({ length: 4000 }, (_, i) => ({ label: `Q${i}`, value: i + 1 })) } }
    const r = await buildFigures({ snapshot, tpl: { params: {} } as never, tier: "NOTA", job: job as never, reader: new InlineSpecReader({ "ok-1": { kind: "CHART", spec: good }, "bad-1": { kind: "CHART", spec: bad } }) })
    const okEntry = r.store.get("Gambar 2.1") as S | undefined
    const badEntry = r.store.get("Gambar 2.2") as S | undefined
    expect(job.errors.length).toBe(1)
    expect(okEntry).toBeDefined()
    expect(okEntry?.failed).toBeUndefined()
    expect(Boolean(okEntry?.svg)).toBe(true)
    expect(badEntry?.failed?.code).toBe("FIGURE_PREPARE_FAILED")
  }, 60_000)
})
