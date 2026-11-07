// Row 151 (decision U24 A, C130): the OVERLAP_CLIP check (spec masterplan/01_specs_output_verification.md §3.2) through
// a render-bridge stub. The default deps run unchanged: the vendored measureLayout page twin and the direct
// checkPage call go through the real runtime (bridgeCall, withLock, the sandbox handshake) to a stub transport
// (`setRenderBridgeTransport`, as rows 67/68/70/108), because Electron cannot run under bun. What the two page scripts
// really measure is proven against real Electron 42 in packages/desktop/test/datum-render-electron/row151-check-page.test.ts.
// Broken cases B1 (overlap), B2 (clipped bottom), B3 (clipped right / box clip) and B10 (unmeasurable = UNKNOWN).
import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { useStudioEnv } from "../ported/_env"
import * as runtime from "../../vendor/src/lib/studio/engine/browser/runtime"
import { MEASURE_SCRIPT } from "../../vendor/src/lib/studio/engine/browser/measure"
import { StudioEngineError } from "../../vendor/src/lib/studio/contract/errors"
import {
  measureFindings,
  OVERLAP_CLIP_CODES,
  OVERLAP_SCRIPT,
  OVERLAP_SCRIPT_NAME,
  overlapCall,
  parseOverlapResult,
  runOverlapClip,
  unknownReasonFor,
} from "../../src/mcp-host/verify/overlap-clip"
import { OVERLAP_DEFAULT_ARGS } from "../../src/mcp-host/verify/overlap-script"
import { VERIFY_FINDINGS_CAP } from "../../src/mcp-host/verify/types"

useStudioEnv()

const GOOD_INFO = { electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 16, scripts: ["studio.measure", OVERLAP_SCRIPT_NAME] }

type Req = Record<string, unknown>
/** Bridge stub: answers hello, checkPage per script (measure / overlap), and pdf (flow page count, 3 pages). */
function stubBridge(o: { measure?: unknown; overlap?: unknown; fail?: Partial<Record<string, { code: string }>>; down?: boolean } = {}) {
  const seen: Req[] = []
  runtime.setRenderBridgeTransport(async (req) => {
    seen.push({ ...req })
    if (o.down) throw new Error("connect ENOENT /no/bridge.sock")
    if (req.op === "hello") return { ok: true, ...GOOD_INFO }
    if (req.op === "pdf") {
      writeFileSync(String(req.dst), Buffer.from("%PDF-1.4\n1 0 obj<</Type /Pages /Count 3>>endobj\n%%EOF\n", "latin1"))
      return { ok: true, electron: "42.3.3", dst: req.dst }
    }
    if (req.op === "checkPage") {
      const which = req.script === MEASURE_SCRIPT ? "measure" : req.script === OVERLAP_SCRIPT ? "overlap" : "other"
      const f = o.fail?.[which]
      if (f) return { ok: false, code: f.code, message: "stub" }
      if (which === "measure") return { ok: true, script: "studio.measure", result: o.measure }
      if (which === "overlap") return { ok: true, script: OVERLAP_SCRIPT_NAME, result: o.overlap }
      return { ok: false, code: "SCRIPT_NOT_ALLOWED" }
    }
    return { ok: false, code: "BAD_REQUEST" }
  })
  return seen
}
afterEach(() => runtime.setRenderBridgeTransport(null))

// ── fixtures: what the two scripts return (shapes of measure.ts:252 and overlap-script.ts) ─────

const page = (n: number) => ({ kind: "page", page: n, xMm: 0, yMm: (n - 1) * 297, widthMm: 210, heightMm: 297, colors: ["#101418"], label: "page", overflow: false })
const text = (n: number, address: string) => ({ kind: "text", page: n, xMm: 24, yMm: 30, widthMm: 160, heightMm: 5, address, tag: "p", label: "st-p", fontSizePt: 10, measureMm: 160, lineCount: 1, charCount: 40, charsPerLine: 40, maxLineWidthMm: 120 })
const MEASURE_CLEAN = { paged: true, pageCount: 2, truncated: false, elements: [page(1), page(2), text(1, "1.1/p1"), text(2, "1.2/p1")] }
const OVERLAP_CLEAN = { paged: true, pageCount: 2, truncated: false, marginsUnreadable: false, contentHeightMm: null, boxes: 42, findingsTotal: 0, findings: [] }

const HTML = "<!doctype html><html><head><style>@page{size:A4;margin:0}</style></head><body><div class=\"page\"><p data-address=\"1.1/p1\">a</p></div></body></html>"
const A4 = { pageWidthMm: 210, pageHeightMm: 297 }

describe("row 151 OVERLAP_CLIP: clean page passes", () => {
  it("a clean paged HTML gives PASS, hands the measured layout to row 150 and spends 2 bridge jobs", async () => {
    const seen = stubBridge({ measure: MEASURE_CLEAN, overlap: OVERLAP_CLEAN })
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 })
    expect(r.check).toMatchObject({ id: "OVERLAP_CLIP", status: "PASS", basis: "self", reason: null, findings: [], truncated: 0 })
    expect(r.bridgeJobs).toBe(2)
    expect(r.layout).toEqual({ metrics: { pageCount: 2, paged: true, pageCountSource: "elements", truncated: false, elements: MEASURE_CLEAN.elements as never } })
    expect(r.overlap?.boxes).toBe(42)
    // The overlap request: fixed script text, the spec §3.2 argument, sheet-sized viewport, the HTML itself.
    const ov = seen.find((q) => q.op === "checkPage" && q.script === OVERLAP_SCRIPT)!
    expect(ov).toMatchObject({ html: HTML, wMm: 210, hMm: 297, viewportWidth: 794, viewportHeight: 1123 })
    expect(ov.arg).toEqual({ pageWidthMm: 210, pageHeightMm: 297, maxBoxes: 5000, minAreaMm2: 1, minFrac: 0.1 })
    // Handshake first, then the measure twin's checkPage, then the overlap checkPage; nothing else.
    expect(seen.map((q) => (q.op === "checkPage" ? (q.script === MEASURE_SCRIPT ? "measure" : "overlap") : q.op))).toEqual(["hello", "measure", "overlap"])
  })

  it("a PDF is checked through its same-job HTML (basis same-job-html)", async () => {
    stubBridge({ measure: MEASURE_CLEAN, overlap: OVERLAP_CLEAN })
    const r = await runOverlapClip({ format: "PDF", html: HTML, ...A4 })
    expect(r.check.status).toBe("PASS")
    expect(r.check.basis).toBe("same-job-html")
  })

  it("a flow document measures its print page count too (3 bridge jobs: measure, print, overlap)", async () => {
    stubBridge({ measure: { paged: false, pageCount: 0, truncated: false, elements: [{ kind: "document", xMm: 0, yMm: 0, widthMm: 210, heightMm: 900, colors: [], overflow: false }] }, overlap: { ...OVERLAP_CLEAN, paged: false, pageCount: 0, contentHeightMm: 247 } })
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 })
    expect(r.check.status).toBe("PASS")
    expect(r.bridgeJobs).toBe(3)
    expect(r.layout && "metrics" in r.layout ? r.layout.metrics.pageCount : -1).toBe(3)
    expect(r.layout && "metrics" in r.layout ? r.layout.metrics.pageCountSource : "").toBe("print")
  })
})

describe("row 151 OVERLAP_CLIP: broken cases B1-B3 are detected with page and element", () => {
  it("B1 overlap: two blocks overlapping on sheet 2 give OVERLAP with the page, both addresses and the area", async () => {
    const overlap = {
      ...OVERLAP_CLEAN,
      findingsTotal: 1,
      findings: [{ code: "OVERLAP", page: 2, address: "2.1/fig1", label: "st-figure", kind: "svg", address2: "2.1/p3", label2: "st-p", kind2: "text", areaMm2: 412.5, frac: 0.86 }],
    }
    stubBridge({ measure: MEASURE_CLEAN, overlap })
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 })
    expect(r.check.status).toBe("FAIL")
    expect(r.check.findings).toHaveLength(1)
    const f = r.check.findings[0]
    expect(f).toMatchObject({ code: "OVERLAP", page: 2, address: "2.1/fig1", label: "st-figure", amount: 412.5 })
    expect(f.detail).toContain("2.1/p3")
    expect(f.detail).toContain("st-p")
  })

  it("B2 clipped page (bottom): content past the sheet's bottom edge gives OVERFLOW_BOTTOM with sheet number and mm", async () => {
    const over = { kind: "overflow", overflow: true, axis: "bottom", overflowMm: 103.4, page: 1, xMm: 24, yMm: 30, widthMm: 160, heightMm: 400, address: "1.2/t1", label: "st-table", tag: "table" }
    stubBridge({ measure: { ...MEASURE_CLEAN, elements: [...MEASURE_CLEAN.elements, over] }, overlap: OVERLAP_CLEAN })
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 })
    expect(r.check.status).toBe("FAIL")
    expect(r.check.findings).toEqual([{ code: "OVERFLOW_BOTTOM", page: 1, address: "1.2/t1", label: "st-table", detail: expect.stringContaining("103.4 mm past the bottom edge"), amount: 103.4 }])
  })

  it("B2 flow layout: an unbreakable row taller than the page content height gives UNBREAKABLE_TOO_TALL", async () => {
    const overlap = { ...OVERLAP_CLEAN, paged: false, pageCount: 0, contentHeightMm: 247, findingsTotal: 1, findings: [{ code: "UNBREAKABLE_TOO_TALL", page: null, address: "3.1/t2", label: "st-row", kind: "tr", heightMm: 402.1, limitMm: 247, overMm: 155.1 }] }
    stubBridge({ measure: { paged: false, pageCount: 0, truncated: false, elements: [{ kind: "document", xMm: 0, yMm: 0, widthMm: 210, heightMm: 900, colors: [], overflow: false }] }, overlap })
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 })
    expect(r.check.status).toBe("FAIL")
    expect(r.check.findings[0]).toMatchObject({ code: "UNBREAKABLE_TOO_TALL", page: null, address: "3.1/t2", amount: 155.1 })
  })

  it("B3 clipped right / box clip / table overflow: each measured defect has its own code", async () => {
    const els = [
      ...MEASURE_CLEAN.elements,
      { kind: "overflow", overflow: true, axis: "right", overflowMm: 41.2, page: 2, xMm: 24, yMm: 50, widthMm: 210, heightMm: 5, address: "2.3/p1", label: "st-p", tag: "p" },
      { kind: "clip", overflow: true, axis: "right", overflowMm: 77.7, page: 2, xMm: 30, yMm: 60, widthMm: 40, heightMm: 5, address: "2.3/t1", label: "st-cell", tag: "td" },
      { kind: "table", overflow: true, page: 2, xMm: 24, yMm: 70, widthMm: 230, heightMm: 30, address: "2.3/t1", label: "st-table-grid", tag: "table" },
    ]
    stubBridge({ measure: { ...MEASURE_CLEAN, elements: els }, overlap: OVERLAP_CLEAN })
    const r = await runOverlapClip({ format: "PDF", html: HTML, ...A4 })
    expect(r.check.status).toBe("FAIL")
    expect(r.check.findings.map((f) => [f.code, f.page, f.address])).toEqual([
      ["OVERFLOW_RIGHT", 2, "2.3/p1"],
      ["BOX_CLIP", 2, "2.3/t1"],
      ["TABLE_OVERFLOW", 2, "2.3/t1"],
    ])
    for (const f of r.check.findings) expect(OVERLAP_CLIP_CODES as readonly string[]).toContain(f.code)
  })

  it("findings are capped at VERIFY_FINDINGS_CAP; the rest (and the script's unlisted ones) are counted in truncated", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ code: "OVERLAP", page: 1, address: `a${i}`, label: "x", address2: `b${i}`, label2: "y", areaMm2: 5 }))
    stubBridge({ measure: MEASURE_CLEAN, overlap: { ...OVERLAP_CLEAN, findingsTotal: 75, findings: many } })
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 })
    expect(r.check.findings).toHaveLength(VERIFY_FINDINGS_CAP)
    expect(r.check.truncated).toBe(75 - VERIFY_FINDINGS_CAP)
  })

  it("document-derived labels and addresses are cut (untrusted)", async () => {
    stubBridge({ measure: MEASURE_CLEAN, overlap: { ...OVERLAP_CLEAN, findingsTotal: 1, findings: [{ code: "OVERLAP", page: 1, address: "A".repeat(5000), label: "L".repeat(5000), address2: "B", label2: "C", areaMm2: 9 }] } })
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 })
    expect(r.check.findings[0].address!.length).toBeLessThanOrEqual(200)
    expect(r.check.findings[0].label!.length).toBeLessThanOrEqual(200)
  })
})

describe("row 151 OVERLAP_CLIP: unmeasurable is UNKNOWN, never PASS (B10)", () => {
  it("no reachable bridge: UNKNOWN BRIDGE_UNAVAILABLE, layout unknown too", async () => {
    stubBridge({ down: true })
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 })
    expect(r.check).toMatchObject({ status: "UNKNOWN", reason: "BRIDGE_UNAVAILABLE", findings: [] })
    expect(r.layout).toEqual({ unknown: "BRIDGE_UNAVAILABLE" })
  })

  it("the bridge refuses the overlap script (not allow-listed yet, row 152): UNKNOWN BRIDGE_UNAVAILABLE", async () => {
    stubBridge({ measure: MEASURE_CLEAN, fail: { overlap: { code: "SCRIPT_NOT_ALLOWED" } } })
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 })
    expect(r.check).toMatchObject({ status: "UNKNOWN", reason: "BRIDGE_UNAVAILABLE" })
  })

  it("a bridge job timeout: UNKNOWN TIMEOUT; a full queue: UNKNOWN QUEUE_FULL", async () => {
    stubBridge({ measure: MEASURE_CLEAN, fail: { overlap: { code: "RENDER_TIMEOUT" } } })
    expect((await runOverlapClip({ format: "HTML", html: HTML, ...A4 })).check).toMatchObject({ status: "UNKNOWN", reason: "TIMEOUT" })
    const queueFull = async () => {
      throw new StudioEngineError("RENDER_QUEUE_FULL", "Browser render queue is full; retry later")
    }
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 }, { measure: queueFull, checkPage: queueFull })
    expect(r.check).toMatchObject({ status: "UNKNOWN", reason: "QUEUE_FULL" })
  })

  it("truncated measure or overlap: UNKNOWN MEASURE_TRUNCATED", async () => {
    stubBridge({ measure: MEASURE_CLEAN, overlap: { ...OVERLAP_CLEAN, truncated: true } })
    expect((await runOverlapClip({ format: "HTML", html: HTML, ...A4 })).check).toMatchObject({ status: "UNKNOWN", reason: "MEASURE_TRUNCATED" })
    stubBridge({ measure: { ...MEASURE_CLEAN, truncated: true }, overlap: OVERLAP_CLEAN })
    expect((await runOverlapClip({ format: "HTML", html: HTML, ...A4 })).check).toMatchObject({ status: "UNKNOWN", reason: "MEASURE_TRUNCATED" })
  })

  it("@page margins unreadable in flow layout: UNKNOWN MARGINS_UNREADABLE", async () => {
    stubBridge({ measure: MEASURE_CLEAN, overlap: { ...OVERLAP_CLEAN, paged: false, marginsUnreadable: true } })
    expect((await runOverlapClip({ format: "HTML", html: HTML, ...A4 })).check).toMatchObject({ status: "UNKNOWN", reason: "MARGINS_UNREADABLE" })
  })

  it("a script value of the wrong shape: UNKNOWN VERIFY_INTERNAL", async () => {
    stubBridge({ measure: MEASURE_CLEAN, overlap: { findings: "nope" } })
    expect((await runOverlapClip({ format: "HTML", html: HTML, ...A4 })).check).toMatchObject({ status: "UNKNOWN", reason: "VERIFY_INTERNAL" })
    expect(parseOverlapResult(null)).toBeNull()
    expect(parseOverlapResult({ paged: true, truncated: false, findings: [{ code: "SOMETHING_ELSE" }] })).toBeNull()
  })

  it("no same-job HTML: UNKNOWN SOURCE_MISSING with 0 bridge jobs", async () => {
    const seen = stubBridge({ measure: MEASURE_CLEAN, overlap: OVERLAP_CLEAN })
    const r = await runOverlapClip({ format: "PDF", html: null, ...A4 })
    expect(r.check).toMatchObject({ status: "UNKNOWN", reason: "SOURCE_MISSING", basis: "same-job-html" })
    expect(r.bridgeJobs).toBe(0)
    expect(seen).toHaveLength(0)
  })

  it("a definite defect outranks an UNKNOWN from the other script (FAIL, findings kept)", async () => {
    stubBridge({ measure: MEASURE_CLEAN, overlap: { ...OVERLAP_CLEAN, truncated: true, findingsTotal: 1, findings: [{ code: "OVERLAP", page: 1, address: "a", label: "x", address2: "b", label2: "y", areaMm2: 3 }] } })
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 })
    expect(r.check).toMatchObject({ status: "FAIL", reason: null })
  })

  it("DOCX, SVG and PNG are NOT_APPLICABLE (fixed matrix §3.7) and spend no bridge job", async () => {
    const seen = stubBridge({})
    for (const format of ["DOCX", "SVG", "PNG"] as const) {
      const r = await runOverlapClip({ format, html: HTML, ...A4 })
      expect(r.check.status).toBe("NOT_APPLICABLE")
      expect(r.bridgeJobs).toBe(0)
    }
    expect(seen).toHaveLength(0)
  })

  it("error mapping: StudioEngineError codes vs our own bugs", () => {
    expect(unknownReasonFor(new StudioEngineError("BROWSER_UNAVAILABLE", "x"))).toBe("BRIDGE_UNAVAILABLE")
    expect(unknownReasonFor(new StudioEngineError("RENDER_TIMEOUT", "x"))).toBe("TIMEOUT")
    expect(unknownReasonFor(new StudioEngineError("RENDER_QUEUE_FULL", "x"))).toBe("QUEUE_FULL")
    expect(unknownReasonFor(new TypeError("x"))).toBe("VERIFY_INTERNAL")
  })

  it("measureFindings: a measure with no page/document element (DATUM-37 NOT_RUN) is UNKNOWN, not PASS", () => {
    expect(measureFindings({ elements: [], truncated: false, pageCount: 0, paged: false }).unknown).toBe("VERIFY_INTERNAL")
  })
})

describe("row 151 page script swarm.verify.overlap: fixed text for the allow-list", () => {
  const src = readFileSync(path.join(import.meta.dir, "../../src/mcp-host/verify/overlap-script.ts"), "utf8")
  it("the script module has no imports (desktop main imports it like MEASURE_SCRIPT, start.ts:12)", () => {
    expect(src).not.toMatch(/^\s*import\s/m)
    expect(src).not.toMatch(/\brequire\(/)
  })
  it("the text is one function expression that compiles and is under the bridge script cap (256 KiB)", () => {
    expect(OVERLAP_SCRIPT.startsWith("(function (o) {")).toBe(true)
    expect(OVERLAP_SCRIPT.endsWith("})")).toBe(true)
    expect(typeof new Function(`return ${OVERLAP_SCRIPT}`)()).toBe("function")
    expect(Buffer.byteLength(OVERLAP_SCRIPT)).toBeLessThan(256 * 1024)
  })
  it("the script name and default argument are the spec's", () => {
    expect(OVERLAP_SCRIPT_NAME).toBe("swarm.verify.overlap")
    expect(OVERLAP_DEFAULT_ARGS).toEqual({ maxBoxes: 5000, minAreaMm2: 1, minFrac: 0.1 })
    expect(overlapCall("<p>x</p>", 148, 210).arg).toEqual({ pageWidthMm: 148, pageHeightMm: 210, maxBoxes: 5000, minAreaMm2: 1, minFrac: 0.1 })
  })
})
