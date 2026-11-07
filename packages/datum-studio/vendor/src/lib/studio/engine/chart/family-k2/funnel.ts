/**
 * K-10 Funnel — batang menyempit per tahap (Tabel 8.3). Acuan pustakachart v37_funnel
 * (PC:655, CB1).
 *
 * Parameter: `stageValues` (default true) nilai per tahap; `conversionPercent` (default
 * true) persen konversi terhadap tahap sebelumnya ("53 %", tanpa tahap pertama).
 * Tahap yang membesar dari tahap sebelumnya -> REPORT `K-10` (corong harus menyempit).
 *
 * Gaya `gallery` (panel Gambar 8.3): batang mendatar ditengahkan pada satu poros, lebar ~
 * nilai/maks; label tahap rata kanan di kolom kiri (Plex Sans Condensed), nilai Plex Mono di
 * kolom kanan; batang konteks ink400, aksen signal hanya dari data/petunjuk.
 * Gaya `datum` (PC:655-668): trapesium bertumpuk, sisi atas ~ nilai tahap, sisi bawah ~
 * nilai tahap berikut (tahap terakhir 0,85 x), isian ink900, teks "<tahap>  <nilai>" Plex
 * Mono kertas di tengah (di luar kanan bila tidak muat); tanpa aksen eksplisit, tahap
 * terakhir beraksen (PC:661 `SIGNAL if i == len-1`).
 */
import type { ChartRenderer } from "../../../contract";
import { fmt, withUnit } from "../../bind";
import { defect } from "../core/guards";
import { num, textWidthMm } from "../core/svg";
import { beginChart, categoricalPoints, endChart, inkOn, kindBool, mid, pt, report } from "./common";

export const renderFunnel: ChartRenderer = (spec, canvas, tpl) => {
  const ctx = beginChart("K-10", spec, canvas, tpl);
  const { doc, pal, dec, x0, x1, y0, y1 } = ctx;
  const T = { label: pt(ctx, 6.4), value: pt(ctx, 6.4) };
  let pts = categoricalPoints(ctx);
  const maxV = Math.max(...pts.map((p) => p.value));
  if (!(maxV > 0)) throw defect("DC-G1", `${ctx.fid} — funnel tanpa nilai positif`, { code: ctx.code });
  const rising = pts.flatMap((p, i) => (i > 0 && p.value > pts[i - 1].value ? [p.label] : []));
  if (rising.length) report(ctx, "K-10", `tahap membesar dari tahap sebelumnya: ${rising.join(", ")}; corong seharusnya menyempit`);
  if (ctx.style === "datum" && !pts.some((p) => p.accent) && ctx.maxAccent >= 1) {
    pts = pts.map((p, i) => ({ ...p, accent: i === pts.length - 1 }));
  }

  const stageValues = kindBool(ctx, "stageValues", true);
  const conversion = kindBool(ctx, "conversionPercent", true);
  const vals = pts.map((p) => fmt(p.value, dec));
  const conv = pts.map((p, i) => (i > 0 && pts[i - 1].value > 0 ? withUnit(fmt((p.value / pts[i - 1].value) * 100, 0), "%") : ""));
  const series = ctx.unit || "tahap";
  const n = pts.length;
  const step = (y1 - y0) / n;
  const convW = conversion ? Math.max(0, ...conv.map((c) => textWidthMm(c, T.value, "data"))) : 0;

  if (ctx.style === "gallery") {
    const labelW = Math.max(...pts.map((p) => textWidthMm(p.label, T.label)));
    const valW = stageValues ? Math.max(...vals.map((v) => textWidthMm(v, T.value, "data"))) : 0;
    const right = (stageValues ? valW + 2.0 : 0) + (conversion ? convW + 2.0 : 0);
    const a0 = x0 + labelW + 2.0;
    const a1 = Math.max(a0 + 1, x1 - right);
    const cx = (a0 + a1) / 2;
    const bh = step * 0.84;
    pts.forEach((p, i) => {
      const yc = y0 + step * (i + 0.5);
      const w = (p.value / maxV) * (a1 - a0);
      doc.text(a0 - 2.0, mid(yc, T.label), p.label, { sizePt: T.label, fill: pal.ink700, anchor: "end" });
      doc.rect(cx - w / 2, yc - bh / 2, w, bh, p.accent ? pal.role.accent : pal.role.contextMain, {
        mark: { mark: "bar", series, index: i },
      });
      let tx = a1 + 2.0;
      if (stageValues) {
        doc.text(tx, mid(yc, T.value), vals[i], { face: "data", sizePt: T.value, fill: pal.ink900, attrs: ' data-label="value"' });
        tx += valW + 2.0;
      }
      if (conversion && conv[i]) doc.text(tx, mid(yc, T.value), conv[i], { face: "data", sizePt: T.value, fill: pal.ink400 });
    });
    return endChart(ctx);
  }

  const a1 = x1 - (conversion ? convW + 1.5 : 0);
  const aw = a1 - x0;
  const cx = (x0 + a1) / 2;
  const th = step * 0.9;
  pts.forEach((p, i) => {
    const top = y0 + step * i;
    const wt = (p.value / maxV) * aw;
    const wb = i + 1 < n ? (pts[i + 1].value / maxV) * aw : wt * 0.85;
    const d = `M${num(cx - wt / 2)} ${num(top)}L${num(cx + wt / 2)} ${num(top)}L${num(cx + wb / 2)} ${num(top + th)}L${num(cx - wb / 2)} ${num(top + th)}Z`;
    const fill = p.accent ? pal.role.accent : pal.ink900;
    doc.path(d, fill, { mark: { mark: "bar", series, index: i } });
    const s = stageValues ? `${p.label}  ${vals[i]}` : p.label;
    const yc = top + th / 2;
    const inside = textWidthMm(s, T.value, "data") <= Math.min(wt, wb) - 1.5;
    doc.text(inside ? cx : cx + Math.max(wt, wb) / 2 + 1.0, mid(yc, T.value), s, {
      face: "data",
      sizePt: T.value,
      fill: inside ? inkOn(ctx, fill) : pal.ink900,
      anchor: inside ? "middle" : "start",
      attrs: stageValues ? ' data-label="value"' : "",
    });
    if (conversion && conv[i]) doc.text(x1, mid(top, T.value), conv[i], { face: "data", sizePt: T.value, fill: pal.ink400, anchor: "end" });
  });
  return endChart(ctx);
};
