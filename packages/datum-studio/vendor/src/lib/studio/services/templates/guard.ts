/**
 * The DATUM template guard (row 67; masterplan/01_specs_studio_templates.md §5.2 steps 2 and 6, and the
 * U16 amendment U.1, U.1a, U.2, U.5; decisions C19 D-B, C65).
 *
 * Installed into the row 66 service with `configureTemplateGuard(createTemplateGuard())` (the host
 * does it in `startStudioHostServer`). For each candidate that already passed the form lock:
 *
 * 1. Lint-parameter pin (U.1a): every key of `lintParameterKeys()` (render limits + every `paramRef`
 *    of LINT_REGISTRY) must resolve to the same value in the candidate as in the reference. A
 *    difference rejects without rendering (`{id:"lint-param", key, outcome:"reject"}`).
 * 2. Render (U.1 step 3): the Swarm sample (`./sample-render`) under the reference and under the
 *    candidate, one after the other, through Studio's ingest dry run and `renderSnapshot` with formats
 *    DOCX + HTML and `measureLayout` on (same engine, same render bridge as `studio_render`).
 * 3. Lint (U.1 step 4): the `LintReport` each render produced (`lintAfterRender`), at the lint tier
 *    TERBIT (SERAH when the candidate is SERAH). Nothing else is called: not Claude's lint, not the
 *    conformance scorer.
 * 4. Fail closed (U.1 step 5): a render error, job-log `LINT_MODULE_NOT_RUN` or `LAYOUT_NOT_MEASURED`,
 *    a missing report, the 60 s per-render or the 120 s whole-guard timeout, a sample the reference
 *    refuses -> `unavailable` (GUARD_UNAVAILABLE, nothing saved). One guard at a time, at most 4
 *    waiting; more -> `unavailable` GUARD_BUSY.
 * 5. Verdict per LINT_REGISTRY id (U.2, classes S1-S5) and overall: any reject -> `reject`; else
 *    `warn` (a pre-existing reference failure, or a REPORT issue) or `pass`.
 *
 * The record saved with a version (row 64 columns): verdict, the report (U.5 shape, at most 64 KiB) and
 * `skillSha` = the sha256 of Studio's lint closure as shipped (U.5).
 */
import { randomUUID } from "node:crypto";
import type { LintIssue, LintReport, StudioTier } from "../../contract";
import { resolveParams } from "../../engine/tokens";
import { ALL_PARAMS } from "../../params";
import { LINT_REGISTRY, LINT_REGISTRY_COUNT, type LintDef } from "../../registry/lint";
import provenanceManifest from "../../../../../provenance.json";
import { loadTemplateLayers } from "../skeleton";
import { lintParameterKeys } from "./form-lock";
import { templatesLog } from "./log";
import { sha256Hex, stableStringify } from "./profile";
import {
  renderSample,
  SampleRenderError,
  sampleLanguageOf,
  sampleSha256,
  sideFromCandidate,
  sideFromVersion,
  swarmSampleDocument,
  SWARM_SAMPLE_VERSION,
  type RenderSide,
  type SampleRenderResult,
} from "./sample-render";
import type { TemplateGuard, TemplateGuardInput, TemplateGuardOutcome } from "./service";

// ── Limits (U.1 step 5, §5.2 step 4) ────────────────────────────────────

export const GUARD_RENDER_TIMEOUT_MS = 60_000;
export const GUARD_TOTAL_TIMEOUT_MS = 120_000;
export const GUARD_MAX_WAITING = 4;
/** Row 64 cap on `guard_report` (TEMPLATE_GUARD_REPORT_MAX_BYTES). */
export const GUARD_REPORT_MAX_BYTES = 65_536;
/** U.5: issue details kept per check, and their length. */
export const GUARD_MAX_ISSUES_PER_CHECK = 12;
export const GUARD_ISSUE_DETAIL_MAX = 300;
/** Job-log codes that make the lint incomplete (U.1 step 5). */
export const GUARD_FAIL_CLOSED_LOG_CODES: readonly string[] = ["LINT_MODULE_NOT_RUN", "LAYOUT_NOT_MEASURED"];

// ── Lint closure sha (U.5) ───────────────────────────────────────────────

/** Files of Studio's lint closure (U.5): services/render/lint.ts, registry/lint.ts and engine/lint/**. */
export function isLintClosurePath(p: string): boolean {
  return p === "src/lib/studio/services/render/lint.ts" || p === "src/lib/studio/registry/lint.ts" || p.startsWith("src/lib/studio/engine/lint/");
}

/** sha256 over the sorted `path  sha256` lines of the lint-closure entries of a provenance manifest. */
export function lintClosureSha(manifest: { files?: ReadonlyArray<{ path?: unknown; sha256?: unknown }> }): { sha256: string; files: number } {
  const lines = (manifest.files ?? [])
    .filter((f): f is { path: string; sha256: string } => typeof f.path === "string" && typeof f.sha256 === "string" && isLintClosurePath(f.path))
    .map((f) => `${f.path}  ${f.sha256}`)
    .sort();
  if (lines.length === 0) throw new Error("lint closure has no files in the provenance manifest");
  return { sha256: sha256Hex(`${lines.join("\n")}\n`), files: lines.length };
}

let shippedClosure: { sha256: string; files: number } | null = null;

/** The closure sha of the vendored copy as shipped (vendor/provenance.json, bundled with the code). */
export function shippedLintClosure(): { sha256: string; files: number } {
  shippedClosure ??= lintClosureSha(provenanceManifest as { files?: ReadonlyArray<{ path?: unknown; sha256?: unknown }> });
  return shippedClosure;
}

// ── Verdict per check (U.2) ──────────────────────────────────────────────

export type GuardClass = "S1" | "S2" | "S3" | "S4" | "S5";
/** U.2 S3: an automated verdict plus a manual half ("mata", Rev A Tabel 13.1). */
export const GUARD_EYE_CHECKS: ReadonlySet<string> = new Set(["DATUM-08", "DATUM-12", "DATUM-13", "DATUM-15"]);
/** U.2 S2: report-only checks (DATUM-36 "lapor", Rev A ID:80; the C INFO entry). */
export const GUARD_REPORT_ONLY_CHECKS: ReadonlySet<string> = new Set(["DATUM-36", "C-INFO-OPENER"]);

/** Static class of one registry check at a lint tier. */
export function guardClassOf(def: Pick<LintDef, "id" | "group" | "tiers" | "notRunReason">, lintTier: "TERBIT" | "SERAH"): GuardClass {
  if (def.group === "H") return "S4";
  if (def.notRunReason || !def.tiers.includes(lintTier)) return "S5";
  if (GUARD_EYE_CHECKS.has(def.id)) return "S3";
  if (GUARD_REPORT_ONLY_CHECKS.has(def.id)) return "S2";
  return "S1";
}

export type SideStatus = "PASS" | "FAIL" | "REPORT" | "NOT_RUN" | "ABSENT";
export interface SideSummary {
  status: SideStatus;
  failCount: number;
  reportCount: number;
}
export type CheckOutcome = "pass" | "warn" | "reject" | "not-run" | "manual";
export type CheckReason = "REGRESSION" | "CHECK_LOST" | "REFERENCE_FAILS" | "REPORT" | "MANUAL_NOT_CHECKED" | "NOT_RUN_BY_DESIGN";

export interface GuardCheckEntry {
  id: string;
  group: string;
  class: GuardClass | "unregistered";
  /** U.1a entries (`id: "lint-param"`): the lint-parameter key that differs. */
  key?: string;
  reference: SideSummary;
  candidate: SideSummary;
  outcome: CheckOutcome;
  reason?: CheckReason;
  /** S3: the eye half is never judged by the guard. */
  eye?: "MANUAL_NOT_CHECKED";
  /** Candidate FAIL/REPORT details for a reject or warn (at most 12, 300 chars each). */
  issues?: Array<{ status: string; detail: string; address?: string; pointer?: string }>;
}

function summarize(issues: readonly LintIssue[] | undefined): SideSummary {
  if (!issues || issues.length === 0) return { status: "ABSENT", failCount: 0, reportCount: 0 };
  const failCount = issues.filter((i) => i.status === "FAIL").length;
  const reportCount = issues.filter((i) => i.status === "REPORT").length;
  const status: SideStatus = failCount > 0 ? "FAIL" : reportCount > 0 ? "REPORT" : issues.some((i) => i.status === "PASS") ? "PASS" : "NOT_RUN";
  return { status, failCount, reportCount };
}

const ran = (s: SideSummary): boolean => s.status === "PASS" || s.status === "FAIL" || s.status === "REPORT";

function clipDetail(s: string | undefined): string {
  const v = s ?? "";
  return v.length > GUARD_ISSUE_DETAIL_MAX ? `${v.slice(0, GUARD_ISSUE_DETAIL_MAX - 1)}…` : v;
}

function evidence(issues: readonly LintIssue[] | undefined): GuardCheckEntry["issues"] {
  return (issues ?? [])
    .filter((i) => i.status === "FAIL" || i.status === "REPORT")
    .slice(0, GUARD_MAX_ISSUES_PER_CHECK)
    .map((i) => ({ status: i.status, detail: clipDetail(i.detail), ...(i.address ? { address: i.address } : {}), ...(i.pointer ? { pointer: i.pointer } : {}) }));
}

/** S1 rule (also the automated half of S3, and checks the registry does not list). */
function automatedOutcome(ref: SideSummary, cand: SideSummary): { outcome: CheckOutcome; reason?: CheckReason } {
  if (cand.failCount > ref.failCount) return { outcome: "reject", reason: "REGRESSION" };
  if (ran(ref) && !ran(cand)) return { outcome: "reject", reason: "CHECK_LOST" };
  if (cand.failCount > 0) return { outcome: "warn", reason: "REFERENCE_FAILS" };
  return reportOutcome(ref, cand);
}

/**
 * S2 (and REPORT issues under S1): a REPORT never rejects. It warns when the candidate reports more
 * than the reference (the change caused it); the same REPORT on both sides is the sample's, not the
 * change's (e.g. C-INFO-OPENER "not applicable" on every render), and stays `pass` with its counts.
 */
function reportOutcome(ref: SideSummary, cand: SideSummary): { outcome: CheckOutcome; reason?: CheckReason } {
  return cand.reportCount > ref.reportCount ? { outcome: "warn", reason: "REPORT" } : { outcome: "pass" };
}

function byId(report: LintReport): Map<string, LintIssue[]> {
  const m = new Map<string, LintIssue[]>();
  for (const i of report.checks) {
    const list = m.get(i.checkId) ?? [];
    list.push(i);
    m.set(i.checkId, list);
  }
  return m;
}

export interface LintComparison {
  verdict: "pass" | "warn" | "reject";
  checks: GuardCheckEntry[];
  /** Check ids the report holds that LINT_REGISTRY does not list (judged by the S1 rule). */
  unregistered: GuardCheckEntry[];
  classCounts: Record<GuardClass, number>;
}

/** Compare the reference and candidate lint reports check by check (U.2). Pure. */
export function compareLintReports(reference: LintReport, candidate: LintReport, lintTier: "TERBIT" | "SERAH"): LintComparison {
  const r = byId(reference);
  const c = byId(candidate);
  const classCounts: Record<GuardClass, number> = { S1: 0, S2: 0, S3: 0, S4: 0, S5: 0 };
  const checks: GuardCheckEntry[] = [];
  const known = new Set<string>();
  for (const def of LINT_REGISTRY) {
    known.add(def.id);
    const cls = guardClassOf(def, lintTier);
    classCounts[cls] += 1;
    const ref = summarize(r.get(def.id));
    const cand = summarize(c.get(def.id));
    const base = { id: def.id, group: def.group, class: cls, reference: ref, candidate: cand } as const;
    let e: GuardCheckEntry;
    if (cls === "S4") e = { ...base, outcome: "manual", reason: "MANUAL_NOT_CHECKED" };
    else if (cls === "S5") e = { ...base, outcome: "not-run", reason: "NOT_RUN_BY_DESIGN" };
    else if (cls === "S2") {
      // A FAIL under a report-only id is still only a warning (never reject), when it is new.
      e = cand.failCount > ref.failCount ? { ...base, outcome: "warn", reason: "REPORT" } : { ...base, ...reportOutcome(ref, cand) };
    } else {
      e = { ...base, ...automatedOutcome(ref, cand), ...(cls === "S3" ? { eye: "MANUAL_NOT_CHECKED" as const } : {}) };
    }
    if (e.outcome === "reject" || e.outcome === "warn") e.issues = evidence(c.get(def.id));
    checks.push(e);
  }
  const unregistered: GuardCheckEntry[] = [];
  for (const id of [...new Set([...r.keys(), ...c.keys()])].filter((k) => !known.has(k)).sort()) {
    const ref = summarize(r.get(id));
    const cand = summarize(c.get(id));
    const e: GuardCheckEntry = { id, group: "-", class: "unregistered", reference: ref, candidate: cand, ...automatedOutcome(ref, cand) };
    if (e.outcome === "reject" || e.outcome === "warn") e.issues = evidence(c.get(id));
    unregistered.push(e);
  }
  const all = [...checks, ...unregistered];
  const verdict = all.some((e) => e.outcome === "reject") ? "reject" : all.some((e) => e.outcome === "warn") ? "warn" : "pass";
  return { verdict, checks, unregistered, classCounts };
}

// ── Lint-parameter pin (U.1a) ────────────────────────────────────────────

export interface LintParamDiff {
  key: string;
  reference: unknown;
  candidate: unknown;
}

/** Keys of the lint-parameter set whose resolved value differs (stable JSON compare). Pure. */
export function lintParamDiffs(reference: Readonly<Record<string, unknown>>, candidate: Readonly<Record<string, unknown>>, keys: readonly string[] = lintParameterKeys()): LintParamDiff[] {
  const own = (o: Readonly<Record<string, unknown>>, k: string) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  const out: LintParamDiff[] = [];
  for (const key of keys) {
    const a = own(reference, key);
    const b = own(candidate, key);
    if (stableStringify(a ?? null) !== stableStringify(b ?? null)) out.push({ key, reference: a ?? null, candidate: b ?? null });
  }
  return out;
}

// ── Guard run ────────────────────────────────────────────────────────────

/** A fail-closed condition (U.1 step 5); becomes `{verdict:"unavailable", reason}`. */
export class GuardUnavailable extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "GuardUnavailable";
  }
}

export interface TemplateGuardOptions {
  /** U.1 step 5 limits (tests shorten them). */
  renderTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxWaiting?: number;
  /** Override of the shipped lint-closure sha (tests); default `shippedLintClosure().sha256`. */
  lintClosureSha?: string;
  /** Test seam: replaces `renderSample` (fault injection: LINT_MODULE_NOT_RUN, LAYOUT_NOT_MEASURED, delays). */
  renderSampleImpl?: typeof renderSample;
}

/** U.5 `guard_report` shape. */
export interface TemplateGuardReport {
  guard: { version: string; sample: string };
  op: TemplateGuardInput["op"];
  slug: string;
  sampleSha256: { reference: string; candidate: string } | null;
  referenceVersionId: string;
  reference: { slug: string; versionNo: number };
  renderTier: StudioTier;
  lintTier: "TERBIT" | "SERAH";
  language: "ID" | "EN";
  formats: ["DOCX", "HTML"];
  lintParamPin: "equal" | "differs";
  /** Tier the reference was re-derived at for the pin (candidate `artifact.tier` differs), else null. */
  lintParamTier: string | null;
  lintParamDiffs?: LintParamDiff[];
  releaseStatus: { reference: string; candidate: string } | null;
  registryCount: number;
  classCounts: Record<GuardClass, number> | null;
  checks: GuardCheckEntry[];
  unregistered: GuardCheckEntry[];
  ingest?: { side: "candidate"; issues: Array<{ pointer?: string; keyword?: string; message: string }> };
  jobWarnings: Array<{ side: "reference" | "candidate"; code: string; message: string }>;
  verdict: "pass" | "warn" | "reject";
  durationMs: number;
}

function sideFailures(side: "reference" | "candidate", out: SampleRenderResult): void {
  const r = out.render;
  if (!r) return;
  const codes = r.log.entries.map((e) => e.code).filter((c): c is string => typeof c === "string");
  for (const code of GUARD_FAIL_CLOSED_LOG_CODES) {
    if (codes.includes(code)) throw new GuardUnavailable(code, `${side} render: ${code}`, { side });
  }
  if (r.status !== "SUCCEEDED" || r.failed.length > 0 || r.errors.length > 0) {
    throw new GuardUnavailable("RENDER_FAILED", `${side} render ${r.status}`, { side, failed: r.failed, errors: r.errors.slice(0, 5).map((e) => ({ code: e.code, message: clipDetail(e.message) })) });
  }
  if (!r.lint) throw new GuardUnavailable("LINT_MISSING", `${side} render produced no lint report`, { side });
}

function jobWarningsOf(side: "reference" | "candidate", out: SampleRenderResult): TemplateGuardReport["jobWarnings"] {
  return (out.render?.log.entries ?? [])
    .filter((e) => e.level === "warn" || e.level === "error")
    .slice(0, 20)
    .map((e) => ({ side, code: String(e.code ?? "-"), message: clipDetail(e.message) }));
}

/** Shrink a report until it fits the row 64 cap (drop issue details first, then pass entries' sides). */
export function fitReport(report: TemplateGuardReport): TemplateGuardReport {
  const size = (r: unknown) => Buffer.byteLength(JSON.stringify(r), "utf8");
  if (size(report) <= GUARD_REPORT_MAX_BYTES) return report;
  const lean: TemplateGuardReport = {
    ...report,
    jobWarnings: report.jobWarnings.slice(0, 5),
    checks: report.checks.map((c) => (c.issues ? { ...c, issues: c.issues.slice(0, 3).map((i) => ({ ...i, detail: i.detail.slice(0, 120) })) } : c)),
    unregistered: report.unregistered.map((c) => (c.issues ? { ...c, issues: c.issues.slice(0, 3) } : c)),
  };
  if (size(lean) <= GUARD_REPORT_MAX_BYTES) return lean;
  return { ...lean, checks: lean.checks.map(({ issues: _i, ...c }) => c), unregistered: lean.unregistered.map(({ issues: _i, ...c }) => c) };
}

async function withTimeout<T>(p: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GuardUnavailable(reason, `template guard exceeded ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Failing checks of a candidate whose sample Studio's ingest gate refused (no render): the gate's lint
 * report FAILs and the issues' `checkId`s, per id, against the reference's render lint. Every entry is a
 * reject (the reference rendered, the candidate cannot); ids without a check id fall under `ingest`.
 */
function ingestGateChecks(reference: LintReport, cand: SampleRenderResult, lintTier: "TERBIT" | "SERAH"): { checks: GuardCheckEntry[]; unregistered: GuardCheckEntry[] } {
  const issues: LintIssue[] = [...(cand.ingest.lint?.checks ?? []).filter((c) => c.status === "FAIL")];
  for (const i of cand.ingest.issues ?? []) {
    const id = (i as { checkId?: unknown }).checkId;
    // The gate's lint report already holds the same finding when it has the id (the issue repeats it as "<id>: …").
    if (typeof id === "string" && !issues.some((x) => x.checkId === id)) issues.push({ checkId: id, status: "FAIL", detail: i.message, ...(i.pointer ? { pointer: i.pointer } : {}) });
  }
  if (issues.length === 0) issues.push({ checkId: "ingest", status: "FAIL", detail: cand.ingest.issues?.[0]?.message ?? "sample refused" });
  const ref = byId(reference);
  const cmp = byId({ ...reference, checks: issues });
  const defs = new Map(LINT_REGISTRY.map((d) => [d.id, d]));
  const checks: GuardCheckEntry[] = [];
  const unregistered: GuardCheckEntry[] = [];
  for (const [id, list] of [...cmp].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const def = defs.get(id);
    const e: GuardCheckEntry = {
      id,
      group: def?.group ?? "-",
      class: def ? guardClassOf(def, lintTier) : "unregistered",
      reference: summarize(ref.get(id)),
      candidate: summarize(list),
      outcome: "reject",
      reason: "REGRESSION",
      issues: evidence(list),
    };
    (def ? checks : unregistered).push(e);
  }
  return { checks, unregistered };
}

/**
 * The reference's resolved params with only `artifact.tier` replaced: its own layers (preset fold +
 * template layer, `loadTemplateLayers`) through the same `resolveParams` that folded the version
 * (`composeVersion`), so class-T keys are derived for that tier.
 */
export async function referenceParamsAtTier(versionId: string, tier: string): Promise<Readonly<Record<string, unknown>>> {
  const t = await loadTemplateLayers(versionId);
  const r = resolveParams({ base: t.layers.preset, overrides: { ...t.layers.template, "artifact.tier": tier }, registry: ALL_PARAMS });
  if (r.errors.length > 0) throw new GuardUnavailable("REFERENCE_TIER_UNRESOLVED", `reference params at tier ${tier} do not resolve`, { errors: r.errors.slice(0, 5).map((e) => e.key) });
  return r.params;
}

async function runGuardOnce(input: TemplateGuardInput, o: Required<Pick<TemplateGuardOptions, "renderTimeoutMs">> & TemplateGuardOptions, skillSha: string): Promise<TemplateGuardOutcome> {
  const t0 = Date.now();
  const render = o.renderSampleImpl ?? renderSample;
  const refSide: RenderSide = await sideFromVersion(input.reference.versionId);
  const candSide: RenderSide = await sideFromCandidate(input.candidate, refSide.tpl);
  const lintTier = input.lintTier;
  const language = sampleLanguageOf(candSide.tpl.params);
  const baseReport = {
    guard: { version: "row67-1", sample: SWARM_SAMPLE_VERSION },
    op: input.op,
    slug: input.slug,
    referenceVersionId: input.reference.versionId,
    reference: { slug: input.reference.slug, versionNo: input.reference.versionNo },
    renderTier: lintTier as StudioTier,
    lintTier,
    language,
    formats: ["DOCX", "HTML"] as ["DOCX", "HTML"],
    registryCount: LINT_REGISTRY_COUNT,
  };

  // U.1a: the candidate may not move its own judge. A tier change (artifact.tier, editable) moves the
  // class-T keys derived from the tier (auditByTier, serahByTier: stricter at SERAH), so the reference
  // is re-derived at the candidate's tier first; any other difference still rejects.
  const candTier = candSide.tpl.params["artifact.tier"];
  const tierRederived = candTier !== refSide.tpl.params["artifact.tier"] && typeof candTier === "string" ? candTier : null;
  const refPin = tierRederived ? await referenceParamsAtTier(input.reference.versionId, tierRederived) : refSide.tpl.params;
  const diffs = lintParamDiffs(refPin, candSide.tpl.params);
  if (diffs.length > 0) {
    const report: TemplateGuardReport = {
      ...baseReport,
      lintParamTier: tierRederived,
      sampleSha256: null,
      lintParamPin: "differs",
      lintParamDiffs: diffs,
      releaseStatus: null,
      classCounts: null,
      checks: diffs.map((d): GuardCheckEntry => ({ id: "lint-param", group: "-", class: "unregistered", key: d.key, reference: { status: "ABSENT", failCount: 0, reportCount: 0 }, candidate: { status: "ABSENT", failCount: 0, reportCount: 0 }, outcome: "reject" })),
      unregistered: [],
      jobWarnings: [],
      verdict: "reject",
      durationMs: Date.now() - t0,
    };
    return { verdict: "reject", report: fitReport(report) };
  }

  // Same sample content on both sides (same slug, language and tier); sections follow each skeleton.
  const refDoc = swarmSampleDocument({ slug: input.reference.slug, tier: lintTier, slots: refSide.skeleton.skeleton.slots, language });
  const candDoc = swarmSampleDocument({ slug: input.reference.slug, tier: lintTier, slots: candSide.skeleton.skeleton.slots, language });
  const common = { tier: lintTier as StudioTier, formats: ["DOCX", "HTML"] as const, timeoutMs: o.renderTimeoutMs, correlationId: input.correlationId };

  const refOut = await render(refSide, refDoc, { ...common, jobId: `guard-${input.correlationId}-reference` });
  if (!refOut.render) {
    throw new GuardUnavailable("SAMPLE_INVALID", "the reference refuses the sample", { issues: (refOut.ingest.issues ?? []).slice(0, 5) });
  }
  sideFailures("reference", refOut);
  const candOut = await render(candSide, candDoc, { ...common, jobId: `guard-${input.correlationId}-candidate` });
  const jobWarnings = [...jobWarningsOf("reference", refOut), ...jobWarningsOf("candidate", candOut)];
  const shas = { reference: sampleSha256(refDoc), candidate: sampleSha256(candDoc) };

  if (!candOut.render) {
    // The reference accepts the sample, the candidate does not: the change caused it. Studio's
    // by-construction gate (blocksIngest checks, e.g. DATUM-05) refused the candidate's document at
    // ingest, so there is no render; its failing checks are reported per id against the reference.
    const issues = (candOut.ingest.issues ?? []).slice(0, GUARD_MAX_ISSUES_PER_CHECK).map((i) => ({ ...(i.pointer ? { pointer: i.pointer } : {}), ...(i.keyword ? { keyword: i.keyword } : {}), message: clipDetail(i.message) }));
    const gate = ingestGateChecks(refOut.render.lint!, candOut, lintTier);
    const report: TemplateGuardReport = {
      ...baseReport,
      lintParamTier: tierRederived,
      sampleSha256: shas,
      lintParamPin: "equal",
      releaseStatus: { reference: refOut.render.lint!.releaseStatus, candidate: "NOT_RUN" },
      classCounts: null,
      checks: gate.checks,
      unregistered: gate.unregistered,
      ingest: { side: "candidate", issues },
      jobWarnings,
      verdict: "reject",
      durationMs: Date.now() - t0,
    };
    return { verdict: "reject", report: fitReport(report) };
  }
  sideFailures("candidate", candOut);

  const cmp = compareLintReports(refOut.render.lint!, candOut.render.lint!, lintTier);
  const report: TemplateGuardReport = {
    ...baseReport,
    lintParamTier: tierRederived,
    sampleSha256: shas,
    lintParamPin: "equal",
    releaseStatus: { reference: refOut.render.lint!.releaseStatus, candidate: candOut.render.lint!.releaseStatus },
    classCounts: cmp.classCounts,
    checks: cmp.checks,
    unregistered: cmp.unregistered,
    jobWarnings,
    verdict: cmp.verdict,
    durationMs: Date.now() - t0,
  };
  const fitted = fitReport(report);
  if (cmp.verdict === "reject") return { verdict: "reject", report: fitted };
  return { verdict: cmp.verdict, report: fitted, skillSha };
}

/**
 * The row 67 guard for `configureTemplateGuard`. One run at a time (one Chromium bridge), at most
 * `maxWaiting` (4) queued; more -> GUARD_BUSY. Never throws: every failure is an outcome.
 */
export function createTemplateGuard(opts: TemplateGuardOptions = {}): TemplateGuard {
  const renderTimeoutMs = opts.renderTimeoutMs ?? GUARD_RENDER_TIMEOUT_MS;
  const totalTimeoutMs = opts.totalTimeoutMs ?? GUARD_TOTAL_TIMEOUT_MS;
  const maxWaiting = opts.maxWaiting ?? GUARD_MAX_WAITING;
  let tail: Promise<unknown> = Promise.resolve();
  /** Runs accepted and not finished: the running one plus the queued ones. */
  let inFlight = 0;

  const unavailable = (input: TemplateGuardInput, reason: string, err: unknown, context: Record<string, unknown> = {}): TemplateGuardOutcome => {
    templatesLog({
      level: reason === "GUARD_BUSY" ? "warn" : "error",
      message: `template guard unavailable: ${reason}`,
      code: "GUARD_UNAVAILABLE",
      correlationId: input.correlationId,
      ...(err instanceof Error && reason !== "GUARD_BUSY" ? { stack_trace: err.stack } : {}),
      context: { op: input.op, slug: input.slug, reason, reference: input.reference, ...context, ...(err instanceof Error ? { error: err.message } : {}) },
    });
    return { verdict: "unavailable", reason };
  };

  return async (input: TemplateGuardInput): Promise<TemplateGuardOutcome> => {
    if (inFlight >= 1 + maxWaiting) return unavailable(input, "GUARD_BUSY", null, { waiting: inFlight - 1 });
    inFlight += 1;
    const turn = tail.then(async () => {
      const started = Date.now();
      try {
        const skillSha = opts.lintClosureSha ?? shippedLintClosure().sha256;
        const out = await withTimeout(runGuardOnce(input, { ...opts, renderTimeoutMs }, skillSha), totalTimeoutMs, "GUARD_TIMEOUT");
        templatesLog({
          level: out.verdict === "reject" ? "warn" : "info",
          message: `template guard ${out.verdict}`,
          code: out.verdict === "reject" ? "GUARD_REJECTED" : "GUARD_DONE",
          correlationId: input.correlationId,
          context: { op: input.op, slug: input.slug, reference: input.reference, lintTier: input.lintTier, verdict: out.verdict, durationMs: Date.now() - started },
        });
        return out;
      } catch (err) {
        if (err instanceof GuardUnavailable) return unavailable(input, err.reason, err, err.context);
        if (err instanceof SampleRenderError) return unavailable(input, err.reason, err);
        return unavailable(input, "GUARD_ERROR", err);
      } finally {
        inFlight -= 1;
      }
    });
    tail = turn.catch(() => undefined);
    return turn;
  };
}

/** A fresh correlation id for guard runs started outside the service (preview `check`). */
export function newGuardCorrelationId(): string {
  return randomUUID();
}
