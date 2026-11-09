/**
 * Row 151 (decision U24 A, C130; spec masterplan/01_specs_output_verification.md §3.2): the OVERLAP_CLIP check, the
 * host-side caller of two fixed page scripts run by the render bridge's `checkPage` op on the stored HTML output
 * (basis `self`) or, for a PDF, on the same render job's HTML (basis `same-job-html`, spec §3.7 and D-3).
 *
 * 1. `studio.measure` through the vendored `measureLayout` (V/engine/browser/index.ts:389; the page twin maps
 *    MEASURE_SCRIPT onto checkPage, runtime.ts:446). Its elements go through `lintRenderedWith` (V/engine/lint/render/
 *    index.ts:544) and only DATUM-37 (check37 :475) decides the sheet overflow: FAIL items are reported as
 *    OVERFLOW_BOTTOM / OVERFLOW_RIGHT with page, address and mm from the same `overflow` elements check37 reads.
 *    Measure `clip` elements (measure.ts:169) are BOX_CLIP, `table` elements with `overflow: true` (:248)
 *    TABLE_OVERFLOW. `truncated` (:252) makes the check UNKNOWN (MEASURE_TRUNCATED).
 * 2. `swarm.verify.overlap` (./overlap-script.ts) called directly with `bridgeCall("checkPage", ...)`
 *    (runtime.ts:209) inside `withLock` (runtime.ts:337) after the sandbox handshake (`ensureBrowser`).
 *
 * Rule: FAIL if either script gives a finding; else UNKNOWN if either could not run (bridge error: BRIDGE_UNAVAILABLE,
 * RENDER_QUEUE_FULL -> QUEUE_FULL, RENDER_TIMEOUT -> TIMEOUT), was truncated (MEASURE_TRUNCATED) or could not read the
 * @page margins (MARGINS_UNREADABLE); else PASS. A FAIL outranks an UNKNOWN (row 150 rule): a definite defect is
 * reported even when the other script could not run. UNKNOWN never counts as a pass.
 * Row 205 (1.2.3, HB-1): the bridge hides scrollbars (electron-renderer.ts) so the layout viewport is the sheet width.
 * The overlap script also reports the layout viewport (`viewportPx`, `layoutWidthPx`); in a flow document laid out
 * narrower than the sheet, the measure's right-edge overflows are judged against a width the PDF never uses: those
 * explained by the missing width are dropped and the check is UNKNOWN FLOW_LAYOUT_UNMEASURABLE (never PASS); a larger
 * overflow still FAILs. Flow findings carry page null by limit L-1 (the screen measure has no printed page boundaries),
 * and their detail says so.
 * Row 151c (C161 L1): an overlap answer with 0 ink boxes for a document that has ink (host-side read of the HTML,
 * or the measured text) is UNKNOWN VERIFY_INTERNAL, never PASS; the script's `{ untrusted }` answer is not the
 * result shape and is UNKNOWN VERIFY_INTERNAL too.
 *
 * The measured layout is handed back as row 150's `LayoutInput` (static-checks.ts:80), so PAGE_COUNT and FIGURE_FIT
 * reuse this one measure instead of a second bridge job. Both bridge calls are injectable (`OverlapClipDeps`) so
 * tests run through a bridge stub; the defaults talk to the real bridge over DATUM_RENDER_SOCKET.
 * Document-derived strings (labels, addresses) are untrusted and cut by `clip` (html-scan.ts:27).
 */
import {
  measureLayout,
  type MeasuredElement,
  type MeasuredLayout,
  type MeasureOptions,
} from "../../../vendor/src/lib/studio/engine/browser/index"
import { bridgeCall, ensureBrowser, withLock } from "../../../vendor/src/lib/studio/engine/browser/runtime"
import { FLOW_LAYOUT_UNMEASURABLE_NOTE, lintRenderedWith, RENDER_LINT_DEFAULTS, type RenderLintLimits } from "../../../vendor/src/lib/studio/engine/lint/render/index"
import { StudioEngineError } from "../../../vendor/src/lib/studio/contract/errors"
import { clip, stripNonMarkup } from "./html-scan.ts"
import { notApplicableCheck, type LayoutInput, type VerifyFormat } from "./static-checks.ts"
import { OVERLAP_SCRIPT, OVERLAP_SCRIPT_NAME, overlapArgs, type OverlapScriptArgs } from "./overlap-script.ts"
import { VERIFY_FINDINGS_CAP, type VerifyBasis, type VerifyCheck, type VerifyFinding, type VerifyUnknownReason } from "./types.ts"

export { OVERLAP_SCRIPT, OVERLAP_SCRIPT_NAME }

const PX_PER_MM = 96 / 25.4

export const OVERLAP_CLIP_CODES = ["OVERLAP", "OVERFLOW_BOTTOM", "OVERFLOW_RIGHT", "BOX_CLIP", "TABLE_OVERFLOW", "UNBREAKABLE_TOO_TALL"] as const

/** One finding as the overlap script returns it (overlap-script.ts, step 2 and 3). */
export interface OverlapScriptFinding {
  code: "OVERLAP" | "UNBREAKABLE_TOO_TALL"
  page: number | null
  address: string | null
  label: string | null
  kind?: string
  address2?: string | null
  label2?: string | null
  kind2?: string
  areaMm2?: number
  frac?: number
  heightMm?: number
  limitMm?: number
  overMm?: number
}

export interface OverlapScriptResult {
  paged: boolean
  pageCount: number
  truncated: boolean
  marginsUnreadable: boolean
  contentHeightMm: number | null
  boxes: number
  /** Row 151c: elements the script looked at (outside SVG content); 0 when an older script text answered. */
  scanned: number
  findingsTotal: number
  findings: OverlapScriptFinding[]
  /** Row 205: window.innerWidth and documentElement.clientWidth in CSS px; null when an older script text answered. */
  viewportPx: number | null
  layoutWidthPx: number | null
}

/** The checkPage request the host sends for `swarm.verify.overlap` (bridge protocol.ts:25). */
export interface OverlapCheckPageCall {
  op: "checkPage"
  html: string
  wMm: number
  hMm: number
  script: string
  arg: OverlapScriptArgs
  viewportWidth: number
  viewportHeight: number
}

export interface OverlapClipDeps {
  /** Default: vendored `measureLayout` (studio.measure through the bridge). */
  measure?: (html: string, opts: MeasureOptions) => Promise<MeasuredLayout>
  /** Default: `withLock` + `ensureBrowser` + `bridgeCall(...).result`. Returns the script's value. */
  checkPage?: (call: OverlapCheckPageCall) => Promise<unknown>
}

export interface OverlapClipInput {
  format: VerifyFormat
  /** The HTML output text (format HTML) or the same render job's HTML (format PDF); null = no such HTML. */
  html: string | null
  pageWidthMm: number
  pageHeightMm: number
  /** `renderLintLimitsFor(log, tpl.params)` (V/services/render/lint.ts:88) of the revision's template version. */
  limits?: RenderLintLimits
  /** Overrides of the spec §3.2 argument (tests and tuning only; row 151 report lists any change). */
  overlapArgs?: Partial<OverlapScriptArgs>
}

export interface OverlapClipResult {
  check: VerifyCheck
  /** Row 150 LayoutInput: the studio.measure metrics, or why there are none; null when there was no HTML. */
  layout: LayoutInput
  overlap: OverlapScriptResult | null
  /** Bridge jobs spent: measure (1, +1 print job for a flow page count) and overlap (1). */
  bridgeJobs: number
}

// ── bridge defaults ──────────────────────────────────────────────────────

/** Direct bridge call for the overlap script (no page twin: it maps only MEASURE_SCRIPT, runtime.ts:446). */
export async function bridgeCheckPage(call: OverlapCheckPageCall): Promise<unknown> {
  return withLock(async () => {
    await ensureBrowser()
    const r = await bridgeCall("verifyOverlap", { ...call })
    return r.result
  })
}

export function overlapCall(html: string, pageWidthMm: number, pageHeightMm: number, over?: Partial<OverlapScriptArgs>): OverlapCheckPageCall {
  return {
    op: "checkPage",
    html,
    wMm: pageWidthMm,
    hMm: pageHeightMm,
    script: OVERLAP_SCRIPT,
    arg: overlapArgs(pageWidthMm, pageHeightMm, over),
    // Same viewport as measureLayout (index.ts:394-398): the sheet width and height at 96 dpi.
    viewportWidth: Math.ceil(pageWidthMm * PX_PER_MM),
    viewportHeight: Math.ceil(pageHeightMm * PX_PER_MM),
  }
}

/** Spec §3.2: a bridge error is BRIDGE_UNAVAILABLE, a full queue QUEUE_FULL, a job timeout TIMEOUT; anything else is ours. */
export function unknownReasonFor(e: unknown): VerifyUnknownReason {
  if (e instanceof StudioEngineError) {
    if (e.code === "RENDER_QUEUE_FULL") return "QUEUE_FULL"
    if (e.code === "RENDER_TIMEOUT") return "TIMEOUT"
    return "BRIDGE_UNAVAILABLE"
  }
  return "VERIFY_INTERNAL"
}

// ── check builder (same FAIL-over-UNKNOWN rule as static-checks.ts CheckBuilder) ─────

class Builder {
  private readonly t0 = performance.now()
  private readonly found: VerifyFinding[] = []
  private extra = 0
  private reason: VerifyUnknownReason | null = null
  constructor(private readonly basis: VerifyBasis) {}
  add(f: VerifyFinding) {
    this.found.push(f)
  }
  /** Findings the script counted but did not list (its own cap). */
  uncounted(n: number) {
    if (n > 0) this.extra += n
  }
  unknown(r: VerifyUnknownReason) {
    if (!this.reason) this.reason = r
  }
  build(): VerifyCheck {
    const status = this.found.length > 0 ? "FAIL" : this.reason ? "UNKNOWN" : "PASS"
    return {
      id: "OVERLAP_CLIP",
      status,
      basis: this.basis,
      reason: status === "UNKNOWN" ? this.reason : null,
      findings: this.found.slice(0, VERIFY_FINDINGS_CAP),
      truncated: Math.max(0, this.found.length - VERIFY_FINDINGS_CAP) + this.extra,
      ms: Math.round(performance.now() - this.t0),
    }
  }
}

/** Row 205: why a finding has no page / address, appended to its detail (AC-2: never a silent null). */
export const FLOW_PAGE_NULL_NOTE = "page null by limit L-1: flow layout, the screen measure has no printed page boundaries"
export const ADDRESS_NULL_NOTE = "address null: no data-address on the element or its ancestors"

function finding(code: string, f: { page?: number | null; address?: string | null; label?: string | null; detail: string; amount?: number }): VerifyFinding {
  const page = typeof f.page === "number" && Number.isInteger(f.page) && f.page > 0 ? f.page : null
  const address = clip(f.address ?? null)
  const notes = [page === null ? FLOW_PAGE_NULL_NOTE : null, address === null ? ADDRESS_NULL_NOTE : null].filter(Boolean)
  // The engine text is kept whole; only the document-derived part (label, address) was cut by clip.
  const detail = notes.length ? `${f.detail}; ${notes.join("; ")}` : f.detail
  const out: VerifyFinding = {
    code,
    page,
    address,
    label: clip(f.label ?? null),
    detail: detail.length > 400 ? `${detail.slice(0, 399)}…` : detail,
  }
  if (typeof f.amount === "number" && Number.isFinite(f.amount)) out.amount = Number(f.amount.toFixed(2))
  return out
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)

// ── part 1: studio.measure -> DATUM-37 + clip + table ───────────────────

/** Map measured layout to OVERLAP_CLIP findings. Exported for tests and for row 154's composition. */
export function measureFindings(
  metrics: Pick<MeasuredLayout, "elements" | "truncated" | "pageCount" | "paged">,
  limits: RenderLintLimits = RENDER_LINT_DEFAULTS,
  html?: string,
): { findings: VerifyFinding[]; unknown: VerifyUnknownReason | null } {
  const findings: VerifyFinding[] = []
  let unknown: VerifyUnknownReason | null = null
  const els: MeasuredElement[] = Array.isArray(metrics.elements) ? metrics.elements : []
  // lintRenderedWith reads only metrics for DATUM-37; svgs are FIGURE_FIT's business (row 150).
  const d37 = lintRenderedWith({ html, svgs: [], metrics: metrics as MeasuredLayout }, limits).filter((i) => i.checkId === "DATUM-37")
  if (d37.some((i) => i.status === "FAIL")) {
    const over = els
      .filter((e) => e.kind === "overflow" && num(e.overflowMm) && e.overflowMm > 0)
      .sort((a, b) => (b.overflowMm as number) - (a.overflowMm as number))
    for (const e of over) {
      const axis = e.axis === "bottom" ? "bottom" : "right"
      findings.push(
        finding(axis === "bottom" ? "OVERFLOW_BOTTOM" : "OVERFLOW_RIGHT", {
          page: e.page ?? null,
          address: e.address ?? null,
          label: e.label ?? e.tag ?? null,
          detail: `${e.tag ?? "element"} runs ${(e.overflowMm as number).toFixed(1)} mm past the ${axis} edge of the ${e.page !== undefined ? `sheet` : "flow page width"}`,
          amount: e.overflowMm,
        }),
      )
    }
    // check37's flow-document case: the document is wider than the sheet with no single element named.
    if (over.length === 0) findings.push(finding("OVERFLOW_RIGHT", { detail: "flow document is wider than the sheet (DATUM-37)" }))
  } else if (d37.some((i) => i.status === "NOT_RUN" && typeof i.detail === "string" && i.detail.startsWith(FLOW_LAYOUT_UNMEASURABLE_NOTE))) {
    // Row 206 (1.2.3, P3): the vendored DATUM-37 itself says the flow layout was narrower than the sheet.
    unknown = "FLOW_LAYOUT_UNMEASURABLE"
  } else if (d37.length === 0 || d37.every((i) => i.status === "NOT_RUN")) {
    unknown = metrics.truncated === true ? "MEASURE_TRUNCATED" : "VERIFY_INTERNAL"
  }
  for (const e of els) {
    if (e.kind === "clip") {
      findings.push(
        finding("BOX_CLIP", {
          page: e.page ?? null,
          address: e.address ?? null,
          label: e.label ?? e.tag ?? null,
          detail: `${e.tag ?? "element"} content is ${num(e.overflowMm) ? e.overflowMm.toFixed(1) : "?"} mm wider than its own box`,
          amount: e.overflowMm,
        }),
      )
    } else if (e.kind === "table" && e.overflow === true) {
      findings.push(
        finding("TABLE_OVERFLOW", {
          page: e.page ?? null,
          address: e.address ?? null,
          label: e.label ?? "table",
          detail: `table is wider than its container (${num(e.widthMm) ? e.widthMm.toFixed(1) : "?"} mm)`,
          amount: e.widthMm,
        }),
      )
    }
  }
  if (metrics.truncated === true && !unknown) unknown = "MEASURE_TRUNCATED"
  return { findings, unknown }
}

// ── part 2: swarm.verify.overlap ─────────────────────────────────────────

/** Validate the script value; null = not the shape this script returns (UNKNOWN VERIFY_INTERNAL). */
export function parseOverlapResult(v: unknown): OverlapScriptResult | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (typeof r.paged !== "boolean" || typeof r.truncated !== "boolean" || !Array.isArray(r.findings)) return null
  const findings: OverlapScriptFinding[] = []
  for (const f of r.findings) {
    if (!f || typeof f !== "object") return null
    const x = f as Record<string, unknown>
    if (x.code !== "OVERLAP" && x.code !== "UNBREAKABLE_TOO_TALL") return null
    findings.push({
      code: x.code,
      page: num(x.page) ? x.page : null,
      address: strOrNull(x.address),
      label: strOrNull(x.label),
      kind: strOrNull(x.kind) ?? undefined,
      address2: strOrNull(x.address2),
      label2: strOrNull(x.label2),
      kind2: strOrNull(x.kind2) ?? undefined,
      areaMm2: num(x.areaMm2) ? x.areaMm2 : undefined,
      frac: num(x.frac) ? x.frac : undefined,
      heightMm: num(x.heightMm) ? x.heightMm : undefined,
      limitMm: num(x.limitMm) ? x.limitMm : undefined,
      overMm: num(x.overMm) ? x.overMm : undefined,
    })
  }
  return {
    paged: r.paged,
    pageCount: num(r.pageCount) ? r.pageCount : 0,
    truncated: r.truncated,
    marginsUnreadable: r.marginsUnreadable === true,
    contentHeightMm: num(r.contentHeightMm) ? r.contentHeightMm : null,
    boxes: num(r.boxes) ? r.boxes : 0,
    scanned: num(r.scanned) ? r.scanned : 0,
    findingsTotal: num(r.findingsTotal) ? r.findingsTotal : findings.length,
    findings,
    viewportPx: num(r.viewportPx) && r.viewportPx > 0 ? r.viewportPx : null,
    layoutWidthPx: num(r.layoutWidthPx) && r.layoutWidthPx > 0 ? r.layoutWidthPx : null,
  }
}

export function overlapFindings(r: OverlapScriptResult): { findings: VerifyFinding[]; unknown: VerifyUnknownReason | null; unlisted: number } {
  const findings = r.findings.map((f) =>
    f.code === "OVERLAP"
      ? finding("OVERLAP", {
          page: f.page,
          address: f.address,
          label: f.label,
          detail: `${f.kind ?? "box"} overlaps ${f.kind2 ?? "box"} of ${clip(f.address2 ?? null) ?? "(no address)"} '${clip(f.label2 ?? null) ?? "?"}' (${(f.areaMm2 ?? 0).toFixed(1)} mm2)`,
          amount: f.areaMm2,
        })
      : finding("UNBREAKABLE_TOO_TALL", {
          page: null,
          address: f.address,
          label: f.label,
          detail: `${f.kind ?? "element"} is ${(f.heightMm ?? 0).toFixed(1)} mm tall, page content height ${(f.limitMm ?? 0).toFixed(1)} mm`,
          amount: f.overMm,
        }),
  )
  const unknown: VerifyUnknownReason | null = r.truncated ? "MEASURE_TRUNCATED" : r.marginsUnreadable ? "MARGINS_UNREADABLE" : null
  return { findings, unknown, unlisted: Math.max(0, r.findingsTotal - r.findings.length) }
}

// ── row 205 (1.2.3, HB-1): the layout viewport of a flow document ─────────

/**
 * CSS px of sheet width the layout did not get, for a flow document: the viewport is not the sheet the host asked for,
 * or a classic scrollbar took part of it. 0 = measurable (or a paged document: page limits are the page boxes, not the
 * viewport); null = unknown (older script answer without the viewport fields).
 */
export function flowWidthShortfallPx(r: OverlapScriptResult, sheetViewportPx: number): number | null {
  if (r.paged) return 0
  if (r.viewportPx === null || r.layoutWidthPx === null) return null
  const short = Math.max(sheetViewportPx - r.layoutWidthPx, Math.abs(r.viewportPx - sheetViewportPx))
  return short > 1 ? short : 0
}

/** A measure finding that only the narrow layout explains: flow (no page), right edge, within the missing width. */
export function explainedByNarrowLayout(f: VerifyFinding, shortfallPx: number): boolean {
  if (f.code !== "OVERFLOW_RIGHT" || f.page !== null) return false
  if (typeof f.amount !== "number") return true // the whole-document DATUM-37 case: wider than a narrowed viewport
  return f.amount <= shortfallPx / PX_PER_MM + 0.5
}

// ── row 151c (C161 L1): host-side plausibility ──────────────────────────

/**
 * True when the document certainly has ink the overlap script must see: visible text in the markup (outside style,
 * script, comments and tags; `&nbsp;` is not ink) or an `<svg>` / `<img>`, or measured text/figure/image elements.
 * Read on the host from the HTML text, so nothing in the page can change it.
 */
export function inkExpected(html: string, measured?: ReadonlyArray<Pick<MeasuredElement, "kind">> | null): boolean {
  if (measured && measured.some((e) => e.kind === "text" || e.kind === "figure" || e.kind === "image")) return true
  const body = /<body\b[^>]*>([\s\S]*)$/i.exec(html)?.[1] ?? html
  const markup = stripNonMarkup(body)
  if (/<(svg|img)\b/i.test(markup)) return true
  const text = markup.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
  return /[^\s\u00a0]/.test(text)
}

/**
 * The overlap script scanned no ink box although the document has ink: something in the page hid the boxes
 * (row 135b L1: `<img name="body">` once made `document.body` an `<img>`, 0 boxes, PASS). Never a pass.
 */
export function implausibleOverlap(r: OverlapScriptResult, html: string, measured?: ReadonlyArray<Pick<MeasuredElement, "kind">> | null): boolean {
  return r.boxes === 0 && inkExpected(html, measured)
}

// ── the check ────────────────────────────────────────────────────────────

/**
 * Run OVERLAP_CLIP for one output. DOCX/SVG/PNG are NOT_APPLICABLE (fixed matrix §3.7); a missing HTML is UNKNOWN
 * SOURCE_MISSING. Never throws: every failure is an UNKNOWN reason.
 */
export async function runOverlapClip(input: OverlapClipInput, deps: OverlapClipDeps = {}): Promise<OverlapClipResult> {
  if (input.format !== "HTML" && input.format !== "PDF") {
    return { check: notApplicableCheck("OVERLAP_CLIP"), layout: null, overlap: null, bridgeJobs: 0 }
  }
  const b = new Builder(input.format === "HTML" ? "self" : "same-job-html")
  if (typeof input.html !== "string" || input.html.length === 0) {
    b.unknown("SOURCE_MISSING")
    return { check: b.build(), layout: null, overlap: null, bridgeJobs: 0 }
  }
  const html = input.html
  const { pageWidthMm, pageHeightMm } = input
  const measure = deps.measure ?? ((h: string, o: MeasureOptions) => measureLayout(h, o))
  const checkPage = deps.checkPage ?? bridgeCheckPage
  let bridgeJobs = 0

  let layout: LayoutInput
  let measured: MeasuredElement[] | null = null
  // Held until the overlap script has said whether the flow layout had the sheet width (row 205).
  let measuredFindings: VerifyFinding[] = []
  try {
    const m = await measure(html, { pageWidthMm, pageHeightMm })
    bridgeJobs += m.pageCountSource === "print" ? 2 : 1
    measured = Array.isArray(m.elements) ? m.elements : null
    layout = { metrics: { pageCount: m.pageCount, paged: m.paged, pageCountSource: m.pageCountSource, truncated: m.truncated, elements: m.elements } }
    const part = measureFindings(m, input.limits ?? RENDER_LINT_DEFAULTS, html)
    measuredFindings = part.findings
    if (part.unknown) b.unknown(part.unknown)
  } catch (e) {
    bridgeJobs += 1
    const reason = unknownReasonFor(e)
    layout = { unknown: reason }
    b.unknown(reason)
  }

  let overlap: OverlapScriptResult | null = null
  try {
    bridgeJobs += 1
    const value = await checkPage(overlapCall(html, pageWidthMm, pageHeightMm, input.overlapArgs))
    overlap = parseOverlapResult(value)
    if (!overlap) b.unknown("VERIFY_INTERNAL")
    else if (implausibleOverlap(overlap, html, measured)) b.unknown("VERIFY_INTERNAL")
    else {
      const part = overlapFindings(overlap)
      part.findings.forEach((f) => b.add(f))
      b.uncounted(part.unlisted)
      if (part.unknown) b.unknown(part.unknown)
    }
  } catch (e) {
    b.unknown(unknownReasonFor(e))
  }

  const shortfall = overlap ? flowWidthShortfallPx(overlap, Math.ceil(pageWidthMm * PX_PER_MM)) : 0
  if (shortfall) {
    measuredFindings = measuredFindings.filter((f) => !explainedByNarrowLayout(f, shortfall))
    b.unknown("FLOW_LAYOUT_UNMEASURABLE")
  }
  measuredFindings.forEach((f) => b.add(f))

  return { check: b.build(), layout, overlap, bridgeJobs }
}
