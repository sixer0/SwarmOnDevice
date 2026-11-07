/**
 * engine/chart/family-h1 — H-05 hexbin (S35; acuan PC v70_hexbin, PENUH).
 *
 * Binning heksagonal DETERMINISTIK = port `Axes.hexbin` matplotlib (gridsize skalar,
 * `mincnt=1`, tanpa C): nx = gridsize, ny = int(nx / sqrt 3); rentang data dipadatkan
 * `nonsingular(expander=0,1)` lalu diberi padding 1e-9; setiap titik dicocokkan ke pusat
 * kisi utama (round, pembulatan setengah-ke-genap seperti numpy) atau kisi selang-seling
 * (floor + 0,5) menurut jarak `d1 < d2` dengan bobot 3 pada sumbu y; urutan sel = kisi
 * utama (ix mayor, iy minor) lalu kisi selang-seling; sel kosong dibuang. Heksagon runcing-
 * atas: verteks (+/-0,5 sx, +/-sy/6) dan (0, +/-sy/3) dalam satuan data. Jumlah sel sama
 * dengan acuan untuk data dan gridsize yang sama (paritas CB1 butir a).
 *
 * gridsize: gaya `datum` 9 (acuan); gaya `gallery` clamp(round(0,65 x sqrt n), 9, 24)
 * (Gambar 8.2: 600 titik -> 16). Warna: 5 kelas sama-interval atas jumlah titik pada
 * ramp tinta ink100..ink900 (satu keluarga, K-32; acuan RAMP abu-abu, panel galeri abu-abu).
 * Domain = rentang data + maks(margin 5 %, setengah sel) sehingga heksagon tepi tidak
 * terpotong. Gaya datum: tepi kertas 0,6 pt (acuan `edgecolors=PAPER`), skala "jumlah
 * titik" di kanan; gaya gallery: tanpa angka sumbu, tanpa skala (panel H-05).
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { fmt } from "../../bind";
import { figureFootMm, apparatusMarker, figureApparatus, noteLine } from "../core/apparatus";
import { MM_PER_PT, SvgDoc, num } from "../core/svg";
import { kindAxisXY, kindBool } from "../core/read";
import { drawAxes, layoutXy } from "./axes";
import { type H1Prep, accentTarget, finishH1, requireXy } from "./common";
import { classOf, drawScale, scaleBandMm } from "./ramp";

export interface HexBin {
  /** Urutan sel tak-kosong (data-index). */
  order: number;
  cx: number;
  cy: number;
  count: number;
}

export interface HexGrid {
  nx: number;
  ny: number;
  sx: number;
  sy: number;
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
  bins: HexBin[];
}

/** np.round: setengah ke genap. */
export function roundHalfEven(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** matplotlib.transforms.nonsingular(vmin, vmax, expander). */
function nonsingular(vmin: number, vmax: number, expander: number): [number, number] {
  let lo = Math.min(vmin, vmax);
  let hi = Math.max(vmin, vmax);
  const maxabs = Math.max(Math.abs(lo), Math.abs(hi));
  if (maxabs < 1e21 * 2.2250738585072014e-308) return [-expander, expander];
  if (hi - lo <= maxabs * 1e-15) {
    if (hi === 0 && lo === 0) return [-expander, expander];
    lo -= expander * Math.abs(lo);
    hi += expander * Math.abs(hi);
  }
  return [lo, hi];
}

export function hexbinMpl(xs: readonly number[], ys: readonly number[], gridsize: number): HexGrid {
  const nx = gridsize;
  const ny = Math.trunc(nx / Math.sqrt(3));
  let [xmin, xmax] = nonsingular(Math.min(...xs), Math.max(...xs), 0.1);
  const [ymin, ymax] = nonsingular(Math.min(...ys), Math.max(...ys), 0.1);
  const nx1 = nx + 1;
  const ny1 = ny + 1;
  const nx2 = nx;
  const ny2 = ny;
  const padding = 1e-9 * (xmax - xmin);
  xmin -= padding;
  xmax += padding;
  const sx = (xmax - xmin) / nx;
  const sy = (ymax - ymin) / ny;
  const c1 = new Array<number>(nx1 * ny1).fill(0);
  const c2 = new Array<number>(nx2 * ny2).fill(0);
  for (let i = 0; i < xs.length; i++) {
    const ix = (xs[i] - xmin) / sx;
    const iy = (ys[i] - ymin) / sy;
    const ix1 = roundHalfEven(ix);
    const iy1 = roundHalfEven(iy);
    const ix2 = Math.floor(ix);
    const iy2 = Math.floor(iy);
    const d1 = (ix - ix1) ** 2 + 3.0 * (iy - iy1) ** 2;
    const d2 = (ix - ix2 - 0.5) ** 2 + 3.0 * (iy - iy2 - 0.5) ** 2;
    if (d1 < d2) {
      if (ix1 >= 0 && ix1 < nx1 && iy1 >= 0 && iy1 < ny1) c1[ix1 * ny1 + iy1]++;
    } else if (ix2 >= 0 && ix2 < nx2 && iy2 >= 0 && iy2 < ny2) {
      c2[ix2 * ny2 + iy2]++;
    }
  }
  const bins: HexBin[] = [];
  c1.forEach((count, j) => {
    if (count >= 1) bins.push({ order: bins.length, cx: xmin + Math.floor(j / ny1) * sx, cy: ymin + (j % ny1) * sy, count });
  });
  c2.forEach((count, j) => {
    if (count >= 1) bins.push({ order: bins.length, cx: xmin + (Math.floor(j / ny2) + 0.5) * sx, cy: ymin + ((j % ny2) + 0.5) * sy, count });
  });
  return { nx, ny, sx, sy, xmin, xmax, ymin, ymax, bins };
}

/** Verteks heksagon matplotlib (satuan data) relatif pusat. */
const HEX_VERTS: ReadonlyArray<readonly [number, number]> = [
  [0.5, -0.5],
  [0.5, 0.5],
  [0, 1],
  [-0.5, 0.5],
  [-0.5, -0.5],
  [0, -1],
];

export function hexGridsize(style: "datum" | "gallery", n: number): number {
  return style === "gallery" ? Math.min(24, Math.max(9, Math.round(0.65 * Math.sqrt(n)))) : 9;
}

export function renderHexbin(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate, prep: H1Prep): SvgResult {
  void tpl;
  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const { pal, style } = prep;
  const pts = requireXy(spec, { ...prep, maxAccent: Number.MAX_SAFE_INTEGER });
  if (accentTarget(spec) || pts.some((p) => p.accent)) {
    prep.issues.push({ checkId: "ACCENT_IGNORED", status: "REPORT", detail: `${prep.code}: hexbin tidak memakai aksen titik; aksen diabaikan` });
  }
  const grid = hexbinMpl(
    pts.map((p) => p.x),
    pts.map((p) => p.y),
    hexGridsize(style, pts.length),
  );
  const spanX = grid.xmax - grid.xmin;
  const spanY = grid.ymax - grid.ymin;
  const padX = Math.max(0.05 * spanX, grid.sx / 2);
  const padY = Math.max(0.05 * spanY, grid.sy / 3);

  const ladder = [pal.ink100, pal.ink200, pal.ink400, pal.ink700, pal.ink900];
  const k = ladder.length;
  const counts = grid.bins.map((b) => b.count);
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  const showScale = style === "datum";
  const bounds = Array.from({ length: k + 1 }, (_, i) => fmt(lo + ((hi - lo) * i) / k, hi - lo >= k ? 0 : 1));
  const scaleTitle = "jumlah titik";
  const rightBand = showScale ? scaleBandMm(bounds, scaleTitle) : 0;

  // Petunjuk galeri H-05 (IP-41c): `axis` {x, y} = domain tercetak (diperluas bila titik di
  // luarnya + REPORT AXIS_DOMAIN); `axesUnlabelled` (tidak diset = gallery tanpa angka).
  // Tidak berlaku pada fallback hexbin H-01 (kode lain).
  const own = prep.code === "H-05" ? { spec, tpl, code: "H-05" as const } : undefined;
  const axis = own ? kindAxisXY(own) : undefined;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const hinted = (dir: "x" | "y", auto: [number, number], v: number[]): [number, number] => {
    const a = axis?.[dir];
    if (!a) return auto;
    const lo = Math.min(a[0], ...v);
    const hi = Math.max(a[1], ...v);
    if (lo < a[0] || hi > a[1]) prep.issues.push({ checkId: "AXIS_DOMAIN", status: "REPORT", detail: `domain sumbu ${dir} ${lo}..${hi}: titik di luar petunjuk ${a[0]}..${a[1]}` });
    return [lo, hi];
  };
  const showTicks = own ? !kindBool(own, "axesUnlabelled", style === "gallery") : style === "datum";
  const L = layoutXy(spec, W, H, prep, hinted("x", [grid.xmin - padX, grid.xmax + padX], xs), hinted("y", [grid.ymin - padY, grid.ymax + padY], ys), {
    showTicks,
    rightBandMm: rightBand,
  });

  const doc = new SvgDoc(W, H, `data-chart="${prep.code}" data-style="${style}"`, prep.minFontPt);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(pal.paper);
  drawAxes(doc, L, pal, spec);
  const edge = style === "datum" ? { stroke: pal.paper, strokeWidthMm: 0.6 * MM_PER_PT } : {};
  for (const b of grid.bins) {
    const d =
      HEX_VERTS.map(([vx, vy], i) => `${i === 0 ? "M" : "L"}${num(L.sx(b.cx + vx * grid.sx))} ${num(L.sy(b.cy + (vy * grid.sy) / 3))}`).join(" ") +
      " Z";
    doc.path(d, ladder[classOf(b.count, lo, hi, k)], {
      mark: { mark: "cell", series: "jumlah", index: b.order },
      ...edge,
      attrs: ` data-count="${b.count}"`,
    });
  }
  if (showScale) drawScale(doc, W - rightBand + 2.0, L.frame.y0, L.frame.y1, ladder, bounds, pal, scaleTitle);
  if (spec.note) noteLine(doc, spec.note, W, H - figureFootMm(spec) - 1.4, pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, pal, H);
  return finishH1({ svg: doc.toString(), widthMm: W, heightMm: H }, prep);
}
