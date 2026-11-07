/**
 * engine/chart/family-p1 — kerangka bersama P-03..P-08 (S33, I23).
 *
 * Semua helper geometri/warna/aparatus berasal dari chart/core (S32): SvgDoc (1 satuan
 * pengguna = 1 mm, huruf pt fisik), palet + peran warna, skala rapi, aparatus, penjaga.
 * Berkas ini hanya menambah yang khas keluarga: resolusi parameter per gaya, aksen
 * tingkat spec, validasi bentuk `series`/`distribution`, sumbu bertick, urutan stabil.
 *
 * Aturan parameter per gaya (dicatat di catatan S33):
 * - `gallery`: parameter registri `chart.kind.<KODE>.<nama>` berlaku penuh
 *   (spec.params -> tpl.params -> default registri), mengikuti panel Gambar 8.1.
 * - `datum` (default): resep acuan pustakachart (kelas paritas CB1/CB2, research/06 §6.2)
 *   untuk parameter warna, label, dan urutan; parameter registri berlaku HANYA bila
 *   diset eksplisit (spec.params, atau tpl.params dengan nilai berbeda dari default
 *   registri). Parameter struktural tanpa padanan acuan (maxSeries, gridlines,
 *   zeroBaseline) berlaku penuh di kedua gaya.
 *
 * Aksen (D-58, delta S03-d1): medan `spec.accent` {point, group, series} menang atas
 * alias `params.accentPoint` (string | indeks | {series?, category|label|point}),
 * `params.accentGroup`, `params.accentSeries`; `accent: true` per titik/seri tetap sah.
 * Kunci `params` diselesaikan resolver tunggal chart/core (`core/params.ts`, IP-25/D-87):
 * alias pendek sah sudah dipindah ke kunci penuh sebelum renderer dipanggil; PARAM_ALIAS
 * dan PARAM_IGNORED dilaporkan di sana.
 *
 * Deterministik: tanpa acak, tanpa waktu; urutan elemen = urutan panggilan.
 */
import type {
  ChartCanvas,
  ChartCode,
  LintIssue,
  ParamValue,
  ResolvedTemplate,
  StudioChartV1,
  SvgResult,
} from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { fmt } from "../../bind";
import { figureFootMm, apparatusMarker, figureApparatus, noteLine } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import { type ChartPalette, chartPalette, chartParam, kindKey, resolveChartColor } from "../core/palette";
import { chartFloors } from "../core/prepare";
import { type NiceDomain, type Scale, axisDomain, decimalsFor, linearScale, niceDomain } from "../core/scale";
import { SvgDoc, ptToMm, textWidthMm, midBaseline } from "../core/svg";
import { measure } from "../core/textfit";
import { keyLabelText } from "../core/lang";
import { LABEL_EDGE_MM } from "../core/labelfit";
import { accentOf } from "../core/params";
import { kindAxis, kindBool as coreKindBool, kindEnum as coreKindEnum, kindInt as coreKindInt, kindValue } from "../core/read";

export type P1Code = "P-03" | "P-04" | "P-05" | "P-06" | "P-07" | "P-08";
export type P1Style = "datum" | "gallery";

/** Ukuran huruf (pt fisik) per gaya. Gallery mengikuti chart/core gallery.ts; datum mengikuti style_ax PC. */
export const TYPE_PT = {
  gallery: { label: 6.4, value: 6.4, tick: 6.0, key: 6.0 },
  datum: { label: 6.5, value: 6.5, tick: 6.5, key: 6.5, title: 6.8 },
} as const;

/** Garis (mm). Lantai fotokopi 0,18 mm (DATUM-27). */
export const HAIR_MM = 0.25;
export const GRID_MM = 0.18;
/** Spine PC `axes.linewidth` 0,6 pt. */
export const SPINE_MM = 0.6 * (25.4 / 72);

/** Tinggi `tinggi_mm` registri pustakachart per kode (cek paritas CB1 (d)); dipakai bila spec tanpa heightMm. */
export const P1_REFERENCE_HEIGHT_MM: Readonly<Record<P1Code, number>> = {
  "P-03": 58,
  "P-04": 58,
  "P-05": 60,
  "P-06": 62,
  "P-07": 58,
  "P-08": 62,
};

export interface P1Ctx {
  code: P1Code;
  spec: StudioChartV1;
  tpl: ResolvedTemplate;
  style: P1Style;
  pal: ChartPalette;
  maxAccent: number;
  minFontPt: number;
  dec: number;
  unit: string;
  fid: string;
  W: number;
  H: number;
  /** Batas bawah area gambar (di atas pita catatan/aparatus figure). */
  bottom: number;
  doc: SvgDoc;
  issues: LintIssue[];
  checks: string[];
}

/** Ukuran huruf efektif: tidak pernah di bawah lantai P7-36 templat. */
export function pt(ctx: P1Ctx, size: number): number {
  return Math.max(size, ctx.minFontPt);
}

export function report(ctx: P1Ctx, checkId: string, detail: string): void {
  if (!ctx.checks.includes(checkId)) ctx.checks.push(checkId);
  ctx.issues.push({ checkId, status: "REPORT", detail });
}

export function beginChart(code: P1Code, spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): P1Ctx {
  const style: P1Style = (spec.style ?? "datum") === "gallery" ? "gallery" : "datum";
  const floors = chartFloors(spec, tpl);
  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const doc = new SvgDoc(W, H, `data-chart="${code}" data-style="${style}"`, floors.minFontPt);
  const pal = chartPalette(spec, tpl);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(pal.paper);
  const foot = figureFootMm(spec) + (spec.note ? 5 : 0);
  return {
    code,
    spec,
    tpl,
    style,
    pal,
    maxAccent: floors.maxAccent,
    minFontPt: floors.minFontPt,
    dec: spec.dec ?? 0,
    unit: spec.unit ?? "",
    fid: figureLabel(spec),
    W,
    H,
    bottom: H - foot,
    doc,
    issues: [],
    checks: [],
  };
}

export function endChart(ctx: P1Ctx): SvgResult {
  const { spec, doc, pal, W, H } = ctx;
  if (spec.note) noteLine(doc, spec.note, W, H - figureFootMm(spec) - 1.4, pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, pal, H);
  return { svg: doc.toString(), widthMm: W, heightMm: H, report: { checksRun: ctx.checks, issues: ctx.issues } };
}

// ── Parameter per gaya ────────────────────────────────────────────────────

/** Mode eksplisit D-77: gaya datum membaca hanya nilai eksplisit kecuali parameter struktural (`always`). */
function explicitFor(ctx: P1Ctx, always: boolean): boolean {
  return ctx.style !== "gallery" && !always;
}

/**
 * Nilai parameter kode ini menurut aturan gaya (API baca tunggal inti `core/read.ts`,
 * S84 #8): gallery = efektif penuh; datum = hanya eksplisit (`undefined` -> pemanggil
 * memakai resep acuan). `always` = efektif penuh di kedua gaya (parameter struktural).
 */
export function kindParam(ctx: P1Ctx, name: string, always = false): ParamValue | undefined {
  return kindValue(ctx, name, explicitFor(ctx, always));
}

export function kindBool(ctx: P1Ctx, name: string, fallback: boolean, always = false): boolean {
  return coreKindBool(ctx, name, fallback, explicitFor(ctx, always));
}

export function kindInt(ctx: P1Ctx, name: string, fallback: number, always = false): number {
  return coreKindInt(ctx, name, fallback, explicitFor(ctx, always));
}

export function kindEnum<T extends string>(ctx: P1Ctx, name: string, allowed: readonly T[], fallback: T, always = false): T {
  return coreKindEnum(ctx, name, allowed, fallback, explicitFor(ctx, always));
}

/** Warna peran parameter (tokenRef/hex) -> hex "RRGGBB"; `fallbackHex` bila tidak berlaku. */
export function kindColour(ctx: P1Ctx, name: string, fallbackHex: string, always = false): string {
  if (kindParam(ctx, name, always) === undefined) return fallbackHex;
  return resolveChartColor(ctx.spec, ctx.tpl, kindKey(ctx.code, name), fallbackHex);
}

/** Garis dasar nol: parameter kode (bila ada di registri) mendahului global P7-04. */
export function zeroBaseline(ctx: P1Ctx, kindName?: string): boolean {
  const global = chartParam(ctx.spec, ctx.tpl, "chart.zeroBaseline");
  const g = typeof global === "boolean" ? global : true;
  return kindName ? kindBool(ctx, kindName, g, true) : g;
}

// ── Aksen tingkat spec ────────────────────────────────────────────────────

export interface AccentHint {
  /** Seri yang diminta (seri penuh bila `target` kosong). */
  series?: string;
  /** Label kategori/grup/objek, atau indeks 0-based. */
  target?: string | number;
}

/**
 * Petunjuk aksen dari pengurai tunggal inti (`accentOf`, S84 #1): `target` = `accent.point`,
 * lalu `accent.group`; `series` = `accent.series` (seri penuh bila `target` kosong).
 */
export function accentHint(spec: StudioChartV1): AccentHint | undefined {
  const a = accentOf(spec);
  if (!a) return undefined;
  const target = a.point ?? a.group;
  return { ...(a.series !== undefined ? { series: a.series } : {}), ...(target !== undefined ? { target } : {}) };
}

/** Indeks label `target` di `labels` (label persis, atau indeks bulat); -1 bila tidak cocok. */
export function resolveTarget(target: string | number | undefined, labels: readonly string[]): number {
  if (target === undefined) return -1;
  if (typeof target === "number") return target >= 0 && target < labels.length ? target : -1;
  return labels.indexOf(target);
}

export function hintMiss(ctx: P1Ctx, what: string): void {
  report(ctx, "ACCENT_HINT", `petunjuk aksen ${what} tidak cocok dengan data; diabaikan`);
}

/** Penjaga DATUM-26: subjek beraksen (unik) <= maks. */
export function assertAccentCount(ctx: P1Ctx, subjects: ReadonlySet<string>): void {
  if (subjects.size > ctx.maxAccent) {
    throw defect("DATUM-26", `${ctx.fid} — ${subjects.size} subjek beraksen (${[...subjects].join(", ")}); maks ${ctx.maxAccent} aksen per gambar`, {
      code: ctx.code,
      accents: subjects.size,
    });
  }
}

/**
 * Atribut penanda tanda milik aksen TINGKAT SERI (satu subjek walau banyak tanda).
 * Lint DATUM-26 chart/core saat ini menghitung subjek per `data-series#data-index`;
 * permintaan S33 ke S32: tanda ber-`data-accent="series"` dihitung satu subjek per seri.
 */
export const SERIES_ACCENT_ATTR = ' data-accent="series"';

// ── Validasi bentuk data ──────────────────────────────────────────────────

export interface SeriesData {
  categories: string[];
  series: Array<{ name: string; values: Array<number | null>; accent: boolean }>;
}

function wrongShape(ctx: P1Ctx, want: string, got: string): StudioEngineError {
  return new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — ${ctx.code} membutuhkan data "${want}", diterima "${got}"`, {
    code: ctx.code,
    shape: got,
  });
}

export function requireSeries(ctx: P1Ctx, minSeries: number): SeriesData {
  const d = ctx.spec.data;
  if (!d) throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — ${ctx.code}: data wajib`, { code: ctx.code });
  if (d.shape !== "series") throw wrongShape(ctx, "series", d.shape);
  if (!Array.isArray(d.categories) || d.categories.length === 0 || !Array.isArray(d.series) || d.series.length === 0) {
    throw defect("DC-G1", `${ctx.fid} — grafik tanpa data`, { code: ctx.code });
  }
  if (d.categories.some((c) => typeof c !== "string")) {
    throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — kategori harus string`, { code: ctx.code });
  }
  if (d.series.length < minSeries) {
    throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — ${ctx.code} membutuhkan >= ${minSeries} seri, diterima ${d.series.length}`, {
      code: ctx.code,
    });
  }
  const series = d.series.map((s, si) => {
    if (typeof s?.name !== "string" || !Array.isArray(s.values) || s.values.length !== d.categories.length) {
      throw defect("DC-G1", `${ctx.fid} — seri ${si} tanpa nama atau jumlah nilai != ${d.categories.length} kategori`, { code: ctx.code, series: si });
    }
    s.values.forEach((v, i) => {
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
        throw defect("DC-G1", `${ctx.fid} — seri "${s.name}" nilai ${i} bukan bilangan hingga`, { code: ctx.code, series: si, index: i });
      }
    });
    return { name: s.name, values: [...s.values], accent: s.accent === true };
  });
  return { categories: [...d.categories], series };
}

/** Data `distribution` (penjaga tunggal inti, S84 #8). */
export { requireDistribution, type DistributionGroup as Group } from "../core/guards";

// ── Urutan stabil ─────────────────────────────────────────────────────────

export const SORT = ["valueDesc", "valueAsc", "byDifference", "natural"] as const;
export type SortMode = (typeof SORT)[number];

/** Urut stabil menurut kunci; indeks asal memutus seri (deterministik lintas mesin JS). */
export function stableSort<T>(items: readonly T[], key: (t: T) => number, dir: 1 | -1): T[] {
  return items
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (key(a.t) - key(b.t)) * dir || a.i - b.i)
    .map((x) => x.t);
}

// ── Sumbu dan tick ────────────────────────────────────────────────────────

export function tickLabels(dom: NiceDomain): string[] {
  const d = decimalsFor(dom.step);
  return dom.ticks.map((t) => fmt(t, d));
}

/** Lebar maks label tick (mm). */
export function tickWidth(dom: NiceDomain, sizePt: number, face: "struct" | "data"): number {
  return Math.max(...tickLabels(dom).map((s) => textWidthMm(s, sizePt, face)));
}

/** Domain rapi nilai; nol dipaksa bila `zero`. Domain tak bermula nol dilaporkan bila nilai semua positif. */
export function valueDomain(values: readonly number[], zero: boolean): NiceDomain {
  return niceDomain(values, { zero });
}

/**
 * Domain nilai berpetunjuk `chart.kind.<KODE>.axis` (IP-41c, panel galeri: domain tercetak);
 * tanpa petunjuk = `auto()` (perilaku lama). Perluasan petunjuk dilaporkan AXIS_DOMAIN.
 */
export function hintedDomain(ctx: P1Ctx, values: readonly number[], zero: boolean, auto: () => NiceDomain): NiceDomain {
  const axis = kindAxis(ctx);
  if (!axis) return auto();
  const ad = axisDomain(values, { zero }, axis);
  if (ad.widened) report(ctx, "AXIS_DOMAIN", ad.widened);
  return ad.dom;
}

/** Gridline vertikal pada tick (dekorasi). */
export function gridX(ctx: P1Ctx, dom: NiceDomain, sx: Scale, top: number, base: number, colour: string): void {
  ctx.doc.open('data-grid="x"');
  for (const t of dom.ticks) ctx.doc.line(sx(t), top, sx(t), base, colour, GRID_MM);
  ctx.doc.close();
}

/** Gridline horizontal pada tick (dekorasi). */
export function gridY(ctx: P1Ctx, dom: NiceDomain, sy: Scale, x0: number, x1: number, colour: string): void {
  ctx.doc.open('data-grid="y"');
  for (const t of dom.ticks) ctx.doc.line(x0, sy(t), x1, sy(t), colour, GRID_MM);
  ctx.doc.close();
}

/** Sumbu x bawah: garis (opsional) + label tick di bawahnya. */
export function axisX(
  ctx: P1Ctx,
  dom: NiceDomain,
  sx: Scale,
  base: number,
  x0: number,
  x1: number,
  o: { colour: string; widthMm: number; sizePt: number; face: "struct" | "data"; line?: boolean },
): void {
  const labels = tickLabels(dom);
  ctx.doc.open('data-axis="x"');
  if (o.line !== false) ctx.doc.line(x0, base, x1, base, o.colour, o.widthMm);
  dom.ticks.forEach((t, i) => {
    ctx.doc.text(sx(t), base + ptToMm(o.sizePt) + 1.2, labels[i], { sizePt: pt(ctx, o.sizePt), fill: ctx.pal.ink400, anchor: "middle", face: o.face });
  });
  ctx.doc.close();
}

/** Sumbu y kiri: garis (opsional) + label tick rata kanan. */
export function axisY(
  ctx: P1Ctx,
  dom: NiceDomain,
  sy: Scale,
  x0: number,
  top: number,
  base: number,
  o: { colour: string; widthMm: number; sizePt: number; face: "struct" | "data"; line?: boolean },
): void {
  const labels = tickLabels(dom);
  ctx.doc.open('data-axis="y"');
  if (o.line !== false) ctx.doc.line(x0, top, x0, base, o.colour, o.widthMm);
  dom.ticks.forEach((t, i) => {
    ctx.doc.text(x0 - 1.2, sy(t) + ptToMm(o.sizePt) * 0.35, labels[i], { sizePt: pt(ctx, o.sizePt), fill: ctx.pal.ink400, anchor: "end", face: o.face });
  });
  ctx.doc.close();
}

/** Garis dasar teks tegak-tengah (definisi tunggal inti). */
export const mid = midBaseline;

/**
 * Tepi kiri plot berlabel kategori (pola chart/core gallery). `anchorGap` = jarak ujung kanan label (anchor `end`) ke
 * tepi plot yang dipakai pemanggil (`x0 - anchorGap`); talang = label terlebar + anchorGap + {@link LABEL_EDGE_MM}, jadi
 * tepi kiri label terlebar selalu >= 0,4 mm dari tepi gambar (IMPL-W10, review 17 #4; sebelumnya pemanggil ber-anchor
 * 1,6 mm mendapat 0 mm).
 */
export function labelGutter(ctx: P1Ctx, labels: readonly string[], sizePt: number, maxFrac = 0.42, anchorGap = 1.2): number {
  // IMPL-W5 D1: metrik glif nyata (textfit), bukan taksiran rerata em.
  const w = Math.max(0, ...labels.map((s) => measure(s, sizePt)));
  return Math.min(Math.max(w + anchorGap + LABEL_EDGE_MM, 6), ctx.W * maxFrac);
}

/**
 * Sebar posisi y label agar jarak minimal `gap` (mm) tanpa mengubah urutan, lalu jepit
 * ke [lo, hi]. Deterministik; mengembalikan posisi baru sesuai indeks masukan.
 */
export function spreadLabels(ys: readonly number[], gap: number, lo: number, hi: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const out = order.map((o) => o.y);
  for (let k = 1; k < out.length; k++) out[k] = Math.max(out[k], out[k - 1] + gap);
  const over = out.length ? out[out.length - 1] - hi : 0;
  if (over > 0) {
    for (let k = out.length - 1; k >= 0; k--) {
      out[k] = k === out.length - 1 ? hi : Math.min(out[k], out[k + 1] - gap);
    }
  }
  for (let k = 0; k < out.length; k++) out[k] = Math.max(out[k], lo);
  const res = new Array<number>(ys.length);
  order.forEach((o, k) => (res[o.i] = out[k]));
  return res;
}

/** Lebar baris KUNCI (keyRow chart/core) untuk penempatan rata kanan. */
export function keyRowWidth(labels: readonly string[], sizePt: number): number {
  const sw = ptToMm(sizePt) * 0.9;
  let w = textWidthMm(keyLabelText(), sizePt, "struct", 0.15) + 2.4;
  for (const l of labels) w += sw + 1.0 + textWidthMm(l, sizePt) + 3.0;
  return w;
}

export { linearScale, type NiceDomain, type Scale, type ChartCode };
