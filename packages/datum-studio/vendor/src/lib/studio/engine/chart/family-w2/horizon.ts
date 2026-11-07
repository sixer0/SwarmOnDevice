/**
 * W-09 Horizon: area dilipat menjadi pita (S40). Tanpa acuan Python (kelas CC: lint +
 * snapshot diri). Cek khusus research/06 §6.5: pita 2-3, legenda pita wajib.
 *
 * Data `series`: satu baris per seri (sensor), `categories` = waktu. Langkah deterministik:
 * 1. `subtractBaseline` (bawaan true): kurangi rerata nilai non-null seri;
 * 2. tinggi pita bh = maks |nilai| semua seri / `bands` (skala bersama);
 * 3. pita k (0..bands-1) = clamp(v - k*bh, 0, bh) dipetakan ke tinggi baris; titik potong
 *    pada tiap batas pita (0, +-k*bh) disisipkan sehingga lipatan tepat, bukan potong-sudut;
 * 4. nilai negatif: `fold` true = dicerminkan ke atas dari garis dasar; false = menggantung
 *    dari atas baris (offset). Warna positif ramp tinta, negatif rona peran limitExceeded.
 * `bands`: angka dipakai (bulat, 1..4); rentang registri [a, b] -> a; di luar 2..3 ->
 * REPORT. `bandLegend` (bawaan true): baris KUNCI rentang tiap pita. `null` = celah.
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { fmt, withUnit } from "../../bind";
import { tintHex } from "../../tokens/color";
import { type KeyItem, keyRow } from "../core/apparatus";
import { figureLabel } from "../core/guards";
import { keyLabelText } from "../core/lang";
import { chartParam, kindKey, paramBool } from "../core/palette";
import { num, textWidthMm } from "../core/svg";
import { accentHint, assertAccentCount, closeFrame, finiteOrNull, mid, openFrame, requireShape } from "./common";
import { categoryLabels } from "./time";

const CODE = "W-09";

/** Deret (x, v) yang disisipi titik potong pada setiap batas `levels`; null memecah run. */
export function refineRuns(xs: readonly number[], vs: ReadonlyArray<number | null>, levels: readonly number[]): Array<Array<[number, number]>> {
  const runs: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  for (let j = 0; j < vs.length; j++) {
    const v = vs[j];
    if (v === null) {
      if (cur.length) runs.push(cur);
      cur = [];
      continue;
    }
    const prev = j > 0 ? vs[j - 1] : null;
    if (cur.length && prev !== null) {
      const cuts = levels
        .filter((L) => (prev - L) * (v - L) < 0)
        .map((L) => (L - prev) / (v - prev))
        .sort((a, b) => a - b);
      for (const t of cuts) cur.push([xs[j - 1] + t * (xs[j] - xs[j - 1]), prev + t * (v - prev)]);
    }
    cur.push([xs[j], v]);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

export function resolveBands(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Array.isArray(raw) && typeof raw[0] === "number" ? raw[0] : 2;
  return Math.min(4, Math.max(1, Math.round(Number.isFinite(n) ? n : 2)));
}

export function renderHorizon(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const fid = figureLabel(spec);
  const data = requireShape(spec, CODE, "series");
  const n = data.categories?.length ?? 0;
  if (n < 2 || !Array.isArray(data.series) || data.series.length === 0) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — W-09: minimal 2 titik waktu dan 1 seri`, { code: CODE });
  }
  data.series.forEach((s, i) => {
    if (typeof s?.name !== "string" || !Array.isArray(s.values) || s.values.length !== n) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — W-09: seri ${i} tanpa nama atau jumlah nilai != ${n}`, { code: CODE, index: i });
    }
  });
  const f = openFrame(spec, canvas, tpl, CODE);
  const { doc, pal, W, gallery } = f;

  const bandsRaw = chartParam(spec, tpl, kindKey(CODE, "bands"));
  const bands = resolveBands(bandsRaw);
  if (bands < 2 || bands > 3) f.issues.push({ checkId: kindKey(CODE, "bands"), status: "REPORT", detail: `${bands} pita di luar 2..3` });
  const fold = paramBool(spec, tpl, kindKey(CODE, "fold"), true);
  const subtract = paramBool(spec, tpl, kindKey(CODE, "subtractBaseline"), true);
  const legend = paramBool(spec, tpl, kindKey(CODE, "bandLegend"), true);
  if (!legend) f.issues.push({ checkId: kindKey(CODE, "bandLegend"), status: "REPORT", detail: "horizon tanpa legenda pita (Tabel 8.4: hindari)" });

  const series = data.series.map((s) => {
    const vals = s.values.map(finiteOrNull);
    const present = vals.filter((v): v is number => v !== null);
    const baseline = subtract && present.length ? present.reduce((a, b) => a + b, 0) / present.length : 0;
    return { name: s.name, accent: s.accent === true, vals: vals.map((v) => (v === null ? null : v - baseline)) };
  });
  const maxAbs = Math.max(0, ...series.flatMap((s) => s.vals.filter((v): v is number => v !== null).map(Math.abs))) || 1;
  const bh = maxAbs / bands;

  const hint = accentHint(spec);
  const accented = new Set<number>();
  series.forEach((s, i) => {
    if (s.accent || s.name === hint.series || s.name === hint.point) accented.add(i);
  });
  assertAccentCount(spec, CODE, accented.size, f.maxAccent, "seri");

  const posRamp = bands === 1 ? [pal.ink400] : bands === 2 ? [pal.ink400, pal.ink700] : bands === 3 ? [pal.ink200, pal.ink400, pal.ink700] : [pal.ink200, pal.ink400, pal.ink700, pal.ink900];
  const neg = pal.role.limitExceeded;
  const negRamp = Array.from({ length: bands }, (_, k) => (k === bands - 1 ? neg : tintHex(pal.paper, neg, Math.round(25 + (75 * k) / Math.max(1, bands - 1)))));

  const LBL = gallery ? 6.0 : 6.2;
  const TICK = gallery ? 6.0 : 6.5;
  const labelW = Math.max(...series.map((s) => textWidthMm(s.name, LBL)));
  const x0 = Math.min(labelW + 2.2, W * 0.3);
  const x1 = W - 0.5;
  const xs = data.categories.map((_, j) => x0 + (j * (x1 - x0)) / (n - 1));

  // Legenda pita: satu baris bila muat, dua baris (positif / negatif) bila tidak.
  const dec = spec.dec ?? (Number.isInteger(bh) ? 0 : 1);
  const span = (k: number, sign: "+" | "-"): string => {
    const lo = k * bh;
    const hi = (k + 1) * bh;
    const a = lo === 0 ? "0" : `${sign}${fmt(lo, dec)}`;
    return `${a} s/d ${withUnit(`${sign}${fmt(hi, dec)}`, spec.unit)}`;
  };
  const posItems: KeyItem[] = posRamp.map((c, k) => ({ label: span(k, "+"), color: c }));
  const negItems: KeyItem[] = negRamp.map((c, k) => ({ label: span(k, "-"), color: c }));
  const itemW = (items: KeyItem[]): number => textWidthMm(keyLabelText(), 6.2, "struct", 0.15) + 2.4 + items.reduce((a, it) => a + 2.0 + 1.0 + textWidthMm(it.label, 6.2) + 3.0, 0);
  const legendRows = !legend ? 0 : itemW([...posItems, ...negItems]) <= W ? 1 : 2;

  const showX = !gallery;
  const top = 1.0;
  const base = f.bottom - (showX ? 4.8 : 0.6) - legendRows * 4.4;
  const step = (base - top) / series.length;
  const rowH = step * 0.84;

  const levels = [0];
  for (let k = 1; k <= bands; k++) levels.push(k * bh, -k * bh);

  series.forEach((s, i) => {
    const rowBase = top + step * i + (step + rowH) / 2;
    const rowTop = rowBase - rowH;
    doc.text(x0 - 1.4, mid(rowBase - rowH / 2, LBL), s.name, {
      sizePt: LBL,
      fill: accented.has(i) ? pal.role.accent : pal.ink700,
      anchor: "end",
      bold: accented.has(i),
    });
    if (!gallery) doc.line(x0, rowBase, x1, rowBase, pal.ink200, 0.18, { attrs: ' data-grid="baseline"' });
    const runs = refineRuns(xs, s.vals, levels);
    for (let k = 0; k < bands; k++) {
      for (const sign of [1, -1] as const) {
        const hgt = (v: number): number => (Math.min(bh, Math.max(0, sign * v - k * bh)) / bh) * rowH;
        const parts: string[] = [];
        for (const run of runs) {
          if (!run.some(([, v]) => hgt(v) > 1e-9)) continue;
          const hang = sign < 0 && !fold;
          const y = (v: number): number => (hang ? rowTop + hgt(v) : rowBase - hgt(v));
          const edge = hang ? rowTop : rowBase;
          const pts = run.map(([x, v]) => `L${num(x)} ${num(y(v))}`).join(" ");
          parts.push(`M${num(run[0][0])} ${num(edge)} ${pts} L${num(run[run.length - 1][0])} ${num(edge)} Z`);
        }
        if (!parts.length) continue;
        doc.path(parts.join(" "), sign > 0 ? posRamp[k] : negRamp[k], {
          mark: { mark: "area", series: s.name, index: i },
          attrs: ` data-band="${sign > 0 ? "+" : "-"}${k + 1}"`,
        });
      }
    }
  });

  if (showX) {
    const labels = categoryLabels(data.categories);
    const maxW = Math.max(...labels.map((l) => textWidthMm(l, TICK))) + 2.0;
    const every = Math.max(1, Math.ceil((n * maxW) / Math.max(1, x1 - x0)));
    doc.open('data-axis="x"');
    doc.line(x0, base + 0.6, x1, base + 0.6, pal.role.textAxis, 0.25);
    labels.forEach((l, j) => {
      if (j % every === 0) doc.text(xs[j], base + 3.9, l, { sizePt: TICK, fill: pal.ink400, anchor: j === 0 ? "start" : "middle" });
    });
    doc.close();
  }
  if (legendRows) {
    const legStart = base + (showX ? 4.8 : 0.6);
    const rowsOfItems = legendRows === 1 ? [[...posItems, ...negItems]] : [posItems, negItems];
    rowsOfItems.forEach((items, r) => keyRow(doc, 0, legStart + 4.4 * (r + 1) - 1.0, items, pal, 6.2));
  }
  return closeFrame(f, spec);
}
