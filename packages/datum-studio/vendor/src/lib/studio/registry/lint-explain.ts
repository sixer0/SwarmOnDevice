/**
 * Swarm row 206 (1.2.3 patch): plain explanations of lint rules for authors, and the tri-state lint summary the
 * MCP tools print (studio_document_status, studio_document_get view=summary) and the host verification reports.
 *
 * - `lintRuleExplanation(id)`: the registry entry (`LINT_REGISTRY`, registry/lint.ts: title, limit, rule reference,
 *   tiers) plus, for the rules authors meet most and misread, what the engine actually inspects (read from the check
 *   code: engine/lint/structure/checks-d.ts d16/d17/d18, engine/lint/render/index.ts check14..check37). Unknown ids
 *   return null; nothing is invented for them.
 * - `summarizeLint(lint, opts)`: a lint record as { ran, verdict, tier, counts, findings[], findingsTotal, reason }.
 *   `ran` is false when no check was actually run (no record, NOT_RUN only, or a record that cannot be read): a
 *   summary is never `{}` and never reads as clean when nothing ran. Findings are the FAIL items (detail: also the
 *   NOT_RUN items) with their check code, address/pointer, engine message and the rule's explanation. The engine
 *   message can quote document text (labels): callers fence it as untrusted, as before.
 *
 * Pure: no I/O, never throws.
 */
import { getLintDef } from "./lint";

/** What the check code inspects, in plain words (source: the check functions named in the header). */
const INSPECTS: Readonly<Record<string, string>> = {
  D16:
    "compares the template's section plan for the document tier with the document: every required section key that is not a slot must be present and no forbidden one may be present; each required table preset of the tier (for example the reconciliation table at SERAH) must sit on a block in an active repeatable slot. Slots themselves are judged by SLOT_CONTENT_MISSING. The finding names the missing or forbidden section key or preset. Fix: add that section or table preset (or choose the tier the content is written for).",
  D17:
    "looks for the first-page identity statement: either the automatic cover carries an identityString, or a paragraph with role \"identity\" exists in the front matter or in the first chapter. It checks presence only, not wording. Fix: add one paragraph with role identity (what the document is, who wrote it, what it is needed for, one measured anchor) at the start; in Markdown put <!-- role: identity --> on its own line just before that paragraph. Not run when the template sets doc.identityStatement.required = false.",
  D18:
    "looks only for at least one paragraph block whose role is \"closingAction\", anywhere in the document (any chapter, slot or zone). It does not read the words: a closing written as an ordinary body paragraph fails, and any paragraph given role closingAction passes; whether the paragraph really names the action and who must take it is left to the human review. Fix: give the closing paragraph (the action and its recipient) role closingAction; in Markdown put <!-- role: closingAction --> on its own line just before it. Not run when the template sets doc.closing.actionAndRecipient.required = false.",
  D19: "finds clock times in prose (not in mono blocks) that carry no time zone (WIB, WITA, WIT or UTC). Fix: write the zone after every time.",
  SLOT_CONTENT_MISSING: "every required skeleton slot of the template must hold content (not EMPTY or PARTIAL) in the released revision; applies at every tier.",
  CONTENT_CHAPTER_GAP: "every chapter key the outline (or a contiguous numbering) expects in a repeatable slot must be present; FAIL at TERBIT/SERAH, REPORT at NOTA.",
  "DATUM-14":
    "counts the distinct chromatic colour values visible on each printed sheet of the rendered HTML (an ink ramp counts as one family) against the template maximum per page. Flow documents without page elements are judged on the whole document.",
  "DATUM-15":
    "measures running body paragraphs (class st-p or tag p, at least two lines, the body font size; cover, control sheet, contents and narrow columns excluded) in the rendered layout and averages the characters per full line against the template range (66-80 by default). Fix: the measure (text column width) comes from the template; shorten or widen it there, or check the rail column setting.",
  "DATUM-25": "counts the distinct chromatic colour values inside each figure SVG against the template maximum per figure.",
  "DATUM-28": "reads the text sizes inside each figure SVG at its printed scale; any text smaller than the template minimum (5.5 pt by default) fails.",
  "DATUM-32": "follows each marked connector (data-mark=\"link\") of a diagram SVG and fails when it runs through a node it does not connect.",
  "DATUM-33": "compares the printed height of every figure and image with the text block height of the sheet (247 mm by default).",
  "DATUM-37":
    "measures the rendered HTML at the sheet size: on paged documents any element past the right edge or below the page register of its sheet fails; on flow documents any element past the right edge of the layout width fails. When a flow document was laid out narrower than the sheet (for example a scrollbar took width), right-edge overflows within the missing width cannot be judged and the check is NOT_RUN (FLOW_LAYOUT_UNMEASURABLE), never PASS. Fix: the named element (label, address) is wider than the sheet; reduce its width (table columns, figure size, long unbroken text).",
};

/** Plain explanation of a lint rule (registry entry + what the check inspects); null for an id the registry does not know. */
export function lintRuleExplanation(id: string): string | null {
  const def = getLintDef(id);
  // Swarm row 210 (security review 209 L-3): own keys only (no Object.prototype member for "constructor" etc.).
  const inspects = Object.hasOwn(INSPECTS, id) ? INSPECTS[id] : undefined;
  if (!def && !inspects) return null;
  if (!def) return `${id}: ${inspects}`;
  return inspects ? `${id} "${def.title}" (${def.ruleRef}): ${inspects}` : `${id} "${def.title}" (limit: ${def.limit}; ${def.ruleRef}; tiers ${def.tiers.join("/")}).`;
}

export type LintVerdict = "PASS" | "FAIL" | "NOT_RUN";

export interface LintSummaryFinding {
  code: string;
  status: string;
  address: string | null;
  message: string;
  rule: string | null;
  /**
   * Swarm 1.2.7 row 35b (N-3): only on a check's summary (carrier) row, which carries `findingsAll`: the number of
   * findings the row stands for (the ones not itemised as their own rows).
   */
  represents?: number;
}

/** Swarm 1.2.7 row 35b (N-3, N7-063): real count of one check code that has a summary (carrier) row. */
export interface LintCarrierCount {
  /** Findings of the carrier's status (row 48b, M2-06: REPORT findings of a FAIL carrier are not counted). */
  total: number;
  /** Findings itemised as their own rows (rows of the code with the carrier's status, other than the carrier). */
  itemised: number;
  /** Findings not itemised (total - itemised). */
  rest: number;
}

/**
 * Swarm 1.2.7 row 35b (N-3, N7-063): per check code of an engine lint record (`checks[]`), the real counts of the codes
 * whose summary row (engine/lint/structure/context.ts `toIssues`, the row with `findingsAll`) has the given status.
 * The summary row itself is never a finding. Codes without a carrier are absent (their rows are their findings).
 */
export function lintCarrierCounts(lint: unknown, status: string = "FAIL"): Map<string, LintCarrierCount> {
  const out = new Map<string, LintCarrierCount>();
  if (!isRec(lint) || !Array.isArray(lint.checks)) return out;
  const rows = lint.checks.filter(isRec);
  for (const c of rows) {
    if (c.status !== status || !Array.isArray(c.findingsAll) || typeof c.checkId !== "string") continue;
    // Swarm 1.2.7 row 48b (M2-06): a check may emit FAIL and REPORT findings (engine/lint/structure/context.ts
    // `toIssues`); only findings of `status` count (an entry without status is FAIL, the engine default). Findings
    // past the stored bound (`findingsTotal` > stored) have no recorded status and count under the carrier's.
    const stored = c.findingsAll.length;
    const matching = c.findingsAll.filter((f) => (isRec(f) && typeof f.status === "string" ? f.status : "FAIL") === status).length;
    const unstored = typeof c.findingsTotal === "number" && Number.isFinite(c.findingsTotal) ? Math.max(0, c.findingsTotal - stored) : 0;
    const total = matching + unstored;
    const itemised = rows.filter((r) => r !== c && r.checkId === c.checkId && !Array.isArray(r.findingsAll) && r.status === status).length;
    out.set(c.checkId, { total, itemised, rest: Math.max(0, total - itemised) });
  }
  return out;
}

export interface LintSummary {
  /** true only when at least one check actually ran (PASS, FAIL or REPORT). */
  ran: boolean;
  verdict: LintVerdict;
  tier: string | null;
  counts: { PASS: number; FAIL: number; REPORT: number; NOT_RUN: number } | null;
  findings: LintSummaryFinding[];
  /** All findings before the cap. */
  findingsTotal: number;
  /** Why `ran` is false or the record could not be read. */
  reason: string | null;
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Tri-state summary of a lint record. Reads the engine's LintReport ({ tier, checks[], releaseStatus }) and the
 * older summary shape ({ verdict|status, findings[]|issues[] }). `max` caps the listed findings; `withNotRun` also
 * lists NOT_RUN items (detail views).
 */
export function summarizeLint(lint: unknown, opts: { max?: number; withNotRun?: boolean; messageMax?: number } = {}): LintSummary {
  const max = Math.max(0, opts.max ?? 10);
  const messageMax = Math.max(40, opts.messageMax ?? 300);
  const none = (reason: string): LintSummary => ({ ran: false, verdict: "NOT_RUN", tier: null, counts: null, findings: [], findingsTotal: 0, reason });
  if (lint === null || lint === undefined) return none("no lint record (the revision has not been rendered)");
  if (!isRec(lint)) return none("lint record unreadable");
  const tier = typeof lint.tier === "string" ? lint.tier : null;
  if (Array.isArray(lint.checks)) {
    const checks = lint.checks.filter(isRec).filter((c) => typeof c.checkId === "string" && typeof c.status === "string");
    const counts = { PASS: 0, FAIL: 0, REPORT: 0, NOT_RUN: 0 };
    for (const c of checks) if (String(c.status) in counts) counts[c.status as keyof typeof counts]++;
    const ran = counts.PASS + counts.FAIL + counts.REPORT > 0;
    const rs = lint.releaseStatus;
    const verdict: LintVerdict = !ran ? "NOT_RUN" : rs === "FAIL" || rs === "PASS" || rs === "NOT_RUN" ? rs : counts.FAIL > 0 ? "FAIL" : "PASS";
    const listed = checks.filter((c) => c.status === "FAIL" || (opts.withNotRun === true && c.status === "NOT_RUN"));
    // Swarm 1.2.7 row 35b (N-3, K7-09): findingsTotal is the real finding count. A code whose listed summary row
    // carries `findingsAll` counts that row's total once and its itemised rows not again; other codes count rows.
    const carriers = lintCarrierCounts(lint, "FAIL");
    const findings = listed.slice(0, max).map((c) => {
      const code = String(c.checkId);
      const where = typeof c.address === "string" && c.address ? c.address : typeof c.pointer === "string" && c.pointer ? c.pointer : null;
      const carrier = c.status === "FAIL" && Array.isArray(c.findingsAll) ? carriers.get(code) : undefined;
      return {
        code,
        status: String(c.status),
        address: where,
        message: cut(typeof c.detail === "string" ? c.detail : "", messageMax),
        rule: lintRuleExplanation(code),
        ...(carrier ? { represents: carrier.rest } : {}),
      };
    });
    const findingsTotal = listed.reduce((n, c) => n + (c.status === "FAIL" && carriers.has(String(c.checkId)) ? 0 : 1), 0) + [...carriers.values()].reduce((n, x) => n + x.total, 0);
    return { ran, verdict, tier, counts, findings, findingsTotal, reason: ran ? null : checks.length === 0 ? "lint record lists no checks" : "no lint check ran (every check NOT_RUN)" };
  }
  const raw = Array.isArray(lint.findings) ? lint.findings : Array.isArray(lint.issues) ? lint.issues : null;
  const v = typeof lint.verdict === "string" ? lint.verdict : typeof lint.status === "string" ? lint.status : null;
  if (v === null && raw === null) return none("lint record unreadable (no checks, verdict or findings)");
  const verdict: LintVerdict = v === "PASS" || v === "FAIL" ? v : v === "NOT_RUN" ? "NOT_RUN" : raw && raw.length > 0 ? "FAIL" : "NOT_RUN";
  const list = (raw ?? []).filter(isRec);
  const findings = list.slice(0, max).map((f) => {
    const code = String(f.checkId ?? f.rule ?? f.code ?? "?");
    const address = typeof f.address === "string" ? f.address : typeof f.pointer === "string" ? f.pointer : null;
    const message = String(f.detail ?? f.message ?? "");
    return { code, status: String(f.status ?? verdict), address, message: cut(message, messageMax), rule: lintRuleExplanation(code) };
  });
  const ran = verdict !== "NOT_RUN";
  return { ran, verdict, tier, counts: null, findings, findingsTotal: list.length, reason: ran ? null : "lint not run" };
}
