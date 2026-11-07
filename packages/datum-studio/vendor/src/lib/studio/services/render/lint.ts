/**
 * Agregasi lint pasca-render (S51): `runLint` (S44, runner + status rilis per
 * tier P16-01) ditambah modul struktur (S46), bahasa (S47), dan render (S45).
 *
 * Lint TIDAK menahan berkas: modul yang gagal dijalankan dicatat sebagai
 * peringatan job dan kontribusinya dianggap NOT_RUN. Cek dari modul tambahan
 * hanya digabung bila `checkId`-nya belum dilaporkan runner (runner S44 boleh
 * sudah memanggil modul yang sama). Urutan hasil deterministik.
 */
import type { LayoutMetrics, LintIssue, LintReport, NormDocSnapshot, ParamMap, ResolvedTemplate, StudioTier, SvgResult } from "../../contract";
import { runLint } from "../../engine/lint/scan";
import {
  lintRenderedWith,
  RENDER_LINT_DEFAULTS,
  renderLintLimitsFromParams,
  type RenderLintLimits,
} from "../../engine/lint/render";
import { lintStructure } from "../../engine/lint/structure";
import { lintLanguage } from "../../engine/lint/language";
import { LINT_REGISTRY } from "../../registry/lint";
import type { JobLog } from "./joblog";

type Tier = LintReport["tier"];

const TIER_SET: ReadonlySet<string> = new Set(["NOTA", "TERBIT", "SERAH"]);

function tierOf(t: string): Tier {
  return (TIER_SET.has(t) ? t : "NOTA") as Tier;
}

function issueKey(i: LintIssue): string {
  return `${i.checkId}\u0000${i.address ?? ""}\u0000${i.pointer ?? ""}\u0000${i.status}\u0000${i.detail ?? ""}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Urut stabil: checkId, alamat, pointer, status, detail. */
export function sortIssues(list: readonly LintIssue[]): LintIssue[] {
  const seen = new Set<string>();
  const out: LintIssue[] = [];
  for (const i of list) {
    const k = issueKey(i);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out.sort((a, b) => cmp(issueKey(a), issueKey(b)));
}

const TIERS_BY_CHECK: ReadonlyMap<string, readonly string[]> = new Map(LINT_REGISTRY.map((d) => [d.id, d.tiers]));

/** Cek berlaku untuk tier bila terdaftar untuk tier itu; cek tak terdaftar selalu berlaku. */
function appliesTo(i: LintIssue, tier: Tier): boolean {
  const tiers = TIERS_BY_CHECK.get(i.checkId);
  return !tiers || tiers.includes(tier);
}

/** Status rilis per tier dari daftar cek (dipakai bila runner tidak tersedia atau cek tambahan masuk). */
export function releaseFor(checks: readonly LintIssue[], tier: Tier): LintReport["releaseStatus"] {
  const applicable = checks.filter((c) => appliesTo(c, tier));
  if (applicable.some((c) => c.status === "FAIL")) return "FAIL";
  if (applicable.some((c) => c.status === "PASS" || c.status === "REPORT")) return "PASS";
  return "NOT_RUN";
}

function counts(checks: readonly LintIssue[]): string {
  const n = { PASS: 0, FAIL: 0, REPORT: 0, NOT_RUN: 0 } as Record<string, number>;
  for (const c of checks) n[c.status] = (n[c.status] ?? 0) + 1;
  return `PASS ${n.PASS}, FAIL ${n.FAIL}, REPORT ${n.REPORT}; NOT-RUN ${n.NOT_RUN}`;
}

function safeRun<T>(log: JobLog, label: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    log.warn(`lint module ${label} not run: ${err instanceof Error ? err.message : String(err)}`, { code: "LINT_MODULE_NOT_RUN" });
    return undefined;
  }
}

/**
 * Batas lint render dari parameter templat (D-64, S45): `lintRendered` kontrak
 * memakai default katalog; S51 memakai batas templat (yang lebih ketat menang).
 * Parameter rusak -> default katalog + peringatan job (lint tidak menahan berkas).
 */
export function renderLintLimitsFor(log: Pick<JobLog, "warn">, params: ParamMap | undefined): RenderLintLimits {
  if (!params) return RENDER_LINT_DEFAULTS;
  try {
    return renderLintLimitsFromParams(params);
  } catch (err) {
    log.warn(`render lint limits from template unavailable, catalogue defaults used: ${err instanceof Error ? err.message : String(err)}`, {
      code: "LINT_LIMITS_DEFAULTED",
    });
    return RENDER_LINT_DEFAULTS;
  }
}

export interface LintInput {
  snapshot: NormDocSnapshot;
  tpl: ResolvedTemplate;
  tier: StudioTier;
  html?: string;
  metrics?: LayoutMetrics;
  svgs: readonly SvgResult[];
  /** Cek tambahan layanan render (mis. gerbang labels_verified diagram). */
  extra?: readonly LintIssue[];
  log: JobLog;
}

/** Laporan lint pasca-render dengan status rilis per tier. Tidak melempar. */
export function lintAfterRender(i: LintInput): LintReport {
  const tier = tierOf(i.tier);
  const base = safeRun(i.log, "scan", () => runLint({ snapshot: i.snapshot, tpl: i.tpl, tier: i.tier, stage: "post" }));
  const baseChecks = base?.checks ?? [];
  const reported = new Set(baseChecks.map((c) => c.checkId));

  const extra: LintIssue[] = [];
  const addMissing = (list: readonly LintIssue[] | undefined): void => {
    if (!list) return;
    for (const c of list) if (!reported.has(c.checkId)) extra.push(c);
  };
  addMissing(safeRun(i.log, "structure", () => lintStructure(i.snapshot, i.tpl, i.tier)));
  addMissing(safeRun(i.log, "language", () => lintLanguage(i.snapshot, i.tpl.params)));
  if (i.metrics || i.svgs.length > 0) {
    const metrics: LayoutMetrics = i.metrics ?? { pageCount: 0, elements: [] };
    const limits = renderLintLimitsFor(i.log, i.tpl.params);
    addMissing(safeRun(i.log, "render", () => lintRenderedWith({ html: i.html, svgs: i.svgs, metrics }, limits)));
  }
  // Laporan cek SVG mesin (chart/diagram) ikut sebagai bukti.
  for (const s of i.svgs) addMissing(s.report.issues);
  addMissing(i.extra);

  const checks = sortIssues([...baseChecks, ...extra]);
  if (base && extra.length === 0) return { ...base, tier, checks };

  let releaseStatus = releaseFor(checks, tier);
  // Runner S44 berwenang atas FAIL-nya sendiri; cek tambahan hanya bisa memperburuk.
  if (base?.releaseStatus === "FAIL") releaseStatus = "FAIL";
  const banner = base
    ? `${base.banner} | render: ${extra.length} cek tambahan (${counts(extra)}); rilis ${tier}: ${releaseStatus}`
    : `Lint ${tier}: ${checks.length} cek (${counts(checks)}); runner tidak tersedia; rilis ${tier}: ${releaseStatus}`;
  return { tier, checks, releaseStatus, banner };
}

/**
 * Lint artefak mandiri (chart/diagram/gambar): hanya laporan SVG + cek tambahan.
 * `params` = parameter templat artefak bila ada (batas lint render templat).
 */
export function lintArtifact(i: {
  svgs: readonly SvgResult[];
  extra?: readonly LintIssue[];
  html?: string;
  metrics?: LayoutMetrics;
  params?: ParamMap;
  log: JobLog;
}): LintReport {
  const tier: Tier = "NOTA";
  const list: LintIssue[] = [];
  for (const s of i.svgs) list.push(...s.report.issues);
  if (i.extra) list.push(...i.extra);
  if (i.svgs.length > 0 || i.metrics) {
    const metrics: LayoutMetrics = i.metrics ?? { pageCount: 0, elements: [] };
    const limits = renderLintLimitsFor(i.log, i.params);
    const r = safeRun(i.log, "render", () => lintRenderedWith({ html: i.html, svgs: i.svgs, metrics }, limits));
    if (r) list.push(...r);
  }
  const checks = sortIssues(list);
  const releaseStatus = releaseFor(checks, tier);
  return { tier, checks, releaseStatus, banner: `Lint artefak: ${checks.length} cek (${counts(checks)}); rilis: ${releaseStatus}` };
}
