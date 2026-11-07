/**
 * P-05 Dot plot — satu atau beberapa titik per kategori; sumbu tidak perlu mulai nol.
 *
 * Acuan: pustakachart `v06_dotplot` (PC:251, kelas CB2 PARSIAL): grup di sumbu x, garis
 * rentang ink400 0,7 pt, titik ulangan ms 2,6 pt dengan jitter RNG, penanda rerata "_",
 * label "maks N" mono, gridline y. Penyimpangan disengaja: jitter deterministik (rasio
 * emas, tanpa RNG); titik ink700 dan rerata ink900 (acuan mewarnai tiap grup dengan
 * CAT_SERIES dan rerata signal = lebih dari satu aksen, melanggar DATUM-26); grup
 * beraksen = titik signal.
 * Galeri (Gambar 8.1 panel P-05): grup di sumbu y berurutan atas ke bawah, titik per peran
 * (nilai ke-1 ink200, ke-2 ink700, dst.), tanpa garis penghubung, gridline x pada tick.
 *
 * Parameter: `gridlines` (struktural, default true; false -> tanpa gridline + REPORT);
 * petunjuk galeri (IP-41c) `axis` (domain tercetak [min, maks]) dan `pointRoles` (nama
 * peran per nilai grup: peran terakhir ink900, sebelumnya ink200 lalu ink400, atribut
 * `data-role`; jumlah nilai grup != jumlah peran -> REPORT, peran dipakai menurut indeks).
 */
import { fmt } from "../../bind";
import { kindStrList } from "../core/read";
import { escAttr, ptToMm, textWidthMm } from "../core/svg";
import {
  type P1Ctx,
  GRID_MM,
  HAIR_MM,
  SERIES_ACCENT_ATTR,
  SPINE_MM,
  TYPE_PT,
  accentHint,
  assertAccentCount,
  axisX,
  axisY,
  gridX,
  gridY,
  hintMiss,
  hintedDomain,
  kindBool,
  labelGutter,
  linearScale,
  mid,
  pt,
  report,
  requireDistribution,
  resolveTarget,
  tickWidth,
  valueDomain,
} from "./common";
import { type ValueLabelIn, categoryAxisPlan, drawCategoryLabel, placeValueLabels } from "../core/labelfit";

/** Jitter deterministik dalam [-0,5, 0,5) (barisan rasio emas). */
function jitter(i: number): number {
  const g = (i * 0.6180339887498949) % 1;
  return g - 0.5;
}

export function renderDotPlot(ctx: P1Ctx): void {
  const { pal, doc, W, style } = ctx;
  const groups = requireDistribution(ctx);
  const names = groups.map((g) => g.name);
  let accentGroup = -1;
  const hint = accentHint(ctx.spec);
  if (hint) {
    accentGroup = resolveTarget(hint.target ?? hint.series, names);
    if (accentGroup < 0) hintMiss(ctx, JSON.stringify(hint));
  }
  assertAccentCount(ctx, new Set(accentGroup >= 0 ? [names[accentGroup]] : []));

  const grid = kindBool(ctx, "gridlines", true, true);
  if (!grid) report(ctx, "P-05.gridlines", "gridline dimatikan; titik kehilangan acuan (Tabel 8.1: hindari tanpa gridline)");
  const all = groups.flatMap((g) => g.values);
  // Dot plot tidak wajib bermula nol (Tabel 8.1: "sumbu tidak perlu mulai nol").
  const dom = hintedDomain(ctx, all, false, () => valueDomain(all, false));
  const roles = kindStrList(ctx, "pointRoles");
  if (roles && groups.some((g) => g.values.length !== roles.length)) {
    report(ctx, "P-05.pointRoles", `${roles.length} peran (${roles.join(", ")}) tidak sama dengan jumlah nilai setiap grup; peran dipakai menurut indeks nilai`);
  }
  /** Warna peran berurut: terakhir ink900 (keadaan sekarang), sebelumnya ink200 lalu ink400. */
  const roleFill = (vi: number): string => (roles && vi === roles.length - 1 ? pal.ink900 : [pal.ink200, pal.ink400][Math.min(vi, 1)]);
  const roleAttr = (vi: number): string => (roles && roles[vi] !== undefined ? ` data-role="${escAttr(roles[vi])}"` : "");

  if (style === "gallery") {
    const T = TYPE_PT.gallery;
    const labelPt = pt(ctx, T.label);
    // IMPL-W10: label berujung di x0 - 1,6 mm -> anchorGap 1,6 (ruang tepi kiri 0,4 mm).
    const x0 = labelGutter(ctx, names, labelPt, 0.3, 1.6);
    const x1 = W - Math.max(1.0, tickWidth(dom, T.tick, "struct") / 2 + 0.3);
    const top = 0.8;
    const base = ctx.bottom - 4.6;
    const sx = linearScale(dom.min, dom.max, x0, x1);
    const step = (base - top) / groups.length;
    const r = Math.min(0.75, step * 0.3);
    const galleryRoles = [pal.ink200, pal.ink700, pal.ink400, pal.ink900];
    if (grid) gridX(ctx, dom, sx, top, base, pal.ink100);
    groups.forEach((g, gi) => {
      const yc = top + step * (gi + 0.5);
      doc.text(x0 - 1.6, mid(yc, labelPt), g.name, { sizePt: labelPt, fill: pal.ink400, anchor: "end" });
      g.values.forEach((v, vi) => {
        const fill =
          gi === accentGroup ? pal.role.accent : roles ? roleFill(vi) : g.values.length === 1 ? pal.ink700 : galleryRoles[vi % galleryRoles.length];
        // Subjek = grup (`data-index` grup), pengamatan di `data-obs` (konvensi lint 26, IP-25).
        doc.circle(sx(v), yc, r, fill, {
          mark: { mark: "point", series: g.name, index: gi },
          attrs: ` data-obs="${vi}"${roleAttr(vi)}${gi === accentGroup ? SERIES_ACCENT_ATTR : ""}`,
        });
      });
    });
    axisX(ctx, dom, sx, base, x0, x1, { colour: pal.role.textAxis, widthMm: HAIR_MM, sizePt: T.tick, face: "struct" });
    return;
  }

  // Gaya datum (resep v06_dotplot, vertikal).
  const T = TYPE_PT.datum;
  const top = 6.0;
  const x0 = 0.5 + tickWidth(dom, T.tick, "data") + 1.6;
  const x1 = W - 0.5;
  // FIG-02a P1-4: label grup bertingkat (hanya saat fit, bila tidak muat di slot).
  const lp = categoryAxisPlan(groups.map((g) => g.name), (x1 - x0) / groups.length, { pt: pt(ctx, T.label) }, { maxRotateBandMm: Math.max(10, ctx.bottom * 0.4) });
  const base = ctx.bottom - 5.2 - (lp?.extraBandMm ?? 0);
  const sy = linearScale(dom.min, dom.max, base, top);
  if (grid) gridY(ctx, dom, sy, x0, x1, pal.ink200);
  const step = (x1 - x0) / groups.length;
  const spread = step * 0.12;
  const r = 1.3 * (25.4 / 72);
  // FIG-02c: label "maks" bertetangga tanpa tumpuk (hanya saat fit; null = jalur lama).
  const valuePt = pt(ctx, T.value);
  const vPlan = (() => {
    const capH = ptToMm(valuePt);
    const lift = capH * 1.25;
    const obstacles: Array<[number, number, number, number]> = [];
    const items: ValueLabelIn[] = [];
    let kk = 0;
    groups.forEach((g, gi) => {
      const gx = x0 + step * (gi + 0.5);
      const lo = Math.min(...g.values);
      const hi = Math.max(...g.values);
      const mean = g.values.reduce((a, b) => a + b, 0) / g.values.length;
      obstacles.push([gx - 0.2, sy(hi), gx + 0.2, sy(lo)], [gx - 2.1, sy(mean) - 0.3, gx + 2.1, sy(mean) + 0.3]);
      g.values.forEach((v) => {
        const px = gx + jitter(++kk) * spread;
        obstacles.push([px - r, sy(v) - r, px + r, sy(v) + r]);
      });
      const maks = `maks ${fmt(hi, ctx.dec)}`;
      const right = gx + spread + 1.0 + textWidthMm(maks, valuePt, "data") <= W - 0.3;
      const yb = sy(hi) - 0.8;
      const R = { x: gx + spread + 1.0, anchor: "start" as const };
      const L = { x: gx - spread - 1.0, anchor: "end" as const };
      const [a, b] = right ? [R, L] : [L, R];
      items.push({
        text: maks,
        cands: [
          { ...a, y: yb },
          { ...b, y: yb },
          { x: gx, y: sy(hi) - r - 0.7, anchor: "middle" },
          { ...a, y: yb - lift },
          { ...b, y: yb - lift },
          { x: gx, y: sy(hi) - r - 0.7 - lift, anchor: "middle" },
        ],
      });
    });
    if (ctx.unit) {
      const ub = top - ptToMm(T.title) - 0.4;
      obstacles.push([x0 - 0.2, ub - ptToMm(pt(ctx, T.title)) * 0.9, x0 + textWidthMm(ctx.unit, pt(ctx, T.title)) + 0.2, ub + ptToMm(pt(ctx, T.title)) * 0.15]);
    }

    return placeValueLabels(items, { pt: valuePt, face: "data" }, [x0 + 0.2, 0.3, W - 0.3, base - 0.2], obstacles, "label maks");
  })();
  let k = 0;
  groups.forEach((g, gi) => {
    const gx = x0 + step * (gi + 0.5);
    const lo = Math.min(...g.values);
    const hi = Math.max(...g.values);
    const mean = g.values.reduce((a, b) => a + b, 0) / g.values.length;
    doc.line(gx, sy(lo), gx, sy(hi), pal.ink400, Math.max(GRID_MM, 0.7 * (25.4 / 72)), { mark: { mark: "whisker", series: g.name, index: gi } });
    g.values.forEach((v, vi) => {
      doc.circle(gx + jitter(++k) * spread, sy(v), r, gi === accentGroup ? pal.role.accent : roles ? roleFill(vi) : pal.ink700, {
        mark: { mark: "point", series: g.name, index: gi },
        attrs: ` data-obs="${vi}"${roleAttr(vi)}${gi === accentGroup ? SERIES_ACCENT_ATTR : ""}`,
      });
    });
    doc.line(gx - 2.1, sy(mean), gx + 2.1, sy(mean), pal.ink900, 1.4 * (25.4 / 72), { mark: { mark: "segment", series: `${g.name} rerata`, index: gi } });
    const maks = `maks ${fmt(hi, ctx.dec)}`;
    if (vPlan) {
      const at = vPlan[gi];
      if (at) doc.text(at.x, at.y, maks, { face: "data", sizePt: valuePt, fill: pal.ink700, anchor: at.anchor, attrs: ' data-label="value"' });
    } else {
      const right = gx + spread + 1.0 + textWidthMm(maks, pt(ctx, T.value), "data") <= W - 0.3;
      doc.text(right ? gx + spread + 1.0 : gx - spread - 1.0, sy(hi) - 0.8, maks, {
        face: "data",
        sizePt: pt(ctx, T.value),
        fill: pal.ink700,
        anchor: right ? "start" : "end",
        attrs: ' data-label="value"',
      });
    }

    if (lp) drawCategoryLabel(doc, lp, gi, gx, base + 3.6, { sizePt: pt(ctx, T.label), fill: pal.ink700, anchor: "middle" });
    else doc.text(gx, base + 3.6, g.name, { sizePt: pt(ctx, T.label), fill: pal.ink700, anchor: "middle" });
  });
  axisY(ctx, dom, sy, x0, top, base, { colour: pal.ink400, widthMm: SPINE_MM, sizePt: T.tick, face: "data" });
  doc.open('data-axis="x"');
  doc.line(x0, base, x1, base, pal.ink400, SPINE_MM);
  doc.close();
  if (ctx.unit) doc.text(x0, top - ptToMm(T.title) - 0.4, ctx.unit, { sizePt: pt(ctx, T.title), fill: pal.ink700 });
}
