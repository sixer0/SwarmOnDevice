/**
 * P-04 Lollipop — garis tipis dengan titik di ujung (banyak kategori, ruang terbatas).
 *
 * Acuan: pustakachart `v05_lollipop` (PC:238, kelas CB1): urut nilai menurun, tangkai
 * ink200 lw 1,2 pt dari 0, titik ink900 ms 6 pt, titik teratas signal, gridline x ink200,
 * domain 0..maks x 1,15. Galeri (Gambar 8.1 panel P-04): tangkai ink200 tipis, titik
 * konteks utama ink400, aksen dari data, sumbu x bertick di bawah.
 *
 * Parameter: `sort` (valueDesc default; byDifference pada satu seri = valueDesc),
 * `stemWeight` (thin 0,3 mm | regular 0,6 mm; datum tanpa set eksplisit = 1,2 pt acuan),
 * `zeroBaseline` (struktural; false -> domain rapi tak bermula nol + REPORT CH-01),
 * petunjuk galeri `axis` (IP-41c: domain tercetak [min, maks], kedua gaya).
 * Aksen: `accent: true` per titik atau petunjuk aksen; gaya datum tanpa aksen -> titik teratas.
 */
import { requireCategorical } from "../core/guards";
import { kindKey, paramEnum } from "../core/palette";
import { ptToMm } from "../core/svg";
import {
  type P1Ctx,
  HAIR_MM,
  SORT,
  SPINE_MM,
  TYPE_PT,
  accentHint,
  assertAccentCount,
  axisX,
  gridX,
  hintMiss,
  hintedDomain,
  kindEnum,
  kindParam,
  labelGutter,
  linearScale,
  mid,
  pt,
  report,
  resolveTarget,
  stableSort,
  tickWidth,
  valueDomain,
  zeroBaseline,
} from "./common";

export function renderLollipop(ctx: P1Ctx): void {
  const { pal, doc, W, style } = ctx;
  let pts = requireCategorical(ctx.spec, "P-04", ctx.maxAccent);

  const hint = accentHint(ctx.spec);
  if (hint) {
    const i = resolveTarget(hint.target, pts.map((p) => p.label));
    if (i >= 0) pts = pts.map((p, k) => (k === i ? { ...p, accent: true } : p));
    else hintMiss(ctx, JSON.stringify(hint));
  }
  assertAccentCount(ctx, new Set(pts.flatMap((p, i) => (p.accent ? [`${i}`] : []))));

  const sort = paramEnum(ctx.spec, ctx.tpl, kindKey("P-04", "sort"), SORT, "valueDesc");
  if (sort !== "natural") pts = stableSort(pts, (p) => p.value, sort === "valueAsc" ? 1 : -1);
  if (style === "datum" && !pts.some((p) => p.accent) && ctx.maxAccent >= 1) {
    pts = pts.map((p, i) => ({ ...p, accent: i === 0 }));
  }

  const zero = zeroBaseline(ctx, "zeroBaseline");
  const values = pts.map((p) => p.value);
  const dom = hintedDomain(ctx, values, zero, () => valueDomain(style === "datum" && zero ? [...values, Math.max(...values) * 1.15] : values, zero));
  if (!zero && dom.min > 0) report(ctx, "CH-01", `domain lollipop ${dom.min}..${dom.max} tidak bermula nol (zeroBaseline=false)`);
  const stemFrom = dom.min <= 0 && dom.max >= 0 ? 0 : dom.min;

  // Datum tanpa set eksplisit: lw 1,2 pt acuan; selain itu thin 0,3 mm | regular 0,6 mm.
  const stemMm =
    kindParam(ctx, "stemWeight") === undefined
      ? 1.2 * (25.4 / 72)
      : kindEnum(ctx, "stemWeight", ["thin", "regular"] as const, "thin") === "regular"
        ? 0.6
        : 0.3;

  const T = style === "gallery" ? TYPE_PT.gallery : TYPE_PT.datum;
  const labelPt = pt(ctx, T.label);
  const x0 = labelGutter(ctx, pts.map((p) => p.label), labelPt);
  const x1 = W - Math.max(1.0, tickWidth(dom, T.tick, style === "gallery" ? "struct" : "data") / 2 + 0.3);
  const top = style === "gallery" ? 0.8 : 1.6;
  const unitBand = style === "datum" && ctx.unit ? ptToMm(TYPE_PT.datum.title) + 1.6 : 0;
  const base = ctx.bottom - 4.6 - unitBand;
  const sx = linearScale(dom.min, dom.max, x0, x1);
  const step = (base - top) / pts.length;
  const r = style === "gallery" ? Math.min(0.85, step * 0.32) : Math.min(3 * (25.4 / 72), step * 0.4);
  const series = ctx.unit || "nilai";

  if (style === "datum") gridX(ctx, dom, sx, top, base, pal.ink200);
  pts.forEach((p, i) => {
    const yc = top + step * (i + 0.5);
    doc.text(x0 - 1.2, mid(yc, labelPt), p.label, { sizePt: labelPt, fill: style === "gallery" ? pal.ink400 : pal.ink700, anchor: "end" });
    doc.line(sx(stemFrom), yc, sx(p.value), yc, pal.role.contextBackground, stemMm, { mark: { mark: "segment", series, index: i } });
  });
  pts.forEach((p, i) => {
    const yc = top + step * (i + 0.5);
    const fill = p.accent ? pal.role.accent : style === "gallery" ? pal.role.contextMain : pal.ink900;
    doc.circle(sx(p.value), yc, r, fill, { mark: { mark: "point", series, index: i } });
  });

  if (style === "gallery") {
    axisX(ctx, dom, sx, base, x0, x1, { colour: pal.role.textAxis, widthMm: HAIR_MM, sizePt: T.tick, face: "struct" });
  } else {
    axisX(ctx, dom, sx, base, x0, x1, { colour: pal.ink400, widthMm: SPINE_MM, sizePt: T.tick, face: "data" });
    doc.open('data-axis="y"');
    doc.line(x0, top, x0, base, pal.ink400, SPINE_MM);
    doc.close();
    if (ctx.unit) doc.text((x0 + x1) / 2, ctx.bottom - 1.0, ctx.unit, { sizePt: pt(ctx, TYPE_PT.datum.title), fill: pal.ink700, anchor: "middle" });
  }
}
