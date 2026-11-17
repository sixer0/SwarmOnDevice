/**
 * Agregasi lint pasca-render (S51): `runLint` (S44, runner + status rilis per
 * tier P16-01) ditambah modul struktur (S46), bahasa (S47), dan render (S45).
 *
 * Lint TIDAK menahan berkas: modul yang gagal dijalankan dicatat sebagai
 * peringatan job dan kontribusinya dianggap NOT_RUN. Cek dari modul tambahan
 * hanya digabung bila `checkId`-nya belum dilaporkan runner (runner S44 boleh
 * sudah memanggil modul yang sama). Urutan hasil deterministik.
 *
 * Swarm 1.3.3 row 64 (ST-9 butir 3, register 03 s7 `LintReport.notRun`): laporan
 * memuat daftar aturan dan modul yang TIDAK dijalankan, satu sebab per butir
 * (`lintNotRun`). Daftar ini hanya membaca hasil; aturan yang dijalankan, isi
 * `checks`, status rilis, dan banner tidak berubah.
 */
import type { LayoutMetrics, LintIssue, LintReport, NormDocSnapshot, ParamMap, ResolvedTemplate, StudioTier, SvgResult } from "../../contract";
import { runLint } from "../../engine/lint/scan";
import {
  lintRenderedWith,
  RENDER_LINT_DEFAULTS,
  renderLintLimitsFromParams,
  type RenderLintLimits,
} from "../../engine/lint/render";
import { lintStructure, STRUCTURE_CHECKS } from "../../engine/lint/structure";
import { LANGUAGE_SCANNERS, lintLanguage } from "../../engine/lint/language";
import { ID_ONLY_CHECKS } from "../../engine/lint/language/checks";
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

/** Modul lint yang bisa gagal sebagai satu kesatuan (register 03 s7: `kind: "module"`). */
type LintNotRunModule = "scan" | "structure" | "language" | "render";

/**
 * Sebab sebuah butir tidak dijalankan. Dua keluarga yang harus dibedakan pembaca:
 *  - tidak berlaku untuk dokumen ini: `tier` (aturan tidak terdaftar untuk tier
 *    laporan) dan `not-applicable` (aturan tidak berlaku untuk isi dokumen, mis.
 *    leksikon khusus bahasa Indonesia pada dokumen EN);
 *  - tidak bisa dijalankan: `staged` (aturan terdaftar tanpa pemindai, atau
 *    ber-`notRunReason`) dan `could-not-run` (masukan tidak ada, mis. belum ada
 *    metrik render; galat instrumen; modul melempar).
 * `human` = pemeriksaan manusia, tidak pernah dijalankan mesin.
 */
type LintNotRunCause = "tier" | "not-applicable" | "human" | "staged" | "could-not-run";

/** Satu butir `LintReport.notRun` (register 03 s7: `{id, kind, reason}`; `cause` = kelas sebab). */
export interface LintNotRun {
  /** `kind: "rule"`: id cek (registri atau tak terdaftar); `kind: "module"`: nama modul. */
  id: string;
  kind: "rule" | "module";
  /** Satu sebab, teks untuk pembaca (paling banyak `NOT_RUN_REASON_MAX` karakter). */
  reason: string;
  cause: LintNotRunCause;
}

/** Laporan lint layanan render: `LintReport` kontrak ditambah `notRun` (selalu ada, boleh kosong). */
type LintReportWithNotRun = LintReport & { notRun: LintNotRun[] };

/** @internal test seam */
export const NOT_RUN_REASON_MAX = 300;

/** Modul yang gagal atau tidak dipanggil pada satu pemanggilan lint. */
interface LintModuleNotRun {
  module: LintNotRunModule;
  reason: string;
}

const MODULE_ORDER: readonly LintNotRunModule[] = ["scan", "structure", "language", "render"];
const DEF_BY_ID = new Map(LINT_REGISTRY.map((d) => [d.id, d]));
const REGISTRY_INDEX = new Map(LINT_REGISTRY.map((d, n) => [d.id, n]));
/** Bentuk alasan runner S44 (`notRunReasonFor`) saat sebuah modul melempar di dalam `runLint`. */
const MODULE_FAULT_RE = /^modul engine\/lint\/(scan|structure|language|render) tidak dijalankan: ([\s\S]*)$/;

function clipReason(s: string): string {
  const t = s.trim() || "tanpa keterangan";
  return t.length > NOT_RUN_REASON_MAX ? `${t.slice(0, NOT_RUN_REASON_MAX - 3)}...` : t;
}

/** Aturan terdaftar yang belum punya pemindai atau cek (tahap persiapan). */
function isStaged(def: (typeof LINT_REGISTRY)[number]): boolean {
  if (def.notRunReason !== undefined) return true;
  if (def.module === "language") return !LANGUAGE_SCANNERS[def.id];
  if (def.module === "structure") return !STRUCTURE_CHECKS[def.id];
  return false;
}

interface LintNotRunInput {
  /** `LintReport.checks` akhir. */
  checks: readonly LintIssue[];
  tier: Tier;
  /** Bahasa dokumen (`meta.language`); tanpa ini `not-applicable` bahasa tidak dinilai. */
  language?: "ID" | "EN";
  /** Modul yang melempar atau tidak dipanggil pada pemanggilan ini. */
  modules?: readonly LintModuleNotRun[];
  /**
   * Modul yang cek registrinya wajib muncul di `checks`: aturan modul ini yang
   * sama sekali tidak dilaporkan ikut didaftar. Kosong = hanya butir NOT_RUN
   * yang ada di `checks`.
   */
  cover?: readonly string[];
}

/**
 * Daftar aturan dan modul yang tidak dijalankan, satu butir per id, dengan satu
 * sebab. Murni dan deterministik: modul lebih dulu (scan, structure, language,
 * render), lalu aturan menurut urutan registri, lalu id tak terdaftar menurut
 * abjad. Kosong bila semua cek dijalankan.
 *
 * Sebuah cek "tidak dijalankan" bila punya butir NOT_RUN di `checks`, atau
 * (untuk modul `cover`) terdaftar tetapi tidak dilaporkan sama sekali. Cek yang
 * sebagian berjalan (NOT_RUN di samping PASS/FAIL/REPORT) tetap didaftar, dengan
 * keterangan "sebagian".
 */
export function lintNotRun(i: LintNotRunInput): LintNotRun[] {
  const moduleReason = new Map<LintNotRunModule, string>();
  for (const m of i.modules ?? []) if (!moduleReason.has(m.module)) moduleReason.set(m.module, m.reason);

  const notRun = new Map<string, LintIssue[]>();
  const ran = new Set<string>();
  const present = new Set<string>();
  for (const c of i.checks) {
    present.add(c.checkId);
    if (c.status !== "NOT_RUN") {
      ran.add(c.checkId);
      continue;
    }
    const g = notRun.get(c.checkId);
    if (g) g.push(c);
    else notRun.set(c.checkId, [c]);
    // Modul yang melempar di dalam runner S44 hanya terlihat dari alasan cek-nya.
    const m = typeof c.detail === "string" ? MODULE_FAULT_RE.exec(c.detail) : null;
    if (m && !moduleReason.has(m[1] as LintNotRunModule)) moduleReason.set(m[1] as LintNotRunModule, m[2]);
  }

  const rules: LintNotRun[] = [];
  const tierReason = (tiers: readonly string[]): string => `tidak berlaku pada tier ${i.tier}; berlaku pada ${tiers.join(", ") || "tidak ada tier"}`;

  for (const [id, list] of notRun) {
    const def = DEF_BY_ID.get(id);
    const detail = list.find((c) => c.detail)?.detail;
    let cause: LintNotRunCause = "could-not-run";
    let reason = detail ?? "tanpa keterangan";
    if (def && !def.tiers.includes(i.tier)) {
      cause = "tier";
      reason = tierReason(def.tiers);
    } else if (def?.module === "human") {
      cause = "human";
    } else if (def && isStaged(def)) {
      cause = "staged";
      reason = detail ?? def.notRunReason ?? "pemindai belum terdaftar";
    } else if (i.language === "EN" && ID_ONLY_CHECKS.has(id)) {
      cause = "not-applicable";
    } else if (ran.has(id)) {
      reason = `sebagian: ${list.length} butir tidak diperiksa; ${reason}`;
    }
    rules.push({ id, kind: "rule", reason: clipReason(reason), cause });
  }

  const cover = new Set(i.cover ?? []);
  if (cover.size > 0) {
    for (const def of LINT_REGISTRY) {
      if (present.has(def.id) || !cover.has(def.module)) continue;
      let cause: LintNotRunCause = "could-not-run";
      let reason: string;
      if (!def.tiers.includes(i.tier)) {
        cause = "tier";
        reason = tierReason(def.tiers);
      } else if (def.module === "human") {
        cause = "human";
        reason = "pemeriksaan manusia; tidak dijalankan mesin";
      } else if (isStaged(def)) {
        cause = "staged";
        reason = def.notRunReason ?? "pemindai belum terdaftar";
      } else {
        const why = moduleReason.get(def.module as LintNotRunModule) ?? (def.module !== "render" ? moduleReason.get("scan") : undefined);
        reason = why ? `modul ${def.module} tidak dijalankan: ${why}` : `modul ${def.module} tidak melapor cek ini`;
      }
      rules.push({ id: def.id, kind: "rule", reason: clipReason(reason), cause });
    }
  }

  rules.sort((a, b) => {
    const ia = REGISTRY_INDEX.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const ib = REGISTRY_INDEX.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return ia !== ib ? ia - ib : cmp(a.id, b.id);
  });
  const modules: LintNotRun[] = MODULE_ORDER.filter((m) => moduleReason.has(m)).map((m) => ({
    id: m,
    kind: "module" as const,
    reason: clipReason(moduleReason.get(m) ?? ""),
    cause: "could-not-run" as const,
  }));
  return [...modules, ...rules];
}

/** Alasan modul render tidak dipanggil: belum ada hasil render untuk diukur. */
/** @internal test seam */
export const RENDER_NO_INPUT_REASON = "belum ada metrik tata letak maupun SVG hasil render";

function safeRun<T>(log: JobLog, label: LintNotRunModule, fn: () => T, faults?: LintModuleNotRun[]): T | undefined {
  try {
    return fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`lint module ${label} not run: ${message}`, { code: "LINT_MODULE_NOT_RUN" });
    faults?.push({ module: label, reason: message });
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
export function lintAfterRender(i: LintInput): LintReportWithNotRun {
  const tier = tierOf(i.tier);
  const faults: LintModuleNotRun[] = [];
  const base = safeRun(i.log, "scan", () => runLint({ snapshot: i.snapshot, tpl: i.tpl, tier: i.tier, stage: "post" }), faults);
  const baseChecks = base?.checks ?? [];
  const reported = new Set(baseChecks.map((c) => c.checkId));

  const extra: LintIssue[] = [];
  const addMissing = (list: readonly LintIssue[] | undefined): void => {
    if (!list) return;
    for (const c of list) if (!reported.has(c.checkId)) extra.push(c);
  };
  addMissing(safeRun(i.log, "structure", () => lintStructure(i.snapshot, i.tpl, i.tier), faults));
  addMissing(safeRun(i.log, "language", () => lintLanguage(i.snapshot, i.tpl.params), faults));
  if (i.metrics || i.svgs.length > 0) {
    const metrics: LayoutMetrics = i.metrics ?? { pageCount: 0, elements: [] };
    const limits = renderLintLimitsFor(i.log, i.tpl.params);
    addMissing(safeRun(i.log, "render", () => lintRenderedWith({ html: i.html, svgs: i.svgs, metrics }, limits), faults));
  } else {
    faults.push({ module: "render", reason: RENDER_NO_INPUT_REASON });
  }
  // Laporan cek SVG mesin (chart/diagram) ikut sebagai bukti.
  for (const s of i.svgs) addMissing(s.report.issues);
  addMissing(i.extra);

  const checks = sortIssues([...baseChecks, ...extra]);
  // Row 64: daftar yang tidak dijalankan; semua modul registri wajib tercakup di laporan dokumen.
  const notRun = lintNotRun({
    checks,
    tier,
    language: i.snapshot?.doc?.meta?.language === "EN" ? "EN" : "ID",
    modules: faults,
    cover: ["scan", "structure", "language", "render", "human"],
  });
  if (base && extra.length === 0) return { ...base, tier, checks, notRun };

  let releaseStatus = releaseFor(checks, tier);
  // Runner S44 berwenang atas FAIL-nya sendiri; cek tambahan hanya bisa memperburuk.
  if (base?.releaseStatus === "FAIL") releaseStatus = "FAIL";
  const banner = base
    ? `${base.banner} | render: ${extra.length} cek tambahan (${counts(extra)}); rilis ${tier}: ${releaseStatus}`
    : `Lint ${tier}: ${checks.length} cek (${counts(checks)}); runner tidak tersedia; rilis ${tier}: ${releaseStatus}`;
  return { tier, checks, releaseStatus, banner, notRun };
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
}): LintReportWithNotRun {
  const tier: Tier = "NOTA";
  const faults: LintModuleNotRun[] = [];
  const list: LintIssue[] = [];
  for (const s of i.svgs) list.push(...s.report.issues);
  if (i.extra) list.push(...i.extra);
  if (i.svgs.length > 0 || i.metrics) {
    const metrics: LayoutMetrics = i.metrics ?? { pageCount: 0, elements: [] };
    const limits = renderLintLimitsFor(i.log, i.params);
    const r = safeRun(i.log, "render", () => lintRenderedWith({ html: i.html, svgs: i.svgs, metrics }, limits), faults);
    if (r) list.push(...r);
  } else {
    faults.push({ module: "render", reason: RENDER_NO_INPUT_REASON });
  }
  const checks = sortIssues(list);
  const releaseStatus = releaseFor(checks, tier);
  // Row 64: artefak mandiri hanya wajib mencakup modul render.
  const notRun = lintNotRun({ checks, tier, modules: faults, cover: ["render"] });
  return { tier, checks, releaseStatus, banner: `Lint artefak: ${checks.length} cek (${counts(checks)}); rilis: ${releaseStatus}`, notRun };
}
