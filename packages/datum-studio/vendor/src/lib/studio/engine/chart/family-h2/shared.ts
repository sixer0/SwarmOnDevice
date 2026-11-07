/**
 * engine/chart/family-h2 — persiapan bersama H-06..H-09 (S36).
 *
 * Memakai helper inti S32 (`../core/*`), tidak menduplikasinya: SvgDoc (mm, pt fisik),
 * palet + peran warna, `chartParam`/`kindKey`, `chartFloors`, aparatus (penanda halaman,
 * caption + SUMBER, catatan). Berkas ini hanya menambah yang khas keluarga:
 *
 * - gaya (`spec.style`): "datum" (default) dan "gallery" (panel Gambar 8.2) lewat `Look`;
 * - ukuran huruf selalu >= lantai `chart.minFontPt` (pt fisik, F-007);
 * - parameter registri: `spec.params["chart.kind.<KODE>.<nama>"]` -> templat -> default
 *   registri; alias pendek galeri S94 (`nodeSize`, `maxSets`, ...) sudah dipindah ke kunci
 *   penuh oleh resolver tunggal chart/core (`core/params.ts`, D-87);
 * - rujukan aksen (D-58): medan `accent` {point, group, series}, alias `params.accentPoint`
 *   / `accentGroup` / `accentSeries`, ditambah petunjuk data kode (mis. `accentSet`,
 *   terdaftar di `CHART_DATA_HINT_KEYS` core);
 * - kunci `params` lain dibuang resolver core + REPORT `PARAM_IGNORED` (D-58).
 */
import type { ChartCode, LintIssue, ParamValue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { PARAMS_BY_KEY } from "../../../params";
import { figureFootMm, apparatusMarker, figureApparatus, noteLine } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import { type ChartPalette, chartPalette, kindKey } from "../core/palette";
import { accentOf } from "../core/params";
import { hintBool, hintEnum, hintValue, invalidParam, kindBool, kindEnum, kindInt, kindValue } from "../core/read";
import { chartFloors } from "../core/prepare";
import { SvgDoc } from "../core/svg";

export type H2Code = "H-06" | "H-07" | "H-08" | "H-09";
export type H2Style = "datum" | "gallery";

/** Ukuran huruf (pt fisik) dan tebal garis (mm) per gaya. */
export interface Look {
  style: H2Style;
  labelPt: number;
  valuePt: number;
  tickPt: number;
  /** Garis sumbu (mm). */
  axisMm: number;
  /** Garis tanda data dasar (mm, >= 0,18 lint 27). */
  markMm: number;
  /** Garis tanda aksen (mm). */
  accentMm: number;
}

export interface H2Prep {
  code: H2Code;
  fid: string;
  style: H2Style;
  look: Look;
  pal: ChartPalette;
  dec: number;
  unit: string;
  maxAccent: number;
  minFontPt: number;
  /** Rujukan aksen (urutan: medan `accent`, lalu alias params). */
  accentRefs: Array<string | number>;
  /** Pita bawah (catatan + aparatus figure), mm. */
  footMm: number;
}

/** Huruf tidak pernah di bawah lantai templat (pt fisik). */
function lookFor(style: H2Style, minPt: number): Look {
  // Lint 28 inti bertoleransi 1e-3 pt (IP-25), jadi ukuran TEPAT di lantai lolos; kenaikan
  // sementara +0,005 pt (S36) dihapus.
  const f = (pt: number): number => Math.max(pt, minPt);
  return style === "gallery"
    ? { style, labelPt: f(6.2), valuePt: f(6.4), tickPt: f(6.0), axisMm: 0.25, markMm: 0.25, accentMm: 0.4 }
    : { style, labelPt: f(6.4), valuePt: f(6.8), tickPt: f(6.2), axisMm: 0.29, markMm: 0.24, accentMm: 0.42 };
}

function pushRef(out: Array<string | number>, v: unknown): void {
  if (typeof v === "string" && v.length > 0) out.push(v);
  else if (typeof v === "number" && Number.isFinite(v)) out.push(v);
}

/**
 * Rujukan aksen dari spec: aksen ter-normalisasi inti (`accentOf`: medan `accent` >
 * `accent.*` > alias, satu tingkat menang utuh, S84 #1) lalu petunjuk data khusus kode
 * (`extraKeys`, mis. H-07 `accentLink`). Medan `point`/`group`/`series` aksen yang sama
 * menyatakan SATU subjek: hanya medan pertama yang ada (point > group > series) dipakai.
 */
export function accentRefsOf(spec: StudioChartV1, extraKeys: readonly string[] = []): Array<string | number> {
  const out: Array<string | number> = [];
  const a = accentOf(spec);
  if (a) pushRef(out, a.point ?? a.group ?? a.series);
  for (const k of extraKeys) pushRef(out, spec.params?.[k]);
  return out;
}

export function prepareH2(spec: StudioChartV1, tpl: ResolvedTemplate, code: H2Code, extraAccentKeys: readonly string[] = []): H2Prep {
  const floors = chartFloors(spec, tpl);
  const style: H2Style = (spec.style ?? "datum") === "gallery" ? "gallery" : "datum";
  return {
    code,
    fid: figureLabel(spec),
    style,
    look: lookFor(style, floors.minFontPt),
    pal: chartPalette(spec, tpl),
    dec: spec.dec ?? 0,
    unit: spec.unit ?? "",
    maxAccent: floors.maxAccent,
    minFontPt: floors.minFontPt,
    accentRefs: accentRefsOf(spec, extraAccentKeys),
    footMm: figureFootMm(spec) + (spec.note ? 5 : 0),
  };
}

/**
 * Nilai parameter lewat API baca tunggal inti (`core/read.ts`, S84 #8): nama ParamDef
 * registri kode (`nodeSize`, `highlightBridges`, `maxSets`) -> kunci penuh di spec ->
 * templat -> default; selain itu petunjuk data kode (`rowOrder`, `labels`, `order`,
 * `regionLabels`; `CHART_DATA_HINT_KEYS` core) `spec.params[<nama>]`.
 */
const isRegistry = (code: ChartCode, name: string): boolean => PARAMS_BY_KEY.has(kindKey(code, name));

export function h2Param(spec: StudioChartV1, tpl: ResolvedTemplate, code: ChartCode, name: string): ParamValue | undefined {
  return isRegistry(code, name) ? kindValue({ spec, tpl, code }, name) : hintValue(spec, name);
}

export function h2Bool(spec: StudioChartV1, tpl: ResolvedTemplate, code: ChartCode, name: string, fallback: boolean): boolean {
  return isRegistry(code, name) ? kindBool({ spec, tpl, code }, name, fallback) : hintBool(spec, name, fallback);
}

export function h2Enum<T extends string>(
  spec: StudioChartV1,
  tpl: ResolvedTemplate,
  code: ChartCode,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  return isRegistry(code, name) ? kindEnum({ spec, tpl, code }, name, allowed, fallback) : hintEnum(spec, name, allowed, fallback);
}

/** Bilangan bulat registri dengan batas tambahan renderer `min..max`. */
export function h2Int(spec: StudioChartV1, tpl: ResolvedTemplate, code: ChartCode, name: string, fallback: number, min: number, max: number): number {
  const v = kindInt({ spec, tpl, code }, name, fallback);
  if (v < min || v > max) throw invalidParam(spec, kindKey(code, name), v, `bilangan bulat ${min}..${max}`, code);
  return v;
}

/** SvgDoc dengan penanda aparatus halaman dan latar kertas. */
export function openDoc(spec: StudioChartV1, prep: H2Prep, widthMm: number, heightMm: number): SvgDoc {
  const doc = new SvgDoc(widthMm, heightMm, `data-chart="${prep.code}" data-style="${prep.style}"`, prep.minFontPt);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(prep.pal.paper);
  return doc;
}

/** Catatan + aparatus figure, lalu SvgResult dengan temuan renderer (PARAM_* oleh resolver core). */
export function closeDoc(doc: SvgDoc, spec: StudioChartV1, prep: H2Prep, issues: LintIssue[]): SvgResult {
  const W = doc.widthMm;
  const H = doc.heightMm;
  if (spec.note) noteLine(doc, spec.note, W, H - figureFootMm(spec) - 1.4, prep.pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, prep.pal, H);
  const all = [...issues];
  const checksRun = [...new Set(all.map((i) => i.checkId))];
  return { svg: doc.toString(), widthMm: W, heightMm: H, report: { checksRun, issues: all } };
}

/** Aksen melebihi `chart.accent.maxSubjects` (lint 26) -> cacat by-construction. */
export function assertAccentCount(prep: H2Prep, n: number, what: string): void {
  if (n > prep.maxAccent) {
    throw defect("DATUM-26", `${prep.fid} — ${n} ${what} beraksen; maks ${prep.maxAccent} aksen per gambar (§03 §2)`, {
      code: prep.code,
      accents: n,
    });
  }
}

export function schemaError(prep: Pick<H2Prep, "fid" | "code">, message: string, extra: Record<string, unknown> = {}): StudioEngineError {
  return new StudioEngineError("SCHEMA_INVALID", `${prep.fid} — ${prep.code}: ${message}`, { code: prep.code, ...extra });
}

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Data graf tervalidasi (H-07, H-08): id unik, tautan ke simpul yang ada, tanpa loop diri. */
export interface GraphData {
  nodes: Array<{ id: string; label: string; value?: number; group?: string }>;
  links: Array<{ from: number; to: number; value: number }>;
}

export function requireGraph(spec: StudioChartV1, prep: H2Prep): GraphData {
  const d = spec.data;
  if (!d) throw schemaError(prep, "data wajib");
  if (d.shape !== "graph") throw schemaError(prep, `membutuhkan data "graph", diterima "${d.shape}"`, { shape: d.shape });
  if (!Array.isArray(d.nodes) || d.nodes.length === 0) throw defect("DC-G1", `${prep.fid} — grafik tanpa simpul`, { code: prep.code });
  const index = new Map<string, number>();
  d.nodes.forEach((n, i) => {
    if (typeof n?.id !== "string" || n.id === "" || typeof n.label !== "string") throw schemaError(prep, `simpul ${i} tanpa id atau label`, { index: i });
    if (index.has(n.id)) throw schemaError(prep, `id simpul "${n.id}" ganda`, { index: i });
    if (n.value !== undefined && !finite(n.value)) throw schemaError(prep, `nilai simpul "${n.id}" bukan bilangan hingga`, { index: i });
    index.set(n.id, i);
  });
  const links = (Array.isArray(d.links) ? d.links : []).map((l, j) => {
    const from = index.get(l?.from);
    const to = index.get(l?.to);
    if (from === undefined || to === undefined) throw schemaError(prep, `tautan ${j} merujuk simpul yang tidak ada (${String(l?.from)} -> ${String(l?.to)})`, { index: j });
    if (from === to) throw schemaError(prep, `tautan ${j} menghubungkan simpul "${l.from}" ke dirinya sendiri`, { index: j });
    if (l.value !== undefined && (!finite(l.value) || l.value < 0)) throw schemaError(prep, `nilai tautan ${j} bukan bilangan hingga >= 0`, { index: j });
    return { from, to, value: l.value ?? 1 };
  });
  return { nodes: d.nodes.map((n) => ({ ...n })), links };
}

/**
 * Tautan aksen dari `params.accentLink` ([from, to] id simpul, arah diabaikan). `undefined`
 * bila tidak ada atau tidak cocok dengan tautan mana pun (diabaikan seperti petunjuk aksen inti).
 */
export function accentLinkIndex(spec: StudioChartV1, g: GraphData): number | undefined {
  const v = spec.params?.accentLink;
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || typeof v[1] !== "string") return undefined;
  const ids = g.nodes.map((n) => n.id);
  const a = ids.indexOf(v[0]);
  const b = ids.indexOf(v[1]);
  if (a < 0 || b < 0) return undefined;
  const j = g.links.findIndex((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a));
  return j < 0 ? undefined : j;
}

/** Indeks simpul yang cocok dengan rujukan aksen (id, label, atau indeks bilangan). */
export function matchNode(g: GraphData, ref: string | number): number | undefined {
  if (typeof ref === "number") return Number.isInteger(ref) && ref >= 0 && ref < g.nodes.length ? ref : undefined;
  const byId = g.nodes.findIndex((n) => n.id === ref);
  if (byId >= 0) return byId;
  const byLabel = g.nodes.findIndex((n) => n.label === ref);
  return byLabel >= 0 ? byLabel : undefined;
}

/** Derajat simpul (tautan paralel dihitung masing-masing). */
export function degrees(g: GraphData): number[] {
  const deg = g.nodes.map(() => 0);
  for (const l of g.links) {
    deg[l.from]++;
    deg[l.to]++;
  }
  return deg;
}

/** Lebar garis tautan menurut nilai: rentang [base, base x 2] bila nilai bervariasi. */
export function linkWidthFor(value: number, lo: number, hi: number, baseMm: number): number {
  if (!(hi > lo)) return baseMm;
  return baseMm * (1 + (value - lo) / (hi - lo));
}
