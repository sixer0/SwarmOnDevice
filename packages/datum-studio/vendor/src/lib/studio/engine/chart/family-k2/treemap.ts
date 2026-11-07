/**
 * K-09 Treemap — persegi bersarang, luas = nilai (Tabel 8.3). Acuan pustakachart
 * v32_treemap (PC:577, CB1; acuan memakai slice-dice satu tingkat).
 *
 * Grup dibaca dari `points[].sub` (CHART_DATA_CONSTRAINTS K-09); titik tanpa `sub` menjadi
 * grup sendiri. Tata letak deterministik dua tingkat:
 * - gaya `datum`: SQUARIFIED (Bruls, Huizing, van Wijk 2000) untuk grup lalu untuk butir di
 *   dalam grup; masukan diurut nilai menurun (seri diputus indeks data);
 * - gaya `gallery`: grup sebagai kolom (lebar ~ total grup) dan butir bertumpuk tegak dalam
 *   urutan data — susunan panel Gambar 8.3 (Perimeter | Forensik/OSINT | Lain/GovTech).
 *
 * Parameter: `labelsInside` (default true) = nama + nilai di pojok kiri atas kotak bila
 * muat (taksiran lebar glif), nilai saja bila hanya itu yang muat, selain itu dihilangkan
 * dan dilaporkan; false = tanpa label dalam, baris KUNCI grup di atas. `limitSmallBoxes`
 * (default true) = kotak < 2,5 % total dilaporkan (REPORT `K-09.limitSmallBoxes`).
 * Warna: titik beraksen = signal. Gaya `gallery`: grup bergiliran rona tinta ink400, ink200,
 * ink700, ink100. Gaya `datum` dengan label dalam (S79 E3, PC:597-602): setiap butir non-aksen
 * bergiliran ink900, ink700, ink400, ink200 menurut peringkat nilai menurun seluruh butir
 * (seri diputus indeks data), seperti `shades[i % 4]` acuan atas daftar terurut; tanpa label
 * dalam, warna tetap per grup (baris KUNCI grup membutuhkannya). Aksen grup (`accent.group`)
 * hanya diterima bila grup itu berisi satu butir (satu subjek, DATUM-26).
 */
import type { ChartRenderer } from "../../../contract";
import { fmt } from "../../bind";
import { keyRow, keyRowExtraMm } from "../core/apparatus";
import { defect } from "../core/guards";
import { ptToMm, textWidthMm } from "../core/svg";
import {
  KEY_BAND_MM,
  accentHint,
  assertAccentCount,
  beginChart,
  categoricalPoints,
  endChart,
  hintMiss,
  inkOn,
  kindBool,
  pt,
  report,
  sum,
} from "./common";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rasio aspek terburuk sebuah baris luas `row` yang diletakkan di sisi sepanjang `side`. */
function worst(row: readonly number[], side: number): number {
  const s = sum(row);
  const mx = Math.max(...row);
  const mn = Math.min(...row);
  return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
}

/**
 * Squarified treemap (Bruls dkk. 2000) atas `values` (> 0) dalam urutan yang diberikan.
 * Mengembalikan kotak sejajar indeks `values`. Deterministik.
 */
export function squarify(values: readonly number[], box: Box): Box[] {
  const out: Box[] = values.map(() => ({ x: box.x, y: box.y, w: 0, h: 0 }));
  const total = sum(values);
  if (!(total > 0) || box.w <= 0 || box.h <= 0) return out;
  const scale = (box.w * box.h) / total;
  const areas = values.map((v) => v * scale);
  const r = { ...box };
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(r.w, r.h);
    let j = i + 1;
    while (j < areas.length && worst(areas.slice(i, j + 1), side) <= worst(areas.slice(i, j), side)) j++;
    const row = areas.slice(i, j);
    const rs = sum(row);
    const last = j >= areas.length;
    if (r.w >= r.h) {
      // Baris tegak di sisi kiri.
      const t = last ? r.w : rs / r.h;
      let y = r.y;
      row.forEach((a, k) => {
        const h = k === row.length - 1 ? r.y + r.h - y : a / t;
        out[i + k] = { x: r.x, y, w: t, h };
        y += h;
      });
      r.x += t;
      r.w -= t;
    } else {
      // Baris mendatar di sisi atas.
      const t = last ? r.h : rs / r.w;
      let x = r.x;
      row.forEach((a, k) => {
        const w = k === row.length - 1 ? r.x + r.w - x : a / t;
        out[i + k] = { x, y: r.y, w, h: t };
        x += w;
      });
      r.y += t;
      r.h -= t;
    }
    i = j;
  }
  return out;
}

/** Slice-dice satu arah: `vertical` = bertumpuk tegak, selain itu berjajar mendatar. */
export function sliceBoxes(values: readonly number[], box: Box, vertical: boolean): Box[] {
  const total = sum(values);
  let at = vertical ? box.y : box.x;
  return values.map((v) => {
    const f = total > 0 ? v / total : 0;
    const b = vertical ? { x: box.x, y: at, w: box.w, h: box.h * f } : { x: at, y: box.y, w: box.w * f, h: box.h };
    at += vertical ? b.h : b.w;
    return b;
  });
}

/** Urutan indeks menurut nilai menurun, seri diputus indeks (stabil). */
function descOrder(values: readonly number[]): number[] {
  return values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v || a.i - b.i)
    .map((x) => x.i);
}

function layoutOrdered(values: readonly number[], box: Box, order: readonly number[]): Box[] {
  const boxes = squarify(order.map((i) => values[i]), box);
  const out: Box[] = new Array<Box>(values.length);
  order.forEach((i, k) => (out[i] = boxes[k]));
  return out;
}

export const renderTreemap: ChartRenderer = (spec, canvas, tpl) => {
  const ctx = beginChart("K-09", spec, canvas, tpl);
  const { doc, pal } = ctx;
  const T = { label: pt(ctx, ctx.style === "gallery" ? 6.4 : 6.2) };
  let pts = categoricalPoints(ctx);
  const total = sum(pts.map((p) => p.value));
  if (!(total > 0)) throw defect("DC-G1", `${ctx.fid} — treemap tanpa nilai positif`, { code: ctx.code });

  // Grup dari `sub` (urutan kemunculan pertama); tanpa sub = grup sendiri.
  const groupKeys: string[] = [];
  const groupNames: string[] = [];
  const memberOf = pts.map((p, i) => {
    const key = p.sub !== undefined && p.sub !== "" ? `g:${p.sub}` : `p:${i}`;
    let g = groupKeys.indexOf(key);
    if (g < 0) {
      g = groupKeys.push(key) - 1;
      groupNames.push(p.sub !== undefined && p.sub !== "" ? p.sub : p.label);
    }
    return g;
  });
  const members = groupKeys.map((_, g) => pts.flatMap((_p, i) => (memberOf[i] === g ? [i] : [])));

  const hint = accentHint(spec);
  if (hint?.group !== undefined) {
    const g = groupNames.indexOf(hint.group);
    if (g < 0) hintMiss(ctx, `grup ${JSON.stringify(hint.group)}`);
    else if (members[g].length !== 1) {
      report(ctx, "ACCENT_HINT", `aksen grup "${hint.group}" berisi ${members[g].length} butir (> 1 subjek); diabaikan, pakai accent.point`);
    } else {
      pts = pts.map((p, i) => (i === members[g][0] ? { ...p, accent: true } : p));
    }
  }
  assertAccentCount(ctx, new Set(pts.flatMap((p, i) => (p.accent ? [`titik ${i}`] : []))));

  // Warna grup: grup yang memuat butir non-aksen mendapat rona berikutnya (bergiliran).
  const shades = ctx.style === "gallery" ? [pal.ink400, pal.ink200, pal.ink700, pal.ink100] : [pal.ink900, pal.ink700, pal.ink400, pal.ink200];
  let s = 0;
  const groupColour = members.map((m) => (m.some((i) => !pts[i].accent) ? shades[s++ % shades.length] : pal.role.accent));
  const labelsInside = kindBool(ctx, "labelsInside", true);
  const itemShade = new Array<string>(pts.length);
  if (ctx.style === "datum" && labelsInside) {
    let k = 0;
    for (const i of descOrder(pts.map((p) => p.value))) if (!pts[i].accent) itemShade[i] = shades[k++ % shades.length];
  }
  const fillOf = (i: number): string => (pts[i].accent ? pal.role.accent : (itemShade[i] ?? groupColour[memberOf[i]]));

  const limitSmall = kindBool(ctx, "limitSmallBoxes", true);
  const { x0, x1, y1 } = ctx;
  let { y0 } = ctx;
  if (!labelsInside) {
    const keyItems = groupNames.map((n, g) => ({ label: n, color: groupColour[g] }));
    keyRow(doc, x0, y0 + 3.0, keyItems, pal, T.label);
    y0 += KEY_BAND_MM + keyRowExtraMm(x0, keyItems.map((k) => k.label), T.label);
  }
  const area: Box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const groupTotals = members.map((m) => sum(m.map((i) => pts[i].value)));

  const boxes: Box[] = new Array<Box>(pts.length);
  if (ctx.style === "gallery") {
    const cols = sliceBoxes(groupTotals, area, false);
    members.forEach((m, g) => {
      const b = sliceBoxes(m.map((i) => pts[i].value), cols[g], true);
      m.forEach((i, k) => (boxes[i] = b[k]));
    });
  } else {
    const gBoxes = layoutOrdered(groupTotals, area, descOrder(groupTotals));
    members.forEach((m, g) => {
      const vals = m.map((i) => pts[i].value);
      const b = layoutOrdered(vals, gBoxes[g], descOrder(vals));
      m.forEach((i, k) => (boxes[i] = b[k]));
    });
  }

  const gap = ctx.style === "gallery" ? 0.35 : 0.4;
  const pad = 1.0;
  const lineH = ptToMm(T.label) * 1.15;
  const nameFace = ctx.style === "gallery" ? "data" : "struct";
  const omitted: string[] = [];
  const small: string[] = [];
  pts.forEach((p, i) => {
    const b = boxes[i];
    if (!(b.w > gap && b.h > gap)) {
      omitted.push(p.label);
      return;
    }
    const fill = fillOf(i);
    doc.rect(b.x + gap / 2, b.y + gap / 2, b.w - gap, b.h - gap, fill, {
      mark: { mark: "tile", series: groupNames[memberOf[i]], index: i },
    });
    if (limitSmall && p.value / total < 0.025) small.push(p.label);
    if (!labelsInside) return;
    const ink = inkOn(ctx, fill);
    const val = fmt(p.value, ctx.dec);
    const room = b.w - gap - 2 * pad;
    const y = b.y + gap / 2 + pad + ptToMm(T.label) * 0.8;
    const nameFits = textWidthMm(p.label, T.label, nameFace) <= room && b.h - gap >= 2 * pad + lineH * 2;
    const valFits = textWidthMm(val, T.label, "data") <= room && b.h - gap >= 2 * pad + lineH;
    if (nameFits && valFits) {
      doc.text(b.x + gap / 2 + pad, y, p.label, { sizePt: T.label, fill: ink, face: nameFace });
      doc.text(b.x + gap / 2 + pad, y + lineH, val, { sizePt: T.label, fill: ink, face: "data", attrs: ' data-label="value"' });
    } else if (valFits) {
      doc.text(b.x + gap / 2 + pad, y, val, { sizePt: T.label, fill: ink, face: "data", attrs: ' data-label="value"' });
      omitted.push(p.label);
    } else {
      omitted.push(p.label);
    }
  });
  if (omitted.length) report(ctx, "K-09.labelsInside", `kotak tanpa label nama yang muat: ${omitted.join(", ")}`);
  if (small.length) report(ctx, "K-09.limitSmallBoxes", `kotak kecil (< 2,5 % total): ${small.join(", ")}`);
  return endChart(ctx);
};
