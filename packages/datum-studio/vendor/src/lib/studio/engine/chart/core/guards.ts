/**
 * engine/chart/core — penjaga titik panggil dan lint SVG chart (S32).
 *
 * Penjaga by-construction (melempar `StudioEngineError` BY_CONSTRUCTION_FAILED dengan
 * `details.checkId`) memakai kode yang sama dengan `periksa()` datumchart.py DC:95-122:
 * G2 lebar anggota himpunan lebar figur sah, N1 garis bawah pada penanda, DATUM-10 tanpa
 * SUMBER, DATUM-36 aparatus "figure" di dalam dokumen, DATUM-26 aksen > 1, DATUM-33
 * tinggi > blok teks, DC-G5 threshold tanpa batas. Bentuk data salah -> SCHEMA_INVALID.
 *
 * Batas figur TURUNAN (D-158/D-245 H1, `figureLimits`): lebar sah =
 * `grid.allowedFigureWidthsMm`, tinggi maks = `grid.textBlockHeightMm` dari parameter
 * templat (A4 potret = 128/166 dan 247, identik dengan konstanta DC). Templat tanpa
 * kunci itu (render mandiri `EMPTY_CHART_TEMPLATE`) memakai bawaan registri ParamDef,
 * pola yang sama dengan palet (`./palette`), TIDAK diam-diam: hasil render memuat REPORT
 * `FIGURE_LIMITS_DEFAULT` (`figureLimitsReport`, FIX-A2 N6, D-281) yang menyebut kunci
 * absen dan batas bawaan yang dipakai; tanpa nilai sama sekali = BY_CONSTRUCTION_FAILED.
 *
 * Lint keluaran (`lintChartSvg`) membaca SVG jadi: huruf min (P7-36, lint 28, pt fisik),
 * keluarga warna maks (P7-17, lint 25, K-32), tinggi (lint 33), lebar (G2), garis min
 * 0,18 mm (lint 27), teks nyata dan aset hanya data: URI (lint 13, D-38), aksen per
 * gambar (lint 26) bila `accentHex` diberikan.
 *
 * Subjek aksen lint 26 (IP-25, konvensi keluarga S33-S43): satu subjek = satu
 * grup/seri/kelompok, bukan satu elemen. Kunci subjek per tanda beraksen:
 * `data-accent-group` (kelompok eksplisit, mis. kuadran P-13) > `data-accent="series"`
 * (seluruh seri = satu subjek) > `data-series` + `data-index` (indeks SUBJEK; posisi di
 * dalam subjek ada di `data-obs`/`data-period`/`data-event`/`data-band` dan tidak ikut
 * dihitung). Sel/tanda ber-`data-rule` (warna dari aturan nilai, P-15) dilewati.
 * Lint 28 bertoleransi 1e-3 pt: font-size ditulis dibulatkan 5 desimal mm (`SvgDoc`).
 */
import { StudioEngineError } from "../../../contract/errors";
import type { ChartCode, LintIssue, ParamValue, StudioChartV1 } from "../../../contract";
import { PARAMS_BY_KEY } from "../../../params";
import { MM_PER_PT } from "./svg";

/** Kunci parameter turunan batas figur (P4G-13, P4G-11). */
export const FIGURE_WIDTHS_PARAM = "grid.allowedFigureWidthsMm";
export const FIGURE_MAX_HEIGHT_PARAM = "grid.textBlockHeightMm";

/** Batas figur turunan templat: lebar sah (mm) dan tinggi maksimum (mm, lint 33). */
export interface FigureLimits {
  widthsMm: readonly number[];
  maxHeightMm: number;
}

function positiveNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function widthList(v: unknown): number[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out = v.map(positiveNum);
  return out.every((w): w is number => w !== undefined) ? (out as number[]) : undefined;
}

/**
 * Batas figur dari parameter efektif (kunci absen -> bawaan registri). Melempar
 * BY_CONSTRUCTION_FAILED bila tidak terbaca sama sekali (tanpa cadangan literal A4).
 */
export function figureLimits(params: Readonly<Record<string, ParamValue>> | undefined): FigureLimits {
  const p = params ?? {};
  const widthsMm = widthList(p[FIGURE_WIDTHS_PARAM]) ?? widthList(PARAMS_BY_KEY.get(FIGURE_WIDTHS_PARAM)?.default);
  const maxHeightMm = positiveNum(p[FIGURE_MAX_HEIGHT_PARAM]) ?? positiveNum(PARAMS_BY_KEY.get(FIGURE_MAX_HEIGHT_PARAM)?.default);
  if (!widthsMm || maxHeightMm === undefined) {
    throw new StudioEngineError(
      "BY_CONSTRUCTION_FAILED",
      `engine/chart/core: batas figur tidak terbaca (${FIGURE_WIDTHS_PARAM}, ${FIGURE_MAX_HEIGHT_PARAM} wajib ada di parameter templat)`,
      { checkId: "FIGURE_LIMITS", keys: [FIGURE_WIDTHS_PARAM, FIGURE_MAX_HEIGHT_PARAM] },
    );
  }
  return { widthsMm, maxHeightMm };
}

/** checkId peringatan batas figur dari bawaan registri (templat tanpa kunci turunan). */
export const FIGURE_LIMITS_DEFAULT_CHECK = "FIGURE_LIMITS_DEFAULT";

/** Kunci batas figur yang absen/tidak terbaca di parameter templat (jatuh ke bawaan registri). */
export function figureLimitsDefaultedKeys(params: Readonly<Record<string, ParamValue>> | undefined): string[] {
  const p = params ?? {};
  const out: string[] = [];
  if (!widthList(p[FIGURE_WIDTHS_PARAM])) out.push(FIGURE_WIDTHS_PARAM);
  if (positiveNum(p[FIGURE_MAX_HEIGHT_PARAM]) === undefined) out.push(FIGURE_MAX_HEIGHT_PARAM);
  return out;
}

function defaultLimitsIssue(keys: readonly string[], limits: FigureLimits): LintIssue {
  return {
    checkId: FIGURE_LIMITS_DEFAULT_CHECK,
    status: "REPORT",
    detail:
      `batas figur tanpa grid/templat: ${keys.join(", ")} absen di parameter templat; bawaan registri dipakai ` +
      `(lebar sah ${allowedWidthsText(limits)}, tinggi maks ${mmText(limits.maxHeightMm)} mm = profil kanonik A4). ` +
      `Teruskan templat dokumen agar batas mengikuti kertas`,
  };
}

/**
 * Peringatan tercatat (REPORT `FIGURE_LIMITS_DEFAULT`) bila batas figur render ini berasal
 * dari bawaan registri, bukan parameter templat (FIX-A2 N6). Kosong bila templat lengkap
 * (semua jalur produksi meneruskan templat dokumen terselesaikan).
 */
export function figureLimitsReport(params: Readonly<Record<string, ParamValue>> | undefined): ChartLint {
  const keys = figureLimitsDefaultedKeys(params);
  if (keys.length === 0) return { checksRun: [FIGURE_LIMITS_DEFAULT_CHECK], issues: [] };
  return { checksRun: [FIGURE_LIMITS_DEFAULT_CHECK], issues: [defaultLimitsIssue(keys, figureLimits(params))] };
}

/** Kunci kisi horizontal turunan (P4G-09, kolom teks / subkolom; A4 128/12). */
export const FIGURE_LATTICE_X_PARAM = "grid.latticeXMm";

/**
 * Grid figur turunan untuk mesin diagram (bentuk struktural `DiagramGrid`
 * engine/diagram/core, D-252): lebar sah, tinggi maks, kisi X. Dipakai pemanggil
 * diagram (layanan render figur, flowchart G-04) agar diagram menggambar pada lebar
 * nyata kertas (A4 = 128/166/247, kisi 128/12: identik dengan grid bawaan diagram).
 */
export function figureGrid(params: Readonly<Record<string, ParamValue>> | undefined): {
  allowedWidthsMm: readonly number[];
  maxHeightMm: number;
  latticeXMm?: number;
} {
  const limits = figureLimits(params);
  const lx = positiveNum((params ?? {})[FIGURE_LATTICE_X_PARAM]);
  return { allowedWidthsMm: limits.widthsMm, maxHeightMm: limits.maxHeightMm, ...(lx !== undefined ? { latticeXMm: lx } : {}) };
}

/** Toleransi keanggotaan lebar sah (mm): akar SVG ditulis tepat lebar turunan. */
export const FIGURE_WIDTH_TOLERANCE_MM = 1e-6;

export function isAllowedWidth(widthMm: number, limits: FigureLimits): boolean {
  return limits.widthsMm.some((w) => Math.abs(widthMm - w) <= FIGURE_WIDTH_TOLERANCE_MM);
}

function mmText(v: number): string {
  return String(Math.round(v * 100) / 100);
}

export function allowedWidthsText(limits: FigureLimits): string {
  return limits.widthsMm.map(mmText).join(" mm maupun ") + " mm";
}
/** Toleransi lint 28 (pt): font-size ditulis 5 desimal mm (galat pembulatan <= 1,5e-4 pt). */
export const FONT_PT_TOLERANCE = 1e-3;
/** Lantai garis fotokopi (DT-11, lint 27). */
export const MIN_STROKE_MM = 0.18;

export function defect(checkId: string, message: string, extra: Record<string, unknown> = {}): StudioEngineError {
  return new StudioEngineError("BY_CONSTRUCTION_FAILED", `[${checkId}] ${message}`, { checkId, ...extra });
}

export function figureLabel(spec: Pick<StudioChartV1, "id">): string {
  return spec.id ?? "(tanpa nomor)";
}

/** Penjaga umum spec tingkat atas (DC periksa: G2, N1, 10, 36, nomor untuk aparatus figure). */
export function assertChartSpec(spec: StudioChartV1, limits: FigureLimits): void {
  const fid = figureLabel(spec);
  // Lebar = anggota himpunan turunan persis; toleransi DC (1,5 mm) tidak dipakai agar akar SVG tepat.
  if (typeof spec.widthMm !== "number" || !isAllowedWidth(spec.widthMm, limits)) {
    throw defect("G2", `${fid} — lebar ${String(spec.widthMm)} mm bukan ${allowedWidthsText(limits)}`, {
      widthMm: spec.widthMm,
      allowedWidthsMm: [...limits.widthsMm],
    });
  }
  if ((spec.id ?? "").includes("_") || (spec.title ?? "").includes("_")) {
    throw defect("N1", `${fid} — penanda gambar memakai garis bawah (DATUM §14)`);
  }
  if (typeof spec.source !== "string" || spec.source.trim() === "") {
    throw defect("DATUM-10", `${fid} — grafik tanpa baris SUMBER`);
  }
  if (spec.apparatus === "figure" && spec.inDocument) {
    throw defect("DATUM-36", `${fid} — apparatus "figure" pada grafik yang masuk dokumen; halaman sudah mencetak keterangan dan SUMBER`);
  }
  if (spec.apparatus === "figure" && !spec.id) {
    throw defect("DATUM-30", `${fid} — apparatus "figure" tanpa nomor gambar`);
  }
  if (spec.heightMm !== undefined && !(spec.heightMm > 0 && spec.heightMm <= limits.maxHeightMm)) {
    throw defect("DATUM-33", `${fid} — tinggi ${spec.heightMm} mm di luar (0, ${mmText(limits.maxHeightMm)}] mm`, {
      heightMm: spec.heightMm,
      maxHeightMm: limits.maxHeightMm,
    });
  }
  if (spec.dec !== undefined && ![0, 1, 2, 3].includes(spec.dec)) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — dec ${String(spec.dec)} bukan 0..3`);
  }
}

export interface CategoricalPoint {
  label: string;
  value: number;
  accent: boolean;
  sub?: string;
}

/** Data kategorikal tervalidasi (bentuk, label, nilai hingga, aksen <= maks). */
export function requireCategorical(spec: StudioChartV1, code: ChartCode, maxAccent: number): CategoricalPoint[] {
  const fid = figureLabel(spec);
  const d = spec.data;
  if (!d) throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code}: data wajib`, { code });
  if (d.shape !== "categorical") {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code} membutuhkan data "categorical", diterima "${d.shape}"`, {
      code,
      shape: d.shape,
    });
  }
  if (!Array.isArray(d.points) || d.points.length === 0) {
    throw defect("DC-G1", `${fid} — grafik tanpa data`, { code });
  }
  const pts = d.points.map((p, i) => {
    if (typeof p?.label !== "string" || typeof p?.value !== "number" || !Number.isFinite(p.value)) {
      throw defect("DC-G1", `${fid} — titik data ${i} tanpa label atau nilai hingga`, { code, index: i });
    }
    return { label: p.label, value: p.value, accent: p.accent === true, ...(p.sub !== undefined ? { sub: p.sub } : {}) };
  });
  const accents = pts.filter((p) => p.accent).length;
  if (accents > maxAccent) {
    throw defect("DATUM-26", `${fid} — ${accents} batang beraksen; maks ${maxAccent} aksen per gambar (§03 §2)`, { code, accents });
  }
  return pts;
}

/** Bar/column/threshold inti: nilai negatif tidak dapat bertumpu pada garis dasar nol tunggal. */
export function assertNonNegative(spec: StudioChartV1, code: ChartCode, pts: readonly CategoricalPoint[]): void {
  const neg = pts.findIndex((p) => p.value < 0);
  if (neg >= 0) {
    throw defect("CH-01", `${figureLabel(spec)} — ${code}: nilai negatif pada titik ${neg}; pakai diverging bar (K-03) atau waterfall (P-10)`, {
      code,
      index: neg,
    });
  }
}

// ── Lint keluaran ─────────────────────────────────────────────────────────

export interface SvgScan {
  widthMm: number;
  heightMm: number;
  /** mm per satuan pengguna. */
  userToMm: number;
  fontPts: number[];
  colors: string[];
  strokeMms: number[];
  rasterImages: number;
  externalRefs: string[];
  /** Tanda data (fill/stroke) per elemen ber-`data-mark`. */
  marks: Array<{
    mark: string;
    series?: string;
    index?: string;
    fill?: string;
    stroke?: string;
    /** `data-accent-group`: kelompok subjek aksen eksplisit. */
    accentGroup?: string;
    /** `data-accent="series"`: seluruh seri = satu subjek. */
    accentSeries?: boolean;
    /** `data-rule`: warna dari aturan nilai (bukan aksen subjek). */
    rule?: boolean;
  }>;
}

const LEN = /^\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*(mm|cm|in|pt|pc|px)?\s*$/;
const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: MM_PER_PT, pc: 12 * MM_PER_PT, px: 25.4 / 96, "": 25.4 / 96 };

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : undefined;
}

/** Baca SVG chart (keluaran pembangun inti atau keluarga) untuk lint. */
export function scanSvg(svg: string): SvgScan {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0];
  if (!root) throw new StudioEngineError("SCHEMA_INVALID", "engine/chart/core: keluaran renderer bukan SVG");
  const vb = (attr(root, "viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const dim = (name: string, idx: number): number => {
    const m = LEN.exec(attr(root, name) ?? "");
    if (m) return Number(m[1]) * UNIT_MM[m[2] ?? ""];
    if (vb.length === 4 && Number.isFinite(vb[idx])) return vb[idx] * UNIT_MM[""];
    throw new StudioEngineError("SCHEMA_INVALID", "engine/chart/core: SVG tanpa width/height maupun viewBox");
  };
  const widthMm = dim("width", 2);
  const heightMm = dim("height", 3);
  const userToMm = vb.length === 4 && vb[2] > 0 ? widthMm / vb[2] : UNIT_MM[""];
  const toMm = (v: string): number | undefined => {
    const m = LEN.exec(v);
    if (!m) return undefined;
    const n = Number(m[1]);
    const u = m[2] ?? "";
    // CSS dalam ruang pengguna: satuan absolut dikonversi ke px pengguna (96/in), lalu skala viewBox.
    const userUnits = u === "" || u === "px" ? n : (n * UNIT_MM[u]) / UNIT_MM[""];
    return userUnits * userToMm;
  };
  const fontPts: number[] = [];
  const colors = new Set<string>();
  const strokeMms: number[] = [];
  const marks: SvgScan["marks"] = [];
  let rasterImages = 0;
  const externalRefs: string[] = [];
  const body = svg.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of body.matchAll(/<([a-zA-Z][\w:-]*)\b[^>]*>/g)) {
    const tag = m[0];
    const name = m[1];
    if (name === "image") rasterImages++;
    for (const key of ["href", "xlink:href"]) {
      const h = attr(tag, key);
      if (h !== undefined && !h.startsWith("data:") && !h.startsWith("#")) externalRefs.push(h);
    }
    const fs = attr(tag, "font-size");
    if (fs !== undefined) {
      const mm = toMm(fs);
      if (mm !== undefined) fontPts.push(mm / MM_PER_PT);
    }
    const fill = attr(tag, "fill");
    const stroke = attr(tag, "stroke");
    for (const c of [fill, stroke]) {
      if (c && /^#[0-9A-Fa-f]{6}$/.test(c)) colors.add(c.slice(1).toUpperCase());
    }
    const sw = attr(tag, "stroke-width");
    if (sw !== undefined && stroke && stroke !== "none") {
      const mm = toMm(sw);
      if (mm !== undefined) strokeMms.push(mm);
    }
    const mk = attr(tag, "data-mark");
    if (mk !== undefined) {
      marks.push({
        mark: mk,
        series: attr(tag, "data-series"),
        index: attr(tag, "data-index"),
        fill: fill?.replace(/^#/, "").toUpperCase(),
        stroke: stroke?.replace(/^#/, "").toUpperCase(),
        accentGroup: attr(tag, "data-accent-group"),
        accentSeries: attr(tag, "data-accent") === "series",
        rule: attr(tag, "data-rule") !== undefined,
      });
    }
  }
  return { widthMm, heightMm, userToMm, fontPts, colors: [...colors].sort(), strokeMms, rasterImages, externalRefs, marks };
}

export interface ChartLintOptions {
  minFontPt: number;
  maxColors: number;
  family: (hex: string) => string;
  /** Lebar sah (tingkat atas: himpunan turunan `figureLimits`); kosong = tidak dicek (panel komposit). */
  widths?: readonly number[];
  /**
   * Tinggi maksimum lint 33 (mm, `figureLimits`); tidak diisi = bawaan registri
   * `grid.textBlockHeightMm` + REPORT `FIGURE_LIMITS_DEFAULT` (tidak diam-diam A4).
   */
  maxHeightMm?: number;
  /** Bila diisi: hitung subjek beraksen (lint 26). */
  accentHex?: string;
  maxAccent?: number;
  /** Aparatus didelegasikan ke halaman (lint 36 lapor). */
  apparatusPage?: boolean;
}

export interface ChartLint {
  checksRun: string[];
  issues: LintIssue[];
}

/** Lint keluaran chart; PASS tidak dicantumkan di `issues` (hanya FAIL/REPORT). */
export function lintChartSvg(svg: string, o: ChartLintOptions): ChartLint {
  const s = scanSvg(svg);
  const checksRun: string[] = [];
  const issues: LintIssue[] = [];
  const run = (id: string, ok: boolean, detail: string, status: "FAIL" | "REPORT" = "FAIL"): void => {
    checksRun.push(id);
    if (!ok) issues.push({ checkId: id, status, detail });
  };

  const minPt = s.fontPts.length ? Math.min(...s.fontPts) : Infinity;
  run("DATUM-28", minPt + FONT_PT_TOLERANCE >= o.minFontPt, `huruf terkecil ${minPt.toFixed(2)} pt < ${o.minFontPt} pt`);

  const families = [...new Set(s.colors.map(o.family))].sort();
  run("DATUM-25", families.length <= o.maxColors, `${families.length} keluarga warna (${families.join(", ")}) > ${o.maxColors}`);

  let maxH = o.maxHeightMm;
  if (maxH === undefined) {
    const lim = figureLimits(undefined);
    maxH = lim.maxHeightMm;
    checksRun.push(FIGURE_LIMITS_DEFAULT_CHECK);
    issues.push(defaultLimitsIssue([FIGURE_MAX_HEIGHT_PARAM], lim));
  }
  run("DATUM-33", s.heightMm <= maxH + 1e-6, `tinggi ${s.heightMm.toFixed(1)} mm > ${mmText(maxH)} mm`);

  if (o.widths && o.widths.length) {
    run("G2", o.widths.some((w) => Math.abs(s.widthMm - w) <= 0.05), `lebar ${s.widthMm.toFixed(2)} mm bukan ${o.widths.join("/")} mm`);
  }

  const minStroke = s.strokeMms.length ? Math.min(...s.strokeMms) : Infinity;
  run("DATUM-27", minStroke + 1e-6 >= MIN_STROKE_MM, `garis tertipis ${minStroke.toFixed(3)} mm < ${MIN_STROKE_MM} mm`);

  run(
    "DATUM-13",
    s.rasterImages === 0 && s.externalRefs.length === 0,
    `raster ${s.rasterImages}, rujukan non-data: ${s.externalRefs.slice(0, 3).join(", ")}`,
  );

  if (o.accentHex) {
    const acc = o.accentHex.replace(/^#/, "").toUpperCase();
    const subjects = new Set(s.marks.filter((m) => !m.rule && (m.fill === acc || m.stroke === acc)).map(accentSubjectKey));
    const max = o.maxAccent ?? 1;
    run("DATUM-26", subjects.size <= max, `${subjects.size} subjek beraksen > ${max}`);
  }

  if (o.apparatusPage) {
    checksRun.push("DATUM-36");
    issues.push({ checkId: "DATUM-36", status: "REPORT", detail: "keterangan dan SUMBER dicetak halaman (apparatus page)" });
  }
  return { checksRun, issues };
}

/** Kunci subjek aksen satu tanda (lihat kepala berkas). */
export function accentSubjectKey(m: SvgScan["marks"][number]): string {
  if (m.accentGroup !== undefined) return `group:${m.accentGroup}`;
  if (m.accentSeries) return `series:${m.series ?? ""}`;
  return `${m.series ?? ""}#${m.index ?? ""}`;
}

/** Gabung laporan; `checksRun` unik berurutan kemunculan pertama. */
export function mergeReports(...rs: ReadonlyArray<{ checksRun: string[]; issues: LintIssue[] }>): ChartLint {
  const seen = new Set<string>();
  const checksRun: string[] = [];
  const issues: LintIssue[] = [];
  for (const r of rs) {
    for (const c of r.checksRun) {
      if (!seen.has(c)) {
        seen.add(c);
        checksRun.push(c);
      }
    }
    issues.push(...r.issues);
  }
  return { checksRun, issues };
}

// ── Data distribution (satu penjaga untuk P-05/P-07, S-01..S-08; S84 #8) ─────

export interface DistributionGroup {
  name: string;
  values: number[];
}

/** Data `distribution` tervalidasi (nama string, >= 1 nilai hingga per grup); salinan nilai. */
export function requireDistribution(c: { spec: StudioChartV1; code: ChartCode }): DistributionGroup[] {
  const { spec, code } = c;
  const fid = figureLabel(spec);
  const d = spec.data;
  if (!d) throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code}: data wajib`, { code });
  if (d.shape !== "distribution") {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code} membutuhkan data "distribution", diterima "${d.shape}"`, { code, shape: d.shape });
  }
  if (!Array.isArray(d.groups) || d.groups.length === 0) throw defect("DC-G1", `${fid} — grafik tanpa data`, { code });
  return d.groups.map((g, gi) => {
    if (typeof g?.name !== "string" || !Array.isArray(g.values) || g.values.length === 0) {
      throw defect("DC-G1", `${fid} — grup ${gi} tanpa nama atau tanpa nilai`, { code, group: gi });
    }
    g.values.forEach((v, i) => {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw defect("DC-G1", `${fid} — grup "${g.name}" nilai ${i} bukan bilangan hingga`, { code, group: gi, index: i });
      }
    });
    return { name: g.name, values: [...g.values] };
  });
}
