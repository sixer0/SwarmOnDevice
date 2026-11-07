/**
 * engine/chart/core — renderer KOMPOSIT GALERI (S32; permintaan S02, spesifikasi §3.5).
 *
 * Satu figur selebar spec (anggota himpunan lebar turunan; A4 128/166 mm) berisi panel bernama dalam kisi `columns` kolom (Gambar 8.1-8.5:
 * 3 kolom). Tiap panel:
 * - plot = keluaran renderer kode panel lewat `CHART_RENDERERS` (dibaca di badan fungsi),
 *   kanvas selebar panel, gaya bawaan "gallery";
 * - pita caption di bawah plot: garis rambut ink200, kode Plex Mono ink400 ("P-01"),
 *   nama Plex Sans Condensed ink900 ("Bar urut"), `caption` opsional rata kanan;
 * - `axisNote` ("x ... / y ...") kecil ink400 di pojok kanan atas;
 * - dibungkus `<g data-panel="<kode>">`; latar kertas dan komentar aparatus panel dibuang.
 *
 * Tinggi: bila `spec.heightMm` ada, baris dibagi rata (Gambar 8.1 = 166 x 220 mm);
 * bila tidak, plot = maks `panel.spec.heightMm` (bawaan 32 mm). Tinggi <= blok teks
 * turunan (`grid.textBlockHeightMm`; A4 potret 247 mm).
 * Lint per panel: huruf, warna, aksen (maks 1 per panel); lint figur: huruf, warna
 * (keluarga, K-32), lebar, tinggi, raster/aset.
 */
import type { ChartPanelSpec, LintIssue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { FIGURE_APPARATUS_BAND_MM, apparatusMarker, figureApparatus } from "./apparatus";
import { panelCanvas } from "./canvas";
import { type FigureLimits, assertChartSpec, defect, figureLabel, figureLimits, figureLimitsReport, lintChartSvg, mergeReports, scanSvg } from "./guards";
import { chartRendererFor, drawnChartDef } from "./lookup";
import { chartPalette, colorFamily } from "./palette";
import { resolveChartParams, runChartRenderer } from "./params";
import { chartFloors } from "./prepare";
import { SvgDoc, escAttr, num } from "./svg";

export const COMPOSITE_DEFAULT_GAP_MM = 4;
export const PANEL_CAPTION_BAND_MM = 8.6;
export const PANEL_DEFAULT_PLOT_MM = 32;
export const PANEL_AXIS_NOTE_BAND_MM = 3.2;
const PANEL_MIN_PLOT_MM = 8;
/** Jarak awal nama panel dari tepi kiri (mm; galeri: kode lalu nama). */
const PANEL_NAME_X_MM = 9.1;

/** Templat kosong: palet dan parameter jatuh ke default registri. */
export const EMPTY_CHART_TEMPLATE: ResolvedTemplate = Object.freeze({
  templateId: "",
  versionId: "",
  versionNo: 0,
  params: {},
  roleFormats: {},
  sectionPlan: {},
  assets: {},
});

export interface CompositeLayout {
  columns: number;
  rows: number;
  gapMm: number;
  panelWidthMm: number;
  plotHeightMm: number;
  footBandMm: number;
  heightMm: number;
}

function compositeOf(spec: StudioChartV1): NonNullable<StudioChartV1["composite"]> {
  const c = spec.composite;
  const fid = figureLabel(spec);
  if (spec.kind !== "composite" || !c) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — komposit membutuhkan kind "composite" dan medan composite`);
  }
  if (![1, 2, 3].includes(c.columns)) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — composite.columns ${String(c.columns)} bukan 1..3`);
  }
  if (!Array.isArray(c.panels) || c.panels.length === 0) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — composite.panels kosong`);
  }
  if (c.gapMm !== undefined && !(c.gapMm >= 0 && Number.isFinite(c.gapMm))) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — composite.gapMm ${String(c.gapMm)} tidak sah`);
  }
  return c;
}

/**
 * Tata letak kisi komposit; `limits` = batas figur turunan. Tanpa `limits` (hanya taksiran
 * tinggi, `compositeHeightMm`) cek blok teks DATUM-33 dilewati, bukan diukur terhadap A4
 * implisit (FIX-A2 N6); `renderComposite` selalu memeriksa dengan batas templat.
 */
export function compositeLayout(spec: StudioChartV1, limits: FigureLimits | undefined): CompositeLayout {
  const c = compositeOf(spec);
  const columns = c.columns;
  const rows = Math.ceil(c.panels.length / columns);
  const gapMm = c.gapMm ?? COMPOSITE_DEFAULT_GAP_MM;
  const panelWidthMm = (spec.widthMm - gapMm * (columns - 1)) / columns;
  const footBandMm = spec.apparatus === "figure" ? FIGURE_APPARATUS_BAND_MM : 0;
  let plotHeightMm: number;
  let heightMm: number;
  if (spec.heightMm !== undefined) {
    heightMm = spec.heightMm;
    plotHeightMm = (heightMm - footBandMm - gapMm * (rows - 1)) / rows - PANEL_CAPTION_BAND_MM;
  } else {
    plotHeightMm = Math.max(...c.panels.map((p) => p.spec.heightMm ?? PANEL_DEFAULT_PLOT_MM));
    heightMm = rows * (plotHeightMm + PANEL_CAPTION_BAND_MM) + gapMm * (rows - 1) + footBandMm;
  }
  if (!(panelWidthMm > 10)) {
    throw defect("G2", `${figureLabel(spec)} — lebar panel ${panelWidthMm.toFixed(1)} mm terlalu sempit`, { panelWidthMm });
  }
  if (!(plotHeightMm >= PANEL_MIN_PLOT_MM)) {
    throw defect("DATUM-33", `${figureLabel(spec)} — tinggi plot panel ${plotHeightMm.toFixed(1)} mm < ${PANEL_MIN_PLOT_MM} mm`, {
      plotHeightMm,
    });
  }
  if (limits && heightMm > limits.maxHeightMm + 1e-9) {
    throw defect("DATUM-33", `${figureLabel(spec)} — tinggi komposit ${heightMm.toFixed(0)} mm melampaui blok teks ${limits.maxHeightMm} mm`, {
      heightMm,
      maxHeightMm: limits.maxHeightMm,
    });
  }
  return { columns, rows, gapMm, panelWidthMm, plotHeightMm, footBandMm, heightMm };
}

export function compositeHeightMm(spec: StudioChartV1, limits?: FigureLimits): number {
  return compositeLayout(spec, limits).heightMm;
}

/** Isi SVG panel tanpa akar, komentar, dan latar kertas; diskalakan ke mm bila perlu. */
export function panelInner(svg: string): string {
  const open = /<svg\b[^>]*>/.exec(svg);
  const end = svg.lastIndexOf("</svg>");
  if (!open || end < open.index) throw new StudioEngineError("SCHEMA_INVALID", "engine/chart/core: keluaran panel bukan SVG");
  const k = scanSvg(svg).userToMm;
  const inner = svg
    .slice(open.index + open[0].length, end)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<rect\b[^>]*\bdata-bg="paper"[^>]*\/>/g, "")
    .replace(/^\s*\n/gm, "");
  return Math.abs(k - 1) > 1e-9 ? `<g transform="scale(${num(k, 6)})">\n${inner}</g>` : inner;
}

/** Komposit galeri. `tpl` opsional (tanda tangan I22 `renderComposite(spec)`); tanpa templat = default registri. */
export function renderComposite(spec: StudioChartV1, tpl: ResolvedTemplate = EMPTY_CHART_TEMPLATE): SvgResult {
  const c = compositeOf(spec);
  const limits = figureLimits(tpl.params);
  assertChartSpec(spec, limits);
  const L = compositeLayout(spec, limits);
  const pal = chartPalette(spec, tpl);
  const floors = chartFloors(spec, tpl);
  const family = (h: string): string => colorFamily(h, pal);
  const W = spec.widthMm;
  const doc = new SvgDoc(W, L.heightMm, 'data-chart="composite" data-style="gallery"', floors.minFontPt);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(pal.paper);

  const panelReports: Array<{ checksRun: string[]; issues: LintIssue[] }> = [];
  c.panels.forEach((p, i) => {
    if (p.spec?.kind !== p.code) {
      throw new StudioEngineError("SCHEMA_INVALID", `${figureLabel(spec)} — panel ${i} kode ${p.code} tidak sama dengan spec.kind ${String(p.spec?.kind)}`, {
        panel: i,
      });
    }
    const def = drawnChartDef(p.code);
    const renderer = chartRendererFor(def);
    const col = i % L.columns;
    const row = Math.floor(i / L.columns);
    const x = col * (L.panelWidthMm + L.gapMm);
    const y = row * (L.plotHeightMm + PANEL_CAPTION_BAND_MM + L.gapMm);
    const noteBand = p.axisNote ? PANEL_AXIS_NOTE_BAND_MM : 0;
    const plotH = L.plotHeightMm - noteBand;
    const panelSpec: StudioChartV1 = {
      ...(p.spec as ChartPanelSpec),
      $schema: "studio.chart/v1",
      kind: p.code,
      title: p.name,
      source: spec.source,
      // Lebar panel bukan anggota himpunan lebar figur: cast terdokumentasi (lihat canvas.ts).
      widthMm: L.panelWidthMm as StudioChartV1["widthMm"],
      heightMm: plotH,
      style: p.spec.style ?? spec.style ?? "gallery",
      apparatus: "page",
      inDocument: true,
    };
    let res: SvgResult;
    try {
      res = runChartRenderer(renderer, resolveChartParams(panelSpec, def.code), panelCanvas(L.panelWidthMm, plotH, limits.maxHeightMm), tpl);
    } catch (e) {
      if (e instanceof StudioEngineError) {
        throw new StudioEngineError(e.code, `panel ${i + 1} (${p.code} ${p.name}): ${e.message}`, { panel: i, code: p.code, cause: e.details });
      }
      throw e;
    }
    const lint = lintChartSvg(res.svg, {
      minFontPt: floors.minFontPt,
      maxColors: floors.maxColors,
      family,
      maxHeightMm: limits.maxHeightMm,
      accentHex: pal.role.accent,
      maxAccent: floors.maxAccent,
    });
    const address = `panel:${p.code}`;
    panelReports.push({
      checksRun: [...res.report.checksRun, ...lint.checksRun],
      issues: [...res.report.issues, ...lint.issues].map((it) => ({ ...it, address: it.address ?? address })),
    });

    doc.open(`data-panel="${escAttr(p.code)}" data-panel-name="${escAttr(p.name)}" transform="translate(${num(x)} ${num(y)})"`);
    const inner = panelInner(res.svg);
    doc.raw(noteBand ? `<g transform="translate(0 ${num(noteBand)})">\n${inner}</g>` : inner);
    if (p.axisNote) doc.text(L.panelWidthMm, 2.3, p.axisNote, { sizePt: 6.0, fill: pal.ink400, anchor: "end" });
    const rule = L.plotHeightMm + 1.8;
    const base = L.plotHeightMm + 6.4;
    doc.line(0, rule, L.panelWidthMm, rule, pal.ink200, 0.25);
    doc.text(0, base, p.code, { face: "data", sizePt: 6.8, fill: pal.ink400 });
    doc.text(PANEL_NAME_X_MM, base, p.name, { sizePt: 7.4, fill: pal.ink900 });
    if (p.caption) doc.text(L.panelWidthMm, base, p.caption, { sizePt: 6.0, fill: pal.ink400, anchor: "end" });
    doc.close();
  });

  if (spec.apparatus === "figure") figureApparatus(doc, spec, pal, L.heightMm);

  const svg = doc.toString();
  const whole = lintChartSvg(svg, {
    minFontPt: floors.minFontPt,
    maxColors: floors.maxColors,
    family,
    widths: limits.widthsMm,
    maxHeightMm: limits.maxHeightMm,
    apparatusPage: (spec.apparatus ?? "page") === "page",
  });
  return { svg, widthMm: W, heightMm: L.heightMm, report: mergeReports(...panelReports, whole, figureLimitsReport(tpl.params)) };
}
