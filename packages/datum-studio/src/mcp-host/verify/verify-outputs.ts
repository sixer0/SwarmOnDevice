/**
 * Row 154 (decision U24 A, C130, C147): compose the output verification of ONE render job
 * (masterplan/01_specs_output_verification.md §2, §3, §3.7, §6).
 *
 * The checks themselves are rows 150, 151 and 153 and are only imported here:
 * - LINT, PAGE_COUNT, FIGURE_FIT, EMPTY_SLOTS: `runStaticChecks` (static-checks.ts, row 150);
 * - OVERLAP_CLIP: `runOverlapClip` (overlap-clip.ts, row 151), run ONCE on the job's HTML. Its `layout`
 *   (the studio.measure metrics) feeds PAGE_COUNT and the FIGURE_FIT height part, so no second measure is made;
 * - FIDELITY: `checkFidelity` (fidelity.ts, row 153) against `revision.snapshot`.
 *
 * Sources per format (§3.7, D-3): HTML is measured itself; PDF through the same-job HTML it was printed from (F3);
 * DOCX through its own bytes plus the same-job HTML for the figure height; SVG itself; PNG through the same-job SVG of
 * the same figure label. A missing source is UNKNOWN (SOURCE_MISSING) and UNKNOWN never counts as a pass:
 * `verified` if and only if every check that is not NOT_APPLICABLE is PASS (§2).
 *
 * Page images (row 151b, C130 GAP-1): `pages[].png` is filled from the vendored `rasterizeHtmlPages` (bridge op
 * `pagePng`, 150 dpi) of the job's HTML into `<store>/verify/<htmlOutputId>/pNNN.png`. The PDF is printed from that
 * same HTML (F3), so its pages[] point at the same images. Images are for the agent to look at; they never decide a
 * status. When they cannot be made, `png` stays null and `pageImages.reason` says why.
 * Patch 1.3.3 row 58 (ST-9 item 1): which pages are imaged = EVERY page that carries a figure or chart
 * (`figurePages`, no cap) plus the general pages of row 151b (`choosePages`: pages with findings, first, last, evenly
 * spaced, at most 12). The bridge takes at most 12 pages per request, so the pages go in batches of
 * VERIFY_PAGE_IMAGE_BATCH, figure pages first; this process keeps only the paths. The list of figure-page witnesses
 * is returned as `VerifyJobResult.witness` and written to `<store>/verify/<htmlOutputId>/witness.json`
 * (`readWitnessManifest`), the seam of row 59's `studio_witness_list`.
 * Row 151c: a listed page without an image, or images the bridge marks approximate (flow layout), is named in
 * `pageImages.note`; after each render only the newest VERIFY_IMAGES_KEEP (20) image folders stay (C161 L5).
 *
 * Fault seam (§9): `opts.fault(format, bytes)` changes the bytes the checks read, never the stored file. It is a
 * test-only option of this function; the production wrapper (render-wrapper.ts) never passes it.
 * Never throws for a check failure: every failure is an UNKNOWN reason. The caller still guards with try/catch
 * (VERIFY_INTERNAL, §6.1) for anything unexpected.
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { strFromU8 } from "fflate"
import { rasterizeHtmlPages, type HtmlPageImages } from "../../../vendor/src/lib/studio/engine/browser/runtime"
import type { RenderLintLimits } from "../../../vendor/src/lib/studio/engine/lint/render/index"
import { checkFidelity, FIDELITY_FIGURE_TYPES, figureBlockFor, fidelityExpectationFromSnapshot, type FidelityExpectation } from "./fidelity.ts"
import { runOverlapClip, unknownReasonFor, type OverlapClipDeps, type OverlapClipResult } from "./overlap-clip.ts"
import { notApplicableCheck, runStaticChecks, VERIFY_CHECK_ORDER, VERIFY_MATRIX, type LayoutInput, type VerifyFormat } from "./static-checks.ts"
import {
  OUTPUT_VERIFICATION_CHECKS_VERSION,
  OUTPUT_VERIFICATION_SCHEMA,
  type OutputVerificationReport,
  type OutputVerificationState,
  type VerifiedOutput,
  type VerifyBasis,
  type VerifyCheck,
  type VerifyCheckId,
  type VerifyPage,
  type VerifyUnknownReason,
} from "./types.ts"

/** Sheet size of the measure: the size the render's own `measureLayout(html)` uses (pure/render.ts:457, index.ts:391-392). */
export const VERIFY_PAGE_MM = Object.freeze({ pageWidthMm: 210, pageHeightMm: 297 })
/** Spec §4: `STUDIO_VERIFY_BUDGET_MS`, default 120 000 ms. */
export const VERIFY_BUDGET_DEFAULT_MS = 120_000
/**
 * Spec §11 GAP-1 / row 151b: at most 12 GENERAL page images per output (`choosePages`). Since patch 1.3.3 row 58 this
 * no longer limits figure pages: every page that carries a figure or chart is imaged on top of these.
 */
export const VERIFY_MAX_PAGE_IMAGES = 12
/** Patch 1.3.3 register section 8 (`studio_witness_list`): witness images have one fixed resolution, 150 dpi. */
export const VERIFY_WITNESS_DPI = 150
/** Pages per bridge request: the bridge refuses more than 12 (`MAX_PAGE_IMAGES`, desktop datum-render/protocol.ts:19, :181). */
/** @internal test seam */
export const VERIFY_PAGE_IMAGE_BATCH = 12
/** Row 58: file name and schema of the witness list beside the page images. */
/** @internal test seam */
export const VERIFY_WITNESS_MANIFEST = "witness.json"
/** @internal test seam */
export const VERIFY_WITNESS_SCHEMA = "studio.verify.witness/v1"

const FORMATS: ReadonlySet<string> = new Set(["DOCX", "PDF", "HTML", "SVG", "PNG"])

/** One output of the render job, as read from the store (`output_file` row + its verified bytes). */
export interface VerifyOutputFile {
  id: string
  format: VerifyFormat
  role: "PRIMARY" | "FIGURE"
  figureLabel: string | null
  sha256: string
  /** `output_file.lint_verdict`. */
  lintVerdict: string | null
  /** The stored bytes (sha256-checked by the store), or null when they could not be read (checks read SOURCE_MISSING). */
  bytes: Uint8Array | null
  /** Absolute path of the stored file (page images of the HTML); null when unknown. */
  absPath: string | null
}

export interface VerifyJobInput {
  documentId: string
  revisionNo: number
  renderJobId: string | null
  scope: OutputVerificationReport["scope"]
  draft: boolean
  formatsAdded: OutputVerificationReport["formatsAdded"]
  /** `document.tier`. */
  tier: string | null
  /** `revision.lint_report` / `revision.completeness` / `revision.completeness_report` / `revision.snapshot`. */
  lintReport: unknown
  completeness: string | null
  completenessReport: unknown
  snapshot: unknown
  /** `renderLintLimitsFor(log, resolved_params)` of the revision's template version. */
  limits?: RenderLintLimits
  outputs: VerifyOutputFile[]
  /** Store root: page images go to `<storeRoot>/verify/<htmlOutputId>/`. null = no page images. */
  storeRoot: string | null
  /** A verified PRIMARY PDF/HTML of this revision already exists in the store (layout witness, §7.2). */
  priorLayoutWitness?: boolean
}

export type PageImager = (o: { src: string; dstDir: string; pages?: number[]; dpi?: number }) => Promise<HtmlPageImages>

/** Row 58: one page that carries at least one figure or chart, with the labels of what it carries (document-derived: untrusted). */
interface FigurePage {
  page: number
  figures: string[]
}

/**
 * Row 58: which pages carry a figure or chart.
 * `basis`: "snapshot" = the figure blocks of the revision snapshot, located on a page through the measured layout;
 * "markup" = no usable snapshot match, so every measured top-level svg or img counts (may include a logo);
 * "none" = not known, `reason` says why (flow layout, page count not measured).
 */
interface FigurePageSelection {
  pages: FigurePage[]
  basis: "snapshot" | "markup" | "none"
  /** Figure blocks of the snapshot that were not found on any page (labels; untrusted). */
  unplaced: string[]
  reason: string | null
}

/** Row 58: one witness = the image of one figure page. `png` is an absolute path of a file the bridge wrote. */
interface WitnessPage {
  page: number
  png: string
  figures: string[]
}

/** Row 58: the witness list of one render (seam of row 59, register section 8 `studio_witness_list`). */
export interface WitnessManifest {
  $schema: typeof VERIFY_WITNESS_SCHEMA
  documentId: string
  revisionNo: number
  htmlOutputId: string
  dpi: number
  basis: FigurePageSelection["basis"]
  /** One entry per figure page that has an image, ascending by page. No cap. */
  pages: WitnessPage[]
  /** Figure pages without an image (budget ran out, bridge failed, image layout shorter than the print). */
  missing: number[]
  unplaced: string[]
  reason: string | null
}

export interface VerifyOptions {
  /** Test-only fault seam (§9): changes the bytes a check reads, never the stored file. */
  fault?: (format: VerifyFormat, bytes: Uint8Array) => Uint8Array
  /** Bridge seams of row 151 (tests); default = the vendored bridge path. */
  overlapDeps?: OverlapClipDeps
  /** Default: vendored `rasterizeHtmlPages`. null = make no page images. */
  pageImages?: PageImager | null
  /** Default `STUDIO_VERIFY_BUDGET_MS` or 120 000. */
  budgetMs?: number
}

export interface VerifyJobResult {
  report: OutputVerificationReport
  /** Page images made for the job's HTML, and why none were made when `made` is 0. */
  pageImages: { made: number; reason: string | null; note?: string | null }
  /** Row 58: witnesses of the figure pages; null when no imaging was attempted (no HTML, images off, no page count). */
  witness: WitnessManifest | null
}

/** Row 151c (C161 L5): page-image folders kept under `<store>/verify/` (newest first, like row 70a's 20 previews). */
export const VERIFY_IMAGES_KEEP = 20

/**
 * Row 151c (C161 L5): keep the newest `keep` page-image folders `<store>/verify/<htmlOutputId>/` (by mtime) and
 * remove the rest; `current` is always kept. Only plain folders with an id-shaped name directly under `verify/` are
 * touched (a link is never followed or removed). Returns how many folders were removed.
 */
export function pruneVerifyImages(verifyDir: string, current: string, keep = VERIFY_IMAGES_KEEP): number {
  let names: string[]
  try {
    names = readdirSync(verifyDir)
  } catch {
    return 0
  }
  const dirs: Array<{ name: string; mtime: number }> = []
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || name === current) continue
    const st = lstatSync(join(verifyDir, name), { throwIfNoEntry: false })
    if (st && st.isDirectory() && !st.isSymbolicLink()) dirs.push({ name, mtime: st.mtimeMs })
  }
  dirs.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1))
  let removed = 0
  for (const d of dirs.slice(Math.max(0, keep - 1))) {
    rmSync(join(verifyDir, d.name), { recursive: true, force: true })
    removed++
  }
  return removed
}

/**
 * Row 151c (DEFECT-157-1): one line naming every listed page that has no image, and why; plus the bridge's note when
 * its pages are an approximation of the printed ones. null when every listed page has an image and none is approximate.
 */
export function pageImagesNote(listed: readonly number[], imaged: ReadonlySet<number>, wanted: readonly number[], run: Pick<HtmlPageImages, "pageCount"> & { approximate?: string | null }, printed: number): string | null {
  const parts: string[] = []
  const missing = listed.filter((n) => !imaged.has(n))
  if (missing.length > 0) {
    const notWanted = missing.filter((n) => !wanted.includes(n))
    const beyond = missing.filter((n) => wanted.includes(n) && n > run.pageCount)
    const other = missing.filter((n) => wanted.includes(n) && n <= run.pageCount)
    if (notWanted.length) parts.push(`pages ${notWanted.join(",")} not imaged (at most 12 images per render)`)
    if (beyond.length) parts.push(`pages ${beyond.join(",")} not imaged (the image layout has ${run.pageCount} pages, the print has ${printed})`)
    if (other.length) parts.push(`pages ${other.join(",")} not imaged (the bridge returned no image)`)
  }
  if (run.approximate) parts.push(`images approximate: ${run.approximate}`)
  return parts.length ? parts.join("; ").slice(0, 400) : null
}

/** `STUDIO_VERIFY_BUDGET_MS` (spec §4), else 120 000 ms. A bad value falls back to the default. */
export function verifyBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.STUDIO_VERIFY_BUDGET_MS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : VERIFY_BUDGET_DEFAULT_MS
}

export function isVerifyFormat(v: unknown): v is VerifyFormat {
  return typeof v === "string" && FORMATS.has(v)
}

/** An UNKNOWN check with a reason (basis from the fixed matrix; NOT_APPLICABLE cells stay NOT_APPLICABLE). */
export function unknownCheck(id: VerifyCheckId, format: VerifyFormat, reason: VerifyUnknownReason): VerifyCheck {
  const basis = VERIFY_MATRIX[id][format]
  if (basis === "NOT_APPLICABLE") return notApplicableCheck(id)
  return { id, status: "UNKNOWN", basis: basis as VerifyBasis, reason, findings: [], truncated: 0, ms: 0 }
}

/** Spec §2: verified if and only if every check that is not NOT_APPLICABLE is PASS (UNKNOWN is never a pass). */
export function outputState(checks: readonly VerifyCheck[]): OutputVerificationState {
  return checks.every((c) => c.status === "PASS" || c.status === "NOT_APPLICABLE") ? "verified" : "unverified"
}

/** Every check UNKNOWN with one reason (verification threw, or its records could not be stored: §6.1). */
export function allUnknownOutput(o: Pick<VerifyOutputFile, "id" | "format" | "role" | "figureLabel" | "sha256">, reason: VerifyUnknownReason): VerifiedOutput {
  const checks = VERIFY_CHECK_ORDER.map((id) => unknownCheck(id, o.format, reason))
  return { outputId: o.id, format: o.format, role: o.role, figureLabel: o.figureLabel, sha256: o.sha256, state: outputState(checks), checks, pages: [] }
}

/** Page choice of spec §11 GAP-1: pages with findings first, then first and last, then evenly spaced; at most `max`. */
export function choosePages(pageCount: number, findingPages: Iterable<number>, max = VERIFY_MAX_PAGE_IMAGES): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) return []
  const out: number[] = []
  const add = (n: number) => {
    if (out.length < max && Number.isInteger(n) && n >= 1 && n <= pageCount && !out.includes(n)) out.push(n)
  }
  for (const n of [...new Set(findingPages)].sort((a, b) => a - b)) add(n)
  add(1)
  add(pageCount)
  const free = max - out.length
  if (free > 0 && pageCount > out.length) {
    const step = pageCount / (free + 1)
    for (let i = 1; i <= free; i++) add(Math.round(i * step))
    for (let n = 1; n <= pageCount && out.length < max; n++) add(n)
  }
  return out.sort((a, b) => a - b)
}

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)

/**
 * Row 58 (ST-9 item 1): the pages that carry a figure or chart, from what verification already has:
 * - the measured layout (`studio.measure`): each top-level svg is an element of kind `figure` and each img of kind
 *   `image`, with its 1-based `page`, the `data-address` of its wrapper and, for an svg, the `data-figure` label
 *   (vendor engine/browser/measure.ts:85-91, :226-233, :249-256; engine/html/tables/figure.ts:219-222);
 * - the revision snapshot: blocks of type chart, diagram, symbolSheet or image (`FIDELITY_FIGURE_TYPES`).
 * A block is on the page of the measured element with the same address, or whose label is the block's artifact label
 * or block id. No cap. Pure.
 */
/** @internal test seam */
export function figurePages(layout: LayoutInput, expected: FidelityExpectation | null): FigurePageSelection {
  if (!layout || !("metrics" in layout)) return { pages: [], basis: "none", unplaced: [], reason: "page count not measured" }
  const m = layout.metrics
  if (!m.paged) return { pages: [], basis: "none", unplaced: [], reason: "flow layout: the measure gives no page per figure" }
  const pageCount = Math.max(0, Math.trunc(m.pageCount))
  const els: Array<{ page: number; label: string; address: string | null }> = []
  for (const e of m.elements as Array<{ kind?: unknown; page?: unknown; label?: unknown; address?: unknown }>) {
    if (e.kind !== "figure" && e.kind !== "image") continue
    if (typeof e.page !== "number" || !Number.isInteger(e.page) || e.page < 1 || e.page > pageCount) continue
    els.push({ page: e.page, label: typeof e.label === "string" ? e.label : "", address: typeof e.address === "string" ? e.address : null })
  }
  const byPage = new Map<number, string[]>()
  const put = (page: number, name: string) => {
    const list = byPage.get(page) ?? []
    const n = cut(name, 80)
    if (n && !list.includes(n)) list.push(n)
    byPage.set(page, list)
  }
  const blocks = expected ? expected.blocks.filter((b) => FIDELITY_FIGURE_TYPES.has(b.type)) : null
  const unplaced: string[] = []
  let basis: FigurePageSelection["basis"] = "markup"
  if (blocks) {
    for (const b of blocks) {
      const name = b.artifactLabel || b.blockId || b.address
      const hits = els.filter((e) => (b.address && e.address === b.address) || (e.label !== "" && (e.label === b.artifactLabel || e.label === b.blockId)))
      if (hits.length === 0) unplaced.push(cut(String(name), 80))
      for (const h of hits) put(h.page, String(name))
    }
    // Figure blocks exist but none was located: the markers did not match, so fall back to the markup rather than
    // make no witness at all. No figure block and a readable snapshot: the document has no figure.
    if (blocks.length === 0 || byPage.size > 0) basis = "snapshot"
  }
  if (basis === "markup") for (const e of els) put(e.page, e.label || e.address || "figure")
  const pages = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([page, figures]) => ({ page, figures }))
  return { pages, basis, unplaced: basis === "snapshot" ? unplaced : [], reason: m.truncated ? "measure truncated: figure pages may be incomplete" : null }
}

/**
 * Row 58: the witness list a render left in `<storeRoot>/verify/<htmlOutputId>/witness.json`, or null when there is
 * none (never rendered with images, or the folder was pruned: only the newest VERIFY_IMAGES_KEEP folders stay).
 * Entries whose PNG no longer exists as a plain file inside that folder are dropped into `missing`, so every
 * `pages[].png` returned is an existing path. Never throws.
 */
export function readWitnessManifest(storeRoot: string, htmlOutputId: string): WitnessManifest | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(htmlOutputId)) return null
  const dir = join(storeRoot, "verify", htmlOutputId)
  try {
    const st = lstatSync(join(dir, VERIFY_WITNESS_MANIFEST), { throwIfNoEntry: false })
    if (!st || !st.isFile() || st.size > 4 * 1024 * 1024) return null
    const j = JSON.parse(readFileSync(join(dir, VERIFY_WITNESS_MANIFEST), "utf8")) as WitnessManifest
    if (!j || j.$schema !== VERIFY_WITNESS_SCHEMA || !Array.isArray(j.pages) || !Array.isArray(j.missing)) return null
    const pages: WitnessPage[] = []
    const missing = new Set<number>(j.missing.filter((n) => Number.isInteger(n) && n >= 1))
    for (const p of j.pages) {
      if (!p || !Number.isInteger(p.page) || p.page < 1 || typeof p.png !== "string") continue
      // The image is always `<dir>/pNNN.png`: the stored path is not trusted for anything but its file name.
      const name = /(?:^|[\\/])(p\d{3,6}\.png)$/.exec(p.png)?.[1]
      const f = name ? lstatSync(join(dir, name), { throwIfNoEntry: false }) : undefined
      if (name && f && f.isFile()) pages.push({ page: p.page, png: join(dir, name), figures: Array.isArray(p.figures) ? p.figures.filter((x) => typeof x === "string").map((x) => cut(x, 80)) : [] })
      else missing.add(p.page)
    }
    return {
      $schema: VERIFY_WITNESS_SCHEMA,
      documentId: String(j.documentId),
      revisionNo: Number(j.revisionNo),
      htmlOutputId,
      dpi: Number(j.dpi),
      basis: j.basis === "snapshot" || j.basis === "markup" ? j.basis : "none",
      pages,
      missing: [...missing].sort((a, b) => a - b),
      unplaced: Array.isArray(j.unplaced) ? j.unplaced.filter((x) => typeof x === "string") : [],
      reason: typeof j.reason === "string" ? j.reason : null,
    }
  } catch {
    return null
  }
}

function text(bytes: Uint8Array | null): string | null {
  if (!bytes) return null
  try {
    return strFromU8(bytes)
  } catch {
    return null
  }
}

/** Race a bridge step against the rest of the budget; the loser is reported as BUDGET_EXCEEDED. */
async function withinBudget<T>(deadline: number, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  const left = deadline - Date.now()
  if (left <= 0) return { ok: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), left)
  })
  try {
    const p = work().then((value) => ({ ok: true as const, value }))
    p.catch(() => undefined)
    return await Promise.race([p, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Per page: the findings of every check on that page (row 150's pages[] counts PAGE_COUNT only). */
function pagesOf(pages: readonly VerifyPage[], checks: readonly VerifyCheck[]): VerifyPage[] {
  return pages.map((p) => ({ n: p.n, png: p.png, findings: checks.reduce((k, c) => k + c.findings.filter((f) => f.page === p.n).length, 0) }))
}

/**
 * Verify every output of one render job (spec §3 over the §3.7 matrix). Pure over its inputs apart from the bridge
 * (measure, overlap script, page images) and the page-image folder.
 */
export async function verifyOutputs(input: VerifyJobInput, opts: VerifyOptions = {}): Promise<VerifyJobResult> {
  const t0 = Date.now()
  const deadline = t0 + (opts.budgetMs ?? verifyBudgetMs())
  const read = (o: VerifyOutputFile | undefined): Uint8Array | null => (o?.bytes ? (opts.fault ? opts.fault(o.format, o.bytes) : o.bytes) : null)

  const primaryHtml = input.outputs.find((o) => o.format === "HTML" && o.role === "PRIMARY") ?? input.outputs.find((o) => o.format === "HTML")
  const html = text(read(primaryHtml))
  let expected: FidelityExpectation | null = null
  try {
    expected = fidelityExpectationFromSnapshot(input.snapshot)
  } catch {
    expected = null
  }

  // OVERLAP_CLIP + the measured layout: once, on the job's HTML (PDF reuses it as same-job-html).
  let bridgeJobs = 0
  let htmlOverlap: OverlapClipResult | null = null
  let layout: LayoutInput = null
  if (primaryHtml && html) {
    const run = await withinBudget(deadline, () => runOverlapClip({ format: "HTML", html, ...VERIFY_PAGE_MM, limits: input.limits }, opts.overlapDeps))
    if (run.ok) {
      htmlOverlap = run.value
      layout = run.value.layout
      bridgeJobs += run.value.bridgeJobs
    } else {
      layout = { unknown: "BUDGET_EXCEEDED" }
    }
  }
  const overlapFor = (format: VerifyFormat): VerifyCheck => {
    if (format !== "HTML" && format !== "PDF") return notApplicableCheck("OVERLAP_CLIP")
    if (!html) return unknownCheck("OVERLAP_CLIP", format, "SOURCE_MISSING")
    if (!htmlOverlap) return unknownCheck("OVERLAP_CLIP", format, "BUDGET_EXCEEDED")
    return { ...htmlOverlap.check, basis: format === "HTML" ? "self" : "same-job-html" }
  }

  const outputs: VerifiedOutput[] = []
  for (const o of input.outputs) {
    const own = read(o)
    let svg: string | null = null
    let figureKind: string | null = null
    if (o.format === "SVG" || o.format === "PNG") {
      const src = o.format === "SVG" ? o : input.outputs.find((x) => x.format === "SVG" && x.figureLabel === o.figureLabel)
      svg = text(read(src))
      figureKind = expected ? figureBlockFor(expected, o.figureLabel)?.type ?? null : null
    }
    const st = runStaticChecks({
      format: o.format,
      lint: { lintReport: input.lintReport, lintVerdict: o.lintVerdict, tier: input.tier },
      completeness: { completeness: input.completeness, completenessReport: input.completenessReport },
      html,
      bytes: own,
      svg,
      figureKind,
      figureLabel: o.figureLabel,
      layout: o.format === "SVG" || o.format === "PNG" ? null : layout,
      limits: input.limits,
    })
    const fidelitySource = o.format === "HTML" || o.format === "PDF" ? html : o.format === "DOCX" ? own : svg
    const fidelity = expected
      ? checkFidelity({ format: o.format, source: fidelitySource, expected, figureLabel: o.figureLabel })
      : unknownCheck("FIDELITY", o.format, "SOURCE_MISSING")
    const byId: Partial<Record<VerifyCheckId, VerifyCheck>> = { ...st.checks, OVERLAP_CLIP: overlapFor(o.format), FIDELITY: fidelity }
    const checks = VERIFY_CHECK_ORDER.map((id) => (VERIFY_MATRIX[id][o.format] === "NOT_APPLICABLE" ? notApplicableCheck(id) : byId[id] ?? unknownCheck(id, o.format, "VERIFY_INTERNAL")))
    outputs.push({
      outputId: o.id,
      format: o.format,
      role: o.role,
      figureLabel: o.figureLabel,
      sha256: o.sha256,
      state: outputState(checks),
      checks,
      pages: o.format === "HTML" || o.format === "PDF" ? pagesOf(st.pages, checks) : [],
    })
  }

  // Page images of the job's HTML (row 151b; row 58: every figure page, in batches). Never a check: failure leaves
  // png null and says why.
  let pageImages: VerifyJobResult["pageImages"] = { made: 0, reason: null }
  let witness: WitnessManifest | null = null
  const pageCount = layout && "metrics" in layout ? layout.metrics.pageCount : 0
  const imager = opts.pageImages === undefined ? rasterizeHtmlPages : opts.pageImages
  if (!primaryHtml) pageImages.reason = "no HTML output in this render"
  else if (imager === null) pageImages.reason = "page images are off"
  else if (!input.storeRoot || !primaryHtml.absPath) pageImages.reason = "no stored HTML path"
  else if (!(pageCount >= 1)) pageImages.reason = "page count not measured"
  else {
    const findingPages = outputs.filter((v) => v.format === "HTML" || v.format === "PDF").flatMap((v) => v.pages.filter((p) => p.findings > 0).map((p) => p.n))
    const figures = figurePages(layout, expected)
    const figureNs = figures.pages.map((p) => p.page)
    // Figure pages first (they are the witnesses and must win the budget), then the general pages of row 151b.
    const want = [...figureNs, ...choosePages(pageCount, findingPages).filter((n) => !figureNs.includes(n))]
    const dstDir = `${input.storeRoot.replace(/\/+$/, "")}/verify/${primaryHtml.id}`
    const byN = new Map<number, string>()
    let stopped: string | null = null
    let first: (Pick<HtmlPageImages, "pageCount" | "dpi"> & { approximate?: string | null }) | null = null
    try {
      mkdirSync(dstDir, { recursive: true })
      const src = primaryHtml.absPath
      // One bridge request per batch; each batch's images are on disk before the next starts, and only their paths
      // are kept here, so the number of figure pages does not grow this process's memory.
      for (let i = 0; i < want.length && stopped === null; i += VERIFY_PAGE_IMAGE_BATCH) {
        const batch = want.slice(i, i + VERIFY_PAGE_IMAGE_BATCH).sort((a, b) => a - b)
        try {
          const run = await withinBudget(deadline, () => imager({ src, dstDir, pages: batch, dpi: VERIFY_WITNESS_DPI }))
          if (!run.ok) stopped = "BUDGET_EXCEEDED"
          else {
            bridgeJobs += 1
            if (!first) first = { pageCount: run.value.pageCount, dpi: run.value.dpi, approximate: run.value.approximate ?? null }
            for (const p of run.value.pages) if (batch.includes(p.n)) byN.set(p.n, p.png)
          }
        } catch (e) {
          stopped = unknownReasonFor(e)
        }
      }
      for (const v of outputs) for (const p of v.pages) p.png = byN.get(p.n) ?? null
      const listed = [...new Set(outputs.flatMap((v) => v.pages.map((p) => p.n)))].sort((a, b) => a - b)
      const missing = figureNs.filter((n) => !byN.has(n))
      const parts: string[] = []
      if (missing.length > 0) parts.push(`figure pages ${missing.join(",")} have no witness image (${stopped ?? "the bridge returned no image"})`)
      if (figures.reason) parts.push(figures.reason)
      if (figures.basis === "markup" && figureNs.length > 0) parts.push("figure pages taken from the markup (every svg or img)")
      if (figures.unplaced.length > 0) parts.push(`${figures.unplaced.length} figure blocks not found on a page`)
      // Row 151c's note names the other listed pages without an image; the figure-page lines come first so the
      // 400-character cut never drops them. After a stop the pages not reached are covered by the stop reason.
      if (stopped && byN.size > 0) parts.push(`imaging stopped before every page was made (${stopped})`)
      const base = first ? pageImagesNote(stopped ? [] : listed.filter((n) => !missing.includes(n)), new Set(byN.keys()), want, first, pageCount) : null
      if (base) parts.push(base)
      const note = parts.length ? parts.join("; ").slice(0, 400) : null
      pageImages = { made: byN.size, reason: byN.size > 0 ? null : stopped ?? "the bridge returned no page image", note }
      witness = {
        $schema: VERIFY_WITNESS_SCHEMA,
        documentId: input.documentId,
        revisionNo: input.revisionNo,
        htmlOutputId: primaryHtml.id,
        dpi: first && Number.isFinite(first.dpi) ? first.dpi : VERIFY_WITNESS_DPI,
        basis: figures.basis,
        pages: figures.pages.filter((p) => byN.has(p.page)).map((p) => ({ page: p.page, png: byN.get(p.page)!, figures: p.figures })),
        missing,
        unplaced: figures.unplaced,
        reason: missing.length > 0 ? stopped ?? "the bridge returned no image" : figures.reason,
      }
      try {
        writeFileSync(join(dstDir, VERIFY_WITNESS_MANIFEST), JSON.stringify(witness))
      } catch {
        // The list is still returned to the caller; only the later lookup (row 59) finds nothing and says so.
        pageImages.note = [pageImages.note, "witness list not stored"].filter(Boolean).join("; ").slice(0, 400)
      }
      try {
        pruneVerifyImages(join(input.storeRoot, "verify"), primaryHtml.id)
      } catch {
        // Clean-up is best effort; the next render prunes again (row 151c L5).
      }
    } catch (e) {
      pageImages.reason = unknownReasonFor(e)
    }
  }

  const layoutKind: OutputVerificationReport["layout"] = layout && "metrics" in layout ? (layout.metrics.paged ? "paged" : "flow") : "none"
  const layoutWitness = outputs.some((v) => v.role === "PRIMARY" && (v.format === "PDF" || v.format === "HTML") && v.state === "verified") || input.priorLayoutWitness === true
  const allVerified = outputs.length > 0 && outputs.every((v) => v.state === "verified")
  const report: OutputVerificationReport = {
    $schema: OUTPUT_VERIFICATION_SCHEMA,
    checksVersion: OUTPUT_VERIFICATION_CHECKS_VERSION,
    documentId: input.documentId,
    revisionNo: input.revisionNo,
    renderJobId: input.renderJobId,
    scope: input.scope,
    draft: input.draft,
    layout: layoutKind,
    formatsAdded: input.formatsAdded,
    layoutWitness,
    overall: allVerified && (input.scope !== "DOCUMENT" || layoutWitness) ? "verified" : "unverified",
    outputs,
    bridgeJobs,
    ms: Date.now() - t0,
  }
  return { report, pageImages, witness }
}
