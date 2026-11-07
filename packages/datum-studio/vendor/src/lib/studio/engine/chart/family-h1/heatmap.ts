/**
 * engine/chart/family-h1 — H-03 heatmap (S35; acuan PC v73_heatmap, PARSIAL).
 *
 * Kisi baris x kolom (baris 0 di atas, seperti `imshow`), sel tanpa celah. Warna = ramp
 * berparameter berkelas (lihat ramp.ts; KT-08 putih ke signal, ramp abu-abu acuan untuk
 * paritas F-008). Jumlah kelas k = 5 dikurangi sampai keluarga warna figur (tinta + kelas
 * + aksen; gaya gallery selalu mencadangkan keluarga aksen untuk panel komposit lain)
 * <= P7-17 `chart.maxColors`. Domain warna: [0, 1] bila semua nilai di dalamnya
 * (skor ternormalisasi acuan), selain itu [min(0, min), maks].
 *
 * Gaya `datum`: label baris/kolom Plex Sans Condensed 6,5 pt ink400 tanpa tanda tick,
 * angka sel Plex Mono 6,0 pt (kertas di atas sel bernilai > 0,55 rentang, selain itu
 * ink700; acuan PC:1094-1097) bila muat, skala warna di kanan (`scaleShown`). Gaya
 * `gallery` (panel H-03 Gambar 8.2): tanpa angka sel, tanda tick keluar, label kolom
 * dijarangkan ke <= 5 interval (00, 06, 12, 18, 23 untuk 24 jam) ditambah kolom akhir.
 * Label yang tidak muat dijarangkan di kedua gaya.
 *
 * Aksen sel: `accent.point` = indeks datar (baris x kolom + kolom) atau "baris|kolom";
 * digambar sebagai tepi signal 0,35 mm pada sel itu.
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { fmt } from "../../bind";
import { figureFootMm, apparatusMarker, figureApparatus, noteLine } from "../core/apparatus";
import { defect } from "../core/guards";
import { colorFamilyExact } from "../core/palette";
import { kindStrList } from "../core/read";
import { decimalsFor } from "../core/scale";
import { SvgDoc, ptToMm, textWidthMm } from "../core/svg";
import { axisLook } from "./axes";
import { type H1Prep, accentTarget, finishH1, kindBool } from "./common";
import { MAX_RAMP_CLASSES, classBounds, classOf, drawScale, heatmapRampStops, rampClasses, scaleBandMm } from "./ramp";

const CELL_PT = 6.0;
const LABEL_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 24, 25, 30, 50, 100, 200, 500, 1000];

interface Matrix {
  rows: string[];
  cols: string[];
  values: number[][];
}

function requireMatrix(spec: StudioChartV1, prep: H1Prep): Matrix {
  const { fid, code } = prep;
  const d = spec.data;
  if (!d) throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code}: data wajib`, { code });
  if (d.shape !== "matrix") {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code} membutuhkan data "matrix", diterima "${d.shape}"`, { code, shape: d.shape });
  }
  const { rows, cols, values } = d;
  if (!Array.isArray(rows) || !Array.isArray(cols) || !Array.isArray(values) || rows.length === 0 || cols.length === 0) {
    throw defect("DC-G1", `${fid} — heatmap tanpa baris atau kolom`, { code });
  }
  if (values.length !== rows.length) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — matrix.values ${values.length} baris, rows ${rows.length}`, { code });
  }
  values.forEach((row, r) => {
    if (!Array.isArray(row) || row.length !== cols.length) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — matrix.values[${r}] tidak berisi ${cols.length} kolom`, { code, row: r });
    }
    row.forEach((v, c) => {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw defect("DC-G1", `${fid} — sel [${r}][${c}] bukan bilangan hingga`, { code, row: r, col: c });
      }
    });
  });
  return { rows: rows.map(String), cols: cols.map(String), values };
}

/** Sel beraksen (indeks datar) atau -1. */
function accentCell(spec: StudioChartV1, m: Matrix, prep: H1Prep): number {
  const t = accentTarget(spec);
  if (!t) return -1;
  const nc = m.cols.length;
  if (typeof t.point === "number" && t.point >= 0 && t.point < m.rows.length * nc) return t.point;
  if (typeof t.point === "string") {
    const [r, c] = t.point.split("|");
    const ri = m.rows.indexOf(r);
    const ci = c === undefined ? -1 : m.cols.indexOf(c);
    if (ri >= 0 && ci >= 0) return ri * nc + ci;
  }
  prep.issues.push({ checkId: "ACCENT_IGNORED", status: "REPORT", detail: `${prep.code}: aksen heatmap memakai accent.point "baris|kolom" atau indeks sel` });
  return -1;
}

/** Langkah penjarangan label: muat di sel, dan (gallery) <= 5 interval. */
function labelStep(n: number, labelMm: number, cellMm: number, maxIntervals?: number): number {
  const ok = (s: number): boolean =>
    s * cellMm * 0.92 >= labelMm && (maxIntervals === undefined || Math.ceil((n - 1) / s) <= maxIntervals);
  // Pembagi n didahulukan (24 jam -> 6: 00, 06, 12, 18), lalu langkah mana pun.
  return LABEL_STEPS.find((s) => n % s === 0 && ok(s)) ?? LABEL_STEPS.find(ok) ?? n;
}

function shownIndices(n: number, step: number, labelMm: number, cellMm: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(i);
  const last = n - 1;
  const prev = out[out.length - 1];
  if (prev !== last && (last - prev) * cellMm >= labelMm) out.push(last);
  return out;
}

export function renderHeatmap(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate, prep: H1Prep): SvgResult {
  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const { pal, style } = prep;
  const m = requireMatrix(spec, prep);
  const nr = m.rows.length;
  const nc = m.cols.length;
  const flat = m.values.flat();
  const vmin = Math.min(...flat);
  const vmax = Math.max(...flat);
  const lo = vmin >= 0 ? 0 : vmin;
  let hi = vmin >= 0 && vmax <= 1 ? 1 : vmax;
  if (!(hi > lo)) hi = lo + 1;
  const dec = spec.dec ?? (flat.every((v) => Number.isInteger(v)) ? 0 : 2);
  const acc = accentCell(spec, m, prep);

  // Kelas warna: turunkan k sampai keluarga warna muat plafon P7-17.
  const stops = heatmapRampStops(spec, tpl, pal);
  let k = MAX_RAMP_CLASSES;
  let colors = rampClasses(stops, k, pal);
  for (; k > 2; k--) {
    colors = rampClasses(stops, k, pal);
    // Hitungan keluarga TANPA pengelompokan rona (colorFamilyExact): k sama dengan keputusan
    // D-82 (galeri k = 4); lint inti kini menghitung rona kertas->X sebagai keluarga X (IP-25).
    const fam = new Set(["ink", ...colors.map((c) => colorFamilyExact(c, pal))]);
    // Galeri: satu keluarga dicadangkan untuk aksen panel tetangga di komposit yang sama.
    if (acc >= 0 || style === "gallery") fam.add(colorFamilyExact(pal.role.accent, pal));
    if (fam.size <= prep.maxColors) break;
  }
  if (k === 2) colors = rampClasses(stops, k, pal);

  const look = axisLook(style);
  const pt = style === "gallery" ? 6.4 : 6.5;
  const labelH = ptToMm(pt);
  const showScale = kindBool(spec, tpl, "H-03", "scaleShown", true);
  const bounds = classBounds(lo, hi, k, Math.max(dec, Math.min(3, decimalsFor((hi - lo) / k))));
  const rightBand = showScale ? scaleBandMm(bounds, spec.unit) : 1.0;
  // Taksiran lebar glif rerata (inti) kurang untuk huruf lebar (K, m, W): cadangan 20 %.
  const rowW = 1.2 * Math.max(...m.rows.map((r) => textWidthMm(r, pt)));
  const x0 = rowW + look.gap + look.tickLen + 0.4;
  const x1 = W - rightBand;
  const y0 = 1.6;
  const y1 = H - prep.footBand - (look.tickLen + look.gap + labelH + 0.6);
  if (!(x1 - x0 > 4) || !(y1 - y0 > 4)) {
    throw defect("DATUM-33", `${prep.fid} — bidang heatmap ${(x1 - x0).toFixed(1)} x ${(y1 - y0).toFixed(1)} mm terlalu kecil; tambah heightMm`, {
      code: prep.code,
    });
  }
  const cw = (x1 - x0) / nc;
  const ch = (y1 - y0) / nr;

  const doc = new SvgDoc(W, H, `data-chart="${prep.code}" data-style="${style}"`, prep.minFontPt);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(pal.paper);

  const cell = (r: number, c: number, stroke?: string): void => {
    const v = m.values[r][c];
    doc.rect(x0 + c * cw, y0 + r * ch, cw, ch, colors[classOf(v, lo, hi, k)], {
      mark: { mark: "cell", series: m.rows[r], index: c },
      ...(stroke ? { stroke, strokeWidthMm: 0.35 } : {}),
      attrs: ` data-value="${fmt(v, dec)}"`,
    });
  };
  for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) if (r * nc + c !== acc) cell(r, c);
  if (acc >= 0) cell(Math.floor(acc / nc), acc % nc, pal.role.accent);

  if (style === "datum") {
    for (let r = 0; r < nr; r++) {
      for (let c = 0; c < nc; c++) {
        const v = m.values[r][c];
        const s = fmt(v, dec);
        if (textWidthMm(s, CELL_PT, "data") > cw - 0.6 || ptToMm(CELL_PT) > ch * 0.8) continue;
        doc.text(x0 + (c + 0.5) * cw, y0 + (r + 0.5) * ch + ptToMm(CELL_PT) * 0.35, s, {
          face: "data",
          sizePt: CELL_PT,
          fill: (v - lo) / (hi - lo) > 0.55 ? pal.paper : pal.ink700,
          anchor: "middle",
          attrs: ' data-label="value"',
        });
      }
    }
  }

  const tick = look.spineColor(pal);
  const colW = 1.2 * Math.max(...m.cols.map((c) => textWidthMm(c, pt)));
  // Petunjuk galeri `colTicks` (IP-41c): kolom berlabel tercetak; tanpa petunjuk = penjarangan.
  const colTicks = kindStrList({ spec, tpl, code: "H-03" }, "colTicks");
  let cols: number[];
  if (colTicks === undefined) cols = shownIndices(nc, labelStep(nc, colW, cw, style === "gallery" ? 5 : undefined), colW, cw);
  else {
    cols = colTicks.map((c) => m.cols.indexOf(c)).filter((i) => i >= 0);
    const miss = colTicks.filter((c) => !m.cols.includes(c));
    if (miss.length) prep.issues.push({ checkId: "H-03.colTicks", status: "REPORT", detail: `kolom tak dikenal diabaikan: ${miss.join(", ")}` });
  }
  doc.open('data-axis="x"');
  for (const c of cols) {
    const x = x0 + (c + 0.5) * cw;
    if (look.tickLen > 0) doc.line(x, y1, x, y1 + look.tickLen, tick, 0.2);
    doc.text(x, y1 + look.tickLen + look.gap + labelH * 0.75, m.cols[c], { sizePt: pt, fill: pal.ink400, anchor: "middle" });
  }
  doc.close();
  const rows = shownIndices(nr, labelStep(nr, labelH * 1.1, ch), labelH * 1.1, ch);
  doc.open('data-axis="y"');
  for (const r of rows) {
    const y = y0 + (r + 0.5) * ch;
    if (look.tickLen > 0) doc.line(x0 - look.tickLen, y, x0, y, tick, 0.2);
    doc.text(x0 - look.tickLen - look.gap, y + labelH * 0.35, m.rows[r], { sizePt: pt, fill: pal.ink400, anchor: "end" });
  }
  doc.close();

  if (showScale) drawScale(doc, x1 + 2.0, y0, y1, colors, bounds, pal, spec.unit);
  if (spec.note) noteLine(doc, spec.note, W, H - figureFootMm(spec) - 1.4, pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, pal, H);
  return finishH1({ svg: doc.toString(), widthMm: W, heightMm: H }, prep);
}
