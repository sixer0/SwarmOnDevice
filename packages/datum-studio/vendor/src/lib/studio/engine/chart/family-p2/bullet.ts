/**
 * P-09 Bullet — realisasi, target, dan pita kinerja per baris KPI (Tabel 8.1).
 *
 * Acuan: pustakachart `v95_bullet` (PC:1214-1229, PARSIAL: satu baris, pita literal
 * 0-60-80-100). Di sini satu baris per titik `categorical`.
 * - Target: `params.targets[i]` -> `params.target` -> `spec.limit` (CHART_DATA_CONSTRAINTS).
 *   `targetLine` benar tanpa target = cacat by-construction (Hindari bila: tidak ada target).
 * - Skala: 0..`params.max` (default 100 bila semua nilai <= 100, selain itu batas rapi);
 *   garis dasar nol selalu (CH-01), nilai negatif ditolak.
 * - Pita `bandLevels`: bilangan bulat 1..5 (3 = batas PC 60/80/100 % dari max; selain itu
 *   rata) atau daftar batas naik (spec galeri S94: `[60, 85, 100]`). Pita dasar ink100,
 *   pita berikutnya ink200 dengan opasitas naik (satu keluarga tinta, K-32).
 * - Gaya `gallery` (Gambar 8.1): batang ink900, batang di bawah target berwarna
 *   `belowTargetColour` (default peran limitExceeded), tick target warna peran aksen;
 *   tanpa label nilai; sumbu x bertick.
 * - Gaya `datum` (PC): batang ink900, garis target peran limitExceeded 2,2 pt, label nilai
 *   mono di atas ujung batang, label sumbu "target".
 * Tick target adalah garis acuan (seperti garis batas P-11): tanpa `data-mark`, ber-`data-target`.
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { fmt, withUnit } from "../../bind";
import { assertNonNegative, defect, figureLabel, requireCategorical } from "../core/guards";
import { kindKey } from "../core/palette";
import { decimalsFor, linearScale, niceDomain } from "../core/scale";
import { ptToMm, textWidthMm } from "../core/svg";
import {
  accentHint,
  assertAccentCount,
  beginP2,
  finishP2,
  hint,
  hintMatches,
  hintNumber,
  kindBool,
  kindParam,
  mid,
  tokenHex,
  xAxis,
} from "./common";
import { fitActive } from "../core/fit";
import { drawGutterLabel, gutterPlan } from "../core/labelfit";

const CODE = "P-09" as const;

/** Batas pita (naik, terakhir = max). */
function bandBounds(spec: StudioChartV1, raw: unknown, max: number): number[] {
  const fid = figureLabel(spec);
  if (Array.isArray(raw)) {
    const b = raw.map((v, i) => {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        throw new StudioEngineError("SCHEMA_INVALID", `${fid} — bandLevels[${i}] bukan bilangan positif`, { key: kindKey(CODE, "bandLevels") });
      }
      return v;
    });
    if (b.length < 1 || b.length > 5 || b.some((v, i) => i > 0 && v <= b[i - 1]) || b[b.length - 1] > max + 1e-9) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — bandLevels ${JSON.stringify(raw)} harus 1..5 batas naik dan <= max ${max}`, {
        key: kindKey(CODE, "bandLevels"),
      });
    }
    if (b[b.length - 1] < max - 1e-9) b.push(max);
    return b;
  }
  const n = raw === undefined ? 3 : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 5) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — bandLevels ${JSON.stringify(raw)} bukan bilangan bulat 1..5 atau daftar batas`, {
      key: kindKey(CODE, "bandLevels"),
    });
  }
  // n = 3: batas literal PC:1216-1218 (60 % dan 80 % dari max); selain itu dibagi rata.
  const fr = n === 3 ? [0.6, 0.8, 1] : Array.from({ length: n }, (_, k) => (k + 1) / n);
  return fr.map((f) => f * max);
}

export function renderBullet(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const ctx = beginP2(spec, canvas, tpl, CODE);
  const { pal, doc, style, W, H } = ctx;
  const fid = figureLabel(spec);
  const pts = requireCategorical(spec, CODE, ctx.maxAccent);
  assertNonNegative(spec, CODE, pts);
  const ah = accentHint(spec, CODE);
  const accent = pts.map((p, i) => p.accent || hintMatches(ah.point, p.label, i));
  assertAccentCount(spec, CODE, accent.filter(Boolean).length, ctx.maxAccent, "baris");

  // Target per baris.
  const tRaw = hint(spec, "targets");
  if (tRaw !== undefined && (!Array.isArray(tRaw) || tRaw.length !== pts.length)) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — params.targets harus daftar ${pts.length} angka (satu per baris)`, { key: "targets" });
  }
  const tOne = hintNumber(spec, "target") ?? spec.limit;
  const targets = pts.map((_, i) => {
    const v = Array.isArray(tRaw) ? tRaw[i] : undefined;
    if (v !== undefined && v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — params.targets[${i}] bukan bilangan hingga >= 0`, { key: "targets" });
    }
    return typeof v === "number" ? v : (tOne ?? null);
  });
  const actualBar = kindBool(spec, tpl, CODE, "actualBar", true);
  const targetLine = kindBool(spec, tpl, CODE, "targetLine", true);
  const missing = targets.findIndex((t) => t === null);
  if (targetLine && missing >= 0) {
    throw defect(kindKey(CODE, "targetLine"), `${fid} — bullet tanpa target pada baris "${pts[missing].label}"; isi params.targets, params.target, atau limit`, {
      code: CODE,
      index: missing,
    });
  }

  // Skala 0..max.
  const dataMax = Math.max(...pts.map((p) => p.value), ...targets.map((t) => t ?? 0));
  const bandRaw = kindParam(spec, tpl, CODE, "bandLevels");
  const maxHint = hintNumber(spec, "max");
  const max =
    maxHint ??
    (Array.isArray(bandRaw) && typeof bandRaw[bandRaw.length - 1] === "number"
      ? Math.max(bandRaw[bandRaw.length - 1] as number, dataMax)
      : dataMax <= 100
        ? 100
        : niceDomain([dataMax], { zero: true }).max);
  if (!(max > 0) || dataMax > max + 1e-9) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — nilai/target terbesar ${dataMax} melampaui max ${max}`, { key: "max" });
  }
  const bands = bandBounds(spec, bandRaw, max);
  const dec = spec.dec ?? 0;
  const unit = spec.unit ?? "";
  const series = unit || "nilai";
  const below = hint(spec, "belowTargetColour");
  const belowHex = below !== undefined ? tokenHex(ctx, below, "belowTargetColour") : style === "gallery" ? pal.role.limitExceeded : null;

  const LBL = ctx.pt(style === "gallery" ? 6.4 : 6.5);
  const VAL = ctx.pt(6.4);
  const showLabels = style === "gallery" || pts.length > 1;
  const labelW = showLabels ? Math.max(...pts.map((p) => textWidthMm(p.label, LBL))) : 0;
  const x00 = showLabels ? Math.min(Math.max(labelW + 1.6, 4), W * 0.4) : 1.0;
  const top0 = style === "gallery" ? 0.8 : 3.4;
  const base0 = H - ctx.footBand - (style === "datum" ? 9.4 : 5.4);
  // FIG-02a P1-5: talang terukur + bungkus (hanya saat fit).
  const gp = showLabels ? gutterPlan(pts.map((p) => p.label), { pt: LBL }, { currentMm: x00, capMm: W * 0.4, padMm: 1.6, pitchMm: (base0 - 1.0 - top0) / pts.length }) : null;
  const x0 = gp ? Math.max(x00, gp.gutterMm) : x00;
  const step = niceDomain([0, max], { zero: true }).step;
  const tdec = decimalsFor(step);
  const ticks = niceDomain([0, max], { zero: true }).ticks.filter((t) => t <= max + 1e-9);
  const xr = W - Math.max(1.0, textWidthMm(fmt(max, tdec), 6.5) / 2 + 0.3);
  const sx = linearScale(0, max, x0, xr);
  const caption = style === "datum";
  const top = style === "gallery" ? 0.8 : 3.4;
  const base = H - ctx.footBand - (caption ? 9.4 : 5.4);
  const rowStep = (base - 1.0 - top) / pts.length;
  const bandH = rowStep * (style === "gallery" ? 0.7 : 0.72);
  const barH = bandH * (style === "gallery" ? 0.34 : 0.47);

  pts.forEach((p, i) => {
    const yc = top + rowStep * (i + 0.5);
    const yb = yc - bandH / 2;
    doc.open(`data-row="${i}"`);
    // Pita: dasar ink100 sepanjang skala, pita k >= 1 ink200 beropasitas k/(n-1).
    doc.rect(x0, yb, sx(max) - x0, bandH, pal.ink100, { attrs: ' data-band="0"' });
    bands.forEach((b, k) => {
      if (k === 0) return;
      const a = sx(bands[k - 1]);
      const op = Math.round((k / (bands.length - 1)) * 1000) / 1000;
      doc.rect(a, yb, sx(b) - a, bandH, pal.ink200, { attrs: ` data-band="${k}" fill-opacity="${op}"` });
    });
    const t = targets[i];
    const fill = accent[i] ? pal.role.accent : belowHex && t !== null && p.value < t ? belowHex : pal.ink900;
    if (actualBar) {
      doc.rect(x0, yc - barH / 2, sx(p.value) - x0, barH, fill, { mark: { mark: "bar", series, index: i } });
    } else {
      doc.circle(sx(p.value), yc, Math.max(0.6, barH / 2), fill, { mark: { mark: "point", series, index: i } });
    }
    if (targetLine && t !== null) {
      const xt = sx(t);
      if (style === "gallery") {
        const tw = 0.6;
        const th = bandH * 0.86;
        doc.rect(xt - tw / 2, yc - th / 2, tw, th, pal.role.accent, { attrs: ` data-target="${i}"` });
      } else {
        const th = bandH * (0.6 / 0.72);
        doc.line(xt, yc - th / 2, xt, yc + th / 2, pal.role.limitExceeded, ptToMm(2.2), { attrs: ` data-target="${i}"` });
      }
    }
    if (showLabels && gp) drawGutterLabel(doc, gp, i, x0 - 1.2, mid(yc, LBL), { sizePt: LBL, fill: pal.ink400, anchor: "end" });
    else if (showLabels) doc.text(x0 - 1.2, mid(yc, LBL), p.label, { sizePt: LBL, fill: pal.ink400, anchor: "end" });
    // FIG-02a P1-8: baris rapat (celah antarpita < tinggi huruf) -> label nilai di ujung batang (hanya saat fit).
    const cramped = fitActive() && rowStep - bandH < ptToMm(VAL) * 1.1;
    if (style === "datum" && cramped) {
      doc.text(sx(p.value) + (actualBar ? 0.6 : Math.max(0.6, barH / 2) + 0.6), mid(yc, VAL), withUnit(fmt(p.value, dec), unit), {
        face: "data",
        sizePt: VAL,
        fill: pal.ink700,
        anchor: "start",
        attrs: ' data-label="value"',
      });
    } else if (style === "datum") {
      doc.text(Math.max(x0 + textWidthMm("0", VAL, "data"), sx(p.value) - 0.5), yb - 0.7, withUnit(fmt(p.value, dec), unit), {
        face: "data",
        sizePt: VAL,
        fill: pal.ink700,
        anchor: "end",
        attrs: ' data-label="value"',
      });
    }
    doc.close();
  });

  xAxis(ctx, { at: base, from: x0, to: sx(max), scale: sx, ticks, label: (v) => fmt(v, tdec), tickMarks: style === "gallery" });
  if (caption) {
    const tTxt = targets[0] !== null ? withUnit(fmt(targets[0] as number, dec), unit) : "";
    const s = pts.length === 1 && targetLine ? `${pts[0].label} - target garis tegak ${tTxt}` : targetLine ? "garis tegak = target" : pts.length === 1 ? pts[0].label : "";
    if (s) doc.text(x0, base + 7.6, s, { sizePt: ctx.pt(6.6), fill: pal.ink700 });
  }
  return finishP2(ctx);
}
