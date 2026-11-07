/**
 * W-06 Bump: peringkat dari waktu ke waktu (S40). Acuan pustakachart `v45_bump`
 * (PC:732-747, kelas CB1): garis + penanda per seri, sumbu peringkat terbalik
 * (1 = teratas), nama seri di kedua ujung dengan warna seri.
 *
 * Data `series`: `categories` = periode (ISO tanggal/bulan diformat Indonesia),
 * `series[].values` = peringkat (bilangan bulat >= 1, unik per periode) atau nilai
 * mentah. Nilai mentah diubah ke peringkat per periode (nilai terbesar = 1, seri
 * memutus seri) dan dilaporkan REPORT `W-06.rank`. `null` = celah garis.
 *
 * Warna: seri beraksen (medan `accent.series`, alias, atau `series[].accent`) memakai
 * peran aksen; seri lain konteks. Gaya `datum` tanpa aksen eksplisit memakai urutan
 * CAT_SERIES acuan (ink900, signal, verd, ink400, alert; seri ke-6 dst. ink200).
 * Gaya `gallery` = panel Gambar 8.4: konteks ink200, titik bulat, tanpa nama seri.
 * Petunjuk galeri `rankAxisInverted` (IP-41c, bawaan true = peringkat 1 di atas; false =
 * peringkat 1 di bawah).
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { figureLabel } from "../core/guards";
import { kindBool } from "../core/read";
import { linearScale } from "../core/scale";
import { num, textWidthMm } from "../core/svg";
import { accentHint, assertAccentCount, closeFrame, finiteOrNull, mid, openFrame, requireShape } from "./common";
import { categoryLabels } from "./time";
import { categoryAxisPlan, drawCategoryLabel } from "../core/labelfit";

const CODE = "W-06";

/** Peringkat per seri per periode (null = celah); `derived` bila diubah dari nilai mentah. */
export function bumpRanks(values: ReadonlyArray<ReadonlyArray<number | null>>, periods: number): { ranks: (number | null)[][]; derived: boolean } {
  let isRank = true;
  for (let j = 0; j < periods && isRank; j++) {
    const seen = new Set<number>();
    for (const row of values) {
      const v = row[j];
      if (v === null) continue;
      if (!Number.isInteger(v) || v < 1 || seen.has(v)) {
        isRank = false;
        break;
      }
      seen.add(v);
    }
  }
  if (isRank) return { ranks: values.map((r) => [...r]), derived: false };
  const ranks: (number | null)[][] = values.map((r) => r.map(() => null));
  for (let j = 0; j < periods; j++) {
    const present = values
      .map((r, i) => ({ v: r[j], i }))
      .filter((x): x is { v: number; i: number } => x.v !== null)
      .sort((a, b) => b.v - a.v || a.i - b.i);
    present.forEach((x, k) => {
      ranks[x.i][j] = k + 1;
    });
  }
  return { ranks, derived: true };
}

/** Path polyline bercelah (null memutus garis). */
function polyline(xs: readonly number[], ys: ReadonlyArray<number | null>): string {
  const parts: string[] = [];
  let pen = false;
  ys.forEach((y, j) => {
    if (y === null) {
      pen = false;
      return;
    }
    parts.push(`${pen ? "L" : "M"}${num(xs[j])} ${num(y)}`);
    pen = true;
  });
  return parts.join(" ");
}

export function renderBump(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const fid = figureLabel(spec);
  const data = requireShape(spec, CODE, "series");
  const n = data.categories?.length ?? 0;
  if (n < 2 || !Array.isArray(data.series) || data.series.length === 0) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — W-06: minimal 2 periode dan 1 seri`, { code: CODE });
  }
  data.series.forEach((s, i) => {
    if (typeof s?.name !== "string" || !Array.isArray(s.values) || s.values.length !== n) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — W-06: seri ${i} tanpa nama atau jumlah nilai != ${n} periode`, { code: CODE, index: i });
    }
  });
  const f = openFrame(spec, canvas, tpl, CODE);
  const { doc, pal, W, gallery } = f;

  const raw = data.series.map((s) => s.values.map(finiteOrNull));
  const { ranks, derived } = bumpRanks(raw, n);
  if (derived) f.issues.push({ checkId: "W-06.rank", status: "REPORT", detail: "nilai seri bukan peringkat unik; diubah ke peringkat per periode (nilai terbesar = 1)" });
  const maxRank = Math.max(1, ...ranks.flat().filter((r): r is number => r !== null));

  const hint = accentHint(spec);
  const accented = new Set<number>();
  data.series.forEach((s, i) => {
    if (s.accent === true || s.name === hint.series || s.name === hint.point) accented.add(i);
  });
  assertAccentCount(spec, CODE, accented.size, f.maxAccent, "seri");

  const cat = [pal.ink900, pal.role.accent, pal.verd, pal.ink400, pal.alert];
  const colour = (i: number): string => {
    if (accented.has(i)) return pal.role.accent;
    if (gallery) return accented.size ? pal.role.contextBackground : pal.role.contextMain;
    if (accented.size) return pal.role.contextMain;
    return i < cat.length ? cat[i] : pal.ink200;
  };

  const LBL = gallery ? 6.0 : 6.2;
  const TICK = gallery ? 6.0 : 6.5;
  const labels = categoryLabels(data.categories);
  const rankW = textWidthMm(String(maxRank), TICK, gallery ? "struct" : "data");
  const nameW = gallery ? 0 : Math.max(...data.series.map((s) => textWidthMm(s.name, LBL)));
  const top = 2.6;
  const axisX = rankW + 1.6;
  const lastHalf = textWidthMm(labels[n - 1], TICK) / 2;
  const x0 = axisX + (gallery ? 3.0 : nameW + 3.0);
  const x1 = W - (gallery ? Math.max(1.4, lastHalf) : nameW + 2.4);
  // FIG-02a P1-4: label periode bertingkat (hanya saat fit, bila tidak muat di jarak periode).
  const lp = categoryAxisPlan(labels, (x1 - x0) / Math.max(1, n - 1), { pt: TICK }, { maxRotateBandMm: Math.max(10, f.bottom * 0.4) });
  const base = f.bottom - (gallery ? 5.0 : 5.4) - (lp?.extraBandMm ?? 0);
  const sx = (j: number): number => x0 + (j * (x1 - x0)) / (n - 1);
  const inverted = kindBool({ spec, tpl, code: CODE }, "rankAxisInverted", true);
  const sy = inverted ? linearScale(1, Math.max(2, maxRank), top + 1.2, base - 2.4) : linearScale(1, Math.max(2, maxRank), base - 2.4, top + 1.2);
  const xs = labels.map((_, j) => sx(j));

  // Sumbu: peringkat (y, terbalik) dan periode (x).
  doc.open('data-axis="y"');
  if (gallery) doc.line(axisX, top, axisX, base, pal.role.textAxis, 0.25);
  for (let r = 1; r <= maxRank; r++) {
    doc.text(axisX - (gallery ? 1.0 : 0.6), mid(sy(r), TICK), String(r), {
      sizePt: TICK,
      fill: pal.ink400,
      anchor: "end",
      face: gallery ? "struct" : "data",
    });
  }
  doc.close();
  doc.open('data-axis="x"');
  doc.line(axisX, base, W - 0.5, base, pal.role.textAxis, 0.25);
  labels.forEach((s, j) =>
    lp ? drawCategoryLabel(doc, lp, j, xs[j], base + 3.4, { sizePt: TICK, fill: pal.ink400, anchor: "middle" }) : doc.text(xs[j], base + 3.4, s, { sizePt: TICK, fill: pal.ink400, anchor: "middle" }),
  );
  doc.close();

  // Konteks dulu, aksen terakhir (di atas).
  const order = data.series.map((_, i) => i).sort((a, b) => Number(accented.has(a)) - Number(accented.has(b)) || a - b);
  const lw = gallery ? 0.45 : 0.53;
  const r = gallery ? 0.75 : 0.7;
  for (const i of order) {
    const s = data.series[i];
    const c = colour(i);
    const ys = ranks[i].map((rk) => (rk === null ? null : sy(rk)));
    doc.path(polyline(xs, ys), "none", { stroke: c, strokeWidthMm: lw, mark: { mark: "line", series: s.name, index: i } });
    ys.forEach((y, j) => {
      if (y !== null) doc.circle(xs[j], y, r, c, { mark: { mark: "point", series: s.name, index: i }, attrs: ` data-period="${j}"` });
    });
    if (!gallery) {
      const first = ys.findIndex((y) => y !== null);
      const last = ys.length - 1 - [...ys].reverse().findIndex((y) => y !== null);
      if (first >= 0) {
        doc.text(xs[first] - 1.4, mid(ys[first] as number, LBL), s.name, { sizePt: LBL, fill: c, anchor: "end" });
        doc.text(xs[last] + 1.4, mid(ys[last] as number, LBL), s.name, { sizePt: LBL, fill: c });
      }
    }
  }
  return closeFrame(f, spec);
}
