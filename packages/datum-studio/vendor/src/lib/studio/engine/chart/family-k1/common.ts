/**
 * engine/chart/family-k1 — bagian bersama K-01..K-06 (S37): validasi data, resolusi
 * aksen (medan `accent` delta S03-d1 + alias `params`), parameter registri bertipe,
 * palet per gaya, bingkai batang horizontal, sumbu x bertick. Kunci `params` (alias pendek,
 * PARAM_ALIAS / PARAM_IGNORED) diselesaikan resolver tunggal chart/core (`core/params.ts`, D-87).
 *
 * Gaya:
 * - "datum" (default) = port pustakachart.py (PC) untuk K-01..K-04 (kelas paritas CB1):
 *   palet `CAT_SERIES` per indeks segmen (PC:130), diverging VERD/ALERT (PC:448-449),
 *   piramida INK900/INK400 (PC:473-474), grid x ink200, spine ink400, label angka mono;
 *   K-05/K-06 (tanpa acuan, CC) = lingkaran + kolom label langsung.
 * - "gallery" = panel Gambar 8.3 Manual 000 (benchmark image9): aksen signal tunggal,
 *   konteks ramp tinta (ink400, ink200, ink100), label kategori Plex Sans Condensed ink400,
 *   sumbu x hairline ink900 bertick.
 *
 * Semua helper inti diimpor dari berkas `../core/<helper>` (bukan indeks inti) agar
 * tidak menarik siklus impor contract/dispatch.
 */
import type { ChartAccent, LintIssue, StudioChartV1 } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { fmt } from "../../bind";
import { figureFootMm } from "../core/apparatus";
import { type CategoricalPoint, defect, figureLabel, requireCategorical } from "../core/guards";
import type { ChartPalette } from "../core/palette";
import { kindKey, readInt, readNum } from "../core/read";
import { accentOf } from "../core/params";
import type { NiceDomain, Scale } from "../core/scale";
import { type SvgDoc, midBaseline } from "../core/svg";
import { measure } from "../core/textfit";

export type K1Code = "K-01" | "K-02" | "K-03" | "K-04" | "K-05" | "K-06";
export type K1Style = "datum" | "gallery";

export function styleOf(spec: Pick<StudioChartV1, "style">): K1Style {
  return spec.style === "gallery" ? "gallery" : "datum";
}

/** Tinggi pita kaki: aparatus "figure" + catatan (sama dengan gaya galeri inti). */
export function footBandMm(spec: StudioChartV1): number {
  return figureFootMm(spec) + (spec.note ? 5 : 0);
}

/** Atribut akar SVG keluarga. */
export function rootAttrs(code: K1Code, style: K1Style): string {
  return `data-chart="${code}" data-style="${style}" data-family="k1"`;
}

/** Penampung temuan renderer (urutan deterministik = urutan pemanggilan). */
export class K1Report {
  readonly checksRun: string[] = [];
  readonly issues: LintIssue[] = [];

  add(checkId: string, status: LintIssue["status"], detail: string): void {
    if (!this.checksRun.includes(checkId)) this.checksRun.push(checkId);
    if (status !== "PASS") this.issues.push({ checkId, status, detail });
  }

  pass(checkId: string): void {
    if (!this.checksRun.includes(checkId)) this.checksRun.push(checkId);
  }

  toJSON(): { checksRun: string[]; issues: LintIssue[] } {
    return { checksRun: [...this.checksRun], issues: [...this.issues] };
  }
}

// ── Parameter: API baca tunggal inti (`core/read.ts`, S84 #8) ───────────────

/** Bilangan bulat registri dengan cek `range` ParamDef. */
export const paramInt = readInt;
/** Sudut derajat registri (tipe "deg") dengan cek rentang. */
export const paramDeg = readNum;

// ── Aksen ──────────────────────────────────────────────────────────────────

/** Medan aksen ter-normalisasi (pengurai tunggal inti `accentOf`, S84 #1). */
function accentField(spec: StudioChartV1, k: keyof ChartAccent): string | number | undefined {
  return accentOf(spec)?.[k];
}

// ── Data seri (K-01..K-04) ─────────────────────────────────────────────────

export interface SeriesRow {
  name: string;
  values: Array<number | null>;
  accent: boolean;
  /** Indeks seri pada data masukan (sebelum penataan ulang). */
  srcIndex: number;
}

export interface SeriesData {
  categories: string[];
  series: SeriesRow[];
}

/**
 * Data "series" tervalidasi: kategori string tak kosong, tiap seri sepanjang kategori,
 * nilai bilangan hingga atau null. Aksen seri = `series[].accent` + `accent.series` /
 * `params.accentSeries`; jumlah seri beraksen > maks -> DATUM-26.
 */
export function requireSeries(spec: StudioChartV1, code: K1Code, maxAccent: number, rep: K1Report): SeriesData {
  const fid = figureLabel(spec);
  const d = spec.data;
  if (!d) throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code}: data wajib`, { code });
  if (d.shape !== "series") {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code} membutuhkan data "series", diterima "${d.shape}"`, { code, shape: d.shape });
  }
  const cats = d.categories;
  if (!Array.isArray(cats) || cats.length === 0 || !Array.isArray(d.series) || d.series.length === 0) {
    throw defect("DC-G1", `${fid} — grafik tanpa data`, { code });
  }
  cats.forEach((c, i) => {
    if (typeof c !== "string") throw new StudioEngineError("SCHEMA_INVALID", `${fid} — kategori ${i} bukan teks`, { code, index: i });
  });
  const series: SeriesRow[] = d.series.map((s, si) => {
    if (typeof s?.name !== "string" || !Array.isArray(s.values)) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — seri ${si} tanpa nama atau values`, { code, series: si });
    }
    if (s.values.length !== cats.length) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — seri "${s.name}" memuat ${s.values.length} nilai untuk ${cats.length} kategori`, {
        code,
        series: si,
      });
    }
    s.values.forEach((v, i) => {
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
        throw defect("DC-G1", `${fid} — seri "${s.name}" nilai ${i} bukan bilangan hingga`, { code, series: si, index: i });
      }
    });
    return { name: s.name, values: [...s.values], accent: s.accent === true, srcIndex: si };
  });

  const hintedRaw = accentField(spec, "series");
  const hinted = typeof hintedRaw === "string" ? hintedRaw : undefined;
  if (hinted !== undefined) {
    const hit = series.find((s) => s.name === hinted);
    if (hit) hit.accent = true;
    else rep.add("ACCENT_HINT", "REPORT", `aksen seri "${hinted}" tidak ditemukan; diabaikan`);
  }
  for (const k of ["point", "group"] as const) {
    if (accentField(spec, k) !== undefined) rep.add("ACCENT_HINT", "REPORT", `accent.${k} tidak berlaku untuk ${code} (data series); pakai accent.series`);
  }
  const n = series.filter((s) => s.accent).length;
  if (n > maxAccent) {
    throw defect("DATUM-26", `${fid} — ${n} seri beraksen; maks ${maxAccent} aksen per gambar`, { code, accents: n });
  }
  return { categories: [...cats], series };
}

/** Tanda bertumpuk (K-01/K-02) tidak menerima nilai negatif (CH-01). */
export function assertSeriesNonNegative(spec: StudioChartV1, code: K1Code, data: SeriesData): void {
  for (const s of data.series) {
    const i = s.values.findIndex((v) => v !== null && v < 0);
    if (i >= 0) {
      throw defect("CH-01", `${figureLabel(spec)} — ${code}: nilai negatif pada seri "${s.name}" kategori ${i}; pakai diverging bar (K-03)`, {
        code,
        series: s.srcIndex,
        index: i,
      });
    }
  }
}

// ── Data kategorikal (K-05/K-06) ───────────────────────────────────────────

/**
 * Iris tervalidasi: `requireCategorical` inti + aksen titik dari `accent.point`
 * (label atau indeks) / `params.accentPoint`. Nilai negatif -> CH-01.
 */
export function requireSlices(spec: StudioChartV1, code: K1Code, maxAccent: number, rep: K1Report): CategoricalPoint[] {
  const fid = figureLabel(spec);
  const pts = requireCategorical(spec, code, maxAccent);
  const neg = pts.findIndex((p) => p.value < 0);
  if (neg >= 0) throw defect("CH-01", `${fid} — ${code}: iris ${neg} bernilai negatif`, { code, index: neg });
  const hint = accentField(spec, "point");
  if (hint !== undefined) {
    let idx = -1;
    if (typeof hint === "number") idx = Number.isInteger(hint) && hint >= 0 && hint < pts.length ? hint : -1;
    else idx = pts.findIndex((p) => p.label === hint);
    if (idx >= 0) pts[idx] = { ...pts[idx], accent: true };
    else rep.add("ACCENT_HINT", "REPORT", `aksen titik ${JSON.stringify(hint)} tidak ditemukan; diabaikan`);
  }
  for (const k of ["series", "group"] as const) {
    if (accentField(spec, k) !== undefined) rep.add("ACCENT_HINT", "REPORT", `accent.${k} tidak berlaku untuk ${code} (data categorical); pakai accent.point`);
  }
  const n = pts.filter((p) => p.accent).length;
  if (n > maxAccent) throw defect("DATUM-26", `${fid} — ${n} iris beraksen; maks ${maxAccent}`, { code, accents: n });
  return pts;
}

// ── Palet ──────────────────────────────────────────────────────────────────

/** `CAT_SERIES` PC:130 — INK900, SIGNAL, VERD, INK400, ALERT (maks 5 warna per figur). */
export function pcCatSeries(pal: ChartPalette): string[] {
  return [pal.ink900, pal.signal, pal.verd, pal.ink400, pal.alert];
}

/**
 * Warna galeri per seri/iris: yang beraksen = peran aksen; sisanya berurutan memakai ramp
 * konteks [contextMain, contextBackground, ink100, ink700] (Gambar 8.3: ink400, ink200,
 * ink100). Tanpa aksen: [ink700, contextMain, contextBackground, ink100, ink900].
 * Lebih dari 5 subjek -> DATUM-25 (ramp tinta habis, warna tidak lagi terbedakan).
 */
export function galleryColors(accentFlags: readonly boolean[], pal: ChartPalette, spec: StudioChartV1, code: K1Code): string[] {
  if (accentFlags.length > 5) {
    throw defect("DATUM-25", `${figureLabel(spec)} — ${code}: ${accentFlags.length} subjek warna > 5; gabungkan bagian kecil menjadi "lainnya"`, {
      code,
      subjects: accentFlags.length,
    });
  }
  const hasAccent = accentFlags.some(Boolean);
  const ramp = hasAccent
    ? [pal.role.contextMain, pal.role.contextBackground, pal.ink100, pal.ink700]
    : [pal.ink700, pal.role.contextMain, pal.role.contextBackground, pal.ink100, pal.ink900];
  let k = 0;
  return accentFlags.map((a) => (a ? pal.role.accent : ramp[k++ % ramp.length]));
}

/** Teks di atas isian: isian terang (kertas, ink100, ink200) -> ink900; selain itu kertas. */
export function inkOn(fill: string, pal: ChartPalette): string {
  const f = fill.replace(/^#/, "").toUpperCase();
  return [pal.paper, pal.ink100, pal.ink200].includes(f) ? pal.ink900 : pal.paper;
}

// ── Bingkai batang horizontal dan sumbu x ──────────────────────────────────

export interface HFrame {
  /** Batas kiri/kanan area batang (mm). */
  x0: number;
  x1: number;
  /** Pita kategori (mm). */
  top: number;
  base: number;
  /** Langkah per kategori dan tinggi batang (mm). */
  step: number;
  barH: number;
  /** Pusat vertikal kategori i. */
  yc: (i: number) => number;
}

export function hFrame(i: {
  categories: readonly string[];
  labelPt: number;
  widthMm: number;
  top: number;
  base: number;
  rightGutter: number;
  barRatio: number;
  labelFace?: "struct" | "data";
}): HFrame {
  // IMPL-W5 D1: talang = label terlebar dengan metrik glif nyata (textfit, sama dengan raster); taksiran rerata 0,5 em
  // (textWidthMm) memotong label berglif lebar ("Low-Medium" 5,29 em > 5,0 em) di tepi kiri gambar.
  const labelW = Math.max(0, ...i.categories.map((c) => measure(c, i.labelPt, i.labelFace ?? "struct")));
  const x0 = Math.min(Math.max(labelW + 2.0, 6), i.widthMm * 0.42);
  const x1 = Math.max(x0 + 4, i.widthMm - i.rightGutter);
  const n = Math.max(1, i.categories.length);
  const step = Math.max(0.5, (i.base - i.top) / n);
  return { x0, x1, top: i.top, base: i.base, step, barH: step * i.barRatio, yc: (k) => i.top + step * (k + 0.5) };
}

/** Garis dasar teks tegak-tengah (definisi tunggal inti). */
export const mid = midBaseline;

/** Label tick; minus tipografis U+2212 untuk gaya galeri (Gambar 8.3 "−20"). */
export function tickText(v: number, dec: number, style: K1Style, absolute = false): string {
  const s = fmt(absolute ? Math.abs(v) : v, dec);
  return style === "gallery" ? s.replace(/^-/, "−") : s;
}

/**
 * Sumbu x horizontal bertick di `y` (dibungkus `<g data-axis="x">`).
 * datum: spine ink400 0,21 mm (PC axes.linewidth 0,6 pt), label angka mono 6,5 pt;
 * gallery: hairline peran textAxis 0,25 mm + tick 0,8 mm, label Plex Sans Condensed 6,0 pt.
 */
export function drawXAxis(
  doc: SvgDoc,
  o: { y: number; x0: number; x1: number; dom: NiceDomain; sx: Scale; style: K1Style; pal: ChartPalette; dec: number; absolute?: boolean },
): void {
  const { pal, style } = o;
  doc.open('data-axis="x"');
  if (style === "gallery") {
    doc.line(o.x0, o.y, o.x1, o.y, pal.role.textAxis, 0.25);
    for (const t of o.dom.ticks) {
      const x = o.sx(t);
      doc.line(x, o.y, x, o.y + 0.8, pal.role.textAxis, 0.25);
      doc.text(x, o.y + 3.6, tickText(t, o.dec, style, o.absolute), { sizePt: 6.0, fill: pal.ink400, anchor: "middle" });
    }
  } else {
    doc.line(o.x0, o.y, o.x1, o.y, pal.ink400, 0.21);
    for (const t of o.dom.ticks) {
      doc.text(o.sx(t), o.y + 3.2, tickText(t, o.dec, style, o.absolute), { face: "data", sizePt: 6.5, fill: pal.ink400, anchor: "middle" });
    }
  }
  doc.close();
}

/** Grid x gaya datum (PC style_ax grid ink200; lebar dinaikkan ke lantai 0,18 mm, lint 27). */
export function drawGridX(doc: SvgDoc, ticks: readonly number[], sx: Scale, top: number, bottom: number, pal: ChartPalette): void {
  doc.open('data-grid="x"');
  for (const t of ticks) doc.line(sx(t), top, sx(t), bottom, pal.ink200, 0.18);
  doc.close();
}

/** Kunci registri khusus kode (satu definisi inti). */
export const k1Key = kindKey;

/** Tanda seri beraksen: seluruh seri = SATU subjek lint 26 (konvensi inti, IP-25). */
export const SERIES_ACCENT_ATTR = ' data-accent="series"';
