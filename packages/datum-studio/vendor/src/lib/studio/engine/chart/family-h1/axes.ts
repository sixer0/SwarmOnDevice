/**
 * engine/chart/family-h1 — sumbu kontinu x/y untuk H-01, H-02, H-04, H-05 (S35).
 *
 * Domain dan tick mengikuti autoscale matplotlib yang dipakai acuan pustakachart
 * (kelas paritas CB1: domain +/- 5 %, jumlah tick +/- 2):
 * - domain = rentang data + margin 5 % tiap sisi (`axes.xmargin/ymargin` 0,05), tanpa
 *   pembulatan ke tick (`axes.autolimit_mode: data`);
 * - tick = MaxNLocator nbins "auto": `nbins = clip(floor(panjang_pt / (huruf_pt x k)), 1, 9)`
 *   dengan k = 3 untuk x dan 2 untuk y; langkah rapi terkecil {1, 2, 2,5, 5, 10} x 10^n
 *   yang >= rentang / nbins (`niceStep` inti).
 *
 * Gaya `datum` (port PC `style_ax`): garis sumbu ink400 0,6 pt, tanpa tanda tick, label
 * angka Plex Mono 6,5 pt ink400. Gaya `gallery` (Gambar 8.2): garis sumbu peran textAxis,
 * tanda tick keluar 0,9 mm, label Plex Sans Condensed 6,4 pt ink400.
 * Kisi hanya bila P7-16 `chart.gridlines` = whenComparing (ink200, 0,18 mm).
 */
import type { StudioChartV1 } from "../../../contract";
import { fmt, pyRound } from "../../bind";
import { defect } from "../core/guards";
import type { ChartPalette } from "../core/palette";
import { type Scale, decimalsFor, linearScale, niceStep } from "../core/scale";
import { MM_PER_PT, type SvgDoc, ptToMm, textWidthMm } from "../core/svg";
import type { H1Prep, H1Style } from "./common";

export interface AxisLook {
  tickPt: number;
  face: "struct" | "data";
  tickLen: number;
  gap: number;
  spineColor: (pal: ChartPalette) => string;
  spineMm: number;
}

export function axisLook(style: H1Style): AxisLook {
  return style === "gallery"
    ? { tickPt: 6.4, face: "struct", tickLen: 0.9, gap: 0.8, spineColor: (p) => p.role.textAxis, spineMm: 0.25 }
    : { tickPt: 6.5, face: "data", tickLen: 0, gap: 1.2, spineColor: (p) => p.ink400, spineMm: 0.6 * MM_PER_PT };
}

/** Domain matplotlib: rentang + margin; rentang nol diperlebar (nonsingular). */
export function mplDomain(values: readonly number[], margin = 0.05): [number, number] {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo <= Math.max(Math.abs(lo), Math.abs(hi)) * 1e-15) {
    if (lo === 0 && hi === 0) return [-0.1, 0.1];
    lo -= 0.1 * Math.abs(lo);
    hi += 0.1 * Math.abs(hi);
    return [lo, hi];
  }
  const d = (hi - lo) * margin;
  return [lo - d, hi + d];
}

export interface Ticks {
  step: number;
  dec: number;
  values: number[];
  labels: string[];
}

/** Tick MaxNLocator (lihat kepala berkas). */
export function axisTicks(lo: number, hi: number, lenMm: number, tickPt: number, dir: "x" | "y"): Ticks {
  const span = hi - lo;
  const nbins = Math.min(9, Math.max(1, Math.floor(lenMm / MM_PER_PT / (tickPt * (dir === "x" ? 3 : 2)))));
  let target = nbins;
  let step = niceStep(span, target);
  let values: number[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const dec = decimalsFor(step);
    const i0 = Math.ceil(lo / step - 1e-9);
    const i1 = Math.floor(hi / step + 1e-9);
    values = [];
    for (let i = i0; i <= i1; i++) {
      const v = pyRound(i * step, dec);
      values.push(v === 0 ? 0 : v); // tanpa "-0"
    }
    if (values.length >= 2) break;
    target *= 2;
    step = niceStep(span, target);
  }
  const dec = decimalsFor(step);
  return { step, dec, values, labels: values.map((v) => fmt(v, dec)) };
}

export interface Frame {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface XyLayout {
  frame: Frame;
  sx: Scale;
  sy: Scale;
  xt: Ticks;
  yt: Ticks;
  look: AxisLook;
  showTicks: boolean;
}

export interface XyLayoutOpts {
  /** Jarak tanda dari tepi bingkai (jari-jari titik/gelembung), mm. */
  insetMm?: number;
  /** Label tick dan tanda tick digambar. */
  showTicks?: boolean;
  /** Pita kanan (skala warna), mm. */
  rightBandMm?: number;
}

/** Tata letak bingkai plot xy dalam kanvas `W x H` mm. */
export function layoutXy(
  spec: StudioChartV1,
  W: number,
  H: number,
  prep: H1Prep,
  xDom: readonly [number, number],
  yDom: readonly [number, number],
  o: XyLayoutOpts = {},
): XyLayout {
  const look = axisLook(prep.style);
  const showTicks = o.showTicks ?? true;
  const inset = o.insetMm ?? 0;
  const labelH = ptToMm(look.tickPt);
  const top = spec.unit ? 4.2 : 1.6;
  const bottom = prep.footBand + (showTicks ? look.tickLen + look.gap + labelH + 0.6 : 1.0);
  const y0 = top;
  const y1 = H - bottom;
  const yt = axisTicks(yDom[0], yDom[1], Math.max(1, y1 - y0 - 2 * inset), look.tickPt, "y");
  const yLabelW = showTicks ? Math.max(...yt.labels.map((s) => textWidthMm(s, look.tickPt, look.face))) : 0;
  const x0 = (showTicks ? yLabelW + look.gap + look.tickLen : 0) + 0.6;
  let x1 = W - (o.rightBandMm ?? 0) - 1.6;
  let xt = axisTicks(xDom[0], xDom[1], Math.max(1, x1 - x0 - 2 * inset), look.tickPt, "x");
  if (showTicks && xt.labels.length) {
    // Label tick terakhir tidak boleh keluar kanvas: sempitkan bingkai sekali.
    const last = xt.values[xt.values.length - 1];
    const sx0 = linearScale(xDom[0], xDom[1], x0 + inset, x1 - inset);
    const over = sx0(last) + textWidthMm(xt.labels[xt.labels.length - 1], look.tickPt, look.face) / 2 - (W - (o.rightBandMm ?? 0) - 0.3);
    if (over > 0) {
      x1 -= over;
      xt = axisTicks(xDom[0], xDom[1], Math.max(1, x1 - x0 - 2 * inset), look.tickPt, "x");
    }
  }
  if (!(x1 - x0 > 2 * inset + 4) || !(y1 - y0 > 2 * inset + 4)) {
    throw defect("DATUM-33", `${prep.fid} — bidang plot ${(x1 - x0).toFixed(1)} x ${(y1 - y0).toFixed(1)} mm terlalu kecil; tambah heightMm`, {
      code: prep.code,
    });
  }
  return {
    frame: { x0, x1, y0, y1 },
    sx: linearScale(xDom[0], xDom[1], x0 + inset, x1 - inset),
    sy: linearScale(yDom[0], yDom[1], y1 - inset, y0 + inset),
    xt,
    yt,
    look,
    showTicks,
  };
}

/** Kisi (dekorasi, P7-16) di belakang tanda data. */
export function drawGrid(doc: SvgDoc, L: XyLayout, pal: ChartPalette): void {
  const { frame: f } = L;
  doc.open('data-grid="xy"');
  for (const v of L.xt.values) doc.line(L.sx(v), f.y0, L.sx(v), f.y1, pal.ink200, 0.18);
  for (const v of L.yt.values) doc.line(f.x0, L.sy(v), f.x1, L.sy(v), pal.ink200, 0.18);
  doc.close();
}

/** Garis sumbu kiri dan bawah + tick + label, dibungkus `data-axis`. */
export function drawAxes(doc: SvgDoc, L: XyLayout, pal: ChartPalette, spec: StudioChartV1): void {
  const { frame: f, look } = L;
  const spine = look.spineColor(pal);
  const labelH = ptToMm(look.tickPt);
  doc.open('data-axis="x"');
  doc.line(f.x0, f.y1, f.x1, f.y1, spine, look.spineMm);
  if (L.showTicks) {
    L.xt.values.forEach((v, i) => {
      const x = L.sx(v);
      if (look.tickLen > 0) doc.line(x, f.y1, x, f.y1 + look.tickLen, spine, 0.2);
      doc.text(x, f.y1 + look.tickLen + look.gap + labelH * 0.75, L.xt.labels[i], {
        face: look.face,
        sizePt: look.tickPt,
        fill: pal.ink400,
        anchor: "middle",
      });
    });
  }
  doc.close();
  doc.open('data-axis="y"');
  doc.line(f.x0, f.y0, f.x0, f.y1, spine, look.spineMm);
  if (L.showTicks) {
    L.yt.values.forEach((v, i) => {
      const y = L.sy(v);
      if (look.tickLen > 0) doc.line(f.x0 - look.tickLen, y, f.x0, y, spine, 0.2);
      doc.text(f.x0 - look.tickLen - look.gap, y + labelH * 0.35, L.yt.labels[i], {
        face: look.face,
        sizePt: look.tickPt,
        fill: pal.ink400,
        anchor: "end",
      });
    });
  }
  doc.close();
  if (spec.unit) doc.text(f.x0, 2.6, spec.unit, { sizePt: 6.2, fill: pal.ink400, anchor: "start" });
}
