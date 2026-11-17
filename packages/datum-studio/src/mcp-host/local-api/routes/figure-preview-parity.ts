/**
 * Swarm 1.3.3 row 65 (ST-7, B-17): the figure preview is as strict as the render for that figure.
 *
 * The render applies, besides the engine build checks the preview already runs (validateSpec, capacity, fit), the lint
 * modules of `lintAfterRender` (vendor services/render/lint.ts): `runLint` (scan), `lintStructure`, `lintLanguage`
 * and `lintRenderedWith` (render). This module walks the lint REGISTRY (not a hand list of ids):
 *
 * - each structure or render rule whose scope is one figure is RUN here with the inputs the render gives it: the
 *   structure checks on a one-figure document built from the stored block content (same meta, tier, enforcement and
 *   artefact label as the document), the render checks on the SVG just built at the width in use (template limits);
 * - each rule that concerns the figure but can only run on the whole document (quota, caption evidence against a
 *   companion table, off-page pairing) or on the rendered pages (colours per page, page overflow) is returned as a
 *   `notRun` entry "belum diperiksa" with the reason (register 03: `notRun` of the preview, shape of row 64);
 * - the scan and language modules read the text of the whole document (captions and sources included): one module
 *   entry each;
 * - a registry rule this module does not know yet is never passed silently: it is a `notRun` entry
 *   ({@link UNMAPPED_REASON}), so a rule added later shows up as not checked until it is mapped in `RULE_SCOPE`.
 *
 * Rules outside the document tier do not count at render (release status by tier), so they are neither run nor listed;
 * without a document the tier is NOTA. Independent of the preview's `lattice` (engine defect E1, row 138). Pure:
 * no I/O, no PDF, no raster; never throws (a module that throws becomes a `module` entry, as in the render report).
 */
import type { AnyNormSnapshot, LintIssue, NormBlock, ResolvedTemplate, StudioTier, SvgResult } from "@/lib/studio/contract";
import { LINT_REGISTRY, type LintDef } from "@/lib/studio/registry/lint";
import { lintStructureWith } from "@/lib/studio/engine/lint/structure";
import { RENDER_LINT_DEFAULTS, lintRenderedWith, renderLintLimitsFromParams } from "@/lib/studio/engine/lint/render";
import { OFFPAGE_PREVIEW_NOT_RUN_REASON, OFFPAGE_UNPAIRED, offpagePreviewNotRun } from "@/lib/studio/services/render/offpage-pairs";
import type { LintNotRun } from "@/lib/studio/services/render/lint";

/** One `notRun` entry of the preview reply: the shape of `LintReport.notRun` (row 64, register 03 s7). */
export type PreviewNotRun = LintNotRun;

/**
 * Scope of a registry rule seen from one figure:
 * - `figure`: runs on one figure; the preview runs it;
 * - `document`: concerns the figure but needs the whole document; listed "belum diperiksa";
 * - `page`: concerns the figure but needs the rendered pages (PDF); listed "belum diperiksa";
 * - `none`: does not look at figures (tables, cover, prose, fonts ...); the render applies it to the document only.
 * Scan and language rules are not in this table: their module is listed once (they read all text of the document).
 */
type PreviewRuleScope = "figure" | "document" | "page" | "none";

/** @internal test seam */
export const RULE_SCOPE: Readonly<Record<string, PreviewRuleScope>> = {
  // structure, group A by construction: the checks that walk figures (checks-a.ts `figures` / `diagrams`)
  "DATUM-01": "figure",
  "DATUM-10": "figure",
  "DATUM-13": "figure",
  "DATUM-23": "figure",
  "DATUM-24": "figure",
  "DATUM-26": "figure",
  "DATUM-27": "figure",
  "DATUM-29": "figure",
  "DATUM-30": "figure",
  "DATUM-34": "figure",
  "DATUM-35": "figure",
  "DATUM-36": "figure",
  // structure, group D: figure checks (checks-d.ts) and the placeholder twin (row 52)
  D09: "figure",
  // structure, group D: text audits per text unit (checks-d.ts `proseTexts`); a figure's caption and source are one
  // unit, audited against the document's register, retired list and template parameters (all carried here)
  D01: "figure",
  D02: "figure",
  D05: "figure",
  D19: "figure",
  D21: "figure",
  D11: "figure",
  D12: "figure",
  D13: "figure",
  D14: "figure",
  D15: "figure",
  PLACEHOLDER_UNFILLED: "figure",
  // figure rules that need the whole document
  D22: "document",
  D23: "document",
  [OFFPAGE_UNPAIRED]: "document",
  // render module (engine/lint/render): per-figure SVG checks run; page checks need the rendered pages
  "DATUM-25": "figure",
  "DATUM-28": "figure",
  "DATUM-32": "figure",
  "DATUM-33": "figure",
  "DATUM-14": "page",
  "DATUM-37": "page",
  "DATUM-15": "none",
  // structure rules that never look at a figure
  "DATUM-02": "none",
  "DATUM-05": "none",
  "DATUM-06": "none",
  "DATUM-07": "none",
  "DATUM-08": "none",
  "DATUM-09": "none",
  "DATUM-11": "none",
  "DATUM-12": "none",
  "DATUM-18": "none",
  "DATUM-20": "none",
  "DATUM-21": "none",
  "DATUM-22": "none",
  D03: "none",
  D04: "none",
  D06: "none",
  D07: "none",
  D08: "none",
  D10: "none",
  D16: "none",
  D17: "none",
  D18: "none",
  D20: "none",
  SLOT_CONTENT_MISSING: "none",
  CONTENT_CHAPTER_GAP: "none",
  SCHEMA_V1_ADAPTED: "none",
};

/** Register 03 (preview `notRun`): every reason starts with this text. */
/** @internal test seam */
export const PREVIEW_NOT_RUN_PREFIX = OFFPAGE_PREVIEW_NOT_RUN_REASON;

const REASON = {
  document: `${PREVIEW_NOT_RUN_PREFIX} (butuh seluruh dokumen)`,
  D22: `${PREVIEW_NOT_RUN_PREFIX} (butuh seluruh dokumen: kuota gambar per dokumen)`,
  D23: `${PREVIEW_NOT_RUN_PREFIX} (butuh seluruh dokumen: bukti keterangan gambar terhadap tabel pendampingnya)`,
  page: `${PREVIEW_NOT_RUN_PREFIX} (butuh halaman hasil render: warna per halaman dan luapan halaman diukur pada PDF)`,
  scan: `${PREVIEW_NOT_RUN_PREFIX} (pemindaian teks seluruh dokumen; keterangan dan sumber gambar ikut dipindai)`,
  language: `${PREVIEW_NOT_RUN_PREFIX} (pemeriksaan bahasa seluruh dokumen; keterangan dan sumber gambar ikut diperiksa)`,
} as const;

/** Reason of a registry rule the preview has no scope for yet (a rule added after row 65). */
/** @internal test seam */
export const UNMAPPED_REASON = `${PREVIEW_NOT_RUN_PREFIX} (aturan registri belum dipetakan ke pratinjau)`;

interface PreviewParityInput {
  /** The block previewed (stored content, or the inline block composed by `composeInlineBlock`). */
  block: NormBlock & { pid?: string };
  /** The resolved spec (artefact references read): used for the off-page check. */
  spec: unknown;
  /** The SVG built for the preview (width in use). */
  svg: SvgResult;
  tpl: ResolvedTemplate;
  /** The document the figure belongs to: meta, tier, register, enforcement. Absent = tier NOTA, no register. */
  snapshot?: AnyNormSnapshot;
}

interface PreviewParity {
  /** Lint rows of the rules run here that did not pass (FAIL, REPORT, NOT_RUN), in registry order. */
  issues: LintIssue[];
  /** Ids of the rules run here (any outcome). */
  ran: string[];
  /** Rules (and modules) that concern this figure but were not checked here. */
  notRun: PreviewNotRun[];
}

/**
 * Run the render's figure-scoped lint rules on one figure and list the rest. Order of `notRun`: modules, then rules in
 * registry order, then the off-page entry (row 50) when the spec holds an `offpage` node and the registry has no row
 * for it yet.
 */
export function previewLintParity(i: PreviewParityInput): PreviewParity {
  // Without a document (direct callers, probes) the tier is NOTA, the draft tier; the route always passes the document.
  const tier: StudioTier = (i.snapshot?.doc?.meta?.tier as StudioTier | undefined) ?? "NOTA";
  const applies = (d: LintDef) => d.tiers.includes(tier);
  const defs = LINT_REGISTRY.filter((d) => d.module === "structure" || d.module === "render");
  const run = defs.filter((d) => RULE_SCOPE[d.id] === "figure" && applies(d));
  const notRun: PreviewNotRun[] = [];
  const issues: LintIssue[] = [];
  const ran: string[] = [];

  const structureIds = run.filter((d) => d.module === "structure").map((d) => d.id);
  if (structureIds.length > 0) {
    const r = attempt(() => lintStructureWith(oneFigureSnapshot(i.block, i.snapshot), i.tpl, tier, { only: structureIds }));
    // Rows about other parts of the one-figure document (its register, its chapter) are not about this figure.
    if (r.ok) collect(r.value.filter((x) => x.pointer === undefined || x.pointer.startsWith(BLOCK_POINTER)), structureIds, issues, ran, notRun);
    else notRun.push({ id: "structure", kind: "module", reason: clip(`${PREVIEW_NOT_RUN_PREFIX} (cek struktur gagal dijalankan: ${r.error})`), cause: "could-not-run" });
  }
  const renderIds = run.filter((d) => d.module === "render").map((d) => d.id);
  if (renderIds.length > 0) {
    const r = attempt(() => lintRenderedWith({ svgs: [i.svg], metrics: { pageCount: 0, elements: [] } }, limitsOf(i.tpl)).filter((x) => renderIds.includes(x.checkId)));
    if (r.ok) collect(r.value, renderIds, issues, ran, notRun);
    else notRun.push({ id: "render", kind: "module", reason: clip(`${PREVIEW_NOT_RUN_PREFIX} (cek render gagal dijalankan: ${r.error})`), cause: "could-not-run" });
  }

  const offpage = offpagePreviewNotRun(i.spec);
  const modules: PreviewNotRun[] = [
    { id: "scan", kind: "module", reason: REASON.scan, cause: "could-not-run" },
    { id: "language", kind: "module", reason: REASON.language, cause: "could-not-run" },
  ];
  const rules: PreviewNotRun[] = [];
  for (const d of defs) {
    if (!applies(d)) continue;
    const scope = RULE_SCOPE[d.id];
    if (scope === "none" || scope === "figure") continue;
    if (d.id === OFFPAGE_UNPAIRED && !offpage) continue; // the pairing concerns only a figure with an offpage node
    if (scope === undefined) rules.push({ id: d.id, kind: "rule", reason: UNMAPPED_REASON, cause: "could-not-run" });
    else rules.push({ id: d.id, kind: "rule", reason: scope === "page" ? REASON.page : (REASON[d.id as "D22" | "D23"] ?? REASON.document), cause: "could-not-run" });
  }
  // Row 50: the off-page pairing is a document check; until the registry row lands (integration row) it is added here.
  if (offpage && !rules.some((r) => r.id === OFFPAGE_UNPAIRED)) rules.push({ ...offpage, cause: "could-not-run" });
  return { issues, ran, notRun: [...modules, ...notRun, ...rules] };
}

function collect(rows: readonly LintIssue[], ids: readonly string[], issues: LintIssue[], ran: string[], notRun: PreviewNotRun[]): void {
  for (const id of ids) {
    const mine = rows.filter((r) => r.checkId === id);
    const staged = mine.length > 0 && mine.every((r) => r.status === "NOT_RUN");
    if (mine.length === 0 || staged) {
      // The render reports this rule NOT_RUN too (staged check, missing instrument): the same reason, never a pass.
      notRun.push({ id, kind: "rule", reason: clip(`${PREVIEW_NOT_RUN_PREFIX} (${mine[0]?.detail ?? "cek tidak menghasilkan butir"})`), cause: "staged" });
      continue;
    }
    ran.push(id);
    issues.push(...mine.filter((r) => r.status !== "PASS"));
  }
}

/**
 * The one-figure document the structure checks read: the stored block (as the document holds it) as the only block of
 * one chapter, with the meta, register, `x` (enforcement) and overrides of the real document, and the block's own
 * address and artefact label (so findings read "Gambar 3.2" as at render).
 */
function oneFigureSnapshot(block: NormBlock & { pid?: string }, snap: AnyNormSnapshot | undefined): AnyNormSnapshot {
  const content = isRec(block.content) ? block.content : {};
  const key = chapterKeyOf(block.artifactLabel) ?? "1";
  const real = (snap?.doc ?? {}) as unknown as Record<string, unknown>;
  const doc = {
    $schema: "studio.doc/v1",
    template: real.template ?? { slug: "preview" },
    meta: real.meta ?? { tier: "NOTA", language: "ID" },
    ...(real.register !== undefined ? { register: real.register } : {}),
    ...(real.overrides !== undefined ? { overrides: real.overrides } : {}),
    ...(real.x !== undefined ? { x: real.x } : {}),
    chapters: [{ key, title: { text: "" }, intro: [{ ...content, type: block.type, blockId: block.blockId }] }],
  };
  const norm: NormBlock = { ...block, unitKey: key, ordinal: 0 };
  return { schema: "studio.norm/v1", doc, units: [], blocks: [norm], numbering: {}, register: snap?.register ?? {} } as unknown as AnyNormSnapshot;
}

/** JSON pointer of the previewed block in the one-figure document. */
const BLOCK_POINTER = "/chapters/0/intro/0";

/** "Gambar 3.2" -> "3", "Gambar A.1" -> "A"; undefined without a label. */
function chapterKeyOf(label: string | undefined): string | undefined {
  const m = typeof label === "string" ? /\s([0-9A-Z]+)\.\d+\s*$/.exec(label.trim()) : null;
  return m ? m[1] : undefined;
}

function limitsOf(tpl: ResolvedTemplate) {
  return tpl.params ? renderLintLimitsFromParams(tpl.params) : RENDER_LINT_DEFAULTS;
}

function attempt<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const clip = (s: string) => (s.length > 300 ? `${s.slice(0, 297)}...` : s);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
