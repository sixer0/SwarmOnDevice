/**
 * Row 150 (decision U24 A, C130; spec masterplan/01_specs_output_verification.md §3.1, §3.4-§3.7): the output checks
 * that need no browser of their own: LINT, PAGE_COUNT, EMPTY_SLOTS and FIGURE_FIT.
 *
 * - Pure functions over plain inputs. Row 154 reads the store (output row, bytes, revision) and the layout metrics
 *   (row 151's bridge caller) and composes the report; nothing here touches the store, the bridge or the disk.
 * - Rev A is reused, never copied: `releaseFor` (V/services/render/lint.ts:61), `lintRenderedWith` +
 *   `RENDER_CHECK_IDS` (V/engine/lint/render/index.ts:37, :544), `lintDiagramGeometry` (V/engine/diagram/fit/lint.ts:343),
 *   `lintChartGeometry` + `CHART_LINT_OPTIONS` (V/engine/chart/core/geometry.ts:326, :333), `countPdfPages`
 *   (V/services/render/pdf.ts:50).
 * - UNKNOWN never counts as a pass (spec §2): a check is PASS only when it measured everything it applies to.
 *   NOT_APPLICABLE comes only from the fixed matrix (§3.7, `VERIFY_MATRIX`), never from a run-time decision.
 * - A FAIL outranks an UNKNOWN in one check: a definite defect is reported even when another part could not be measured.
 * - Document-derived strings (labels, slot keys, lint addresses) are untrusted and cut to SCAN_TEXT_MAX characters.
 */
import type { MeasuredElement, MeasuredLayout } from "../../../vendor/src/lib/studio/engine/browser/index"
import type { LintIssue, LintReport } from "../../../vendor/src/lib/studio/contract"
import { releaseFor } from "../../../vendor/src/lib/studio/services/render/lint"
import { countPdfPages } from "../../../vendor/src/lib/studio/services/render/pdf"
import {
  lintRenderedWith,
  RENDER_CHECK_IDS,
  RENDER_LINT_DEFAULTS,
  type RenderLintLimits,
} from "../../../vendor/src/lib/studio/engine/lint/render/index"
import { lintDiagramGeometry, type DiagramDefectKind } from "../../../vendor/src/lib/studio/engine/diagram/fit/lint"
import { CHART_LINT_OPTIONS, lintChartGeometry } from "../../../vendor/src/lib/studio/engine/chart/core/geometry"
import { CAPTION_GUIDE_MAX_CHARS } from "../../../vendor/src/lib/studio/contract/schema/figure-bounds"
import {
  clip,
  DocxParseError,
  docxDocumentXml,
  findDocxPlaceholders,
  findHtmlFigures,
  findHtmlPlaceholders,
  type FigureBlockType,
} from "./html-scan.ts"
import {
  VERIFY_FINDINGS_CAP,
  type VerifiedOutput,
  type VerifyBasis,
  type VerifyCheck,
  type VerifyCheckId,
  type VerifyFinding,
  type VerifyPage,
  type VerifyUnknownReason,
} from "./types.ts"

export type VerifyFormat = VerifiedOutput["format"]
export type NotApplicable = "NOT_APPLICABLE"

/** The six check ids in report order (`VerifyCheckId` order, spec §2: "always all six ids, in the order of VerifyCheckId"). */
export const VERIFY_CHECK_ORDER: readonly VerifyCheckId[] = ["LINT", "OVERLAP_CLIP", "FIDELITY", "PAGE_COUNT", "FIGURE_FIT", "EMPTY_SLOTS"]

/**
 * Spec §3.7, fixed. Where a cell names two sources ("self + same-job-html", "self + revision-store") the basis
 * reported is the output-side one: PAGE_COUNT PDF `self`, EMPTY_SLOTS HTML/DOCX `self`, EMPTY_SLOTS PDF `same-job-html`.
 */
export const VERIFY_MATRIX: Readonly<Record<VerifyCheckId, Readonly<Record<VerifyFormat, VerifyBasis | NotApplicable>>>> = Object.freeze({
  LINT: { HTML: "revision-lint", PDF: "revision-lint", DOCX: "revision-lint", SVG: "revision-lint", PNG: "revision-lint" },
  OVERLAP_CLIP: { HTML: "self", PDF: "same-job-html", DOCX: "NOT_APPLICABLE", SVG: "NOT_APPLICABLE", PNG: "NOT_APPLICABLE" },
  FIDELITY: { HTML: "self", PDF: "same-job-html", DOCX: "self", SVG: "self", PNG: "same-job-svg" },
  PAGE_COUNT: { HTML: "self", PDF: "self", DOCX: "NOT_APPLICABLE", SVG: "NOT_APPLICABLE", PNG: "NOT_APPLICABLE" },
  FIGURE_FIT: { HTML: "same-job-html", PDF: "same-job-html", DOCX: "same-job-html", SVG: "self", PNG: "same-job-svg" },
  EMPTY_SLOTS: { HTML: "self", PDF: "same-job-html", DOCX: "self", SVG: "NOT_APPLICABLE", PNG: "NOT_APPLICABLE" },
})

export function isApplicable(id: VerifyCheckId, format: VerifyFormat): boolean {
  return VERIFY_MATRIX[id][format] !== "NOT_APPLICABLE"
}

/** A NOT_APPLICABLE check. The type needs a basis; a not-applicable check is reported with `self`. */
export function notApplicableCheck(id: VerifyCheckId): VerifyCheck {
  return { id, status: "NOT_APPLICABLE", basis: "self", reason: null, findings: [], truncated: 0, ms: 0 }
}

/**
 * Layout of the measured HTML, from row 151's bridge caller (`measureLayout` through `studio.measure`):
 * the metrics, or the reason they could not be had. `null` = the same-job HTML does not exist (SOURCE_MISSING).
 */
export type LayoutInput =
  | { metrics: Pick<MeasuredLayout, "pageCount" | "paged" | "pageCountSource" | "truncated" | "elements"> }
  | { unknown: VerifyUnknownReason }
  | null

// ── check builder ────────────────────────────────────────────────────────

class CheckBuilder {
  private readonly t0 = performance.now()
  private readonly failing: VerifyFinding[] = []
  private readonly reportOnly: VerifyFinding[] = []
  private unknown: VerifyUnknownReason | null = null
  constructor(
    private readonly id: VerifyCheckId,
    private readonly basis: VerifyBasis,
  ) {}
  fail(f: VerifyFinding): void {
    this.failing.push(f)
  }
  /** Listed, status unchanged (spec §3.5: diagram `edgeCross` / `edgeCollinear`). */
  note(f: VerifyFinding): void {
    this.reportOnly.push(f)
  }
  /** First reason wins; later parts that also could not be measured do not overwrite it. */
  unknownBecause(reason: VerifyUnknownReason): void {
    if (!this.unknown) this.unknown = reason
  }
  build(): VerifyCheck {
    const all = [...this.failing, ...this.reportOnly]
    const status = this.failing.length > 0 ? "FAIL" : this.unknown ? "UNKNOWN" : "PASS"
    return {
      id: this.id,
      status,
      basis: this.basis,
      reason: status === "UNKNOWN" ? this.unknown : null,
      findings: all.slice(0, VERIFY_FINDINGS_CAP),
      truncated: Math.max(0, all.length - VERIFY_FINDINGS_CAP),
      ms: Math.round(performance.now() - this.t0),
    }
  }
}

function finding(code: string, f: Partial<Omit<VerifyFinding, "code">> & { detail: string }): VerifyFinding {
  const out: VerifyFinding = {
    code,
    page: f.page ?? null,
    address: clip(f.address ?? null),
    label: clip(f.label ?? null),
    detail: clip(f.detail) ?? "",
  }
  if (typeof f.amount === "number" && Number.isFinite(f.amount)) out.amount = Number(f.amount.toFixed(2))
  return out
}

function parseJson(v: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof v !== "string") return { ok: true, value: v }
  try {
    return { ok: true, value: JSON.parse(v) as unknown }
  } catch {
    return { ok: false }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

// ── LINT (§3.1) ──────────────────────────────────────────────────────────

type Tier = LintReport["tier"]
const TIERS: ReadonlySet<string> = new Set(["NOTA", "TERBIT", "SERAH"])
const RENDER_IDS: ReadonlySet<string> = new Set(RENDER_CHECK_IDS)

export interface LintCheckInput {
  format: VerifyFormat
  /** `revision.lint_report` as stored (JSON text) or parsed; null when the column is NULL. */
  lintReport: unknown
  /** `output_file.lint_verdict`: PENDING | PASS | FAIL | NOT_RUN. */
  lintVerdict: string | null
  /** The document's tier; when missing or not a Rev A tier the stored report's own tier is used. */
  tier?: string | null
}

/** Applicability by tier through `releaseFor` itself (a single check releases FAIL only when it applies to the tier). */
function appliesAtTier(c: LintIssue, tier: Tier): boolean {
  return releaseFor([{ ...c, status: "FAIL" }], tier) === "FAIL"
}

function readLintReport(v: unknown): { checks: LintIssue[]; tier: string | null } | null {
  const p = parseJson(v)
  if (!p.ok || !isRecord(p.value) || !Array.isArray(p.value.checks)) return null
  const checks = p.value.checks.filter(
    (c): c is LintIssue => isRecord(c) && typeof c.checkId === "string" && typeof c.status === "string",
  )
  return { checks, tier: typeof p.value.tier === "string" ? p.value.tier : null }
}

export function checkLint(i: LintCheckInput): VerifyCheck {
  const b = new CheckBuilder("LINT", "revision-lint")
  const report = i.lintReport === null || i.lintReport === undefined ? null : readLintReport(i.lintReport)
  if (!report) {
    b.unknownBecause("LINT_NOT_RUN")
    return b.build()
  }
  const tierName = i.tier && TIERS.has(i.tier) ? i.tier : report.tier && TIERS.has(report.tier) ? report.tier : "NOTA"
  const tier = tierName as Tier
  const release = releaseFor(report.checks, tier)
  if (release === "FAIL") {
    // Row 206 (1.2.3, AC-4): every failing lint check is a finding with its check id (label), where it is (address,
    // else the JSON pointer) and the engine message (document-derived parts untrusted, cut by `finding`).
    for (const c of report.checks) {
      if (c.status === "FAIL" && appliesAtTier(c, tier)) {
        const msg = typeof c.detail === "string" && c.detail.trim() !== "" ? `${c.checkId}: ${c.detail}` : c.checkId
        b.fail(finding("LINT_FAIL", { address: c.address ?? c.pointer ?? null, label: c.checkId, detail: msg }))
      }
    }
    // A FAIL release always has an applicable FAIL check (releaseFor); should none be listed, LINT is not a
    // finding-less FAIL but UNKNOWN (never verified, never a LINT without findings).
    const built = b.build()
    if (built.status === "FAIL") return built
    const u = new CheckBuilder("LINT", "revision-lint")
    u.unknownBecause("LINT_PARTIAL")
    return u.build()
  }
  if (release === "NOT_RUN" || i.lintVerdict === "PENDING" || i.lintVerdict === "NOT_RUN" || i.lintVerdict === null) {
    b.unknownBecause("LINT_NOT_RUN")
    return b.build()
  }
  if (report.checks.some((c) => RENDER_IDS.has(c.checkId) && c.status === "NOT_RUN" && appliesAtTier(c, tier))) {
    b.unknownBecause("LINT_PARTIAL")
  }
  return b.build()
}

// ── PAGE_COUNT (§3.4) ────────────────────────────────────────────────────

export interface PageCountInput {
  format: VerifyFormat
  /** The stored PDF bytes (PDF outputs). */
  pdf?: Uint8Array | null
  /** HTML outputs: their own layout. PDF outputs: the same-job HTML's layout. */
  layout: LayoutInput
}

export interface PageCountResult {
  check: VerifyCheck
  /** 1..count for HTML/PDF when the count is known (spec §3.4 "Report"); `png` stays null (GAP-1 is row 151b). */
  pages: VerifyPage[]
}

const CONTENT_KINDS: ReadonlySet<string> = new Set(["text", "figure", "image", "table"])

function layoutCount(layout: LayoutInput, b: CheckBuilder): { count: number; metrics: Extract<LayoutInput, { metrics: unknown }>["metrics"] } | null {
  if (layout === null) {
    b.unknownBecause("SOURCE_MISSING")
    return null
  }
  if ("unknown" in layout) {
    b.unknownBecause(layout.unknown)
    return null
  }
  const m = layout.metrics
  if (m.pageCountSource === "none" || !Number.isFinite(m.pageCount)) {
    // measureLayout without a print count (flow layout, `countPrintPages:false` or a failed print): no count to judge.
    b.unknownBecause("BRIDGE_UNAVAILABLE")
    return null
  }
  return { count: Math.max(0, Math.trunc(m.pageCount)), metrics: m }
}

function pageList(count: number, findings: readonly VerifyFinding[]): VerifyPage[] {
  const n = Math.min(Math.max(0, count), 10000)
  const pages: VerifyPage[] = []
  for (let p = 1; p <= n; p++) pages.push({ n: p, png: null, findings: findings.filter((f) => f.page === p).length })
  return pages
}

export function checkPageCount(i: PageCountInput): PageCountResult {
  if (!isApplicable("PAGE_COUNT", i.format)) return { check: notApplicableCheck("PAGE_COUNT"), pages: [] }
  const b = new CheckBuilder("PAGE_COUNT", VERIFY_MATRIX.PAGE_COUNT[i.format] as VerifyBasis)
  let count: number | null = null

  if (i.format === "HTML") {
    const l = layoutCount(i.layout, b)
    if (l) {
      count = l.count
      if (count === 0) b.fail(finding("NO_PAGES", { detail: `html ${l.metrics.paged ? "paged" : "flow"} layout has 0 pages` }))
      else if (l.metrics.paged) {
        // Blank sheets: only measurable in paged layout (L-1). Truncated metrics cannot prove a sheet empty.
        const used = new Set<number>()
        for (const e of l.metrics.elements as MeasuredElement[]) if (CONTENT_KINDS.has(e.kind) && typeof e.page === "number") used.add(e.page)
        const blank: number[] = []
        for (let p = 1; p <= count; p++) if (!used.has(p)) blank.push(p)
        if (blank.length && l.metrics.truncated) b.unknownBecause("MEASURE_TRUNCATED")
        else for (const p of blank) b.fail(finding("BLANK_PAGE", { page: p, detail: `sheet ${p} has no text, figure, image or table` }))
      }
    }
  } else {
    // PDF: its own count (countPdfPages), tied to the same-job HTML count.
    if (!i.pdf || i.pdf.byteLength === 0) b.unknownBecause("SOURCE_MISSING")
    else {
      count = countPdfPages(i.pdf)
      if (count === 0) b.fail(finding("NO_PAGES", { detail: "pdf has 0 pages" }))
      else {
        const l = layoutCount(i.layout, b)
        if (l && l.count !== count) {
          b.fail(
            finding("PAGE_COUNT_MISMATCH", {
              detail: `pdf ${count} pages, same-job html ${l.count} (${l.metrics.paged ? "paged: a sheet broke in print" : "flow"})`,
              amount: count - l.count,
            }),
          )
        }
      }
    }
  }
  const check = b.build()
  return { check, pages: count === null ? [] : pageList(count, check.findings) }
}

// ── FIGURE_FIT (§3.5) ────────────────────────────────────────────────────

/**
 * Diagram defect kinds that fail the check; `edgeCross` / `edgeCollinear` are report-only (CP-41 routing, U21).
 * Swarm 1.2.6 row 26 (T-03, register N-007): the connector-end kinds `edgeEntryCollision`, `stubSegment`,
 * `arrowTangent` (row 25, N-001/N-003/N-005) fail too (6 -> 9).
 */
export const DIAGRAM_FAIL_KINDS: ReadonlySet<DiagramDefectKind> = new Set([
  "textOverlap",
  "textOutside",
  "textExceedsNode",
  "lineThroughText",
  "textOverNode",
  "edgeThroughNode",
  "edgeEntryCollision",
  "stubSegment",
  "arrowTangent",
  // Swarm 1.2.8 row 55c (C133): a container frame clipped by the figure box (9 -> 10).
  "frameOutside",
  // Swarm 1.2.8 row 58b (C134, G3-08): a label band over an arrowhead, node outline or container rule (row 57c kind,
  // GEOM_LABEL_COLLISION) fails FIGURE_FIT too, not only the preview (10 -> 11).
  "labelCollision",
])

/**
 * Swarm 1.2.6 row 28 (T-01, register N-015, U3): engine fit notes that FAIL FIGURE_FIT (they were info only).
 * The check sees the output SVG, not the engine report, so both are read back from the apparatus caption the engine
 * drew inside the SVG (apparatus "figure"; a page-apparatus caption is HTML and is never wrapped by the engine):
 * more than one caption line = CAPTION_WRAP, a caption or SUMBER line cut with an ellipsis = CAPTION_TRUNCATED.
 */
export const FIGURE_FIT_FAIL_NOTES: ReadonlySet<string> = new Set(["CAPTION_WRAP", "CAPTION_TRUNCATED"])

const ELLIPSIS = "…"
/** Diagram / symbol sheet caption lines: `CAPTION_MARK_ATTR` before `withCaptionAbove`, `data-caption-above` after. */
const DIAGRAM_CAPTION_LINE = /<text\b[^>]*\bdata-(?:st-caption|caption-above)="1"[^>]*>([\s\S]*?)<\/text>/g
/** Chart apparatus (apparatus.ts `figureApparatus`): the caption `<text>` directly before the SUMBER `<text>`. */
const CHART_APPARATUS = /<text\b[^>]*>((?:(?!<\/text>)[\s\S])*)<\/text>\s*<text\b[^>]*>((?:<tspan\b[^>]*>)?SUMBER\b(?:(?!<\/text>)[\s\S])*)<\/text>/

const plainText = (s: string) => s.replace(/<[^>]*>/g, "")

function captionLinesOf(kind: string, svg: string): { lines: number; truncated: boolean } | null {
  if (kind === "diagram" || kind === "symbolSheet") {
    const lines = [...svg.matchAll(DIAGRAM_CAPTION_LINE)].map((m) => plainText(m[1]))
    return lines.length ? { lines: lines.length, truncated: lines.some((l) => l.trimEnd().endsWith(ELLIPSIS)) } : null
  }
  if (kind === "chart") {
    const m = CHART_APPARATUS.exec(svg)
    if (!m) return null
    const tspans = m[1].match(/<tspan\b[^>]*\bdy="/g)?.length ?? 0
    return { lines: Math.max(1, tspans), truncated: plainText(m[1]).includes(ELLIPSIS) || plainText(m[2]).includes(ELLIPSIS) }
  }
  return null
}

/** FIGURE_FIT_FAIL_NOTES as findings; the detail cites the caption guide limit (N-014), never the caption text. */
function captionFitOf(f: FigureSvg, b: CheckBuilder): void {
  const c = captionLinesOf(f.kind, f.svg)
  if (!c) return
  const limit = `maks ${CAPTION_GUIDE_MAX_CHARS} karakter (CAPTION_GUIDE_MAX_CHARS) agar muat satu baris`
  if (c.lines > 1) {
    b.fail(finding("CAPTION_WRAP", { address: f.address, label: f.label, detail: `caption ${c.lines} baris: persingkat caption, ${limit}`, amount: c.lines }))
  }
  if (c.truncated) {
    b.fail(finding("CAPTION_TRUNCATED", { address: f.address, label: f.label, detail: `caption/SUMBER dipotong elipsis: persingkat, ${limit}` }))
  }
}

export interface FigureFitInput {
  format: VerifyFormat
  /** HTML / PDF / DOCX: the same-job HTML (the HTML output itself for HTML). null = no same-job HTML. */
  html?: string | null
  /** HTML / PDF / DOCX: layout of that HTML for the height part (DATUM-33). */
  layout?: LayoutInput
  /** SVG: the file itself. PNG: the same-job SVG of the same figure_label (null = SOURCE_MISSING). */
  svg?: string | null
  /** SVG / PNG: block type of the figure (`figure_label` -> block type). */
  figureKind?: FigureBlockType | string | null
  figureLabel?: string | null
  /** Template render-lint limits (`renderLintLimitsFor(log, tpl.params)`, V/services/render/lint.ts:88). */
  limits?: RenderLintLimits
}

interface FigureSvg {
  kind: string
  svg: string
  address: string | null
  label: string | null
}

function geometryOf(f: FigureSvg, b: CheckBuilder): void {
  try {
    captionFitOf(f, b) // row 28 (T-01): FIGURE_FIT_FAIL_NOTES
    // Spec §3.5 test (row 150, "symbolSheet decision"): row 150c (C144 A) fixed the overlapping sheet text and taught
    // lintDiagramGeometry to read cell labels in translate-only `<g data-symbol>` cells, so engine symbol sheets
    // lint clean and a symbol sheet gets the same measured verdict as a diagram.
    if (f.kind === "diagram" || f.kind === "symbolSheet") {
      const r = lintDiagramGeometry(f.svg)
      // An SVG the scanner cannot size (no viewBox / not an engine SVG) gives no defects: that is not a pass.
      if (!(r.widthMm > 0 && r.heightMm > 0)) return b.unknownBecause("PARSE_FAILED")
      for (const d of r.defects) {
        const fd = finding("FIG_GEOMETRY", {
          address: f.address,
          label: f.label,
          detail: `${d.kind}: ${d.text}${d.other ? ` / ${d.other}` : ""}`,
          amount: d.amount,
        })
        if (DIAGRAM_FAIL_KINDS.has(d.kind)) b.fail(fd)
        else b.note(fd)
      }
    } else if (f.kind === "chart") {
      const r = lintChartGeometry(f.svg, CHART_LINT_OPTIONS)
      if (!(r.widthMm > 0 && r.heightMm > 0)) return b.unknownBecause("PARSE_FAILED")
      for (const d of r.defects) {
        b.fail(
          finding("FIG_GEOMETRY", {
            address: f.address,
            label: f.label,
            detail: `${d.kind}: ${d.text}${d.other ? ` / ${d.other}` : ""}`,
            amount: d.amount,
          }),
        )
      }
    } else if (f.kind !== "image") {
      b.unknownBecause("NO_GEOMETRY_LINT")
    }
  } catch {
    b.unknownBecause("PARSE_FAILED")
  }
}

/** DATUM-33 on the measured layout (same metrics as OVERLAP_CLIP, §3.2): FAIL items -> FIG_TOO_TALL. */
function heightOf(html: string, layout: LayoutInput, limits: RenderLintLimits, b: CheckBuilder): void {
  if (layout === null || layout === undefined) {
    b.unknownBecause("SOURCE_MISSING")
    return
  }
  if ("unknown" in layout) {
    b.unknownBecause(layout.unknown)
    return
  }
  const m = layout.metrics
  const issues = lintRenderedWith({ html, svgs: [], metrics: { pageCount: m.pageCount, elements: m.elements } }, limits).filter(
    (c) => c.checkId === "DATUM-33",
  )
  if (!issues.length || issues.some((c) => c.status === "NOT_RUN")) {
    b.unknownBecause("VERIFY_INTERNAL")
    return
  }
  const figs = (m.elements as MeasuredElement[]).filter((e) => e.kind === "figure" || e.kind === "image")
  for (const c of issues) {
    if (c.status !== "FAIL") continue
    const el = c.address ? figs.find((e) => e.address === c.address) : undefined
    b.fail(
      finding("FIG_TOO_TALL", {
        page: typeof el?.page === "number" ? el.page : null,
        address: c.address ?? null,
        label: el?.label ?? null,
        detail: "DATUM-33",
        amount: el?.heightMm,
      }),
    )
  }
  if (m.truncated && !issues.some((c) => c.status === "FAIL")) b.unknownBecause("MEASURE_TRUNCATED")
}

export function checkFigureFit(i: FigureFitInput): VerifyCheck {
  const basis = VERIFY_MATRIX.FIGURE_FIT[i.format] as VerifyBasis
  const b = new CheckBuilder("FIGURE_FIT", basis)
  if (basis === "same-job-html") {
    if (typeof i.html !== "string" || i.html === "") {
      b.unknownBecause("SOURCE_MISSING")
      return b.build()
    }
    heightOf(i.html, i.layout ?? null, i.limits ?? RENDER_LINT_DEFAULTS, b)
    for (const f of findHtmlFigures(i.html)) {
      for (const svg of f.svgs) geometryOf({ kind: f.type, svg, address: f.address, label: f.label }, b)
    }
    return b.build()
  }
  // SVG (self) / PNG (same-job SVG): geometry inside the figure. Height on the page is the HTML/PDF outputs' part.
  if (typeof i.svg !== "string" || i.svg === "") {
    b.unknownBecause("SOURCE_MISSING")
    return b.build()
  }
  if (!i.figureKind) {
    b.unknownBecause("NO_GEOMETRY_LINT")
    return b.build()
  }
  geometryOf({ kind: i.figureKind, svg: i.svg, address: null, label: i.figureLabel ?? null }, b)
  return b.build()
}

// ── EMPTY_SLOTS (§3.6) ───────────────────────────────────────────────────

export interface EmptySlotsInput {
  format: VerifyFormat
  /** `revision.completeness`: COMPLETE | INCOMPLETE. */
  completeness: string | null
  /** `revision.completeness_report` (JSON text or parsed; null for v1 / work reports). */
  completenessReport: unknown
  /** HTML: the output itself. PDF: the same-job HTML (null = SOURCE_MISSING). */
  html?: string | null
  /** DOCX: the output bytes. */
  docx?: Uint8Array | null
}

const OPEN_STATES: ReadonlySet<string> = new Set(["EMPTY", "PARTIAL"])

function revisionSlots(i: EmptySlotsInput, b: CheckBuilder): void {
  const p = i.completenessReport === null || i.completenessReport === undefined ? { ok: true as const, value: null } : parseJson(i.completenessReport)
  const report = p.ok && isRecord(p.value) ? p.value : null
  let listed = 0
  if (report && Array.isArray(report.slots)) {
    for (const s of report.slots) {
      if (!isRecord(s) || s.required !== true || typeof s.state !== "string" || !OPEN_STATES.has(s.state)) continue
      listed++
      b.fail(finding("SLOT_EMPTY", { label: typeof s.slotKey === "string" ? s.slotKey : null, detail: s.state }))
    }
  }
  if (listed > 0 || i.completeness === "COMPLETE") return
  // No open slot listed, but the revision is not COMPLETE (or its state is unknown): the gate column decides.
  const missing = report && Array.isArray(report.missingRequired) ? report.missingRequired.filter((x): x is string => typeof x === "string") : []
  if (missing.length) for (const k of missing) b.fail(finding("SLOT_EMPTY", { label: k, detail: "missingRequired" }))
  else b.fail(finding("SLOT_EMPTY", { detail: `revision completeness ${i.completeness ?? "unknown"}` }))
}

export function checkEmptySlots(i: EmptySlotsInput): VerifyCheck {
  if (!isApplicable("EMPTY_SLOTS", i.format)) return notApplicableCheck("EMPTY_SLOTS")
  const b = new CheckBuilder("EMPTY_SLOTS", VERIFY_MATRIX.EMPTY_SLOTS[i.format] as VerifyBasis)
  revisionSlots(i, b)
  if (i.format === "DOCX") {
    if (!i.docx || i.docx.byteLength === 0) b.unknownBecause("SOURCE_MISSING")
    else {
      try {
        for (const p of findDocxPlaceholders(docxDocumentXml(i.docx))) {
          b.fail(finding("PLACEHOLDER_IN_OUTPUT", { label: p.text, detail: `docx paragraph ${p.paragraph} has the draft placeholder border` }))
        }
      } catch (e) {
        if (e instanceof DocxParseError) b.unknownBecause("PARSE_FAILED")
        else throw e
      }
    }
    return b.build()
  }
  if (typeof i.html !== "string" || i.html === "") {
    b.unknownBecause("SOURCE_MISSING")
    return b.build()
  }
  for (const p of findHtmlPlaceholders(i.html)) {
    b.fail(finding("PLACEHOLDER_IN_OUTPUT", { address: p.address, label: p.slotKey, detail: p.marker }))
  }
  for (const f of findHtmlFigures(i.html)) {
    if (f.svgs.length === 0 && !f.hasImg) {
      b.fail(finding("FIGURE_PLACEHOLDER", { address: f.address, label: f.label, detail: `${f.type} figure has no svg or img (${f.graphicSource ?? "?"})` }))
    }
  }
  return b.build()
}

// ── convenience: the four static checks of one output ────────────────────

export interface StaticChecksInput {
  format: VerifyFormat
  lint: Omit<LintCheckInput, "format">
  completeness: Pick<EmptySlotsInput, "completeness" | "completenessReport">
  /** HTML: the output; PDF/DOCX: the same-job HTML. */
  html?: string | null
  /** PDF: the output bytes. DOCX: the output bytes. */
  bytes?: Uint8Array | null
  /** SVG: the output text; PNG: the same-job SVG. */
  svg?: string | null
  figureKind?: string | null
  figureLabel?: string | null
  /** HTML layout from the bridge (row 151 caller); HTML: own, PDF/DOCX: same-job HTML. */
  layout?: LayoutInput
  limits?: RenderLintLimits
}

export interface StaticChecksResult {
  checks: Partial<Record<"LINT" | "PAGE_COUNT" | "FIGURE_FIT" | "EMPTY_SLOTS", VerifyCheck>>
  pages: VerifyPage[]
}

/** LINT, PAGE_COUNT, FIGURE_FIT, EMPTY_SLOTS for one output (row 154 adds OVERLAP_CLIP and FIDELITY). */
export function runStaticChecks(i: StaticChecksInput): StaticChecksResult {
  // No layout given = nothing was measured (bridge not called): BRIDGE_UNAVAILABLE. `null` = no same-job HTML exists.
  const layout: LayoutInput = i.layout === undefined ? { unknown: "BRIDGE_UNAVAILABLE" } : i.layout
  const pc = checkPageCount({ format: i.format, pdf: i.format === "PDF" ? i.bytes ?? null : null, layout })
  return {
    checks: {
      LINT: checkLint({ format: i.format, ...i.lint }),
      PAGE_COUNT: pc.check,
      FIGURE_FIT: checkFigureFit({
        format: i.format,
        html: i.html,
        layout,
        svg: i.svg,
        figureKind: i.figureKind,
        figureLabel: i.figureLabel,
        limits: i.limits,
      }),
      EMPTY_SLOTS: checkEmptySlots({
        format: i.format,
        ...i.completeness,
        html: i.html,
        docx: i.format === "DOCX" ? i.bytes ?? null : null,
      }),
    },
    pages: pc.pages,
  }
}
