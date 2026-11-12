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
  verdict: "FAIL" | "UNKNOWN"
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
    if (o.entries.length === 0) continue
    const head = `${safeWords(o.format)} ${o.outputId === null ? "-" : tok(o.outputId, "?")}: ${o.entries.length} check entr${o.entries.length === 1 ? "y" : "ies"}${o.more > 0 ? ` (+${o.more} more findings in structuredContent)` : ""}${o.coverage ? `; OVERLAP_CLIP ${o.coverage}` : ""}`
    if (notShown > 0 || size + printedSize(head) > CLIENT_FINDINGS_BLOCK_MAX) {
      notShown += o.entries.length
      continue
    }
    body.push(head)
    size += printedSize(head)
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

/**
 * OUTPUT_UNVERIFIED (mission done gate, store/mission/output-gate.ts): the stored checks of each unverified output
 * become client entries in `details` (`checks`, `more`), and the same entries go into one fenced text block.
 */
export function outputGateFindings(details: Record<string, unknown>): { details: Record<string, unknown>; block: string } {
  const deliverables = Array.isArray(details.deliverables) ? (details.deliverables as Array<Record<string, unknown>>) : []
  const blocks: ClientOutputChecks[] = []
  const mapped = deliverables.map((d) => {
    const outs = Array.isArray(d.outputs) ? (d.outputs as Array<Record<string, unknown>>) : []
    return {
      ...d,
      outputs: outs.map((o) => {
        if (!Array.isArray(o.checks)) return o
        const { entries, more, coverage } = clientEntries(o.checks as CheckLike[])
        // Row 210 (L-2): docKey and format are safe tokens or "?" (outputId too, in clientFindingsBlock).
        blocks.push({ format: `${typeof d.docKey === "string" ? tok(d.docKey, "?") : "-"} ${typeof o.format === "string" ? tok(o.format, "?") : "-"}`, outputId: typeof o.outputId === "string" ? o.outputId : null, entries, more, coverage })
        return { ...o, checks: entries, ...(more > 0 ? { more } : {}), ...(coverage ? { coverage } : {}) }
      }),
    }
  })
  return { details: deliverables.length ? { ...details, deliverables: mapped } : details, block: clientFindingsBlock(blocks) }
}
