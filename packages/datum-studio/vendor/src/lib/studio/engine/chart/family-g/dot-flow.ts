/**
 * engine/chart/family-g — G-02 dot map dan G-03 flow map (S43), TANPA-ACUAN.
 *
 * D-22 KT-12: digambar SKEMATIS di atas grid petak yang sama dengan tile map (G-01),
 * tanpa peta dasar dan tanpa GeoJSON. Sel grid merentang mengisi area gambar; posisi
 * hanya bermakna relatif (akar SVG membawa `data-schematic="KT-12"`, REPORT `KT-12`).
 * research/06 §6.4: label "wilayah ilustrasi" berasal dari label petak data; tebal
 * panah G-03 sebanding volume.
 *
 * G-02: `data.dots[]` {tile, dx?, dy?, label?}; dx/dy relatif sel 0..1 (default 0,5;
 * y ke bawah). Gaya datum: petak ink100 berlabel, titik ink700, label titik di kanan;
 * gaya gallery: bingkai petak putus-putus berlabel (panel Gambar 8.5), titik tanpa
 * label. Aksen: `accent.point` = label/indeks titik (datum: titik signal; gallery:
 * cincin signal), `accent.group` = kode petak.
 *
 * G-03: `data.flows[]` {from, to, value >= 0} antar kode petak. Simpul = pusat sel
 * (titik ink900 + label di bawah); aliran = kurva kuadratik melengkung ke kanan arah
 * gerak, tebal linear 0,35..maks mm menurut nilai, kepala panah segitiga. Datum:
 * latar petak ink100 + label nilai di tengah kurva; gallery: tanpa latar dan label
 * nilai. Aksen: `accent.point` = indeks aliran atau "ASAL>TUJUAN" (juga "-", "->",
 * "→"); `accent.group` = kode simpul.
 *
 * Petunjuk galeri (IP-41c): `schematic` (G-02/G-03; satu-satunya mode "KT-12 grid tile",
 * dicatat di REPORT KT-12) dan G-02 `regionFrame` (dashed | solid | none; tidak diset =
 * gallery dashed, datum petak berisi ink100).
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { fmt, withUnit } from "../../bind";
import { defect } from "../core/guards";
import { kindEnum, kindValue } from "../core/read";
import { num, ptToMm, textWidthMm } from "../core/svg";
import {
  type GCtx,
  type Tile,
  HAIR_MM,
  TYPE_PT,
  accentHint,
  assertAccentCount,
  beginChart,
  endChart,
  gridOf,
  hintMiss,
  inkOn,
  report,
  requireTiles,
  tileLabel,
} from "./common";

const SCHEMATIC = 'data-schematic="KT-12"';

function schematicNote(ctx: GCtx): void {
  const mode = kindEnum(ctx, "schematic", ["KT-12 grid tile"] as const, "KT-12 grid tile");
  report(ctx, "KT-12", `peta skematis (${mode}) di atas grid petak (tanpa peta dasar/GeoJSON); posisi relatif, bukan skala`);
}

function tileIndex(tiles: readonly Tile[]): Map<string, number> {
  return new Map(tiles.map((t, i) => [t.code, i]));
}

/** Petunjuk kode petak (`accent.group`) -> indeks petak; -1 bila tidak ada/cocok. */
function groupTarget(ctx: GCtx, idx: Map<string, number>, group: string | undefined): number {
  if (group === undefined) return -1;
  const i = idx.get(group) ?? -1;
  if (i < 0) hintMiss(ctx, `group "${group}"`);
  return i;
}

// ── G-02 ──────────────────────────────────────────────────────────────────

export function renderDotMap(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const ctx = beginChart("G-02", spec, canvas, tpl, SCHEMATIC);
  const { pal, doc, style } = ctx;
  const data = requireTiles(ctx);
  const { tiles } = data;
  const dots = data.dots ?? [];
  if (!Array.isArray(dots) || dots.length === 0) throw defect("DC-G1", `${ctx.fid} — dot map tanpa titik (data.dots)`, { code: "G-02" });
  const idx = tileIndex(tiles);
  dots.forEach((d, i) => {
    if (!idx.has(d?.tile)) {
      throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — titik ${i}: petak "${String(d?.tile)}" tidak ada di data.tiles`, { code: "G-02", index: i });
    }
    for (const k of ["dx", "dy"] as const) {
      const v = d[k];
      if (v !== undefined && !(typeof v === "number" && v >= 0 && v <= 1)) {
        throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — titik ${i}: ${k} harus 0..1 (relatif sel)`, { code: "G-02", index: i });
      }
    }
  });
  schematicNote(ctx);

  // Aksen.
  const hint = accentHint(spec);
  let accentDot = -1;
  let accentTile = -1;
  if (hint?.point !== undefined) {
    const p = hint.point;
    accentDot = typeof p === "number" ? (p < dots.length ? p : -1) : dots.findIndex((d) => d.label === p);
    if (accentDot < 0) hintMiss(ctx, `point ${JSON.stringify(p)}`);
  } else if (hint) accentTile = groupTarget(ctx, idx, hint.group);
  if (hint) assertAccentCount(ctx, [accentDot >= 0 ? `titik ${accentDot}` : "", accentTile >= 0 ? tiles[accentTile].code : ""].filter(Boolean));

  const T = TYPE_PT[style];
  const labPt = Math.max(ctx.minFontPt, T.label);
  const area = { x: 0.6, y: 0.6, w: ctx.W - 1.2, h: ctx.bottom - 1.2 };
  const g = gridOf(tiles, area, false);
  const gap = style === "datum" ? Math.min(0.6, g.cellW * 0.04) : 0;
  // Bingkai wilayah: petunjuk `regionFrame` bila diset, selain itu menurut gaya.
  const frame: "dashed" | "solid" | "none" | "fill" =
    kindValue(ctx, "regionFrame") === undefined
      ? style === "gallery"
        ? "dashed"
        : "fill"
      : kindEnum(ctx, "regionFrame", ["dashed", "solid", "none"] as const, "dashed");

  tiles.forEach((t, i) => {
    const { x, y } = g.cell(t.row, t.col);
    const w = g.cellW - gap;
    const h = g.cellH - gap;
    const acc = i === accentTile;
    const mark = { mark: "tile" as const, series: "wilayah", index: i };
    if (frame === "dashed" || frame === "solid") {
      doc.rect(x, y, w, h, pal.paper, { mark, stroke: acc ? pal.role.accent : pal.ink400, strokeWidthMm: HAIR_MM, attrs: frame === "dashed" ? ' stroke-dasharray="1 0.8"' : "" });
    } else if (frame === "fill") {
      doc.rect(x, y, w, h, acc ? pal.role.accent : pal.ink100, { mark });
    }
    const fill = frame === "fill" && acc ? inkOn(pal, pal.role.accent) : pal.ink400;
    doc.text(x + 1.0, y + 1.0 + ptToMm(labPt) * 0.8, tileLabel(t), { sizePt: labPt, fill });
  });

  const r = style === "gallery" ? 0.5 : 0.75;
  const dotPos = dots.map((d) => {
    const t = tiles[idx.get(d.tile) as number];
    const { x, y } = g.cell(t.row, t.col);
    return { x: x + (d.dx ?? 0.5) * (g.cellW - gap), y: y + (d.dy ?? 0.5) * (g.cellH - gap) };
  });
  dots.forEach((d, i) => {
    if (i === accentDot) return; // aksen digambar terakhir (di atas)
    const p = dotPos[i];
    doc.circle(p.x, p.y, r, pal.ink700, { mark: { mark: "point", series: "lokasi", index: i } });
    if (style === "datum" && d.label) doc.text(p.x + r + 0.6, p.y + ptToMm(labPt) * 0.35, d.label, { sizePt: labPt, fill: pal.ink700 });
  });
  if (accentDot >= 0) {
    const p = dotPos[accentDot];
    const mark = { mark: "point" as const, series: "lokasi", index: accentDot };
    if (style === "gallery") {
      const rr = 1.0;
      const d = `M${num(p.x - rr)} ${num(p.y)}a${num(rr)} ${num(rr)} 0 1 0 ${num(2 * rr)} 0a${num(rr)} ${num(rr)} 0 1 0 ${num(-2 * rr)} 0`;
      doc.path(d, "none", { mark, stroke: pal.role.accent, strokeWidthMm: 0.35 });
    } else {
      doc.circle(p.x, p.y, r * 1.25, pal.role.accent, { mark });
      const lab = dots[accentDot].label;
      if (lab) doc.text(p.x + r * 1.25 + 0.6, p.y + ptToMm(labPt) * 0.35, lab, { sizePt: labPt, fill: pal.ink900, bold: true });
    }
  }
  return endChart(ctx);
}

// ── G-03 ──────────────────────────────────────────────────────────────────

const FLOW_SEP = /^(.+?)\s*(?:->|→|>|-)\s*(.+)$/;

export function renderFlowMap(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const ctx = beginChart("G-03", spec, canvas, tpl, SCHEMATIC);
  const { pal, doc, style } = ctx;
  const data = requireTiles(ctx);
  const { tiles } = data;
  const flows = data.flows ?? [];
  if (!Array.isArray(flows) || flows.length === 0) throw defect("DC-G1", `${ctx.fid} — flow map tanpa aliran (data.flows)`, { code: "G-03" });
  const idx = tileIndex(tiles);
  flows.forEach((f, i) => {
    for (const end of [f?.from, f?.to]) {
      if (!idx.has(end)) {
        throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — aliran ${i}: petak "${String(end)}" tidak ada di data.tiles`, { code: "G-03", index: i });
      }
    }
    if (f.from === f.to) throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — aliran ${i}: asal sama dengan tujuan`, { code: "G-03", index: i });
    if (typeof f.value !== "number" || !Number.isFinite(f.value) || f.value < 0) {
      throw defect("DC-G1", `${ctx.fid} — aliran ${i}: nilai harus bilangan hingga >= 0`, { code: "G-03", index: i });
    }
  });
  schematicNote(ctx);

  // Aksen.
  const hint = accentHint(spec);
  let accentFlow = -1;
  let accentNode = -1;
  if (hint?.point !== undefined) {
    const p = hint.point;
    if (typeof p === "number") accentFlow = p < flows.length ? p : -1;
    else {
      const m = FLOW_SEP.exec(p);
      accentFlow = m ? flows.findIndex((f) => f.from === m[1] && f.to === m[2]) : -1;
    }
    if (accentFlow < 0) hintMiss(ctx, `point ${JSON.stringify(p)}`);
  } else if (hint) accentNode = groupTarget(ctx, idx, hint.group);
  if (hint) assertAccentCount(ctx, [accentFlow >= 0 ? `aliran ${accentFlow}` : "", accentNode >= 0 ? tiles[accentNode].code : ""].filter(Boolean));

  const T = TYPE_PT[style];
  const labPt = Math.max(ctx.minFontPt, T.label);
  const labH = ptToMm(labPt);
  const halfLab = Math.max(...tiles.map((t) => textWidthMm(tileLabel(t), labPt))) / 2;
  const padX = Math.min(halfLab + 0.6, ctx.W * 0.2);
  const area = { x: padX, y: 1.6, w: ctx.W - 2 * padX, h: ctx.bottom - 1.6 - labH - 1.8 };
  const g = gridOf(tiles, area, false);
  const centre = (i: number): { x: number; y: number } => {
    const t = tiles[i];
    const c = g.cell(t.row, t.col);
    return { x: c.x + g.cellW / 2, y: c.y + g.cellH / 2 };
  };

  if (style === "datum") {
    const gap = Math.min(0.6, g.cellW * 0.04);
    tiles.forEach((t, i) => {
      const c = g.cell(t.row, t.col);
      doc.rect(c.x + gap / 2, c.y + gap / 2, g.cellW - gap, g.cellH - gap, pal.ink100, { mark: { mark: "tile", series: "wilayah", index: i } });
    });
  }

  const maxV = Math.max(...flows.map((f) => f.value));
  const wMax = style === "gallery" ? 1.3 : 1.6;
  const wMin = 0.35;
  const r = style === "gallery" ? 0.9 : 0.8;
  const order = flows.map((_, i) => i).filter((i) => i !== accentFlow);
  if (accentFlow >= 0) order.push(accentFlow);
  for (const i of order) {
    const f = flows[i];
    const w = maxV > 0 ? wMin + ((wMax - wMin) * f.value) / maxV : wMin;
    const colour = i === accentFlow ? pal.role.accent : pal.role.contextMain;
    const a = centre(idx.get(f.from) as number);
    const b = centre(idx.get(f.to) as number);
    drawFlow(ctx, a, b, w, r, colour, i, style === "datum" ? withUnit(fmt(f.value, ctx.dec), ctx.unit) : undefined);
  }

  // Arah keluar kurva di tiap simpul (menuju titik kendali) untuk memilih sisi label.
  const tangents = new Map<number, Array<{ x: number; y: number }>>();
  flows.forEach((f) => {
    const ia = idx.get(f.from) as number;
    const ib = idx.get(f.to) as number;
    const c = control(centre(ia), centre(ib));
    for (const i of [ia, ib]) {
      const p = centre(i);
      const l = Math.hypot(c.x - p.x, c.y - p.y) || 1;
      tangents.set(i, [...(tangents.get(i) ?? []), { x: (c.x - p.x) / l, y: (c.y - p.y) / l }]);
    }
  });
  tiles.forEach((t, i) => {
    const c = centre(i);
    doc.circle(c.x, c.y, r, i === accentNode ? pal.role.accent : pal.ink900, { mark: { mark: "node", series: "lokasi", index: i } });
    const side = labelSide(tangents.get(i) ?? []);
    const lab = tileLabel(t);
    const gapR = r + 0.6;
    if (side === "below") doc.text(c.x, c.y + gapR + labH * 0.8, lab, { sizePt: labPt, fill: pal.ink700, anchor: "middle" });
    else if (side === "above") doc.text(c.x, c.y - gapR - labH * 0.15, lab, { sizePt: labPt, fill: pal.ink700, anchor: "middle" });
    else doc.text(c.x + (side === "right" ? gapR : -gapR), c.y + labH * 0.35, lab, { sizePt: labPt, fill: pal.ink700, anchor: side === "right" ? "start" : "end" });
  });
  return endChart(ctx);
}

/** Titik kendali kurva: lengkung 20 % panjang ke kanan arah gerak (layar, y ke bawah). */
function control(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (a.x + b.x) / 2 - ((b.y - a.y) / len) * 0.2 * len, y: (a.y + b.y) / 2 + ((b.x - a.x) / len) * 0.2 * len };
}

type Side = "below" | "above" | "right" | "left";
const SIDES: ReadonlyArray<[Side, number, number]> = [
  ["below", 0, 1],
  ["above", 0, -1],
  ["right", 1, 0],
  ["left", -1, 0],
];

/** Sisi label simpul dengan kurva paling sedikit dalam 60 derajat; seri = urutan SIDES. */
function labelSide(dirs: ReadonlyArray<{ x: number; y: number }>): Side {
  let best: Side = "below";
  let bestScore = Infinity;
  for (const [side, sx, sy] of SIDES) {
    const score = dirs.filter((d) => d.x * sx + d.y * sy > 0.5).length;
    if (score < bestScore) {
      best = side;
      bestScore = score;
    }
  }
  return best;
}

function drawFlow(
  ctx: GCtx,
  a: { x: number; y: number },
  b: { x: number; y: number },
  w: number,
  r: number,
  colour: string,
  index: number,
  valueLabel: string | undefined,
): void {
  const { doc, pal } = ctx;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  // Lengkung ke kanan arah gerak (layar, y ke bawah): normal (-dy, dx).
  const nx = -dy / len;
  const ny = dx / len;
  const c = control(a, b);
  const unit = (p: { x: number; y: number }, q: { x: number; y: number }) => {
    const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    return { x: (q.x - p.x) / l, y: (q.y - p.y) / l };
  };
  const u0 = unit(a, c);
  const u1 = unit(c, b);
  const s = { x: a.x + u0.x * (r + 0.3), y: a.y + u0.y * (r + 0.3) };
  const tip = { x: b.x - u1.x * (r + 0.4), y: b.y - u1.y * (r + 0.4) };
  const headL = Math.max(1.3, w * 2.2);
  const headW = Math.max(0.65, w * 1.3);
  const base = { x: tip.x - u1.x * headL, y: tip.y - u1.y * headL };
  const mark = { mark: "link" as const, series: "aliran", index };
  doc.path(`M${num(s.x)} ${num(s.y)}Q${num(c.x)} ${num(c.y)} ${num(base.x)} ${num(base.y)}`, "none", {
    mark,
    stroke: colour,
    strokeWidthMm: w,
  });
  const px = -u1.y * headW;
  const py = u1.x * headW;
  doc.path(
    `M${num(tip.x)} ${num(tip.y)}L${num(base.x + px)} ${num(base.y + py)}L${num(base.x - px)} ${num(base.y - py)}Z`,
    colour,
    { mark },
  );
  if (valueLabel) {
    // Titik kurva t = 0,5, digeser ke sisi cembung.
    const mx = 0.25 * a.x + 0.5 * c.x + 0.25 * b.x + nx * (w / 2 + 1.2);
    const my = 0.25 * a.y + 0.5 * c.y + 0.25 * b.y + ny * (w / 2 + 1.2);
    const size = Math.max(ctx.minFontPt, 6.0);
    doc.text(mx, my + ptToMm(size) * 0.35, valueLabel, { face: "data", sizePt: size, fill: pal.ink700, anchor: "middle", attrs: ' data-label="value"' });
  }
}
