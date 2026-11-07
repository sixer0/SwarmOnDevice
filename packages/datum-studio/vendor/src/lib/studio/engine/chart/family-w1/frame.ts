/**
 * engine/chart/family-w1 — bingkai plot waktu (S39): tata letak mm, domain y, sumbu x
 * waktu, grid, sumbu, aparatus.
 *
 * Gaya "datum" (default) mengikuti kerangka pustakachart (PC:105-139, `style_ax`):
 * spine kiri + bawah ink400 0,6 pt, tanpa tick mark, label tick 6,5 pt (angka Plex Mono),
 * grid y ink200 (W-01, W-03, W-04; W-05 tanpa grid), label sumbu y = `spec.unit` 6,8 pt
 * ink700 diputar, domain garis = data +/- 5 % rentang (margin matplotlib), area = 0 ..
 * maks x 1,15 (PC:716).
 * Gaya "gallery" = panel Gambar 8.4 Manual 000 (research/06:219): sumbu rambut peran
 * textAxis dengan tick mark 0,9 mm, label tick 6,0 pt ink400, tanpa grid, domain garis
 * rapi (niceDomain), area 0 .. maks x 1,05; satuan kecil di pojok kiri atas.
 *
 * Satuan pengguna = 1 mm; huruf dalam pt fisik (SvgDoc). Grid memakai 0,18 mm (lantai
 * DATUM-27), bukan 0,4 pt matplotlib (0,14 mm). Deterministik.
 */
import type { ChartCanvas, StudioChartV1 } from "../../../contract";
import { fmt } from "../../bind";
import { figureFootMm, apparatusMarker, figureApparatus, noteLine } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import type { ChartPalette } from "../core/palette";
import { type Scale, axisDomain, decimalsFor, linearScale, niceDomain, niceStep } from "../core/scale";
import { SvgDoc, num, ptToMm, textWidthMm } from "../core/svg";
import type { W1Code } from "./params";
import { type XAxisModel, buildXAxis } from "./timeaxis";

export type W1Style = "datum" | "gallery";
/** nice = niceDomain; pad = data +/- 5 %; zeroTop = 0 .. maks x (1 + headroom). */
export type YMode = "nice" | "pad" | "zeroTop";

const NOTE_BAND_MM = 5;
const MIN_PLOT_MM = 8;

export interface StyleMetrics {
  tickPt: number;
  axisPt: number;
  labelPt: number;
  valuePt: number;
  tickLenMm: number;
  axisMm: number;
  gridMm: number;
}

export function styleMetrics(style: W1Style, minFontPt: number): StyleMetrics {
  const f = (pt: number): number => Math.max(pt, minFontPt);
  return style === "gallery"
    ? { tickPt: f(6.0), axisPt: f(6.0), labelPt: f(6.4), valuePt: f(6.2), tickLenMm: 0.9, axisMm: 0.25, gridMm: 0.18 }
    : { tickPt: f(6.5), axisPt: f(6.8), labelPt: f(6.5), valuePt: f(6.2), tickLenMm: 0, axisMm: ptToMm(0.6), gridMm: 0.18 };
}

export interface FrameInput {
  spec: StudioChartV1;
  canvas: ChartCanvas;
  pal: ChartPalette;
  style: W1Style;
  code: W1Code;
  minFontPt: number;
  categories: readonly string[];
  /** Nilai hingga yang harus muat di domain y (tidak kosong). */
  yValues: readonly number[];
  yMode: YMode;
  /** Margin x sebagai pecahan rentang posisi (0 = titik pertama di sumbu). */
  padX: number;
  rightGutterMm: number;
  /** Pita tambahan di atas plot (baris KUNCI). */
  topExtraMm: number;
  grid: boolean;
  /** Petunjuk galeri `axis` (IP-41c): domain y tercetak [min, maks]; menggantikan `yMode`. */
  yAxis?: readonly [number, number];
}

export interface Frame {
  doc: SvgDoc;
  style: W1Style;
  pal: ChartPalette;
  m: StyleMetrics;
  x: XAxisModel;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  yMin: number;
  yMax: number;
  yTicks: number[];
  yDec: number;
  sx: Scale;
  sy: Scale;
  W: number;
  H: number;
  /** Alasan petunjuk `axis` diperluas (REPORT AXIS_DOMAIN oleh pemanggil). */
  yAxisWidened?: string;
}

function ticksIn(lo: number, hi: number, step: number): number[] {
  const dec = decimalsFor(step);
  const out: number[] = [];
  const i0 = Math.ceil(lo / step - 1e-9);
  const i1 = Math.floor(hi / step + 1e-9);
  for (let i = i0; i <= i1; i++) out.push(Number((i * step).toFixed(dec)));
  return out;
}

function yDomain(values: readonly number[], mode: YMode, style: W1Style, target: number): { min: number; max: number; step: number; ticks: number[] } {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (mode === "nice") {
    const d = niceDomain(values, { zero: false, target });
    return { min: d.min, max: d.max, step: d.step, ticks: d.ticks };
  }
  let min: number;
  let max: number;
  if (mode === "pad") {
    const span = hi - lo || Math.abs(hi) || 1;
    min = lo - 0.05 * span;
    max = hi + 0.05 * span;
  } else {
    const head = style === "datum" ? 0.15 : 0.05;
    min = lo < 0 ? lo * (1 + head) : 0;
    max = hi > 0 ? hi * (1 + head) : 0;
    if (max === min) max = min + 1;
  }
  const step = niceStep(max - min, target);
  return { min, max, step, ticks: ticksIn(min, max, step) };
}

/** Bangun kanvas, latar, penanda aparatus, dan geometri plot. */
export function layoutFrame(i: FrameInput): Frame {
  const { spec, canvas, pal, style } = i;
  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const m = styleMetrics(style, i.minFontPt);
  const doc = new SvgDoc(W, H, `data-chart="${i.code}" data-style="${style}"`, i.minFontPt);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(pal.paper);

  const tickH = ptToMm(m.tickPt);
  const unit = spec.unit ?? "";
  const xFace = (k: XAxisModel["kind"]): "struct" | "data" => (style === "datum" && k === "numeric" ? "data" : "struct");
  const probe = buildXAxis(i.categories, 100, m.tickPt, "struct");
  const hasYears = probe.ticks.some((t) => t.year !== undefined);

  const footBand = figureFootMm(spec) + (spec.note ? NOTE_BAND_MM : 0);
  // Label tick: garis dasar y1 + tickLen + 0,95 em + jarak; sisakan turunan huruf (~0,3 em) + 0,8 mm.
  const xBand = m.tickLenMm + tickH * 1.3 + (style === "gallery" ? 0.5 : 0.9) + 0.8 + (hasYears ? tickH * 1.2 : 0);
  const y0 = (style === "gallery" ? 2.2 : 2.4) + (style === "gallery" && unit ? tickH + 1.4 : 0) + i.topExtraMm;
  const y1 = H - footBand - xBand;
  const fid = figureLabel(spec);
  if (!(y1 - y0 >= MIN_PLOT_MM)) {
    throw defect("DATUM-33", `${fid} — tinggi plot ${(y1 - y0).toFixed(1)} mm < ${MIN_PLOT_MM} mm; tambah heightMm`, { code: i.code });
  }

  const target = Math.max(3, Math.min(6, Math.round((y1 - y0) / (style === "datum" ? 9 : 8))));
  const ad = i.yAxis ? axisDomain(i.yValues, { zero: false, target }, i.yAxis) : undefined;
  const yd = ad ? ad.dom : yDomain(i.yValues, i.yMode, style, target);
  const yDec = decimalsFor(yd.step);
  const yFace = style === "datum" ? "data" : "struct";
  const yLabelW = Math.max(0, ...yd.ticks.map((t) => textWidthMm(fmt(t, yDec), m.tickPt, yFace)));
  const unitBand = style === "datum" && unit ? ptToMm(m.axisPt) + 1.2 : 0;
  const x0 = unitBand + yLabelW + 1.2 + m.tickLenMm + (style === "gallery" ? 0.2 : 0.4);
  // Label tick terakhir berpusat di ujung plot: sisakan separuh lebarnya di kanan.
  const lastHalf = textWidthMm(probe.labels[probe.labels.length - 1] ?? "", m.tickPt, xFace(probe.kind)) / 2 + 0.3;
  const x1 = W - Math.max(i.rightGutterMm + (style === "gallery" ? 0.4 : 1.0), lastHalf);
  if (!(x1 - x0 >= MIN_PLOT_MM)) {
    throw defect("G2", `${fid} — lebar plot ${(x1 - x0).toFixed(1)} mm < ${MIN_PLOT_MM} mm; label terlalu panjang untuk kanvas ${num(W)} mm`, {
      code: i.code,
    });
  }

  const probeKind = probe.kind;
  const x = buildXAxis(i.categories, x1 - x0, m.tickPt, xFace(probeKind));
  const p0 = x.pos[0];
  const p1 = x.pos[x.pos.length - 1];
  const span = p1 - p0;
  const d0 = span === 0 ? p0 - 0.5 : p0 - i.padX * span;
  const d1 = span === 0 ? p1 + 0.5 : p1 + i.padX * span;
  return {
    doc,
    style,
    pal,
    m,
    x,
    x0,
    x1,
    y0,
    y1,
    yMin: yd.min,
    yMax: yd.max,
    yTicks: yd.ticks,
    yDec,
    sx: linearScale(d0, d1, x0, x1),
    sy: linearScale(yd.min, yd.max, y1, y0),
    W,
    H,
    ...(ad?.widened ? { yAxisWidened: ad.widened } : {}),
  };
}

/** Grid y (gaya datum saja; dekorasi, digambar sebelum tanda data). */
export function drawGrid(f: Frame, on: boolean): void {
  if (!on || f.style !== "datum") return;
  f.doc.open('data-grid="y"');
  for (const t of f.yTicks) f.doc.line(f.x0, f.sy(t), f.x1, f.sy(t), f.pal.ink200, f.m.gridMm);
  f.doc.close();
}

/** Sumbu y dan x (digambar sesudah tanda data agar garis sumbu di atas isian). */
export function drawAxes(f: Frame, unit: string): void {
  const { doc, pal, m } = f;
  const tickH = ptToMm(m.tickPt);
  const gallery = f.style === "gallery";
  const axisColour = gallery ? pal.role.textAxis : pal.ink400;
  const yFace = gallery ? "struct" : "data";

  doc.open('data-axis="y"');
  doc.line(f.x0, f.y0, f.x0, f.y1, axisColour, m.axisMm);
  for (const t of f.yTicks) {
    const y = f.sy(t);
    if (gallery) doc.line(f.x0 - m.tickLenMm, y, f.x0, y, axisColour, m.axisMm);
    doc.text(f.x0 - m.tickLenMm - (gallery ? 0.6 : 1.2), y + tickH * 0.35, fmt(t, f.yDec), {
      sizePt: m.tickPt,
      fill: pal.ink400,
      face: yFace,
      anchor: "end",
    });
  }
  if (unit) {
    if (gallery) {
      doc.text(0, 2.2 + tickH * 0.8, unit, { sizePt: m.tickPt, fill: pal.ink400 });
    } else {
      const cx = ptToMm(m.axisPt) * 0.8;
      const cy = (f.y0 + f.y1) / 2;
      doc.text(cx, cy, unit, { sizePt: m.axisPt, fill: pal.ink700, anchor: "middle", attrs: ` transform="rotate(-90 ${num(cx)} ${num(cy)})"` });
    }
  }
  doc.close();

  const xFace = !gallery && f.x.kind === "numeric" ? "data" : "struct";
  const base = f.y1 + m.tickLenMm + tickH * 0.95 + (gallery ? 0.5 : 0.9);
  doc.open('data-axis="x"');
  doc.line(f.x0, f.y1, f.x1, f.y1, axisColour, m.axisMm);
  for (const t of f.x.ticks) {
    const x = f.sx(t.pos);
    if (gallery) doc.line(x, f.y1, x, f.y1 + m.tickLenMm, axisColour, m.axisMm);
    doc.text(x, base, t.label, { sizePt: m.tickPt, fill: pal.ink400, face: xFace, anchor: "middle" });
    if (t.year) doc.text(x, base + tickH * 1.2, t.year, { sizePt: m.tickPt, fill: pal.ink400, face: "data", anchor: "middle" });
  }
  doc.close();
}

/** Catatan dan aparatus "figure" di dasar kanvas. */
export function drawFoot(f: Frame, spec: StudioChartV1): void {
  if (spec.note) noteLine(f.doc, spec.note, f.W, f.H - figureFootMm(spec) - 1.4, f.pal);
  if (spec.apparatus === "figure") figureApparatus(f.doc, spec, f.pal, f.H);
}

/**
 * Tata label langsung di ujung garis/lapisan: urut menurut y, didorong agar berjarak
 * >= `gapMm`, lalu digeser naik bila melewati `bottom`. Mengembalikan y baru per masukan.
 */
export function spreadLabels(ys: readonly number[], gapMm: number, top: number, bottom: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const out = order.map((o) => o.y);
  for (let k = 0; k < out.length; k++) {
    if (k === 0) out[k] = Math.max(out[k], top);
    else out[k] = Math.max(out[k], out[k - 1] + gapMm);
  }
  for (let k = out.length - 1; k >= 0; k--) {
    if (k === out.length - 1) out[k] = Math.min(out[k], bottom);
    else out[k] = Math.min(out[k], out[k + 1] - gapMm);
  }
  const res = new Array<number>(ys.length);
  order.forEach((o, k) => (res[o.i] = out[k]));
  return res;
}
