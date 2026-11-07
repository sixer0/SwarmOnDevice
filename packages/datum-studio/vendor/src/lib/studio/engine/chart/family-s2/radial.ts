/**
 * S-08 Radial histogram — histogram arah dalam sektor seragam (TANPA-ACUAN, lint saja).
 *
 * Data: `distribution`, grup pertama = sudut dalam derajat (0 = utara). Nilai di luar
 * [0, 360) dinormalkan modulo 360 (REPORT `S-08.normalized`); grup tambahan diabaikan
 * (REPORT `S-08.groups`). Sektor k mencakup [k w, (k + 1) w), w = 360 / sektor.
 * Panjang baji LINIER terhadap jumlah: jari-jari lingkar acuan = maks domain rapi
 * [0, jumlah terbanyak] (spec galeri: "jumlah = jari-jari / jari-jari lingkar x 20").
 *
 * Orientasi: sudut layar phi (dari atas, searah jarum jam) = (northUp ? 0 : 90) +
 * (clockwise ? theta : -theta); x = cx + r sin phi, y = cy - r cos phi.
 *
 * Gaya gallery (Gambar 8.5 panel S-08): lingkar acuan ink200, salib tipis ink100, baji
 * ink400, sektor beraksen signal, label mata angin U/T/S/B ink700 di luar lingkar.
 * Gaya datum: idem + lingkar kisi pada tick (ink200) dan label jumlah mono di sumbu utara.
 *
 * Parameter registri: `northUp`, `clockwise` (default true; false -> REPORT karena
 * katalog mensyaratkan utara di atas dan searah jarum jam), `uniformSectors` (default
 * true; false tidak didukung tanpa batas sektor -> tetap seragam + REPORT).
 * Petunjuk data (S94): `sectors` (bulat 4..72, default 36), `compassLabels` (4 string,
 * default ["U", "T", "S", "B"]), `accentSectorDeg` (sudut di dalam sektor beraksen).
 * Aksen: `spec.accent.point` / `params.accentPoint` angka = indeks sektor; menang atas
 * `accentSectorDeg`.
 */
import { StudioEngineError } from "../../../contract/errors";
import { defect } from "../core/guards";
import {
  type S2Ctx,
  GRID_MM,
  HAIR_MM,
  TYPE_PT,
  accentTarget,
  hint,
  hintNumber,
  kindBool,
  mid,
  num,
  pt,
  ptToMm,
  ran,
  report,
  requireDistribution,
  tickLabels,
  valueDomain,
} from "./common";

import { fitActive, fitNote } from "../core/fit";
import { measure } from "../core/textfit";

const DEFAULT_SECTORS = 36;

const DEFAULT_COMPASS = ["U", "T", "S", "B"] as const;

/** Lingkaran tanpa isian sebagai path dua busur (SvgDoc.circle mewajibkan isian hex). */
function ring(cx: number, cy: number, r: number): string {
  return `M${num(cx - r)} ${num(cy)} A${num(r)} ${num(r)} 0 1 0 ${num(cx + r)} ${num(cy)} A${num(r)} ${num(r)} 0 1 0 ${num(cx - r)} ${num(cy)} Z`;
}

function sectorCount(ctx: S2Ctx): number {
  const v = hintNumber(ctx, "sectors");
  if (v === undefined) return DEFAULT_SECTORS;
  if (!Number.isInteger(v) || v < 4 || v > 72) {
    throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — params.sectors = ${v} bukan bilangan bulat 4..72`, { key: "sectors" });
  }
  return v;
}

function compassLabels(ctx: S2Ctx): readonly string[] {
  const v = hint(ctx, "compassLabels");
  if (v === undefined) return DEFAULT_COMPASS;
  if (!Array.isArray(v) || v.length !== 4 || v.some((s) => typeof s !== "string")) {
    throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — params.compassLabels harus 4 string (utara, timur, selatan, barat)`, {
      key: "compassLabels",
    });
  }
  return v as string[];
}

export function renderRadial(ctx: S2Ctx): void {
  const { pal, doc, W, style, fid } = ctx;
  const gal = style === "gallery";
  const groups = requireDistribution(ctx);
  if (groups.length > 1) report(ctx, "S-08.groups", `${groups.length} grup; radial histogram membaca grup pertama ("${groups[0].name}")`);
  const g = groups[0];

  const northUp = kindBool(ctx, "northUp", true);
  const clockwise = kindBool(ctx, "clockwise", true);
  const uniform = kindBool(ctx, "uniformSectors", true);
  if (!northUp) report(ctx, "S-08.northUp", "northUp=false: 0 derajat di kanan (katalog: utara di atas)");
  if (!clockwise) report(ctx, "S-08.clockwise", "clockwise=false: sudut berlawanan jarum jam (katalog: searah jarum jam)");
  if (!uniform) report(ctx, "S-08.uniformSectors", "uniformSectors=false tidak didukung tanpa batas sektor; sektor tetap seragam");
  ran(ctx, "S-08.orientation");

  const n = sectorCount(ctx);
  const w = 360 / n;
  const counts = new Array<number>(n).fill(0);
  let normalized = 0;
  for (const v of g.values) {
    const a = ((v % 360) + 360) % 360;
    if (a !== v) normalized++;
    counts[Math.min(n - 1, Math.floor(a / w + 1e-9))]++;
  }
  if (normalized) report(ctx, "S-08.normalized", `${normalized} sudut di luar [0, 360) dinormalkan modulo 360`);

  // Sektor beraksen: accent.point/accentPoint angka (indeks) -> accentSectorDeg.
  let accent = -1;
  const t = accentTarget(ctx.spec);
  if (typeof t === "number") accent = t >= 0 && t < n ? t : -1;
  if (t === undefined) {
    const deg = hintNumber(ctx, "accentSectorDeg");
    if (deg !== undefined) accent = Math.min(n - 1, Math.floor((((deg % 360) + 360) % 360) / w + 1e-9));
  } else if (accent < 0) {
    report(ctx, "ACCENT_HINT", `petunjuk aksen ${JSON.stringify(t)} bukan indeks sektor 0..${n - 1}; diabaikan`);
  }
  if (accent >= 0 && ctx.maxAccent < 1) {
    throw defect("DATUM-26", `${fid} — aksen diminta tetapi chart.accent.maxSubjects = ${ctx.maxAccent}`, { code: "S-08" });
  }

  const maxCount = Math.max(...counts);
  const dom = valueDomain([0, Math.max(1, maxCount)], true);
  const labels = compassLabels(ctx);
  const lp = pt(ctx, gal ? TYPE_PT.gallery.label : TYPE_PT.datum.label);
  const lh = ptToMm(lp);
  const labW = Math.max(...labels.map((s) => s.length)) * lh * 0.55;
  const top = 0.8;
  const bottom = ctx.bottom - 0.8;
  const R = Math.max(2, Math.min((W - 2 * (labW + 2.0)) / 2, (bottom - top - 2 * (lh + 1.6)) / 2));
  const cx = W / 2;
  const cy = (top + bottom) / 2;
  const phi = (theta: number): number => (((northUp ? 0 : 90) + (clockwise ? theta : -theta)) * Math.PI) / 180;
  const pos = (r: number, theta: number): [number, number] => [cx + r * Math.sin(phi(theta)), cy - r * Math.cos(phi(theta))];
  const scale = (c: number): number => (c / dom.max) * R;

  // Dekorasi: lingkar acuan (dan kisi datum) + salib.
  doc.open('data-grid="polar"');
  if (!gal) {
    for (const tk of dom.ticks.slice(1, -1)) doc.path(ring(cx, cy, scale(tk)), "none", { stroke: pal.ink200, strokeWidthMm: GRID_MM });
  }
  doc.line(cx, cy - R, cx, cy + R, pal.ink100, GRID_MM);
  doc.line(cx - R, cy, cx + R, cy, pal.ink100, GRID_MM);
  doc.close();

  doc.open('data-sectors="' + n + '"');
  counts.forEach((c, k) => {
    if (c === 0) return;
    const r = scale(c);
    const a0 = k * w;
    const a1 = (k + 1) * w;
    const [x0, y0] = pos(r, a0);
    const [x1, y1] = pos(r, a1);
    const sweep = clockwise ? 1 : 0;
    const large = w > 180 ? 1 : 0;
    doc.path(
      `M${num(cx)} ${num(cy)} L${num(x0)} ${num(y0)} A${num(r)} ${num(r)} 0 ${large} ${sweep} ${num(x1)} ${num(y1)} Z`,
      k === accent ? pal.role.accent : pal.ink400,
      {
        stroke: pal.paper,
        strokeWidthMm: GRID_MM,
        mark: { mark: "bar", series: g.name, index: k },
        attrs: ` data-count="${c}" data-from="${num(a0)}" data-to="${num(a1)}"`,
      },
    );
  });
  doc.close();

  doc.open('data-axis="polar"');
  doc.path(ring(cx, cy, R), "none", { stroke: pal.ink200, strokeWidthMm: HAIR_MM });
  // Mata angin: utara, timur, selatan, barat pada 0, 90, 180, 270 derajat.
  labels.forEach((s, i) => {
    const [x, y] = pos(R + 1.6 + (i % 2 === 0 ? lh * 0.5 : 0), i * 90);
    const anchor = Math.abs(x - cx) < 0.5 ? "middle" : x > cx ? "start" : "end";
    doc.text(x, mid(y, lp), s, { sizePt: lp, fill: pal.ink700, anchor });
  });
  if (!gal && fitActive()) {
    // FIG-02c (hanya saat fit): label lingkar dipasang pada sinar yang paling sedikit membuat
    // label memotong baji (utara kanan/kiri, selatan, timur, barat; seri = posisi lama).
    const tl = tickLabels(dom);
    const tp = pt(ctx, TYPE_PT.datum.tick);
    const capH = ptToMm(tp);
    const off = northUp ? 0 : 90;
    /** Indeks baji yang memuat titik, atau -1 (lint menilai potong tanda per baji). */
    const wedgeAt = (x: number, y: number): number => {
      const d = Math.hypot(x - cx, y - cy);
      let ph = (Math.atan2(x - cx, -(y - cy)) * 180) / Math.PI;
      ph = ((ph % 360) + 360) % 360;
      const th = (((clockwise ? ph - off : off - ph) % 360) + 360) % 360;
      const k = Math.min(n - 1, Math.floor(th / w + 1e-9));
      return d <= scale(counts[k]) ? k : -1;
    };
    type Place = (tk: number, wMm: number) => { x: number; y: number; anchor: "start" | "end" };
    const places: Place[] = [
      (tk) => ({ x: cx + 0.8, y: cy - scale(tk) + capH + 0.4, anchor: "start" }),
      (tk) => ({ x: cx - 0.8, y: cy - scale(tk) + capH + 0.4, anchor: "end" }),
      (tk) => ({ x: cx + 0.8, y: cy + scale(tk) - 0.4, anchor: "start" }),
      (tk) => ({ x: cx - 0.8, y: cy + scale(tk) - 0.4, anchor: "end" }),
      (tk) => ({ x: cx + scale(tk) - 0.6, y: cy - 0.6, anchor: "end" }),
      (tk) => ({ x: cx + scale(tk) - 0.6, y: cy + capH + 0.6, anchor: "end" }),
      (tk) => ({ x: cx - scale(tk) + 0.6, y: cy - 0.6, anchor: "start" }),
      (tk) => ({ x: cx - scale(tk) + 0.6, y: cy + capH + 0.6, anchor: "start" }),
    ];
    const ticks = dom.ticks.slice(1);
    const widths = ticks.map((_, i) => measure(tl[i + 1], tp, "data"));
    const cuts = (pl: Place, tk: number, i: number): boolean => {
      const p = pl(tk, widths[i]);
      const x0 = p.anchor === "start" ? p.x : p.x - widths[i];
      const per = new Map<number, number>();
      for (let u = 0; u < 7; u++) {
        for (let v = 0; v < 3; v++) {
          const sx = x0 + widths[i] * (0.12 + 0.76 * (u / 6));
          const sy = p.y - capH * 0.87 + capH * 0.99 * (0.2 + 0.6 * (v / 2));
          const k = wedgeAt(sx, sy);
          if (k >= 0) per.set(k, (per.get(k) ?? 0) + 1);
        }
      }
      return [...per.values()].some((c) => c > 0 && c < 21);

    };
    const straddles = (pl: Place): number => ticks.reduce((a, tk, i) => a + (cuts(pl, tk, i) ? 1 : 0), 0);
    let bestK = 0;
    let bestS = straddles(places[0]);
    for (let k = 1; k < places.length && bestS > 0; k++) {
      const s = straddles(places[k]);
      if (s < bestS) {
        bestS = s;
        bestK = k;
      }
    }
    if (bestK > 0) fitNote("RADIAL_LABEL_MOVED", "label lingkar dipindah ke sinar yang tidak memotong baji");
    // Label lingkar yang tetap memotong baji pada sinar terbaik disembunyikan (lingkar kisinya
    // tetap tergambar); label terluar selalu dipertahankan.
    const hide = ticks.map((tk, i) => i < ticks.length - 1 && cuts(places[bestK], tk, i));
    const nHide = hide.filter(Boolean).length;
    if (nHide) fitNote("LABEL_DROPPED", `${nHide} label lingkar disembunyikan karena memotong baji di semua sinar (lingkar kisi tetap tergambar)`);
    ticks.forEach((tk, i) => {
      if (hide[i]) return;
      const p = places[bestK](tk, widths[i]);

      doc.text(p.x, p.y, tl[i + 1], {
        sizePt: tp,
        fill: pal.ink400,
        face: "data",
        anchor: p.anchor,
        attrs: ` stroke="#${pal.paper}" stroke-width="0.6" paint-order="stroke"`,
      });
    });
  } else if (!gal) {
    const tl = tickLabels(dom);
    const tp = pt(ctx, TYPE_PT.datum.tick);
    dom.ticks.slice(1).forEach((tk, i) => {
      // Label lingkar di sisi dalam lingkar, pada sinar layar ke atas (tidak bergantung
      // orientasi), dengan halo kertas agar terbaca di atas baji.
      doc.text(cx + 0.8, cy - scale(tk) + ptToMm(tp) + 0.4, tl[i + 1], {
        sizePt: tp,
        fill: pal.ink400,
        face: "data",
        attrs: ` stroke="#${pal.paper}" stroke-width="0.6" paint-order="stroke"`,
      });
    });
  }
  doc.close();
}
