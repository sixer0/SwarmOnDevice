/**
 * Rakitan diagram saat fit (FIG-02b): rintangan label tepi, jepit label zona (P2-16), dan baris
 * catatan label bernomor (P1-13). Hanya dipanggil dari `build/svg.ts` bila `diagramFitActive()`.
 */
import type { DiagramZone, RoutedEdge, StudioDiagramV1 } from "../../../contract";
import { FONT_ASCENT_EM, FONT_DESCENT_EM, measure } from "../../chart/core/textfit";
import { EDGE_KINDS, LATTICE_Y, pt2mm, role, STROKE_PRIMARY, svgText, type Sheet, type SheetNode } from "../core";
import { edgeArrowsOfPaths, edgeLineDash, type EdgeArrows } from "../core/svg";
import { ARROW_SIZES_MM } from "../core/tokens";
import { decorationOf, type Box, type HeadSize } from "../fit/lint";
import { labelAtBaseline, placeEdgeLabels, type EdgeLabelInput, type EdgeLabelPlan, layoutNotes } from "../fit/labels";
import { diagramFitAllows, diagramFitNote } from "../fit/state";
import { capLineMm, capWidthMm, nodeTextLayout } from "../fit/text";
import { flowDirectionOf } from "../layout-a/flow";

const SUGGEST_EDGE = "persingkat label tepi (maks ~20 karakter)";

/** Kotak teks satu baris (garis dasar `y`, anchor) untuk ukuran `sizeMm`. */
function textBox(x: number, y: number, w: number, sizeMm: number, anchor: "start" | "middle" | "end"): Box {
  const x0 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  return [x0, y - FONT_ASCENT_EM * sizeMm, x0 + w, y + FONT_DESCENT_EM * sizeMm];
}

function headerWidth(s: string): number {
  const r = role("table_header");
  return measure(s, r.size, "struct", { bold: (r.weight ?? 400) >= 600, caps: Boolean(r.upper), trackMm: pt2mm(r.size) * (r.track_em ?? 0) });
}

export interface ZoneGeom {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  lx: number;
  ly: number;
}

/**
 * Swarm 1.2.9 row 29 (AC-A06, register N9-051): least distance (mm, centre lines) from a zone frame to every member
 * outline and to every non-member outline it runs beside (C10(b)); the precedent is `SHARED_BAND_CLEAR_MM` in route.ts.
 * @internal test seam
 */
export const ZONE_CLEAR_MM = 1.5;

/**
 * Row 29 (AC-A06): the frame pads (left, top, right, bottom) of a zone around its members' box. A pad starts at the
 * Garis A default (half a column across, two lattice rows down) and is capped where a non-member outline lies beside
 * that side over an overlapping span, so the frame stays `ZONE_CLEAR_MM` off it and `ZONE_CLEAR_MM` outside the
 * members; with less than twice that room the frame takes the middle. A pad with no such neighbour keeps its value, so
 * a zone with room around it keeps its bytes.
 */
function zonePads(members: readonly SheetNode[], sheet: Sheet, box: readonly [number, number, number, number]): [number, number, number, number] {
  const [x0, y0, x1, y1] = box;
  const cap = (pad: number, room: number) => Math.min(pad, room >= 2 * ZONE_CLEAR_MM ? room - ZONE_CLEAR_MM : room / 2);
  let [pl, pt, pr, pb] = [sheet.colMm / 2, LATTICE_Y * 2, sheet.colMm / 2, LATTICE_Y * 2];
  const others = [...sheet.nodes.values()].filter((nd) => !members.includes(nd)).map(nodeBox);
  // top and bottom against a node over the frame's x span, wholly above or below the members
  for (const [nx0, ny0, nx1, ny1] of others) {
    if (!(nx0 < x1 + pr && nx1 > x0 - pl)) continue;
    if (ny0 >= y1 - 1e-6) pb = cap(pb, ny0 - y1);
    if (ny1 <= y0 + 1e-6) pt = cap(pt, y0 - ny1);
  }
  // left and right against a node over the (capped) frame's y span, wholly left or right of the members
  for (const [nx0, ny0, nx1, ny1] of others) {
    if (!(ny0 < y1 + pb && ny1 > y0 - pt)) continue;
    if (nx0 >= x1 - 1e-6) pr = cap(pr, nx0 - x1);
    if (nx1 <= x0 + 1e-6) pl = cap(pl, x0 - nx1);
  }
  return [pl, pt, pr, pb];
}

/** Row 29 (AC-A06): whether zone frames keep `ZONE_CLEAR_MM` (every spec except a legacy flow, C10(a)/C12). */
export function zoneClearOn(s: StudioDiagramV1): boolean {
  return !(s.family === "flow" && !flowDirectionOf(s as StudioDiagramV1 & { direction?: unknown }));
}

/**
 * Geometri zona Garis A; saat fit label dijepit ke dalam lembar (rect tidak diubah).
 * Row 29 (AC-A06): with `clear` the pads keep `ZONE_CLEAR_MM` off non-member outlines (`zonePads`). The caller passes
 * false for a legacy flow (family `flow` without `direction`, frozen at its 1.2.5 bytes, 01e A15, C10(a), C12).
 */
export function zoneGeom(z: DiagramZone, members: readonly SheetNode[], sheet: Sheet, fit: boolean, clear = false): ZoneGeom {
  const box = [
    Math.min(...members.map((m) => m.x)),
    Math.min(...members.map((m) => m.y)),
    Math.max(...members.map((m) => m.x + m.w)),
    Math.max(...members.map((m) => m.y + m.h)),
  ] as const;
  const [pl, pt, pr, pb] = clear ? zonePads(members, sheet, box) : [sheet.colMm / 2, LATTICE_Y * 2, sheet.colMm / 2, LATTICE_Y * 2];
  const zx = box[0] - pl;
  const zy = box[1] - pt;
  const zw = box[2] - zx + pr;
  const zh = box[3] - zy + pb;
  const label = String(z.label !== undefined ? z.label : z.id !== undefined ? z.id : "zona");
  let lx = zx + 1.0;
  let ly = zy + pt2mm(5.0);
  if (fit) {
    const size = pt2mm(role("table_header").size);
    const lw = headerWidth(label);
    const nx = Math.min(Math.max(lx, 0.5), Math.max(0.5, sheet.widthMm - lw - 0.5));
    const ny = Math.max(ly, FONT_ASCENT_EM * size + 0.4);
    if (Math.abs(nx - lx) > 1e-9 || Math.abs(ny - ly) > 1e-9) {
      diagramFitNote("ZONE_LABEL_CLAMP", `label zona '${label}' dijepit ke dalam lembar`);
      lx = nx;
      ly = ny;
    }
  }
  return { x: zx, y: zy, w: zw, h: zh, label, lx, ly };
}

function zoneLabelBox(g: ZoneGeom): Box {
  return textBox(g.lx, g.ly, headerWidth(g.label), pt2mm(role("table_header").size), "start");
}

/** Kotak simpul untuk rintangan label: rel bus hanya batangnya (ruang di atas/bawah bebas). */
function nodeBox(nd: SheetNode): Box {
  if (nd.spec.shape === "bus") {
    const cy = nd.y + nd.h / 2;
    const half = (STROKE_PRIMARY * 3) / 2 + 0.3;
    return [nd.x, cy - half, nd.x + nd.w, cy + half];
  }
  return [nd.x, nd.y, nd.x + nd.w, nd.y + nd.h];
}

/** Kotak teks label simpul (satu baris di pusat, atau tata letak fit). */
function nodeTextBox(nd: SheetNode): Box {
  const capMm = pt2mm(role("caption").size);
  const lay = nodeTextLayout(nd);
  if (lay) {
    const w = Math.max(...lay.label.lines.map(capWidthMm));
    const b = textBox(lay.label.x, lay.label.y, w, capMm, "middle");
    return [b[0], b[1], b[2], b[3] + (lay.label.lines.length - 1) * capLineMm()];
  }
  return textBox(nd.x + nd.w / 2, nd.y + nd.h / 2, capWidthMm(String(nd.spec.label ?? "")), capMm, "middle");
}

export interface FitLabelInputs {
  s: StudioDiagramV1;
  sheet: Sheet;
  nodes: readonly SheetNode[];
  paths: readonly RoutedEdge[];
  /** Posisi bawaan per konektor (pusat x, garis dasar). */
  orig: ReadonlyArray<readonly [number, number]>;
  yMax: number;
  yMin?: number;
  /**
   * Row 57c: the frame decoration the sheet draws (swimlane lane rules, phase separators and headers, pool borders and
   * labels, as SVG elements): its rules may not be crossed by a label band, its texts are obstacles.
   */
  decoration?: readonly string[];
}

/** Row 57c: marker size (mm) of a head as core/svg.ts `arrowMarkerSvg` draws it (W = 0.89 L). */
function headSize(h: EdgeArrows["end"] | EdgeArrows["start"]): HeadSize | null {
  if (!h) return null;
  const L = ARROW_SIZES_MM[h === "kind" ? "m" : h.size];
  return { L, W: 0.89 * L };
}

/** Rencana label tepi saat fit (rintangan: simpul, teks simpul, label zona dan lajur). */
export function fitEdgeLabels(a: FitLabelInputs): EdgeLabelPlan {
  const nodeBoxes = a.nodes.map(nodeBox);
  const obstacles: Box[] = a.nodes.map(nodeTextBox);
  const clear = zoneClearOn(a.s); // row 29 (AC-A06)
  for (const z of a.s.zones ?? []) {
    const members = (z.members ?? []).map((m) => a.sheet.nodes.get(m)).filter((m): m is SheetNode => m !== undefined);
    if (members.length) obstacles.push(zoneLabelBox(zoneGeom(z, members, a.sheet, true, clear)));
  }
  const hdr = pt2mm(role("table_header").size);
  for (const lane of a.sheet.lanes) obstacles.push(textBox(0.5, lane.y + hdr + LATTICE_Y / 2.0, headerWidth(lane.name), hdr, "start"));
  // Row 57c: frame rules and header texts (lane, phase, pool) from the decoration the sheet draws.
  const deco = a.decoration?.length ? decorationOf(a.decoration, a.sheet.widthMm) : { rules: [], texts: [] };
  obstacles.push(...deco.texts);
  // Swarm 1.2.8 row 57b (VIS-9, 01f §3.4): an edge with `label_at` keeps its label at that fraction of the path, fixed.
  const arrows = edgeArrowsOfPaths(a.s.edges ?? [], a.paths);
  const at = arrows.map((x) => x.labelAt);
  const edges: EdgeLabelInput[] = a.paths.map((p, i) => {
    const fixedAt = at[i];
    // Row 57c: the drawn heads, so a band keeps them visible.
    const heads = { end: headSize(arrows[i]?.end ?? null), start: headSize(arrows[i]?.start ?? null) };
    // Row 56d (C134 G3-09): the drawn dash pattern, so a band leaves no stray dash fragment.
    const dash = edgeLineDash(p.kind, arrows[i]?.line)?.split(",").map(Number).filter((v) => Number.isFinite(v));
    const base = { points: p.points, label: String(p.label ?? ""), kind: p.kind, heads, ...(dash?.length ? { dash } : {}) };
    return fixedAt ? { ...base, orig: labelAtBaseline(p.points, fixedAt), fixed: true } : { ...base, orig: a.orig[i] };
  });
  const plan = placeEdgeLabels(edges, {
    W: a.sheet.widthMm,
    yMax: a.yMax,
    yMin: a.yMin,
    nodeBoxes,
    obstacles,
    allowNumbered: diagramFitAllows("numbered"),
    rules: deco.rules,
  });
  const moved = plan.placed.filter((p) => p.mode === "moved").length;
  if (moved) diagramFitNote("LABEL_MOVED", `${moved} label tepi dipindah ke posisi bebas tabrakan`);
  plan.placed.forEach((p, i) => {
    if (p.mode === "leader") diagramFitNote("LABEL_LEADER", `label tepi '${edges[i].label}' digeser dengan garis penunjuk`, SUGGEST_EDGE);
    if (p.mode === "numbered") {
      diagramFitNote("LABEL_NUMBERED", `label tepi '${edges[i].label}' tidak mendapat posisi bebas; diganti nomor ${p.number} + catatan`, SUGGEST_EDGE);
    }
    if (p.mode === "unplaced") diagramFitNote("LABEL_UNPLACED", `label tepi '${edges[i].label}' tidak mendapat posisi bebas tabrakan`, SUGGEST_EDGE);
  });
  return plan;
}

/** Geser rencana label secara vertikal (lembar graph D-290 menggeser isi kelipatan kisi). */
export function shiftPlan(plan: EdgeLabelPlan, dy: number): EdgeLabelPlan {
  if (!dy) return plan;
  return {
    numbered: plan.numbered,
    placed: plan.placed.map((p) => ({ ...p, y: p.y - dy, ...(p.leader ? { leader: [p.leader[0], p.leader[1] - dy, p.leader[2], p.leader[3] - dy] as const } : {}) })),
  };
}

/** Rentang y (atas, bawah) tiap label untuk kotak pembatas lembar graph. */
export function planBands(plan: EdgeLabelPlan): Array<[number, number]> {
  const s = pt2mm(role("evidence_rail").size);
  return plan.placed.map((p) => {
    let lo = p.y - s * 1.15;
    let hi = lo + s * 1.7;
    if (p.leader) {
      lo = Math.min(lo, p.leader[1], p.leader[3]);
      hi = Math.max(hi, p.leader[1], p.leader[3]);
    }
    return [lo, hi];
  });
}

/** Baris catatan label bernomor: jumlah baris dan elemen SVG pada garis dasar pertama `y0`. */
export function noteRows(plan: EdgeLabelPlan, W: number): { rows: number; svg: (y0: number) => string[] } {
  const { items, rows } = layoutNotes(plan.numbered, W);
  return {
    rows,
    svg: (y0) =>
      items.flatMap((it) => {
        const y = y0 + it.row * LATTICE_Y;
        const opts = { role: "evidence_rail", colourToken: EDGE_KINDS[it.kind].colour, anchor: "start" as const };
        return [svgText(it.xNum, y, String(it.number), opts), svgText(it.xText, y, it.text, opts)];
      }),
  };
}
