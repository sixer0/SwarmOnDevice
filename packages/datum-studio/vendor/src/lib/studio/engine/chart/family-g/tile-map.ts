/**
 * engine/chart/family-g — G-01 tile map (S43). Acuan: pustakachart `v84_tilemap`
 * (PC:1155-1172, PARSIAL, kelas CB2: jumlah petak = jumlah wilayah + lint).
 *
 * Satu petak sama besar per wilayah pada grid baris/kolom data (lihat `provinces.ts`
 * untuk grid tetap 38 provinsi). Warna dari nilai pada SATU ramp tinta berkelas:
 * <= 4 nilai berbeda = satu kelas per nilai; lebih = 4 kelas interval sama. Ramp PC
 * kontinu (paper -> ink200 -> ink400 -> ink900) dikuantisasi agar keluarga warna tetap
 * <= 5 (lint 25, K-32): 1 kelas ink400; 2 ink200/ink700; 3 ink200/ink400/ink900;
 * 4 ink200/ink400/ink700/ink900. Petak tanpa nilai = ink100 ("tanpa data").
 *
 * Parameter registri: `standardAbbrev` (label di luar kode petak Studio atau label ganda
 * dilaporkan REPORT, tidak ditolak: benchmark G-01 mencetak KALT x3, SULT x2, MALU x2),
 * `singleRamp` (false = kelas teratas diberi warna aksen, gaya panel galeri; lint 26
 * melaporkan bila lebih dari satu petak), `valueInTile` (nilai Plex Mono di pojok kanan
 * bawah petak bila muat; datum tanpa nilai tergambar -> baris KUNCI kelas).
 * Aksen: `accent.point`/`accent.group` (atau alias) = kode petak, cadangan label.
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { fmt } from "../../bind";
import { KEY_ROW_HEIGHT_MM, keyRow } from "../core/apparatus";
import { kindKey } from "../core/palette";
import { escAttr, num, ptToMm, textWidthMm } from "../core/svg";
import {
  TYPE_PT,
  accentHint,
  assertAccentCount,
  beginChart,
  endChart,
  fitPt,
  gridOf,
  hintMiss,
  inkOn,
  kindBool,
  mid,
  ran,
  report,
  requireTiles,
  tileLabel,
} from "./common";
import { PROVINCE_BY_CODE } from "./provinces";

/** Rasio celah petak PC (petak 1,0 pada pitch 1,08). */
const PC_GAP_RATIO = 0.08 / 1.08;

export function renderTileMap(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const ctx = beginChart("G-01", spec, canvas, tpl);
  const { pal, doc, style } = ctx;
  const { tiles } = requireTiles(ctx);
  const T = TYPE_PT[style];

  const standardAbbrev = kindBool(ctx, "standardAbbrev", true);
  const singleRamp = kindBool(ctx, "singleRamp", true);
  const valueInTile = kindBool(ctx, "valueInTile", true);
  const labels = tiles.map(tileLabel);

  // Singkatan baku: laporkan, jangan tolak (render apa adanya).
  if (standardAbbrev) {
    const key = kindKey("G-01", "standardAbbrev");
    ran(ctx, key);
    const foreign = [...new Set(labels.filter((l) => !PROVINCE_BY_CODE.has(l)))];
    if (foreign.length) report(ctx, key, `label di luar kode petak Studio (provinces.ts): ${foreign.join(", ")}`);
    const counts = new Map<string, number>();
    for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    const dup = [...counts].filter(([, n]) => n > 1).map(([l, n]) => `${l} x${n}`);
    if (dup.length) report(ctx, key, `label petak ganda: ${dup.join(", ")}`);
  }
  ran(ctx, "G-01.tileCount");

  // Kelas warna.
  const vals = tiles.map((t) => t.value).filter((v): v is number => v !== undefined);
  const distinct = [...new Set(vals)].sort((a, b) => a - b);
  const nClass = Math.min(4, distinct.length);
  const lo = distinct.length ? distinct[0] : 0;
  const hi = distinct.length ? distinct[distinct.length - 1] : 0;
  const classOf = (v: number): number => {
    if (distinct.length <= 4) return distinct.indexOf(v);
    return Math.min(3, Math.floor(((v - lo) / (hi - lo)) * 4));
  };
  const RAMPS: Record<number, string[]> = {
    1: [pal.ink400],
    2: [pal.ink200, pal.ink700],
    3: [pal.ink200, pal.ink400, pal.ink900],
    4: [pal.ink200, pal.ink400, pal.ink700, pal.ink900],
  };
  const ramp = nClass ? [...RAMPS[nClass]] : [];
  if (!singleRamp && nClass >= 2) {
    ramp[nClass - 1] = pal.role.accent;
    report(ctx, kindKey("G-01", "singleRamp"), "singleRamp=false: kelas teratas memakai warna aksen");
  }

  // Aksen petak tunggal dari petunjuk spec.
  const hint = accentHint(spec);
  let accentIdx: number[] = [];
  if (hint) {
    const target = hint.point ?? hint.group;
    if (typeof target === "number") accentIdx = target < tiles.length ? [target] : [];
    else if (target !== undefined) {
      const byCode = tiles.findIndex((t) => t.code === target);
      accentIdx = byCode >= 0 ? [byCode] : labels.flatMap((l, i) => (l === target ? [i] : []));
    }
    if (!accentIdx.length) hintMiss(ctx, JSON.stringify(target));
    assertAccentCount(ctx, accentIdx.map((i) => tiles[i].code));
  }

  // Area dan pita KUNCI (datum, nilai tidak tergambar di petak).
  const top = 0.8;
  let keyBand = 0;
  const area = { x: 0.5, y: top, w: ctx.W - 1, h: ctx.bottom - top - 0.8 };
  const probe = gridOf(tiles, area, true);
  const labPt = Math.max(ctx.minFontPt, T.label);
  const valPt = Math.max(ctx.minFontPt, T.value);
  const roomForValue = probe.cellW * (1 - PC_GAP_RATIO) >= ptToMm(labPt) + ptToMm(valPt) + 1.2;
  const showValues = valueInTile && vals.length > 0 && roomForValue;
  if (valueInTile && vals.length > 0 && !roomForValue) {
    report(ctx, kindKey("G-01", "valueInTile"), `petak ${probe.cellW.toFixed(1)} mm terlalu kecil untuk label dan nilai; nilai tidak dicetak`);
  }
  if (style === "datum" && !showValues && nClass > 0) keyBand = KEY_ROW_HEIGHT_MM + 1.2;
  const g = keyBand ? gridOf(tiles, { ...area, h: area.h - keyBand }, true) : probe;
  const gap = style === "datum" ? g.cellW * PC_GAP_RATIO : Math.min(0.2, g.cellW * 0.04);
  const side = g.cellW - gap;

  let overflow = 0;
  let squeezed = 0;
  tiles.forEach((t, i) => {
    const { x, y } = g.cell(t.row, t.col);
    const accent = accentIdx.includes(i);
    const fill = accent ? pal.role.accent : t.value === undefined ? pal.ink100 : ramp[classOf(t.value)];
    const ink = inkOn(pal, fill);
    doc.rect(x, y, side, side, fill, { mark: { mark: "tile", series: "nilai", index: i }, attrs: ` data-code="${escAttr(t.code)}"` });
    const lab = labels[i];
    const room = side * 0.92;
    const f = fitPt(ctx, lab, room, T.label);
    // Label yang tetap terlalu lebar pada lantai huruf dipadatkan horizontal (tinggi huruf
    // tetap >= lantai pt fisik); rasio < 0,7 dibiarkan meluap dan dilaporkan.
    const squeeze = !f.fits && room / textWidthMm(lab, f.size) >= 0.7;
    if (squeeze) squeezed++;
    else if (!f.fits) overflow++;
    const fitAttr = squeeze ? ` textLength="${num(room)}" lengthAdjust="spacingAndGlyphs"` : "";
    const cx = x + side / 2;
    if (showValues && t.value !== undefined) {
      // PC: label di tengah, nilai rata kanan di dasar petak.
      doc.text(cx, mid(y + side * 0.42, f.size), lab, { sizePt: f.size, fill: ink, anchor: "middle", attrs: fitAttr });
      doc.text(x + side - 0.5, y + side - 0.6, fmt(t.value, ctx.dec), {
        face: "data",
        sizePt: valPt,
        fill: ink === pal.paper ? pal.paper : pal.ink700,
        anchor: "end",
        attrs: ' data-label="value"',
      });
    } else {
      doc.text(cx, mid(y + side / 2, f.size), lab, { sizePt: f.size, fill: ink, anchor: "middle", attrs: fitAttr });
    }
  });
  if (squeezed) report(ctx, "G-01.labelFit", `${squeezed} label dipadatkan horizontal (textLength) agar muat petak pada lantai ${ctx.minFontPt} pt`);
  if (overflow) report(ctx, "G-01.labelFit", `${overflow} label melebihi lebar petak pada lantai ${ctx.minFontPt} pt`);

  if (keyBand) {
    const items = ramp.map((color, k) => ({ color, label: classLabel(k, distinct, lo, hi, ctx.dec) }));
    if (tiles.some((t) => t.value === undefined)) items.push({ color: pal.ink100, label: "tanpa data" });
    const y = ctx.bottom - 1.0;
    const used = keyRow(doc, 0.5, y, items, pal, Math.max(ctx.minFontPt, 6.2));
    if (used > ctx.W) report(ctx, "G-01.key", `baris KUNCI ${used.toFixed(1)} mm melebihi lebar ${ctx.W} mm`);
  }
  return endChart(ctx);
}

/** Label kelas KUNCI: nilai tunggal, atau rentang interval sama (en dash). */
function classLabel(k: number, distinct: readonly number[], lo: number, hi: number, dec: number): string {
  if (distinct.length <= 4) return fmt(distinct[k], dec);
  const step = (hi - lo) / 4;
  return `${fmt(lo + step * k, dec)}–${fmt(k === 3 ? hi : lo + step * (k + 1), dec)}`;
}
