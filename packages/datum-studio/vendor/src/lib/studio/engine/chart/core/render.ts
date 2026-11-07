/**
 * engine/chart/core — `renderChart` (I22): titik masuk render chart tunggal dan komposit.
 *
 * Alur: komposit -> renderComposite; kode tak dikenal -> CHART_KIND_UNKNOWN; drawn=false
 * -> CHART_KIND_NOT_DRAWN (+ alternatives); penjaga spec (G2, N1, 10, 36, 30, 33);
 * renderer dari CHART_RENDERERS (dibaca di badan fungsi); kanvas mm selebar spec (anggota
 * himpunan lebar figur turunan templat, `figureLimits`; A4 = 128/166) dengan tinggi
 * taksiran <= blok teks turunan; lint keluaran digabung ke `report`. Deterministik:
 * masukan sama -> SVG sama.
 *
 * `kind = "custom"` + `form` (DC-27, 05 §12) didispatch lebih dulu ke kode keluarga
 * tergambar lewat `./custom` (I68; di luar CU-01..CU-09 -> 422 EC28); spec preset lewat
 * apa adanya.
 *
 * Kunci `params` diselesaikan SATU resolver (`./params`, IP-25/D-87) sebelum tinggi dan
 * renderer: alias pendek sah -> kunci penuh (REPORT PARAM_ALIAS), lainnya PARAM_IGNORED.
 */
import type { ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { figureFootMm } from "./apparatus";
import { chartCanvas, finalizeChart } from "./canvas";
import { type StudioChartInput, toStudioChart } from "./custom";
import { EMPTY_CHART_TEMPLATE, compositeHeightMm, renderComposite } from "./composite";
import { coreHeightMm, isCoreCode } from "./families";
import { autoFitChart } from "./autofit";
import { applyChartIntent, attachFullLabels, capacityAdvice } from "./intent";
import { CHART_LINT_OPTIONS, lintChartGeometry } from "./geometry";
import { assertChartSpec, figureLabel, figureLimits, mergeReports } from "./guards";
import { referenceHeightMm } from "./heights";
import { chartRendererFor, drawnChartDef } from "./lookup";
import { resolveChartParams, runChartRenderer } from "./params";
import { measure } from "./textfit";
import { ChartOverCapacity } from "../../figure-capacity";

/** Row 158: categories (categorical points / series categories) of a chart spec, else null. */
function categoryCount(spec: StudioChartV1): number | null {
  const d = spec.data;
  if (d?.shape === "categorical") return d.points.length;
  if (d?.shape === "series") return d.categories.length;
  return null;
}

/** Row 158: category labels of a chart spec ([] when the shape has none). */
function categoryLabels(spec: StudioChartV1): string[] {
  const d = spec.data;
  if (d?.shape === "categorical") return d.points.map((p) => String(p.label));
  if (d?.shape === "series") return d.categories.map(String);
  return [];
}

/** Row 158: column slot rule of autofit `columnLabelsTooWide` (6,4 pt caps label + 0,8 mm air). */
const COLUMN_LABEL_PT = 6.4;
const COLUMN_SLOT_PAD_MM = 0.8;
const COLUMN_SIDE_MM = 8;

/**
 * Row 158 (U24 B): refuse a render whose best layout still has overlapping labels or text outside
 * the canvas (lint `textOverlap` + `textOutside` > 0). Limit/measured: categories that fit as
 * columns at this width with the longest label, when that is the binding limit; otherwise the
 * count of crowded labels against 0. Other residual defects stay REPORT `GEOM_*`.
 */
function assertNotCrowded(spec: StudioChartV1, svg: string, limits: { maxHeightMm: number }): void {
  const geo = lintChartGeometry(svg, CHART_LINT_OPTIONS);
  const crowded = (geo.counts.textOverlap ?? 0) + (geo.counts.textOutside ?? 0);
  if (crowded === 0) return;
  const labels = categoryLabels(spec);
  const longest = labels.reduce((a, b) => (measure(b, COLUMN_LABEL_PT, "struct", { caps: true }) > measure(a, COLUMN_LABEL_PT, "struct", { caps: true }) ? b : a), "");
  const fitCols = labels.length ? Math.max(1, Math.floor((spec.widthMm - COLUMN_SIDE_MM) / (measure(longest, COLUMN_LABEL_PT, "struct", { caps: true }) + COLUMN_SLOT_PAD_MM) + 1e-9)) : null;
  const byCategories = fitCols !== null && fitCols < labels.length;
  const series = spec.data?.shape === "series" ? spec.data.series.length : null;
  const parts = [
    byCategories ? `kurangi menjadi maks ${fitCols} kategori pada ${spec.widthMm} mm (\`topN: ${fitCols}\` bila kode ini mendukungnya)` : "kurangi kategori atau titik berlabel",
    `persingkat label (labelShort; terpanjang ${longest.length} karakter: "${longest.slice(0, 40)}")`,
    ...(series !== null && series > 1 ? [`kurangi seri (${series} seri)`] : []),
    // capacityAdvice's own topN (8) would contradict a smaller column limit; keep its other actions.
    byCategories ? `pisah menjadi dua gambar${spec.kind !== "P-01" ? ", atau pakai batang horizontal P-01 (tanpa orientation: vertical)" : ""}` : capacityAdvice(spec.kind),
  ];
  throw new ChartOverCapacity(
    `[CAPACITY-LABELS] ${figureLabel(spec)} — ${geo.counts.textOverlap ?? 0} label bertumpuk dan ${geo.counts.textOutside ?? 0} teks keluar kanvas setelah tata letak otomatis (blok teks ${limits.maxHeightMm} mm)`,
    {
      checkId: "CAPACITY-LABELS",
      family: spec.kind,
      quantity: byCategories ? "kategori sebagai kolom" : "label bertumpuk/keluar kanvas",
      unit: byCategories ? "kategori" : "label",
      limit: byCategories ? fitCols : 0,
      measured: byCategories ? labels.length : crowded,
      suggestion: parts.join("; "),
    },
  );
}

/** Rasio tinggi bawaan keluarga tanpa `heightMm` (mm per mm lebar). */
export const DEFAULT_HEIGHT_RATIO = 0.5;

/**
 * Tinggi kanvas (mm) yang akan dipakai renderChart. Komposit: tata letak kisi; inti:
 * taksiran DC; keluarga lain: `spec.heightMm`, lalu tinggi acuan kode
 * (`CHART_REFERENCE_HEIGHT_MM`, paritas CB1 (d)), lalu lebar x 0,5; ditambah pita
 * aparatus figure bila tinggi tidak diset spec.
 */
export function estimateHeightMm(input: StudioChartInput): number {
  const given: StudioChartV1 = toStudioChart(input);
  // FIG-03a: maksud analitis (mis. `topN`) mengubah jumlah kategori -> taksiran atas spec terapan.
  const spec = given.kind !== "composite" && given.intent !== undefined ? applyChartIntent(given, EMPTY_CHART_TEMPLATE).spec : given;
  if (spec.kind === "composite") return compositeHeightMm(spec);
  if (isCoreCode(spec.kind)) return coreHeightMm(spec, spec.kind);
  if (spec.heightMm !== undefined) return spec.heightMm;
  const base = referenceHeightMm(spec.kind) ?? Math.round(spec.widthMm * DEFAULT_HEIGHT_RATIO * 10) / 10;
  return base + figureFootMm(spec);
}

/**
 * FIG-03a: spec TANPA `intent` lewat jalur preset apa adanya (byte-identik). Dengan `intent`:
 * `applyChartIntent` (transformasi data, REPORT `INTENT_APPLIED`/`HINT_IGNORED`) -> render preset
 * -> label singkat diberi `<title>` label lengkap. Komposit: maksud diabaikan (`HINT_IGNORED`).
 */
export function renderChart(raw: StudioChartInput, tpl: ResolvedTemplate = EMPTY_CHART_TEMPLATE): SvgResult {
  const input: StudioChartV1 = toStudioChart(raw);
  if (input.kind === "composite") {
    const res = renderComposite(input, tpl);
    if (input.intent === undefined) return res;
    const issue = { checkId: "HINT_IGNORED", status: "REPORT" as const, detail: "orientation/sort/topN/labelShort diabaikan pada grafik komposit (kirim per gambar tunggal)" };
    return { ...res, report: mergeReports(res.report, { checksRun: ["HINT_IGNORED"], issues: [issue] }) };
  }
  if (input.intent === undefined) return renderPreset(input, tpl);
  const applied = applyChartIntent(input, tpl);
  const res = renderPreset(applied.spec, tpl, applied.noAutoOrient);
  const notes = { checksRun: [...new Set(applied.notes.map((i) => i.checkId))], issues: applied.notes };
  return { ...res, svg: attachFullLabels(res.svg, applied.shorts), report: mergeReports(res.report, notes) };
}

/** Render spec preset (jalur sebelum FIG-03a); `noAutoOrient` = maksud `orientation: "vertical"`. */
function renderPreset(input: StudioChartV1, tpl: ResolvedTemplate, noAutoOrient = false): SvgResult {
  const limits = figureLimits(tpl.params);
  const renderOnce = (s: StudioChartV1, heightMm?: number): { res: SvgResult; heightMm: number; spec: StudioChartV1 } => {
    const def = drawnChartDef(s.kind);
    assertChartSpec(s, limits);
    const renderer = chartRendererFor(def);
    const resolved = resolveChartParams(s, def.code);
    const h = heightMm ?? estimateHeightMm(resolved.spec);
    if (h > limits.maxHeightMm + 1e-9) {
      // Swarm patch (row 158, U24 B): FIGURE_OVER_CAPACITY with the measured height and the limit.
      const n = categoryCount(resolved.spec);
      throw new ChartOverCapacity(`[DATUM-33] ${figureLabel(resolved.spec)} — perkiraan tinggi ${h.toFixed(0)} mm melampaui blok teks ${limits.maxHeightMm} mm`, {
        checkId: "DATUM-33",
        family: resolved.spec.kind,
        quantity: "tinggi taksiran",
        unit: "mm",
        limit: limits.maxHeightMm,
        measured: Math.round(h * 10) / 10,
        suggestion: `kurangi kategorinya${n !== null ? ` (${n} kategori)` : ""}: ${capacityAdvice(resolved.spec.kind)}`,
      });
    }
    return { res: runChartRenderer(renderer, resolved, chartCanvas(resolved.spec.widthMm, h, limits), tpl), heightMm: h, spec: resolved.spec };
  };
  const first = renderOnce(input);
  // FIG-02a: render bersih (lint geometri tanpa cacat) dikembalikan apa adanya (byte-identik);
  // tata letak otomatis hanya bila cacat terdeteksi.
  const geo = lintChartGeometry(first.res.svg, CHART_LINT_OPTIONS);
  if (geo.score === 0) return finalizeChart(first.res, first.spec, tpl);
  const fitted = autoFitChart(input, first.res, geo, {
    render: (s, h) => renderOnce(s, h),
    estimate: (s) => estimateHeightMm(resolveChartParams(s, drawnChartDef(s.kind).code).spec),
    maxHeightMm: limits.maxHeightMm,
    noAutoOrient,
  });
  // Swarm patch (row 158, U24 B): the best layout still overlaps labels or pushes text off the
  // canvas -> refuse FIGURE_OVER_CAPACITY instead of returning the squeezed render.
  assertNotCrowded(input, fitted.res.svg, limits);
  const fin = finalizeChart(fitted.res, fitted.spec === input ? first.spec : resolveChartParams(fitted.spec, drawnChartDef(fitted.spec.kind).code).spec, tpl);
  return { ...fin, report: mergeReports(fin.report, { checksRun: [...new Set(fitted.extra.map((i) => i.checkId))], issues: fitted.extra }) };
}
