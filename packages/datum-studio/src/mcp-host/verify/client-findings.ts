/**
 * Row 206 (1.2.3 patch, AC-2..AC-5): the checks of every unverified output reach the client in the TEXT result.
 *
 * Swarm's handoff (2026-11-09): studio_render said only `fail=LINT,OVERLAP_CLIP` and "read structuredContent.verification",
 * which an MCP client that shows the short text never sees; the mission done gate's OUTPUT_UNVERIFIED named reasons
 * (CHECK_FAILED) but no check. The row 154 design (108_row154_render_verify_wrapper.md:18) meant the report to be
 * readable. This module turns a stored or fresh `VerifyCheck[]` into compact entries
 * `{check, verdict, page, address, measured, expected, rule, message}`:
 *
 * - every UNKNOWN check is exactly ONE entry (verdict UNKNOWN, rule = the reason): the count of UNKNOWN entries of an
 *   output equals the `unknown=` list of its summary line (AC-3), and UNKNOWN entries are never cut by the cap;
 * - every FAIL check gives one entry per finding, at most FAIL_PER_CHECK per check and ENTRIES_PER_OUTPUT per output,
 *   and at least one entry (AC-4: a failing check is never printed without what failed); the rest is counted in `more`;
 * - LINT findings carry the lint rule's plain explanation (vendor registry/lint-explain.ts) and the registry limit.
 *
 * Document-derived parts (address, label, engine messages that quote labels or text) are untrusted: the text form
 * is one fenced block made by the vendor's `untrustedBlock` (MCP-D4), as every other server text.
 */
import { tok, untrustedBlock } from "../../../vendor/scripts/studio/mcp/tool-kit"
import { getLintDef } from "../../../vendor/src/lib/studio/registry/lint"
import { lintRuleExplanation } from "../../../vendor/src/lib/studio/registry/lint-explain"
import type { VerifyCheck, VerifyCheckId, VerifyFinding } from "./types.ts"
import { overlapCoverageText } from "./overlap-clip.ts"

export const FAIL_PER_CHECK = 4
export const ENTRIES_PER_OUTPUT = 12
const MESSAGE_MAX = 300
/**
 * Row 210 (security review 209 M-1): total size of the fenced block body, measured as printed (NFKC, every "<" or
 * look-alike counted as its 4-character escape). A refusal over 20 deliverables x N outputs stays bounded; the entries
 * not printed are counted in one closing `(+N more check entries in structuredContent)` line, never silent.
 */
export const CLIENT_FINDINGS_BLOCK_MAX = 16_000
/** The "<" look-alikes the vendor block escape turns into `&lt;` (tool-kit.ts LT_LIKE), for the printed-size estimate. */
const LT_LIKE = /[<＜﹤〈〈⟨❬❮‹˂]/g
const printedSize = (line: string): number => {
  const n = line.normalize("NFKC")
  return n.length + 3 * (n.match(LT_LIKE)?.length ?? 0) + 1
}
/** Row 210 (L-2): head-line ids are safe tokens or "?"; a format made of several words is checked word by word. */
const safeWords = (s: string): string => s.split(" ").map((w) => tok(w, "?")).join(" ")

export interface ClientCheckEntry {
  check: VerifyCheckId | string
  /** "NOT_RUN" (1.3.3 row 67): a lint rule or module that did not run; made only by `outputGateFindings`. */
  verdict: "FAIL" | "UNKNOWN" | "NOT_RUN"
  page: number | null
  address: string | null
  measured: string | null
  expected: string | null
  rule: string
  message: string
}

/** What each finding code means and what the check expected (source: the code that raises it, verify/*.ts). */
const CODES: Readonly<Record<string, { rule: string; expected: string | null; unit?: string }>> = {
  OVERFLOW_RIGHT: { rule: "OVERLAP_CLIP/OVERFLOW_RIGHT (DATUM-37): an element runs past the right edge of the printed sheet", expected: "0 mm past the right edge", unit: "mm past the edge" },
  OVERFLOW_BOTTOM: { rule: "OVERLAP_CLIP/OVERFLOW_BOTTOM (DATUM-37): an element runs below the page register of its sheet", expected: "0 mm past the bottom edge", unit: "mm past the edge" },
  BOX_CLIP: { rule: "OVERLAP_CLIP/BOX_CLIP: content is wider than its own box and is cut off", expected: "content fits its box", unit: "mm wider than the box" },
  TABLE_OVERFLOW: { rule: "OVERLAP_CLIP/TABLE_OVERFLOW: a table is wider than its container", expected: "table width <= container width", unit: "mm table width" },
  OVERLAP: { rule: "OVERLAP_CLIP/OVERLAP: two boxes with ink (text, figure, table) overlap on the printed page", expected: "0 mm2 overlap", unit: "mm2 overlap" },
  UNBREAKABLE_TOO_TALL: { rule: "OVERLAP_CLIP/UNBREAKABLE_TOO_TALL: an element that cannot break is taller than the page content height", expected: "height <= page content height", unit: "mm too tall" },
  BLOCK_MISSING: { rule: "FIDELITY/BLOCK_MISSING: a block of the revision is not in the output", expected: "every block of the revision printed" },
  NUMBER_CHANGED: { rule: "FIDELITY/NUMBER_CHANGED: a number in the output differs from the revision", expected: "numbers equal to the revision" },
  TABLE_CELL_CHANGED: { rule: "FIDELITY/TABLE_CELL_CHANGED: a table cell differs from the revision", expected: "cells equal to the revision" },
  TABLE_SHAPE: { rule: "FIDELITY/TABLE_SHAPE: the printed table has other rows x columns than the revision", expected: "same rows x columns", unit: "cells off" },
  LABEL_MISSING: { rule: "FIDELITY/LABEL_MISSING: a figure label of the spec is not drawn", expected: "every label drawn" },
  PAGE_COUNT_MISMATCH: { rule: "PAGE_COUNT/PAGE_COUNT_MISMATCH: the PDF has another page count than the same-job HTML", expected: "pdf pages = html pages", unit: "pages difference" },
  NO_PAGES: { rule: "PAGE_COUNT/NO_PAGES: the output has no page", expected: ">= 1 page" },
  BLANK_PAGE: { rule: "PAGE_COUNT/BLANK_PAGE: a sheet has no text, figure, image or table", expected: "no blank sheet" },
  FIG_GEOMETRY: { rule: "FIGURE_FIT/FIG_GEOMETRY: the figure's geometry lint failed (labels outside cells, overlaps)", expected: "figure geometry clean" },
  FIG_TOO_TALL: { rule: "FIGURE_FIT/FIG_TOO_TALL (DATUM-33): a figure is taller than the text block", expected: "height <= text block height", unit: "mm" },
  SLOT_EMPTY: { rule: "EMPTY_SLOTS/SLOT_EMPTY: a required slot is empty or partial", expected: "required slots filled" },
  FIGURE_PLACEHOLDER: { rule: "EMPTY_SLOTS/FIGURE_PLACEHOLDER: a figure block printed without its graphic", expected: "every figure has its svg or image" },
  PLACEHOLDER_IN_OUTPUT: { rule: "EMPTY_SLOTS/PLACEHOLDER_IN_OUTPUT: a draft placeholder is printed in the output", expected: "no placeholder" },
}

/** Plain meaning of each UNKNOWN reason (types.ts VerifyUnknownReason). */
const UNKNOWN_REASONS: Readonly<Record<string, string>> = {
  BRIDGE_UNAVAILABLE: "the render bridge (the app's hidden browser) could not measure the output; the check cannot pass until it can",
  QUEUE_FULL: "the render bridge queue was full; render again",
  TIMEOUT: "the measure timed out; render again",
  BUDGET_EXCEEDED: "verification ran out of its time budget (STUDIO_VERIFY_BUDGET_MS); render again",
  MEASURE_TRUNCATED: "the layout has more elements than the measure lists; the result is incomplete",
  LINT_NOT_RUN: "the revision has no lint result (lint did not run on this render)",
  LINT_PARTIAL: "a render lint check that applies at this tier was NOT_RUN; see the lint findings of studio_document_status detail",
  SOURCE_MISSING: "the measured source of this output (same-job HTML or SVG) is missing; render with html (or svg) as well",
  PARSE_FAILED: "the output could not be parsed",
  NO_GEOMETRY_LINT: "the figure kind has no geometry lint",
  MARGINS_UNREADABLE: "the page margins could not be read from the output",
  NUMBER_UNPARSED: "a number could not be read for comparison",
  VERIFY_INTERNAL: "verification failed internally (see the host log); the output stays unverified",
  FLOW_LAYOUT_UNMEASURABLE:
    "the flow page was laid out narrower than the sheet (for example a scrollbar took width), so a right-edge overflow cannot be judged against the printed sheet; render again (1.2.3 renders without scrollbars)",
}

const cut = (s: string, n = MESSAGE_MAX): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function lintEntry(f: VerifyFinding): ClientCheckEntry {
  // Row 206: LINT findings carry the lint check id in `label` and the engine message in `detail` ("<id>: <message>").
  const id = f.label ?? f.detail.split(":")[0]!.trim()
  const def = getLintDef(id)
  return {
    check: "LINT",
    verdict: "FAIL",
    page: f.page,
    address: f.address,
    measured: null,
    expected: def ? def.limit : null,
    rule: lintRuleExplanation(id) ?? id,
    message: cut(f.detail),
  }
}

function findingEntry(c: CheckLike, f: VerifyFinding): ClientCheckEntry {
  if (c.id === "LINT") return lintEntry(f)
  const meta = CODES[f.code]
  const measured = typeof f.amount === "number" ? `${f.amount}${meta?.unit ? ` ${meta.unit}` : ""}` : null
  return {
    check: c.id,
    verdict: "FAIL",
    page: f.page,
    address: f.address,
    measured,
    expected: meta?.expected ?? null,
    rule: meta?.rule ?? `${c.id}/${f.code}`,
    message: cut(f.label ? `${f.label}: ${f.detail}` : f.detail),
  }
}

/** The parts of a check this module reads (a fresh VerifyCheck or a stored refusal check). */
export type CheckLike = Pick<VerifyCheck, "id" | "status" | "reason" | "findings"> & { truncated?: number; coverage?: unknown }

/** Entries for one output's checks; `more` = FAIL findings not listed (cap), counted, never silent. */
export function clientEntries(checks: readonly CheckLike[]): { entries: ClientCheckEntry[]; more: number; coverage: string | null } {
  const unknown: ClientCheckEntry[] = []
  const failing: ClientCheckEntry[] = []
  let more = 0
  for (const c of checks) {
    if (c.status === "UNKNOWN") {
      const reason = c.reason ?? "UNKNOWN"
      unknown.push({ check: c.id, verdict: "UNKNOWN", page: null, address: null, measured: null, expected: null, rule: reason, message: UNKNOWN_REASONS[reason] ?? "the check could not be measured; the output stays unverified" })
    } else if (c.status === "FAIL") {
      const list = c.findings.length > 0 ? c.findings : [{ code: `${c.id}_FAIL`, page: null, address: null, label: null, detail: `${c.id} failed without a listed finding` } satisfies VerifyFinding]
      const shown = list.slice(0, FAIL_PER_CHECK)
      failing.push(...shown.map((f) => findingEntry(c, f)))
      more += list.length - shown.length + (c.truncated ?? 0)
    }
  }
  // UNKNOWN entries are never cut (AC-3); FAIL entries share the rest of the per-output budget, one per check at least.
  const room = Math.max(ENTRIES_PER_OUTPUT - unknown.length, new Set(failing.map((e) => e.check)).size)
  const keep: ClientCheckEntry[] = []
  const seen = new Set<string>()
  for (const e of failing) if (!seen.has(String(e.check))) (seen.add(String(e.check)), keep.push(e))
  for (const e of failing) if (keep.length < room && !keep.includes(e)) keep.push(e)
  more += failing.length - keep.length
  const order = new Map(failing.map((e, i) => [e, i]))
  keep.sort((a, b) => order.get(a)! - order.get(b)!)
  // 1.2.6 INT-1 (row 30, T-13 / N-032): the OVERLAP_CLIP coverage text ("diukur m/n halaman") of this output, if any.
  const overlap = checks.find((c) => c.id === "OVERLAP_CLIP")
  return { entries: [...keep, ...unknown], more, coverage: overlap ? overlapCoverageText(overlap) : null }
}

export interface ClientOutputChecks {
  format: string
  outputId: string | null
  entries: ClientCheckEntry[]
  more: number
  /** 1.2.6 INT-1: OVERLAP_CLIP coverage text (overlapCoverageText), printed on the output's head line. */
  coverage?: string | null
  /** 1.3.3 row 67: summary lines ("kurang ...", "info ...") printed under the head line, before the entries. */
  lines?: readonly string[]
}

/**
 * The fenced text block: per output a head line and one JSON object per entry. Empty string when nothing to say.
 * Row 210: the body is capped at CLIENT_FINDINGS_BLOCK_MAX (printed size); the rest is counted in a final line.
 */
export function clientFindingsBlock(outputs: readonly ClientOutputChecks[], attrs: Record<string, string> = {}): string {
  const body: string[] = []
  let size = 0
  let notShown = 0
  // Concise: a long rule explanation is printed once per block; later entries of the same rule point back to it.
  const explained = new Set<string>()
  for (const o of outputs) {
    const lines = o.lines ?? []
    if (o.entries.length === 0 && lines.length === 0) continue
    const head = `${safeWords(o.format)} ${o.outputId === null ? "-" : tok(o.outputId, "?")}:${o.entries.length === 0 ? "" : ` ${o.entries.length} check entr${o.entries.length === 1 ? "y" : "ies"}`}${o.more > 0 ? ` (+${o.more} more findings in structuredContent)` : ""}${o.coverage ? `; OVERLAP_CLIP ${o.coverage}` : ""}`
    if (notShown > 0 || size + printedSize(head) > CLIENT_FINDINGS_BLOCK_MAX) {
      notShown += o.entries.length
      continue
    }
    body.push(head)
    size += printedSize(head)
    for (const l of lines) {
      const line = cut(l, 600)
      if (size + printedSize(line) > CLIENT_FINDINGS_BLOCK_MAX) break
      body.push(line)
      size += printedSize(line)
    }
    for (const e of o.entries) {
      const long = e.rule.length > 100
      const rule = long && explained.has(e.rule) ? `${e.rule.split(" ")[0]} (rule explained above)` : e.rule
      const line = JSON.stringify({ ...e, rule })
      if (notShown > 0 || size + printedSize(line) > CLIENT_FINDINGS_BLOCK_MAX) {
        notShown++
        continue
      }
      if (long) explained.add(e.rule)
      body.push(line)
      size += printedSize(line)
    }
  }
  if (notShown > 0) body.push(`(+${notShown} more check entries in structuredContent)`)
  return body.length ? untrustedBlock(body.join("\n"), { jenis: "verifikasi-temuan", ...attrs }) : ""
}

/** Stored report (output_verification.report) -> its checks, read defensively (store rows are JSON text). */
export function checksOfReport(report: unknown): VerifyCheck[] {
  let r = report
  if (typeof r === "string") {
    try {
      r = JSON.parse(r)
    } catch {
      return []
    }
  }
  if (!r || typeof r !== "object" || !Array.isArray((r as { checks?: unknown }).checks)) return []
  return ((r as { checks: unknown[] }).checks as VerifyCheck[]).filter(
    (c) => c && typeof c === "object" && typeof c.id === "string" && typeof c.status === "string" && Array.isArray(c.findings),
  )
}

// ── 1.3.3 row 67 (MC-5): OUTPUT_UNVERIFIED says, per output, exactly what is missing ──────────────────────────────
//
// The gate (store/mission/output-gate.ts) decides WHEN a row is refused; nothing here changes that. This part turns
// the gate's per-output reason and stored checks, plus the facts the gate or the host can add (lint rules that did
// not run, figure pages without a witness image, a pending human check), into:
//   - `verified`: boolean per output;
//   - `missing[]`: the reasons an AGENT can act on, each `{kind, ...ids, fix}` where `fix` is the ONE tool to call;
//   - `info[]`: what is true but not agent-fixable (a person checks the labels); never counted as missing.
// Every string of `missing` and `info` is a safe token (kind, rule id, tool name) or a number, because the mission
// refusal prints them outside the fenced block (tool-result.ts `safeBrief`). Sentences (the hint of each fix, the
// reason a lint rule did not run) go into the fenced block and into `checks` entries (verdict NOT_RUN), which the
// refusal already marks untrusted.

/** One entry of `LintReport.notRun` (row 64, vendor services/render/lint.ts `LintNotRun`), read defensively. */
export interface LintNotRunLike {
  id: string
  kind: "rule" | "module"
  reason: string
  cause: "tier" | "not-applicable" | "human" | "staged" | "could-not-run"
}

/** The witness facts of one deliverable revision (row 58 `readWitnessManifest`: `missing`, `unplaced`). */
export interface OutputGateWitnessFacts {
  htmlOutputId?: string | null
  missing: readonly number[]
  unplaced?: readonly string[]
}

/**
 * Facts the gate's details do not carry by themselves. A caller with store access passes them (second argument of
 * `outputGateFindings`) or registers them once (`setOutputGateFacts`); the same facts embedded in the details
 * (`deliverable.lintNotRun`, `deliverable.witness`, `deliverable.awaitingHumanCheck`, `details.awaitingHumanCheck`,
 * `output.fileMissing`) win over these. Absent fact = "not known": the detail then says so, it never guesses.
 */
export interface OutputGateFacts {
  /** `notRun` of the parsed lint report of that revision; null/undefined = no list (older report, or not read). */
  lintNotRun?(documentId: string, revisionNo: number): readonly LintNotRunLike[] | null | undefined
  /** Witness list of that revision's newest PRIMARY HTML render; null/undefined = no list. */
  witness?(documentId: string, revisionNo: number): OutputGateWitnessFacts | null | undefined
  /** false = the stored file of that output is not on disk; null/undefined = not checked. */
  fileExists?(outputId: string): boolean | null | undefined
}

let registeredFacts: OutputGateFacts | null = null
/** Registers (or clears, with null) the facts source used when `outputGateFindings` gets no second argument. */
export function setOutputGateFacts(facts: OutputGateFacts | null): void {
  registeredFacts = facts
}

export type OutputGateMissingKind =
  | "file-missing"
  | "sha256-mismatch"
  | "not-checked"
  | "no-layout-witness"
  | "lint-failed"
  | "lint-not-run"
  | "witness-missing"
  | "check-failed"
  | "check-unknown"

/** One agent-fixable reason. Strings are safe tokens only (see the section head). */
export interface OutputGateMissing {
  kind: OutputGateMissingKind
  /** lint-failed: the failing lint rule ids; lint-not-run: the rule ids that did not run (cause staged / could-not-run). */
  rules?: string[]
  /** Rule ids not listed (cap OUTPUT_GATE_IDS_MAX). */
  moreRules?: number
  /** lint-not-run: whole lint modules that did not run (scan, structure, language, render). */
  modules?: string[]
  /** lint-not-run: the causes present in `rules` + `modules` ("staged", "could-not-run"). */
  causes?: string[]
  /** lint-not-run: false when the lint report carries no `notRun` list, so the ids are not known here. */
  listed?: boolean
  /** lint-not-run: the output of the same deliverable whose `checks` carry the reason of each rule. */
  reasonsAt?: string
  /** witness-missing: the figure pages without a witness image. */
  pages?: number[]
  morePages?: number
  /** check-failed / check-unknown: the verification checks (OVERLAP_CLIP, FIDELITY, ...). */
  checks?: string[]
  /** check-unknown: the reasons of those checks (BRIDGE_UNAVAILABLE, ...). */
  reasons?: string[]
  /** no-layout-witness: the listed PDF / HTML outputs whose verification would lift it. */
  because?: string[]
  /** The one tool to call. */
  fix: string
}

/** Not agent-fixable: shown as information, never as something missing. */
export interface OutputGateInfo {
  kind: "awaiting-human-check" | "human-rule"
  /** awaiting-human-check: the register vocabulary (`labels_verified`). */
  checks?: string[]
  /** The lint rule ids that report it (D09, P1-labels_verified) or that only a person runs. */
  rules?: string[]
  moreRules?: number
}

export const OUTPUT_GATE_IDS_MAX = 20
export const OUTPUT_GATE_PAGES_MAX = 60
/** NOT_RUN reason entries printed per deliverable (the ids are all in `missing[].rules`, up to OUTPUT_GATE_IDS_MAX). */
export const NOT_RUN_ENTRIES_PER_DELIVERABLE = 12

/** Lint rules that only say "a person has not checked the labels" (register section 7: D09, P1-labels_verified). */
const HUMAN_LABEL_RULES: ReadonlySet<string> = new Set(["D09", "P1-labels_verified"])
const LABELS_VERIFIED = "labels_verified"

/** The one call per reason kind (tool name) and its hint sentence (next-call hint style, printed in the block). */
const FIX: Readonly<Record<OutputGateMissingKind, { tool: string; hint: string }>> = {
  "file-missing": { tool: "studio_render", hint: "no output file of this revision exists: studio_render {documentId, formats} makes and verifies it" },
  "sha256-mismatch": { tool: "studio_render", hint: "the stored verification is for other bytes than this file (sha256 differs): studio_render again verifies the current file" },
  "not-checked": { tool: "studio_render", hint: "this file has no verification record: studio_render {documentId, formats} of the current revision verifies it" },
  "no-layout-witness": { tool: "studio_render", hint: "no verified PDF or HTML of this revision: studio_render with pdf or html; it lifts when one of them is verified" },
  "lint-failed": { tool: "studio_edit", hint: "fix the content at the addresses of the LINT entries below with studio_edit, then studio_render" },
  "lint-not-run": { tool: "studio_render", hint: "these lint rules did not run (reason per rule in the NOT_RUN entries): studio_render with html gives the render rules their input" },
  "witness-missing": { tool: "studio_render", hint: "these figure pages have no witness image: studio_render with html makes them; studio_witness_list {documentId} shows the result" },
  "check-failed": { tool: "studio_edit", hint: "fix what the FAIL entries below name with studio_edit, then studio_render" },
  "check-unknown": { tool: "studio_render", hint: "these checks could not be measured (reason in the UNKNOWN entries below): studio_render again" },
}
const FIX_STAGED = { tool: "studio_mission_request_decision", hint: "these lint rules have no scanner in this version, no call makes them run: ask the person with studio_mission_request_decision" }
const FIX_NOT_LISTED = { tool: "studio_document_status", hint: "the lint report has no list of the rules that did not run: studio_document_status {documentId, detail: true} lists the NOT_RUN lint checks; then studio_render with html" }
const HUMAN_HINT = "a person checks the diagram labels in Mission Control (labels_verified); an agent cannot set it and it is not something to fix here"

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const uniq = <T>(a: readonly T[]): T[] => [...new Set(a)]
const safeId = (v: unknown): string => tok(v, "?")
function capIds(ids: readonly string[]): { rules: string[]; moreRules?: number } {
  const all = uniq(ids.map(safeId))
  return all.length > OUTPUT_GATE_IDS_MAX ? { rules: all.slice(0, OUTPUT_GATE_IDS_MAX), moreRules: all.length - OUTPUT_GATE_IDS_MAX } : { rules: all }
}

const CAUSES: ReadonlySet<string> = new Set(["tier", "not-applicable", "human", "staged", "could-not-run"])
/** A `notRun` list read defensively (a stored lint report is JSON text written by another version). */
export function readLintNotRun(v: unknown): LintNotRunLike[] | null {
  if (!Array.isArray(v)) return null
  const out: LintNotRunLike[] = []
  for (const x of v) {
    if (!isRec(x) || typeof x.id !== "string" || (x.kind !== "rule" && x.kind !== "module") || typeof x.cause !== "string" || !CAUSES.has(x.cause)) continue
    out.push({ id: x.id, kind: x.kind, reason: typeof x.reason === "string" ? x.reason : "", cause: x.cause as LintNotRunLike["cause"] })
  }
  return out
}

function readWitness(v: unknown): OutputGateWitnessFacts | null {
  if (!isRec(v) || !Array.isArray(v.missing)) return null
  const missing = uniq((v.missing as unknown[]).filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1)).sort((a, b) => a - b)
  return { htmlOutputId: str(v.htmlOutputId), missing, unplaced: Array.isArray(v.unplaced) ? (v.unplaced as unknown[]).filter((u): u is string => typeof u === "string") : [] }
}

/** `awaitingHumanCheck` as the register writes it: an array of values, or the row object `{checks, clearedBy?}`. */
function awaitingChecks(v: unknown): string[] {
  if (Array.isArray(v)) return uniq(v.filter((x): x is string => typeof x === "string").map(safeId))
  if (isRec(v) && Array.isArray(v.checks) && (v.clearedBy === undefined || v.clearedBy === null)) return awaitingChecks(v.checks)
  return []
}

/** The detail of one output of a refused deliverable. */
export interface OutputGateOutputDetail {
  verified: boolean
  missing: OutputGateMissing[]
  info: OutputGateInfo[]
  /** NOT_RUN entries (rule id, cause, reason) wanted for this output; the caller prints them once per deliverable. */
  notRun: LintNotRunLike[]
}

export interface DeliverableFacts {
  lintNotRun: readonly LintNotRunLike[] | null
  witness: OutputGateWitnessFacts | null
  /** The listed PDF / HTML outputs (for `because` of no-layout-witness). */
  layoutOutputs: string[]
}

/**
 * Pure: the gate's entry of one output (`{outputId, format, state, reason, checks?}`, checks as STORED, before they
 * become client entries) -> verified / missing / info. Reason kinds, by what feeds the gate (output-gate.ts):
 *   NOT_RENDERED -> file-missing; NO_LAYOUT_WITNESS -> no-layout-witness; NOT_CHECKED -> not-checked;
 *   STALE -> sha256-mismatch; CHECK_FAILED -> lint-failed (LINT) and check-failed (others);
 *   CHECK_UNKNOWN -> lint-not-run (LINT) and check-unknown (others).
 */
export function outputGateOutputDetail(o: Record<string, unknown>, f: DeliverableFacts, fileExists?: boolean | null): OutputGateOutputDetail {
  const missing: OutputGateMissing[] = []
  const info: OutputGateInfo[] = []
  let notRun: LintNotRunLike[] = []
  if (o.state === "verified") return { verified: true, missing, info, notRun }
  const reason = str(o.reason)
  const add = (kind: OutputGateMissingKind, extra: Partial<OutputGateMissing> = {}) => missing.push({ kind, ...extra, fix: extra.fix ?? FIX[kind].tool })

  if (o.fileMissing === true || fileExists === false || reason === "NOT_RENDERED") add("file-missing")
  if (reason === "NO_LAYOUT_WITNESS") add("no-layout-witness", f.layoutOutputs.length ? { because: f.layoutOutputs } : {})
  if (reason === "NOT_CHECKED") add("not-checked")
  if (reason === "STALE") add("sha256-mismatch")

  const checks = Array.isArray(o.checks) ? (o.checks as CheckLike[]).filter((c) => isRec(c) && typeof c.id === "string") : []
  if (reason === "CHECK_FAILED" || reason === "CHECK_UNKNOWN") {
    const failed: string[] = []
    const unknown: string[] = []
    const unknownReasons: string[] = []
    for (const c of checks) {
      if (c.id === "LINT" && c.status === "FAIL") {
        const ids = (Array.isArray(c.findings) ? c.findings : []).map((x) => x.label ?? x.detail.split(":")[0]!.trim())
        const human = ids.filter((id) => HUMAN_LABEL_RULES.has(id))
        const agent = ids.filter((id) => !HUMAN_LABEL_RULES.has(id))
        // A LINT FAIL without a listed finding is still a lint failure: never dropped (row 206 AC-4).
        if (agent.length > 0 || human.length === 0) add("lint-failed", capIds(agent))
        if (human.length > 0) info.push({ kind: "awaiting-human-check", checks: [LABELS_VERIFIED], ...capIds(human) })
      } else if (c.id === "LINT" && c.status === "UNKNOWN") {
        const list = f.lintNotRun
        if (list === null) {
          add("lint-not-run", c.reason === "LINT_NOT_RUN" ? { listed: false } : { listed: false, fix: FIX_NOT_LISTED.tool })
        } else {
          // Row 64 reading rule: `tier` and `not-applicable` are not unchecked and are not listed; `human` is information.
          const wanted = list.filter((n) => n.cause === "staged" || n.cause === "could-not-run")
          const people = list.filter((n) => n.cause === "human" && n.kind === "rule")
          const causes = uniq(wanted.map((n) => n.cause))
          const modules = uniq(wanted.filter((n) => n.kind === "module").map((n) => safeId(n.id)))
          add("lint-not-run", {
            ...capIds(wanted.filter((n) => n.kind === "rule").map((n) => n.id)),
            ...(modules.length ? { modules } : {}),
            causes,
            listed: true,
            // Nothing a render can change when every entry is `staged` (no scanner yet): the person decides.
            ...(wanted.length > 0 && causes.every((x) => x === "staged") ? { fix: FIX_STAGED.tool } : {}),
          })
          notRun = wanted
          if (people.length > 0) info.push({ kind: "human-rule", ...capIds(people.map((n) => n.id)) })
        }
      } else if (c.status === "FAIL") failed.push(safeId(c.id))
      else if (c.status === "UNKNOWN") (unknown.push(safeId(c.id)), unknownReasons.push(safeId(c.reason ?? "UNKNOWN")))
    }
    if (failed.length > 0) add("check-failed", { checks: uniq(failed) })
    if (unknown.length > 0) add("check-unknown", { checks: uniq(unknown), reasons: uniq(unknownReasons) })
    // The stored report could not be read (no checks): the reason stays, as the gate gave it.
    if (checks.length === 0) add(reason === "CHECK_FAILED" ? "check-failed" : "check-unknown", { checks: [] })
  }

  const isHtml = str(o.outputId) !== null && (f.witness?.htmlOutputId ? f.witness.htmlOutputId === o.outputId : str(o.format) === "HTML")
  if (f.witness && f.witness.missing.length > 0 && isHtml) add("witness-missing", pagesOf(f.witness.missing))
  return { verified: false, missing, info, notRun }
}

function pagesOf(missing: readonly number[]): { pages: number[]; morePages?: number } {
  return missing.length > OUTPUT_GATE_PAGES_MAX ? { pages: missing.slice(0, OUTPUT_GATE_PAGES_MAX), morePages: missing.length - OUTPUT_GATE_PAGES_MAX } : { pages: [...missing] }
}

/** The block line of one missing reason: `kurang <kind> <ids>: <hint>` (ids are safe tokens; the hint is ours). */
function missingLine(m: OutputGateMissing): string {
  const ids: string[] = []
  if (m.rules?.length) ids.push(`rules ${m.rules.join(",")}${m.moreRules ? ` (+${m.moreRules})` : ""}`)
  if (m.modules?.length) ids.push(`modules ${m.modules.join(",")}`)
  if (m.pages?.length) ids.push(`pages ${m.pages.join(",")}${m.morePages ? ` (+${m.morePages})` : ""}`)
  if (m.checks?.length) ids.push(`checks ${m.checks.join(",")}`)
  if (m.reasons?.length) ids.push(`reasons ${m.reasons.join(",")}`)
  if (m.because?.length) ids.push(`because ${m.because.join(",")} unverified`)
  const hint =
    m.kind === "lint-not-run" && m.fix === FIX_STAGED.tool
      ? FIX_STAGED.hint
      : m.kind === "lint-not-run" && m.fix === FIX_NOT_LISTED.tool
        ? FIX_NOT_LISTED.hint
        : m.kind === "no-layout-witness" && m.because?.length
          ? `no verified PDF or HTML of this revision: it lifts when one of the outputs named here is verified; what each lacks is on its own lines (first call: ${m.fix})`
          : FIX[m.kind].hint
  return `kurang ${m.kind}${ids.length ? ` ${ids.join("; ")}` : ""}: ${hint}`
}

function infoLine(i: OutputGateInfo): string {
  const ids = [i.checks?.length ? i.checks.join(",") : "", i.rules?.length ? `rules ${i.rules.join(",")}${i.moreRules ? ` (+${i.moreRules})` : ""}` : ""].filter(Boolean).join("; ")
  return i.kind === "awaiting-human-check"
    ? `info awaiting-human-check ${ids}: ${HUMAN_HINT}`
    : `info human-rule ${ids}: only a person runs these lint rules; not something to fix here`
}

const notRunEntry = (n: LintNotRunLike): ClientCheckEntry => ({
  check: "LINT",
  verdict: "NOT_RUN",
  page: null,
  address: null,
  measured: null,
  expected: null,
  rule: `${n.kind === "module" ? "module " : ""}${safeId(n.id)} (${n.cause})`,
  message: cut(n.reason || "no reason recorded"),
})

/**
 * OUTPUT_UNVERIFIED (mission done gate, store/mission/output-gate.ts): the stored checks of each unverified output
 * become client entries in `details` (`checks`, `more`), and the same entries go into one fenced text block.
 *
 * 1.3.3 row 67 (MC-5): each output also carries `verified`, `missing[]` (agent-fixable reasons, each with the one
 * tool to call) and `info[]` (a pending human check: information, not missing); each deliverable carries
 * `agentFixable` (false = nothing in it is for the agent) and, when figure pages lack a witness image, `witness`.
 * `details.fix` lists the tools to call, in order of first use. `facts` (or the registered source) adds what the
 * gate's details do not carry; see `OutputGateFacts`.
 */
export function outputGateFindings(details: Record<string, unknown>, facts: OutputGateFacts | null = registeredFacts): { details: Record<string, unknown>; block: string } {
  const deliverables = Array.isArray(details.deliverables) ? (details.deliverables as Array<Record<string, unknown>>) : []
  const blocks: ClientOutputChecks[] = []
  const fixes: string[] = []
  const rowAwaiting = awaitingChecks(details.awaitingHumanCheck)
  const fact = <T>(read: () => T | null | undefined): T | null => {
    try {
      return read() ?? null
    } catch {
      // A facts source that throws must not hide the refusal: the fact is "not known".
      return null
    }
  }
  const mapped = deliverables.map((d) => {
    const outs = Array.isArray(d.outputs) ? (d.outputs as Array<Record<string, unknown>>) : []
    const documentId = str(d.documentId)
    const revisionNo = typeof d.revisionNo === "number" ? d.revisionNo : null
    const known = documentId !== null && revisionNo !== null
    const f: DeliverableFacts = {
      lintNotRun: readLintNotRun(d.lintNotRun) ?? (known && facts?.lintNotRun ? readLintNotRun(fact(() => facts.lintNotRun!(documentId, revisionNo))) : null),
      witness: readWitness(d.witness) ?? (known && facts?.witness ? readWitness(fact(() => facts.witness!(documentId, revisionNo))) : null),
      layoutOutputs: outs.filter((o) => o.state !== "verified" && (o.format === "PDF" || o.format === "HTML") && typeof o.outputId === "string").map((o) => safeId(o.outputId)),
    }
    const docKey = typeof d.docKey === "string" ? tok(d.docKey, "?") : "-"
    let reasonsAt: string | null = null
    let anyMissing = false
    const infoHere = uniq([...rowAwaiting, ...awaitingChecks(d.awaitingHumanCheck)])
    let witnessShown = false
    const dets = outs.map((o) => {
      const outputId = typeof o.outputId === "string" ? o.outputId : null
      return outputGateOutputDetail(o, f, outputId !== null && facts?.fileExists ? fact(() => facts.fileExists!(outputId)) : null)
    })
    // NO_LAYOUT_WITNESS is derived: it follows from the listed PDF / HTML outputs being unverified. Its fix is theirs;
    // when only a human check holds them, it is not something missing either.
    const layout = outs.map((o, i) => ({ o, det: dets[i]! })).filter((x) => f.layoutOutputs.includes(safeId(x.o.outputId)))
    if (layout.length > 0) {
      const theirFix = layout.flatMap((x) => x.det.missing.map((m) => m.fix))[0]
      const theirInfo = layout.flatMap((x) => x.det.info).find((i) => i.kind === "awaiting-human-check")
      for (const det of dets) {
        const at = det.missing.findIndex((m) => m.kind === "no-layout-witness")
        if (at < 0) continue
        if (theirFix) det.missing[at]!.fix = theirFix
        else {
          det.missing.splice(at, 1)
          if (theirInfo) det.info.push({ kind: "awaiting-human-check", checks: theirInfo.checks })
        }
      }
    }
    const outputs = outs.map((o, at) => {
      const outputId = typeof o.outputId === "string" ? o.outputId : null
      const det = dets[at]!
      if (det.missing.some((m) => m.kind === "witness-missing")) witnessShown = true
      let extra: ClientCheckEntry[] = []
      let extraMore = 0
      for (const m of det.missing) {
        if (m.kind !== "lint-not-run" || det.notRun.length === 0) continue
        if (reasonsAt === null) {
          // The reason of each rule is printed once per deliverable (the list is the revision's, the same for every output).
          extra = det.notRun.slice(0, NOT_RUN_ENTRIES_PER_DELIVERABLE).map(notRunEntry)
          extraMore = det.notRun.length - extra.length
          reasonsAt = outputId === null ? "-" : safeId(outputId)
        } else m.reasonsAt = reasonsAt
      }
      for (const m of det.missing) if (!fixes.includes(m.fix)) fixes.push(m.fix)
      if (det.missing.length > 0) anyMissing = true
      const lines = [...det.missing.map(missingLine), ...det.info.map(infoLine)]
      // A document-level entry (NOT_RENDERED, NO_LAYOUT_WITNESS) has no format: the head says "document".
      const head = `${docKey} ${typeof o.format === "string" ? tok(o.format, "?") : outputId === null ? "document" : "-"}`
      const shape = { verified: det.verified, missing: det.missing, ...(det.info.length ? { info: det.info } : {}) }
      if (!Array.isArray(o.checks)) {
        if (lines.length > 0) blocks.push({ format: head, outputId, entries: [], more: 0, lines })
        return { ...o, ...shape }
      }
      const { entries, more, coverage } = clientEntries(o.checks as CheckLike[])
      const all = [...entries, ...extra]
      const moreAll = more + extraMore
      // Row 210 (L-2): docKey and format are safe tokens or "?" (outputId too, in clientFindingsBlock).
      blocks.push({ format: head, outputId, entries: all, more: moreAll, coverage, lines })
      return { ...o, ...shape, checks: all, ...(moreAll > 0 ? { more: moreAll } : {}), ...(coverage ? { coverage } : {}) }
    })
    // Figure pages without a witness image, when the HTML output itself is not listed (it is verified): said once
    // for the deliverable, with the same fix.
    const w = f.witness && f.witness.missing.length > 0 ? f.witness : null
    const wp = w ? pagesOf(w.missing) : null
    if (w && !witnessShown) {
      const m: OutputGateMissing = { kind: "witness-missing", ...pagesOf(w.missing), fix: FIX["witness-missing"].tool }
      if (!fixes.includes(m.fix)) fixes.push(m.fix)
      anyMissing = true
      blocks.push({ format: `${docKey} HTML`, outputId: w.htmlOutputId ?? null, entries: [], more: 0, lines: [missingLine(m)] })
    }
    const info: OutputGateInfo[] = infoHere.length ? [{ kind: "awaiting-human-check", checks: infoHere }] : []
    if (info.length) blocks.push({ format: `${docKey} document`, outputId: null, entries: [], more: 0, lines: info.map(infoLine) })
    // The raw facts are consumed above; they are not echoed (reason sentences and figure labels are document text).
    const { lintNotRun: _n, witness: _w, ...rest } = d
    return {
      ...rest,
      agentFixable: anyMissing,
      ...(w ? { witness: { htmlOutputId: w.htmlOutputId ? safeId(w.htmlOutputId) : null, missingPages: wp!.pages, ...(wp!.morePages ? { morePages: wp!.morePages } : {}), unplaced: w.unplaced?.length ?? 0, fix: FIX["witness-missing"].tool } } : {}),
      ...(info.length ? { info } : {}),
      outputs,
    }
  })
  const out = deliverables.length ? { ...details, deliverables: mapped, ...(fixes.length ? { fix: fixes } : {}) } : details
  return { details: out, block: clientFindingsBlock(blocks) }
}
