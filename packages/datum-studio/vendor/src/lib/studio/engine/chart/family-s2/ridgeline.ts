/**
 * S-05 Ridgeline — kurva kepadatan per grup ditumpuk vertikal (grup pertama di atas).
 *
 * KDE: Gauss, lebar pita Silverman per grup (`_kde` PC:852-857), dievaluasi pada 160
 * titik berjarak sama, dinormalkan ke puncak masing-masing (= v59_ridge PC:920-936).
 * Rentang x = domain rapi atas [min - 1,5 bw, maks + 1,5 bw] semua grup (bw terbesar).
 *
 * Gaya datum (acuan pustakachart `v59_ridge`, PENUH): isian ink100 + garis ink900 1,0 pt,
 * puncak 0,8 x jarak baris (tanpa tumpang tindih), label grup rata kanan di kiri plot,
 * sumbu x bertick mono + satuan, tanpa spine kiri. Grup beraksen: garis signal.
 * Gaya gallery (Gambar 8.5 panel S-05): hanya garis ink700 (isian kertas menutup punggung
 * di belakangnya), puncak 1,5 x jarak baris, tanpa sumbu x, aksen garis signal.
 *
 * Parameter registri:
 * - `periodOrder` (default true): urutan data dipertahankan (periode atas ke bawah);
 *   false -> grup diurut median menaik dari atas ke bawah (urut stabil);
 * - `slightOverlap` (default true): puncak gallery 1,5 x jarak baris; false -> 0,8 (tanpa
 *   tumpang tindih). Gaya datum memakai resep acuan 0,8 kecuali parameter diset eksplisit
 *   (spec, atau templat berbeda dari default): true -> 1,3, false -> 0,8;
 * - `sharedAxis` (default true): satu skala x; false -> skala per grup, sumbu x tidak
 *   digambar (REPORT S-05.sharedAxis);
 * - `maxGroups` (default 12): grup > maks -> BY_CONSTRUCTION_FAILED `chart.kind.S-05.maxGroups`.
 */
import { defect } from "../core/guards";
import { kindKey } from "../core/palette";
import {
  type S2Ctx,
  HAIR_MM,
  SPINE_MM,
  TYPE_PT,
  accentGroupIndex,
  axisX,
  kde,
  kindBool,
  kindInt,
  linearScale,
  linspace,
  median,
  mid,
  num,
  pt,
  ptToMm,
  report,
  requireDistribution,
  silvermanBw,
  textWidthMm,
  tickLabels,
  valueDomain,
} from "./common";

const GRID_POINTS = 160;

export function renderRidgeline(ctx: S2Ctx): void {
  const { pal, doc, W, style, fid } = ctx;
  const gal = style === "gallery";
  let groups = requireDistribution(ctx);
  const maxGroups = kindInt(ctx, "maxGroups", 12);
  if (groups.length > maxGroups) {
    throw defect(kindKey("S-05", "maxGroups"), `${fid} — ${groups.length} grup > ${maxGroups}; ridgeline membaca paling banyak ${maxGroups} kelompok`, {
      code: "S-05",
      groups: groups.length,
    });
  }
  const accent = accentGroupIndex(
    ctx,
    groups.map((g) => g.name),
  );
  const accentName = accent >= 0 ? groups[accent].name : undefined;

  if (!kindBool(ctx, "periodOrder", true)) {
    const med = groups.map((g) => median(g.values));
    groups = groups
      .map((g, i) => ({ g, i }))
      .sort((a, b) => med[a.i] - med[b.i] || a.i - b.i)
      .map((x) => x.g);
    report(ctx, "S-05.periodOrder", "periodOrder=false: grup diurut median menaik dari atas ke bawah");
  }
  const overlap = kindBool(ctx, "slightOverlap", true, !gal);
  const peak = overlap ? (gal ? 1.5 : 1.3) : 0.8;
  const shared = kindBool(ctx, "sharedAxis", true);
  if (!shared) report(ctx, "S-05.sharedAxis", "sharedAxis=false: skala x per grup, sumbu x tidak digambar (bentuk saja yang dapat dibandingkan)");

  const bws = groups.map((g) => silvermanBw(g.values));
  const ext = (vs: readonly number[], bw: number): number[] => [Math.min(...vs) - 1.5 * bw, Math.max(...vs) + 1.5 * bw];
  const dom = valueDomain(ext(groups.flatMap((g) => g.values), Math.max(...bws)), false);

  const T = gal ? TYPE_PT.gallery : TYPE_PT.datum;
  const labelPt = pt(ctx, T.label);
  const labelW = Math.max(...groups.map((g) => textWidthMm(g.name, labelPt)));
  const x0 = Math.min(Math.max(labelW + 2.0, 6), W * 0.35);
  // Datum bersumbu: ruang setengah label tick terakhir agar tidak terpotong tepi kanan.
  const x1 = W - (!gal && shared ? Math.max(0.5, textWidthMm(tickLabels(dom)[dom.ticks.length - 1], TYPE_PT.datum.tick, "data") / 2 + 0.3) : 0.5);
  const top = gal ? 1.0 : 2.0;
  const base = ctx.bottom - (gal ? 1.0 : shared ? (ctx.unit ? 8.8 : 5.6) : 1.0);
  const n = groups.length;
  // Datum bersumbu: punggung terbawah berjarak 1 mm di atas garis sumbu.
  const ridgeBase = base - (!gal && shared ? 1.0 : 0);
  const rowStep = (ridgeBase - top) / (n - 1 + peak);
  const amp = peak * rowStep;
  const lineMm = gal ? 0.4 : 1.0 * (25.4 / 72);

  // Belakang ke depan: grup teratas digambar dulu, punggung di bawahnya menutupinya.
  groups.forEach((g, gi) => {
    const yb = top + amp + gi * rowStep;
    const [a, b] = shared ? [dom.min, dom.max] : ext(g.values, bws[gi]);
    const sx = linearScale(a, b, x0, x1);
    const grid = linspace(a, b, GRID_POINTS);
    const dens = kde(g.values, grid, bws[gi]);
    const top1 = Math.max(...dens) || 1;
    const pts = grid.map((x, k) => `${num(sx(x))} ${num(yb - (dens[k] / top1) * amp)}`);
    const isAcc = g.name === accentName;
    doc.open(`data-ridge="${gi}"`);
    doc.path(`M${num(x0)} ${num(yb)} L${pts.join(" L")} L${num(x1)} ${num(yb)} Z`, gal ? pal.paper : pal.ink100, {
      mark: { mark: "area", series: g.name, index: gi },
    });
    doc.path(`M${pts.join(" L")}`, "none", {
      stroke: isAcc ? pal.role.accent : gal ? pal.ink700 : pal.ink900,
      strokeWidthMm: lineMm,
      mark: { mark: "line", series: g.name, index: gi },
    });
    doc.close();
    const ly = gal ? mid(yb - 0.6, labelPt) : yb - Math.min(0.32 * rowStep, 2.0);
    doc.text(x0 - 1.2, ly, g.name, { sizePt: labelPt, fill: pal.ink700, anchor: "end" });
  });

  if (!gal && shared) {
    const sx = linearScale(dom.min, dom.max, x0, x1);
    axisX(ctx, dom, sx, base, x0, x1, { colour: pal.ink400, widthMm: SPINE_MM, sizePt: TYPE_PT.datum.tick, face: "data" });
    if (ctx.unit) {
      doc.text(x1, base + ptToMm(TYPE_PT.datum.tick) + 1.2 + ptToMm(TYPE_PT.datum.axisTitle) + 0.6, ctx.unit, {
        sizePt: pt(ctx, TYPE_PT.datum.axisTitle),
        fill: pal.ink700,
        anchor: "end",
      });
    }
  } else if (!gal) {
    doc.open('data-axis="x"');
    doc.line(x0, base, x1, base, pal.ink400, Math.max(HAIR_MM, SPINE_MM));
    doc.close();
  }
}
