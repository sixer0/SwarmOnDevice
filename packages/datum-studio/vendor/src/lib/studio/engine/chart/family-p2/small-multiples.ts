/**
 * P-12 Small multiples — chart garis yang sama diulang per seri (Tabel 8.1).
 *
 * Acuan: pustakachart `v13_small_multiples` (PC:329-352, PENUH): kisi 2x3 tetap, maks 6
 * panel, satu garis per panel, judul panel di atas, tick mono 5,8 pt, ylim bersama.
 * - Data `series`: kategori = sumbu x bersama, satu panel per seri (1..6;
 *   CHART_DATA_CONSTRAINTS P-12). Lebih dari 6 = cacat by-construction.
 * - Kisi: `params.grid` [baris, kolom] bila ada; selain itu kolom = min(3, n), baris =
 *   ceil(n/3) (6 seri = 2x3 PC).
 * - `sharedScale` (default benar): satu domain untuk semua panel; salah = domain per panel.
 *   Domain memuat nol bila `chart.zeroBaseline` (P7-04) benar.
 * - Gaya `gallery` (Gambar 8.1): sumbu L hitam tanpa tick, nama panel di pojok kiri atas
 *   di dalam panel, garis peran contextMain, seri beraksen warna peran accent.
 * - Gaya `datum` (PC): judul panel di atas, tick mono, garis ink900 1 pt dengan titik
 *   ujung. Penyimpangan: titik ujung PC selalu SIGNAL (6 aksen); di sini warna garisnya
 *   dan tanpa `data-mark` agar aksen tetap satu subjek (P7-06).
 * Nilai null memutus garis.
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { fmt } from "../../bind";
import { defect, figureLabel } from "../core/guards";
import { paramBool } from "../core/palette";
import { type NiceDomain, decimalsFor, linearScale, niceDomain } from "../core/scale";
import { escAttr, num, ptToMm, textWidthMm } from "../core/svg";
import { accentHint, assertAccentCount, axisStroke, beginP2, finishP2, hint, kindBool, requireSeries, tickFont, xAxis, yAxis } from "./common";
import { fitActive, fitNote } from "../core/fit";
import { ellipsize, measure } from "../core/textfit";


const CODE = "P-12" as const;
const MAX_PANELS = 6;

function gridOf(spec: StudioChartV1, n: number): [number, number] {
  const g = hint(spec, "grid");
  if (g === undefined) return [Math.ceil(n / 3), Math.min(3, n)];
  if (
    !Array.isArray(g) ||
    g.length !== 2 ||
    !g.every((v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_PANELS) ||
    (g[0] as number) * (g[1] as number) < n
  ) {
    throw new StudioEngineError("SCHEMA_INVALID", `${figureLabel(spec)} — params.grid ${JSON.stringify(g)} bukan [baris, kolom] yang memuat ${n} panel`, {
      key: "grid",
    });
  }
  return [g[0] as number, g[1] as number];
}

export function renderSmallMultiples(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const ctx = beginP2(spec, canvas, tpl, CODE);
  const { pal, doc, style, W, H } = ctx;
  const sd = requireSeries(spec, CODE);
  const n = sd.series.length;
  if (n > MAX_PANELS) {
    throw defect("CHART_DATA_CONSTRAINTS.P-12", `${figureLabel(spec)} — ${n} seri > ${MAX_PANELS} panel; pisah gambarnya`, { code: CODE, series: n });
  }
  const [rows, cols] = gridOf(spec, n);
  const ah = accentHint(spec, CODE);
  const accent = sd.series.map((s) => s.accent || (ah.series !== undefined && ah.series === s.name));
  assertAccentCount(spec, CODE, accent.filter(Boolean).length, ctx.maxAccent, "seri");
  const shared = kindBool(spec, tpl, CODE, "sharedScale", true);
  const zero = paramBool(spec, tpl, "chart.zeroBaseline", true);
  const valuesOf = (vs: Array<number | null>): number[] => vs.filter((v): v is number => v !== null);
  const all = sd.series.flatMap((s) => valuesOf(s.values));
  if (all.length === 0) throw defect("DC-G1", `${figureLabel(spec)} — semua nilai kosong`, { code: CODE });
  const sharedDom = niceDomain(all, { zero, target: 3 });
  const domOf = (vs: Array<number | null>): NiceDomain => {
    const v = valuesOf(vs);
    return shared || v.length === 0 ? sharedDom : niceDomain(v, { zero, target: 3 });
  };

  const m = sd.categories.length;
  const TICK = ctx.pt(5.8);
  const TITLE = ctx.pt(style === "gallery" ? 6.4 : 6.8);
  const gx = style === "gallery" ? 2.6 : 3.0;
  const gy = style === "gallery" ? 2.6 : 2.0;
  const top = 0.6;
  const bottom = H - ctx.footBand - 0.4;
  const cellW = (W - gx * (cols - 1)) / cols;
  const cellH = (bottom - top - gy * (rows - 1)) / rows;
  const st = axisStroke(ctx);
  const tickEvery = Math.max(1, Math.ceil(m / 4));
  const xTicks = sd.categories.map((_, i) => i).filter((i) => i % tickEvery === 0);
  const tickW = (d: NiceDomain): number => Math.max(...d.ticks.map((t) => textWidthMm(fmt(t, decimalsFor(d.step)), TICK, "data")));

  sd.series.forEach((s, si) => {
    const r = Math.floor(si / cols);
    const c = si % cols;
    const cx = c * (cellW + gx);
    const cy = top + r * (cellH + gy);
    const dom = domOf(s.values);
    const tdec = decimalsFor(dom.step);
    // Kotak plot panel.
    const px0 = style === "gallery" ? cx + 0.2 : cx + tickW(dom) + 1.4;
    const px1 = cx + cellW - (style === "gallery" ? 0.4 : 1.0);
    const py0 = cy + (style === "gallery" ? 4.0 : ptToMm(TITLE) + 1.6);
    const py1 = cy + cellH - (style === "gallery" ? 0 : ptToMm(TICK) + 1.8);
    const sx = (i: number): number => (m === 1 ? (px0 + px1) / 2 : px0 + 0.8 + (i / (m - 1)) * (px1 - px0 - 1.6));
    const sy = linearScale(dom.min, dom.max, py1, py0 + 0.8);
    const color = accent[si] ? pal.role.accent : style === "gallery" ? pal.role.contextMain : pal.ink900;

    doc.open(`data-multiple="${si}" data-multiple-name="${escAttr(s.name)}"`);
    if (style === "gallery") {
      doc.open('data-axis="y"');
      doc.line(px0, cy + 0.4, px0, py1, st.color, st.width);
      doc.close();
      doc.open('data-axis="x"');
      doc.line(px0, py1, px1, py1, st.color, st.width);
      doc.close();
      doc.text(px0 + 0.8, cy + 2.8, s.name, { sizePt: TITLE, fill: pal.ink900 });
    } else {
      doc.text(cx + cellW / 2, cy + ptToMm(TITLE), s.name, { sizePt: TITLE, fill: pal.ink900, anchor: "middle" });
      yAxis(ctx, { at: px0, from: py0, to: py1, scale: sy, ticks: dom.ticks, label: (v) => fmt(v, tdec), sizePt: TICK });
      if (fitActive()) {
        // FIG-02a/02c (fit): tick kategori dipotong ke jarak antartick terukur dengan huruf tick
        // sebenarnya (mono datum); bila jarak terlalu sempit untuk ~3 huruf + elipsis, tick
        // dijarangkan; label dijaga di dalam sel panel; teks lengkap di <title>.
        const font = { pt: TICK, face: tickFont(ctx).face };
        const minW = measure("Abc…", TICK, font.face);
        const span = (px1 - px0 - 1.6) / Math.max(1, m - 1);
        let every = tickEvery;
        while (every < m - 1 && span * every - 0.8 < minW) every++;
        const fitTicks = sd.categories.map((_, i) => i).filter((i) => i % every === 0);
        const room = m === 1 ? cellW - 0.8 : span * every - 0.8;
        const cut = sd.categories.map((c) => ellipsize(c, Math.max(room, minW), font));
        if (every > tickEvery) fitNote("AXIS_TICK_THIN", `tick kategori panel ditampilkan tiap ${every} (label panjang; teks lengkap di <title>)`);
        const labelAt = (i: number): number => {
          const w = measure(cut[i].text, TICK, font.face);
          return Math.min(Math.max(sx(i), cx + w / 2 + 0.3), cx + cellW - w / 2 - 0.3);
        };
        xAxis(ctx, {
          at: py1,
          from: px0,
          to: px1,
          scale: sx,
          ticks: fitTicks,
          label: (i) => cut[i].text,
          labelTitle: (i) => (cut[i].truncated ? sd.categories[i] : undefined),
          labelAt,
          sizePt: TICK,
        });
      } else {
        xAxis(ctx, { at: py1, from: px0, to: px1, scale: sx, ticks: xTicks, label: (i) => sd.categories[i], sizePt: TICK });
      }
    }
    // Garis data (null memutus segmen).
    let d = "";
    let pen = false;
    let last = -1;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${num(sx(i))} ${num(sy(v))} `;
      pen = true;
      last = i;
    });
    if (d) {
      doc.path(d.trim(), "none", {
        stroke: color,
        strokeWidthMm: style === "gallery" ? 0.35 : ptToMm(1.0),
        mark: { mark: "line", series: s.name, index: si },
        attrs: ' stroke-linejoin="round" stroke-linecap="round"',
      });
    }
    if (style === "datum" && last >= 0) {
      doc.circle(sx(last), sy(s.values[last] as number), ptToMm(1.5), color, { attrs: ' data-end="1"' });
    }
    doc.close();
  });
  return finishP2(ctx);
}
