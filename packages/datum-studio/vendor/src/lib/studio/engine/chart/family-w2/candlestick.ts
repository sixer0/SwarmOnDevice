/**
 * W-10 Candlestick: buka, tutup, tertinggi, terendah (S40). Tanpa acuan Python (kelas CC).
 * Cek khusus research/06 §6.5: OHLC lengkap per titik (l <= min(o, c), h >= maks(o, c),
 * semua hingga; selain itu BY_CONSTRUCTION_FAILED `W-10.ohlc`); naik dan turun dibedakan
 * dengan posisi, bukan warna saja.
 *
 * Gaya `datum`: naik = badan berongga (kertas, garis ink900), turun = badan ink900 penuh,
 * sehingga terbaca tanpa warna (fotokopi). Gaya `gallery` = panel Gambar 8.4: naik ink700,
 * turun peran limitExceeded (alert), tanpa label sumbu x. Sumbu y tidak dipaksa nol
 * (harga, bukan besaran bertumpu nol): domain = rentang data +- 4 %, tick rapi di
 * dalamnya. `t` ISO diformat Indonesia (time.ts); label x dijarangkan agar tidak tumpang.
 * Aksen: `accent.point` = label `t` atau indeks titik.
 * Petunjuk galeri (IP-41c): `upColour` / `downColour` (tokenRef; datum: naik tetap berongga
 * bergaris warna naik) dan `axis` (domain harga tercetak [min, maks], tick rapi di dalamnya).
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { fmt } from "../../bind";
import { defect, figureLabel } from "../core/guards";
import { kindKey, resolveChartColor } from "../core/palette";
import { kindAxis } from "../core/read";
import { axisDomain, decimalsFor, linearScale, niceStep } from "../core/scale";
import { textWidthMm } from "../core/svg";
import { accentHint, assertAccentCount, closeFrame, mid, openFrame, requireShape } from "./common";
import { categoryLabels } from "./time";

const CODE = "W-10";

export function renderCandlestick(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const fid = figureLabel(spec);
  const data = requireShape(spec, CODE, "ohlc");
  if (!Array.isArray(data.points) || data.points.length === 0) throw defect("DC-G1", `${fid} — grafik tanpa data`, { code: CODE });
  data.points.forEach((p, i) => {
    const vals = [p?.o, p?.h, p?.l, p?.c];
    if (typeof p?.t !== "string" || vals.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
      throw defect("W-10.ohlc", `${fid} — titik ${i}: OHLC tidak lengkap (t, o, h, l, c wajib)`, { code: CODE, index: i });
    }
    if (p.l > Math.min(p.o, p.c) || p.h < Math.max(p.o, p.c)) {
      throw defect("W-10.ohlc", `${fid} — titik ${i} "${p.t}": l <= min(o, c) dan h >= maks(o, c) wajib`, { code: CODE, index: i });
    }
  });
  const pts = data.points;
  const n = pts.length;
  const f = openFrame(spec, canvas, tpl, CODE);
  const { doc, pal, W, gallery } = f;

  const hint = accentHint(spec);
  const accented = new Set<number>();
  pts.forEach((p, i) => {
    if (hint.point !== undefined && (hint.point === p.t || hint.point === i)) accented.add(i);
  });
  assertAccentCount(spec, CODE, accented.size, f.maxAccent, "titik");

  const lo = Math.min(...pts.map((p) => p.l));
  const hi = Math.max(...pts.map((p) => p.h));
  const pad = (hi - lo) * 0.04 || Math.abs(hi) * 0.04 || 1;
  const axis = kindAxis({ spec, tpl, code: CODE });
  const ad = axis ? axisDomain([lo, hi], { zero: false, target: 4 }, axis) : undefined;
  if (ad?.widened) f.issues.push({ checkId: "AXIS_DOMAIN", status: "REPORT", detail: ad.widened });
  const d0 = ad ? ad.dom.min : lo - pad;
  const d1 = ad ? ad.dom.max : hi + pad;
  const stepV = ad ? ad.dom.step : niceStep(d1 - d0, 4);
  const tdec = decimalsFor(stepV);
  const ticks: number[] = [];
  if (ad) ticks.push(...ad.dom.ticks);
  else for (let k = Math.ceil(d0 / stepV - 1e-9); k * stepV <= d1 + 1e-9; k++) ticks.push(Number((k * stepV).toFixed(tdec)));
  const upInk = resolveChartColor(spec, tpl, kindKey(CODE, "upColour"), gallery ? pal.ink700 : pal.ink900);
  const downInk = resolveChartColor(spec, tpl, kindKey(CODE, "downColour"), gallery ? pal.role.limitExceeded : pal.ink900);

  const TICK = gallery ? 6.0 : 6.5;
  const face = gallery ? "struct" : "data";
  const tickW = Math.max(...ticks.map((t) => textWidthMm(fmt(t, tdec), TICK, face)));
  const unitBand = !gallery && spec.unit ? 3.4 : 0;
  const top = 1.6 + unitBand;
  const showX = !gallery;
  const base = f.bottom - (showX ? 5.0 : 1.2);
  const x0 = tickW + 2.0;
  const x1 = W - 0.8;
  const sy = linearScale(d0, d1, base, top);
  const slot = (x1 - x0) / n;
  const bw = Math.min(slot * 0.6, 6);
  const cx = (i: number): number => x0 + slot * (i + 0.5);

  doc.open('data-axis="y"');
  doc.line(x0, top, x0, base, pal.role.textAxis, 0.25);
  for (const t of ticks) {
    doc.line(x0 - 0.8, sy(t), x0, sy(t), pal.role.textAxis, 0.25);
    doc.text(x0 - 1.2, mid(sy(t), TICK), fmt(t, tdec), { sizePt: TICK, fill: pal.ink400, anchor: "end", face });
  }
  doc.close();
  if (unitBand) doc.text(0, 2.6, spec.unit as string, { sizePt: 6.0, fill: pal.ink400 });

  pts.forEach((p, i) => {
    const up = p.c >= p.o;
    const acc = accented.has(i);
    const ink = acc ? pal.role.accent : up ? upInk : downInk;
    const fill = gallery ? ink : up ? pal.paper : ink;
    const x = cx(i);
    const mark = { series: "ohlc", index: i };
    doc.line(x, sy(p.h), x, sy(p.l), ink, 0.25, { mark: { mark: "whisker", ...mark } });
    const yTop = sy(Math.max(p.o, p.c));
    const hBody = Math.max(0.25, sy(Math.min(p.o, p.c)) - yTop);
    doc.rect(x - bw / 2, yTop, bw, hBody, fill, {
      mark: { mark: "box", ...mark },
      stroke: gallery ? undefined : ink,
      strokeWidthMm: 0.25,
      attrs: ` data-dir="${up ? "up" : "down"}"`,
    });
  });

  doc.open('data-axis="x"');
  doc.line(x0, base, x1, base, pal.role.textAxis, 0.25);
  if (showX) {
    const labels = categoryLabels(pts.map((p) => p.t));
    const maxW = Math.max(...labels.map((l) => textWidthMm(l, TICK))) + 1.6;
    const every = Math.max(1, Math.ceil(maxW / slot));
    labels.forEach((l, i) => {
      if (i % every === 0) doc.text(cx(i), base + 3.4, l, { sizePt: TICK, fill: pal.ink400, anchor: "middle" });
    });
  }
  doc.close();
  return closeFrame(f, spec);
}
