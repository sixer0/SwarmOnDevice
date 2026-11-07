/**
 * P-13 Quadrant — scatter yang dibagi empat kuadran (Tabel 8.1).
 *
 * Acuan: pustakachart `v72_quadrant` (PC:1066-1085, PENUH): garis pembagi = median x
 * dan median y (putus-putus ink400 0,8 pt), titik ink900, nama kuadran di pojok, label
 * sumbu "garis = median", kisi kedua sumbu.
 * - Domain: `params.axis` `{x: [min, max], y: [min, max]}` bila ada, selain itu domain rapi
 *   data (posisi, tanpa paksaan nol).
 * - Pembagi: `params.divider` `{x?, y?}` bila ada, selain itu median (PC). Pembagi eksplisit
 *   tanpa `dividerJustification` dilaporkan REPORT (Hindari bila: garis pembagi tanpa
 *   alasan); median memakai alasan bawaan "median".
 * - `quadrantNames`: daftar [kiri atas, kanan atas, kiri bawah, kanan bawah] atau objek
 *   `{kiriAtas, kananAtas, kiriBawah, kananBawah}` (spec galeri S94).
 * - Aksen: `points[].accent`, `accent.point` (label/indeks), `accent.group` (grup titik
 *   atau nama kuadran). Subjek aksen dihitung per grup (grup titik, bila tidak ada kuadran):
 *   beberapa titik beraksen dalam SATU kuadran = satu subjek (galeri: dua titik "kejar").
 * - Gaya `gallery`: sumbu L hitam tanpa tick, pembagi ink200 utuh, nama kuadran ink900 di
 *   tengah atas/bawah tiap kuadran, titik peran contextMain.
 */
import type { ChartCanvas, ParamValue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { fmt } from "../../bind";
import { figureLabel } from "../core/guards";
import { kindKey } from "../core/palette";
import { decimalsFor, linearScale, niceDomain } from "../core/scale";
import { escAttr, ptToMm, textWidthMm } from "../core/svg";
import {
  accentHint,
  asRange,
  assertAccentCount,
  axisStroke,
  beginP2,
  finishP2,
  gridLines,
  hint,
  hintMatches,
  kindParam,
  reportIssue,
  requireXy,
  tickFont,
  xAxis,
  yAxis,
} from "./common";
import { fitActive } from "../core/fit";
import { placePointLabels } from "../core/labelfit";

const CODE = "P-13" as const;
const QUADS = ["kiriAtas", "kananAtas", "kiriBawah", "kananBawah"] as const;
type Quad = (typeof QUADS)[number];
const QUAD_ALIASES: Record<string, Quad> = { topLeft: "kiriAtas", topRight: "kananAtas", bottomLeft: "kiriBawah", bottomRight: "kananBawah" };

function median(vs: readonly number[]): number {
  const s = [...vs].sort((a, b) => a - b);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

function quadNames(spec: StudioChartV1, raw: ParamValue | undefined): Partial<Record<Quad, string>> {
  const out: Partial<Record<Quad, string>> = {};
  if (raw === undefined) return out;
  const bad = (): never => {
    throw new StudioEngineError(
      "SCHEMA_INVALID",
      `${figureLabel(spec)} — quadrantNames harus daftar <= 4 string atau objek {kiriAtas, kananAtas, kiriBawah, kananBawah}`,
      { key: kindKey(CODE, "quadrantNames") },
    );
  };
  if (Array.isArray(raw)) {
    if (raw.length > 4) bad();
    raw.forEach((v, i) => {
      if (typeof v !== "string") bad();
      else if (v) out[QUADS[i]] = v;
    });
    return out;
  }
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      const q = (QUADS as readonly string[]).includes(k) ? (k as Quad) : QUAD_ALIASES[k];
      if (!q || typeof v !== "string") bad();
      else if (v) out[q] = v;
    }
    return out;
  }
  return bad();
}

export function renderQuadrant(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const ctx = beginP2(spec, canvas, tpl, CODE);
  const { pal, doc, style, W, H } = ctx;
  const fid = figureLabel(spec);
  const pts = requireXy(spec, CODE);

  // Domain = parameter templat `chart.kind.P-13.axis` (resolver memindah alias `axis` ke kunci
  // penuh; IP-59/FIX-A); petunjuk pendek tetap dibaca untuk spec yang tidak lewat resolver.
  const axis = kindParam(spec, tpl, CODE, "axis") ?? hint(spec, "axis");
  if (axis !== undefined && (axis === null || typeof axis !== "object" || Array.isArray(axis))) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — params.axis harus {x: [min, max], y: [min, max]}`, { key: "axis" });
  }
  const ax = axis as Record<string, ParamValue> | undefined;
  const xr = asRange(spec, ax?.x, "params.axis.x");
  const yr = asRange(spec, ax?.y, "params.axis.y");
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const xd = xr ? niceDomain(xr, { zero: false }) : niceDomain(xs, { zero: false });
  const yd = yr ? niceDomain(yr, { zero: false }) : niceDomain(ys, { zero: false });
  const xmin = xr ? xr[0] : xd.min;
  const xmax = xr ? xr[1] : xd.max;
  const ymin = yr ? yr[0] : yd.min;
  const ymax = yr ? yr[1] : yd.max;

  const div = hint(spec, "divider");
  if (div !== undefined && (div === null || typeof div !== "object" || Array.isArray(div))) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — params.divider harus {x?, y?}`, { key: "divider" });
  }
  const dv = div as Record<string, ParamValue> | undefined;
  const finiteOpt = (v: ParamValue | undefined, k: string): number | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — params.divider.${k} bukan bilangan hingga`, { key: "divider" });
    }
    return v;
  };
  const dxHint = finiteOpt(dv?.x, "x");
  const dyHint = finiteOpt(dv?.y, "y");
  const dx = dxHint ?? median(xs);
  const dy = dyHint ?? median(ys);
  const explicitDivider = dxHint !== undefined || dyHint !== undefined;
  const just = kindParam(spec, tpl, CODE, "dividerJustification");
  const justification = typeof just === "string" && just.trim() ? just.trim() : explicitDivider ? "" : "median";
  if (!justification) {
    reportIssue(ctx, kindKey(CODE, "dividerJustification"), `${fid} — garis pembagi kuadran (${dx}, ${dy}) tanpa alasan; isi chart.kind.P-13.dividerJustification`);
  }
  const names = quadNames(spec, kindParam(spec, tpl, CODE, "quadrantNames"));
  const quadOf = (x: number, y: number): Quad => (y >= dy ? (x < dx ? "kiriAtas" : "kananAtas") : x < dx ? "kiriBawah" : "kananBawah");

  const ah = accentHint(spec, CODE);
  const accent = pts.map((p, i) => {
    const q = quadOf(p.x, p.y);
    return (
      p.accent ||
      hintMatches(ah.point, p.label, i) ||
      (ah.group !== undefined && (p.group === ah.group || names[q] === ah.group || q === ah.group))
    );
  });
  const subjects = new Set(pts.filter((_, i) => accent[i]).map((p) => p.group ?? quadOf(p.x, p.y)));
  assertAccentCount(spec, CODE, subjects.size, ctx.maxAccent, "grup titik");

  // Tata letak.
  const tf = tickFont(ctx);
  const xdec = decimalsFor(xd.step);
  const ydec = decimalsFor(yd.step);
  const xTicks = xd.ticks.filter((t) => t >= xmin - 1e-9 && t <= xmax + 1e-9);
  const yTicks = yd.ticks.filter((t) => t >= ymin - 1e-9 && t <= ymax + 1e-9);
  const NOTE = ctx.pt(6.8);
  const tickW = Math.max(...yTicks.map((t) => textWidthMm(fmt(t, ydec), tf.sizePt, tf.face)));
  const x0 = style === "gallery" ? 1.0 : tickW + 1.8;
  const x1 = W - (style === "gallery" ? 0.5 : Math.max(1.0, textWidthMm(fmt(xmax, xdec), tf.sizePt, tf.face) / 2 + 0.3));
  const y0 = style === "gallery" ? 0.8 : 1.0;
  const y1 = H - ctx.footBand - (style === "gallery" ? 0.6 : 4.4 + ptToMm(NOTE) + 1.4);
  const sx = linearScale(xmin, xmax, x0, x1);
  const sy = linearScale(ymin, ymax, y1, y0);
  const NAME = ctx.pt(style === "gallery" ? 6.4 : 6.2);

  if (style === "datum") {
    gridLines(ctx, true, xTicks.map(sx), y0, y1);
    gridLines(ctx, false, yTicks.map(sy), x0, x1);
  }
  // Garis pembagi (acuan, tanpa data-mark).
  const dash = style === "gallery" ? undefined : [ptToMm(4), ptToMm(3)];
  const dcol = style === "gallery" ? pal.ink200 : pal.ink400;
  const dw = style === "gallery" ? 0.3 : ptToMm(0.8);
  doc.open(`data-divider="quadrant"`);
  if (dx >= xmin && dx <= xmax) doc.line(sx(dx), y0, sx(dx), y1, dcol, dw, { dashMm: dash, attrs: ' data-divider-axis="x"' });
  if (dy >= ymin && dy <= ymax) doc.line(x0, sy(dy), x1, sy(dy), dcol, dw, { dashMm: dash, attrs: ' data-divider-axis="y"' });
  doc.close();

  // Nama kuadran.
  const xm = Math.min(Math.max(sx(dx), x0), x1);
  const asc = ptToMm(NAME) * 0.75;
  for (const q of QUADS) {
    const s = names[q];
    if (!s) continue;
    const left = q === "kiriAtas" || q === "kiriBawah";
    const upper = q === "kiriAtas" || q === "kananAtas";
    if (style === "gallery") {
      const x = left ? (x0 + xm) / 2 : (xm + x1) / 2;
      const y = upper ? y0 + asc + 1.0 : y1 - 1.0;
      doc.text(x, y, s, { sizePt: NAME, fill: pal.ink900, anchor: "middle", attrs: ` data-quadrant="${q}"` });
    } else {
      const x = left ? x0 + 1.0 : x1 - 1.0;
      const y = upper ? y0 + asc + 0.8 : y1 - 1.0;
      doc.text(x, y, s, { sizePt: NAME, fill: pal.ink400, anchor: left ? "start" : "end", attrs: ` data-quadrant="${q}"` });
    }
  }

  // Titik.
  const r = style === "gallery" ? 1.05 : Math.sqrt(18) / 2 * ptToMm(1);
  const base = style === "gallery" ? pal.role.contextMain : pal.ink900;
  pts.forEach((p, i) => {
    const fill = accent[i] ? pal.role.accent : base;
    // data-accent-group: subjek aksen = grup/kuadran (beberapa titik satu grup = satu subjek).
    const grp = accent[i] ? ` data-accent-group="${escAttr(p.group ?? quadOf(p.x, p.y))}"` : "";
    doc.circle(sx(p.x), sy(p.y), r, fill, { mark: { mark: "point", series: p.group ?? "titik", index: i }, attrs: grp });
    if (p.label && !fitActive()) {
      doc.text(sx(p.x) + ptToMm(5), sy(p.y) - ptToMm(4), p.label, {
        sizePt: ctx.pt(6.2),
        fill: accent[i] ? pal.role.accent : pal.ink700,
        attrs: ' data-label="point"',
      });
    }
  });

  // FIG-02a P1-8: saat fit, label titik ditempatkan tanpa tabrakan (8 posisi + penunjuk).
  if (fitActive()) {
    const font = { pt: ctx.pt(6.2) };
    const lab = pts.map((p, i) => ({ p, i })).filter(({ p }) => p.label);
    const dots = pts.map((p) => [sx(p.x) - r, sy(p.y) - r, sx(p.x) + r, sy(p.y) + r] as [number, number, number, number]);
    const placed = placePointLabels(lab.map(({ p }) => ({ x: sx(p.x), y: sy(p.y), r, text: p.label as string })), font, [Math.max(0.3, x0), Math.max(0.3, y0), Math.min(W - 0.3, x1), y1], dots);
    placed.forEach((pl, k) => {
      if (!pl) return;
      const { p, i } = lab[k];
      if (pl.leader) doc.line(pl.leader.x1, pl.leader.y1, pl.leader.x2, pl.leader.y2, pal.ink400, 0.18, { attrs: ' data-leader="point"' });
      doc.text(pl.x, pl.y, p.label as string, { sizePt: font.pt, fill: accent[i] ? pal.role.accent : pal.ink700, anchor: pl.anchor, attrs: ' data-label="point"' });
    });
  }

  // Sumbu.
  if (style === "gallery") {
    const st = axisStroke(ctx);
    doc.open('data-axis="y"');
    doc.line(x0, y0, x0, y1, st.color, st.width);
    doc.close();
    doc.open('data-axis="x"');
    doc.line(x0, y1, x1, y1, st.color, st.width);
    doc.close();
  } else {
    yAxis(ctx, { at: x0, from: y0, to: y1, scale: sy, ticks: yTicks, label: (v) => fmt(v, ydec) });
    xAxis(ctx, { at: y1, from: x0, to: x1, scale: sx, ticks: xTicks, label: (v) => fmt(v, xdec) });
    doc.text(x0, y1 + 4.4 + ptToMm(NOTE), `garis = ${justification || "pembagi"}`, { sizePt: NOTE, fill: pal.ink700 });
  }
  return finishP2(ctx);
}
