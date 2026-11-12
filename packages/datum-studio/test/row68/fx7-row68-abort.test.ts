// 1.2.6 row FX-7 item b (C19f, M3 S1 + N4 + N5; follow-up of row 68 / T-15): the whole render job is aborted by the
// job's own aborted/timeout state, never by a figure's RENDER_TIMEOUT error code. A figure whose browser operation runs
// past its own limit becomes a FIGURE_PREPARE_FAILED placeholder; the other figures still render and the job is
// PARTIAL. A dead render bridge is tried once per job: after the first handshake failure the remaining figures are
// marked failed without another handshake. The job error of a raster failure names the figure (N5), and a marker in
// the prepared store does not hide a good fallback entry (N4).
// Pure local: stub bridge transport (engine/browser setRenderBridgeTransport), no Electron.
import { afterEach, describe, expect, test } from "bun:test"
import type { NormBlock } from "../../vendor/src/lib/studio/contract"
import { useStudioEnv } from "../ported/_env"

useStudioEnv()
const runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")
const { buildFigures } = await import("../../vendor/src/lib/studio/services/render/figures")
const { InlineSpecReader, createDetachedJob } = await import("../../vendor/src/lib/studio/services/render/pure/job")

const HELLO = { ok: true, sandbox: true, contextIsolation: true, nodeIntegration: false, electron: "stub", chrome: "stub" }
const LABELS = ["Gambar 6.1", "Gambar 6.2", "Gambar 6.3"]

function fixture() {
  const blocks = LABELS.map((_, i) => ({ blockId: `b${i + 1}`, type: "chart", content: { spec: { artifactId: `art-${i + 1}` } }, address: `6.1.${i + 1}`, unitKey: "6" })) as unknown as NormBlock[]
  const numbering = Object.fromEntries(LABELS.map((l, i) => [`b${i + 1}`, l]))
  const snapshot = { doc: { meta: { issueDate: "2026-11-12", tier: "NOTA" } }, numbering, blocks } as never
  const spec = (n: number) => ({ $schema: "studio.chart/v1", kind: "P-02", title: `t${n}`, source: "s", widthMm: 166, data: { shape: "categorical", points: [{ label: "A", value: 1 }, { label: "B", value: 2 }, { label: "C", value: 3 }] } })
  const reader = new InlineSpecReader(Object.fromEntries(LABELS.map((_, i) => [`art-${i + 1}`, { kind: "CHART", spec: spec(i + 1) }])))
  return { snapshot, reader }
}

type Marker = { failed?: { code: string; causeCode?: string; message: string }; png?: Uint8Array }

afterEach(() => runtime.setRenderBridgeTransport(null))

describe("FX-7 b (C19f): job abort comes from job state, not from a figure's RENDER_TIMEOUT", () => {
  test("a per-figure browser timeout (job not aborted) gives a placeholder per figure, the job continues PARTIAL", async () => {
    runtime.setRenderBridgeTransport(async (req) => (req.op === "hello" ? HELLO : { ok: false, code: "RENDER_TIMEOUT", message: "stub: page op exceeded its limit" }))
    const job = createDetachedJob(["DOCX"])
    const { snapshot, reader } = fixture()
    const r = await buildFigures({ snapshot, tpl: { params: {} } as never, tier: "NOTA", job: job as never, reader })
    expect(job.aborted).toBe(false)
    for (const l of LABELS) {
      const e = r.store.get(l) as Marker | undefined
      expect([l, e?.failed?.code, e?.failed?.causeCode]).toEqual([l, "FIGURE_PREPARE_FAILED", "RENDER_TIMEOUT"])
    }
    // N5: one job error per figure, and each names its figure.
    expect(job.errors.length).toBe(3)
    for (const l of LABELS) expect(job.errors.some((e) => String(e.message).includes(l))).toBe(true)
  }, 60_000)

  test("when the job itself is aborted, buildFigures stops with RENDER_TIMEOUT (whole-job abort kept)", async () => {
    const job = createDetachedJob(["DOCX"])
    runtime.setRenderBridgeTransport(async (req) => {
      if (req.op === "hello") return HELLO
      job.aborted = true // the job's timer fired while the first figure was in the bridge
      return { ok: false, code: "RENDER_FAILED", message: "stub" }
    })
    const { snapshot, reader } = fixture()
    let code: unknown
    await buildFigures({ snapshot, tpl: { params: {} } as never, tier: "NOTA", job: job as never, reader }).catch((e) => (code = (e as { code?: unknown }).code))
    expect(code).toBe("RENDER_TIMEOUT")
  }, 60_000)

  test("a dead render bridge is handshaken once per job; the remaining figures are marked without another try", async () => {
    let hellos = 0
    runtime.setRenderBridgeTransport(async (req, o) => {
      if (req.op === "hello") hellos++
      const saved = process.env[runtime.RENDER_SOCKET_ENV]
      delete process.env[runtime.RENDER_SOCKET_ENV] // socket transport: not configured -> connect-class failure
      try {
        return await runtime.socketTransport(req, o)
      } finally {
        if (saved !== undefined) process.env[runtime.RENDER_SOCKET_ENV] = saved
      }
    })
    const job = createDetachedJob(["DOCX"])
    const { snapshot, reader } = fixture()
    const r = await buildFigures({ snapshot, tpl: { params: {} } as never, tier: "NOTA", job: job as never, reader })
    expect(hellos).toBe(1)
    for (const l of LABELS) {
      const e = r.store.get(l) as Marker | undefined
      expect([l, e?.failed?.code, e?.failed?.causeCode]).toEqual([l, "FIGURE_PREPARE_FAILED", "BROWSER_UNAVAILABLE"])
    }
    expect(job.errors.length).toBe(3)
  }, 60_000)
})

describe("FX-7 b (M3 N4): a FIGURE_PREPARE_FAILED marker does not hide a good fallback entry", () => {
  test("assembleDocx with svgFor + ctx.figures: the fallback PNG is used for a figure whose preparation failed", async () => {
    const R = await import("../ported/renderers/_kit")
    const { assembleDocxDetailed } = await import("../../vendor/src/lib/studio/engine/docx/assemble")
    const tpl = await R.fixtureTemplate("doc_serah_handover")
    const snap = R.snapshotOf(R.loadFixtureDoc("doc_serah_handover"))
    const figs = snap.blocks.filter((b) => ["chart", "diagram", "symbolSheet"].includes(b.type))
    const failing = figs[1]
    const key = snap.numbering[failing.blockId] ?? failing.artifactLabel ?? failing.blockId
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="166mm" height="60mm" viewBox="0 0 166 60"><rect x="1" y="1" width="164" height="58" fill="none" stroke="#000"/></svg>`
    const svgFor = async (b: NormBlock) => {
      if (b.blockId === failing.blockId) throw new Error("stub: prepare failed")
      return { svg, widthMm: 166, heightMm: 60 }
    }
    const fallback = { get: (l: string) => (l === key ? { svg, png: R.STUB_FIG.png, widthMm: 166, heightMm: 60 } : undefined) }
    const { ctx } = R.makeCtx(snap, tpl, { figures: fallback })
    const { bytes } = await assembleDocxDetailed(ctx, { svgFor, rasterize: async () => R.STUB_FIG.png, figureTypes: ["chart", "diagram", "symbolSheet"] })
    const doc = new TextDecoder().decode(R.unzip(bytes)["word/document.xml"])
    expect(doc.includes("FIGURE_PREPARE_FAILED")).toBe(false)
    const names = [...doc.matchAll(/<wp:docPr id="\d+" name="([^"]*)"/g)].map((m) => m[1])
    expect(names.filter((n) => n.startsWith(`${key} `)).length).toBe(1)
  }, 60_000)
})
