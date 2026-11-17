/**
 * Rakitan diagram saat fit (FIG-02b): rintangan label tepi, jepit label zona (P2-16), dan baris
 * catatan label bernomor (P1-13). Hanya dipanggil dari `build/svg.ts` bila `diagramFitActive()`.
 */
import type { DiagramZone, RoutedEdge, StudioDiagramV1 } from "../../../contract";
import { FONT_ASCENT_EM, FONT_DESCENT_EM, measure } from "../../chart/core/textfit";
import { EDGE_KINDS, LATTICE_Y, pt2mm, role, STROKE_PRIMARY, svgText, type Sheet, type SheetNode } from "../core";
import { pyNum } from "../core/pyfmt";
import { edgeArrowsOfPaths, edgeLineDash, type EdgeArrows } from "../core/svg";
import { ARROW_SIZES_MM, PAPER, STROKE_HAIR } from "../core/tokens";
import { decorationOf, type Box, type HeadSize } from "../fit/lint";
import { edgeLabelRemedy, labelAtBaseline, placeEdgeLabels, type ContainerRule, type EdgeLabelInput, type EdgeLabelPlan, layoutNotes } from "../fit/labels";
import { diagramFitAllows, diagramFitNote } from "../fit/state";
import { capLineMm, capWidthMm, nodeTextLayout } from "../fit/text";
import { flowDirectionOf } from "../layout-a/flow";

/** Swarm 1.3.3 row 42 (ST-3 item 3): what the author can do about a clamped container label. */
const SUGGEST_ZONE = "persingkat label zona, atau beri zona ruang dari tepi lembar";

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
  /**
   * Swarm 1.3.3 row 42 (ST-3 item 3): the plain ground of the label (`zoneLabelGroundSvg`), to be drawn after every
   * zone frame and right before the label text. Absent for a legacy flow (`clear` false: frozen at its 1.2.5 bytes,
   * C10(a), C12).
   */
  ground?: string;
}

/** Row 42: width (mm) of a container label as drawn (role `table_header`; the case follows the role's `upper`). */
export function zoneLabelWidthMm(label: string): number {
  return headerWidth(label);
}

/** Row 42: the ground runs this far (mm) past the label on its left and right. */
const ZONE_GROUND_PAD_MM = 0.4;
/**
 * Row 42: the ground starts this share of the font size above the baseline: the cap height of the condensed face plus
 * the hair frame line the capitals sit under. It ends `FONT_DESCENT_EM` below the baseline.
 */
const ZONE_GROUND_RISE_EM = 0.8;

/**
 * Swarm 1.3.3 row 42 (ST-3 item 3, gap matrix N17: "label wadah menimpa garis bingkai wadah"): a paper rect under a
 * container label, so a frame line, lane rule or lifeline drawn before it does not run through the letters. The label
 * baseline sits `pt2mm(5)` under the frame's top line, so the capitals touch that line: the ground knocks the line out
 * over the label's width (the label reads as a tab in the frame) and leaves the frame's left side (1 mm away) whole.
 * `dy` = the caller's baseline shift (build/svg.ts draws a `group` label 0.8 mm lower). The rect is clipped to the sheet.
 * `stroke="none"` keeps the geometry lint from reading it as an edge-label band (a filled rect without a stroke
 * attribute right before a text, fit/lint.ts `prevKnock`), as a frame or as a container rule; it carries no
 * `data-mark` (decoration, G-2).
 */
export function zoneLabelGroundSvg(g: Pick<ZoneGeom, "label" | "lx" | "ly">, sheetW: number, dy = 0): string {
  const size = pt2mm(role("table_header").size);
  const x0 = Math.max(0, g.lx - ZONE_GROUND_PAD_MM);
  const x1 = Math.max(x0, Math.min(sheetW, g.lx + headerWidth(g.label) + ZONE_GROUND_PAD_MM));
  const y0 = Math.max(0, g.ly + dy - ZONE_GROUND_RISE_EM * size);
  const y1 = g.ly + dy + FONT_DESCENT_EM * size;
  return `<rect x="${pyNum(x0, 2)}" y="${pyNum(y0, 2)}" width="${pyNum(x1 - x0, 2)}" height="${pyNum(Math.max(0, y1 - y0), 2)}" fill="${PAPER}" stroke="none"/>`;
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
      // Swarm 1.3.3 row 42 (ST-3 item 3): a clamp is never silent. The note says how far the label moved and what the
      // author can do; a label wider than the sheet cannot be clamped into it and is reported as that.
      const mm = (v: number) => pyNum(Math.abs(v), 1);
      const moved = [Math.abs(nx - lx) > 1e-9 ? `${mm(nx - lx)} mm ke ${nx < lx ? "kiri" : "kanan"}` : "", Math.abs(ny - ly) > 1e-9 ? `${mm(ny - ly)} mm ke bawah` : ""].filter(Boolean).join(", ");
      const detail =
        lw > sheet.widthMm - 1.0 + 1e-9
          ? `label zona '${label}' lebih lebar dari lembar (${mm(lw)} mm, lembar ${mm(sheet.widthMm)} mm): digeser ${moved}, tetap keluar lembar`
          : `label zona '${label}' dijepit ke dalam lembar (digeser ${moved})`;
      diagramFitNote("ZONE_LABEL_CLAMP", detail, SUGGEST_ZONE);
      lx = nx;
      ly = ny;
    }
  }
  const g: ZoneGeom = { x: zx, y: zy, w: zw, h: zh, label, lx, ly };
  // Row 42: the ground of the label; a `group` label is drawn 0.8 mm lower (build/svg.ts row 55b).
  if (clear) g.ground = zoneLabelGroundSvg(g, sheet.widthMm, (z as { style?: unknown }).style === "group" ? 0.8 : 0);
  return g;
}

/**
 * Row 42: least gap (mm) between an edge-label band and the stroke of a zone frame side: two print units (coordinates
 * are printed to 0.01 mm), so a band that clears the line in the plan still clears it on paper. Lane rules and pool
 * borders keep no extra gap (row 57c); a larger value here moves labels that do not touch a frame (0.2 mm moved
 * `JALUR UTAMA` of the parity fixture dg_topology, 0.06 mm off its zone frame, and changed that locked fit render).
 */
const ZONE_RULE_CLEAR_MM = 0.02;

/**
 * Swarm 1.3.3 row 42 (ST-3 item 3, gap matrix N17: "label garis menimpa garis bingkai wadah"): the four sides of every
 * zone frame as build/svg.ts draws it (clipped to the sheet on the left, top and right, row 55c), as container rules for
 * the edge-label placement (`EdgeLabelCtx.rules`). They are `strict`: unlike a lane rule, a band may not cover a frame
 * side even where a connector runs along it (R2 u1/1, u1/2: a connector routed on the frame's top line carried its
 * label there). The dashed frame is not a rule for the geometry lint's scanner, so it is handed over here. None for a legacy flow (`zoneClearOn` false: frozen at its 1.2.5 bytes, C10(a), C12).
 */
export function zoneFrameRules(s: StudioDiagramV1, sheet: Sheet, fit: boolean): ContainerRule[] {
  if (!zoneClearOn(s)) return [];
  const out: ContainerRule[] = [];
  const inset = STROKE_HAIR / 2;
  const half = STROKE_HAIR / 2 + ZONE_RULE_CLEAR_MM;
  for (const z of s.zones ?? []) {
    const members = (z.members ?? []).map((m) => sheet.nodes.get(m)).filter((m): m is SheetNode => m !== undefined);
    if (!members.length) continue;
    const g = zoneGeom(z, members, sheet, fit, true);
    const x0 = g.x < 0 ? inset : g.x;
    const y0 = g.y < 0 ? inset : g.y;
    const x1 = g.x + g.w > sheet.widthMm ? sheet.widthMm - inset : g.x + g.w;
    const y1 = g.y + g.h;
    const c: Array<readonly [number, number]> = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    for (let i = 0; i < 4; i++) out.push({ a: c[i], b: c[(i + 1) % 4], half, strict: true });
  }
  return out;
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
    // Swarm 1.3.3 row 42 (ST-3 item 3): zone frames are container rules too (not for a legacy flow).
    rules: [...deco.rules, ...zoneFrameRules(a.s, a.sheet, true)],
  });
  const moved = plan.placed.filter((p) => p.mode === "moved").length;
  if (moved) diagramFitNote("LABEL_MOVED", `${moved} label tepi dipindah ke posisi bebas tabrakan`);
  // Swarm 1.3.3 row 44 (ST-3 item 5): the remedy names the room of the label's own connector (`edgeLabelRemedy`), not a
  // fixed "~20 characters"; a leader is a notice (row 46), numbered / unplaced are the refusal stage and name the label.
  plan.placed.forEach((p, i) => {
    if (p.mode === "leader") diagramFitNote("LABEL_LEADER", `label tepi '${edges[i].label}' digeser dengan garis penunjuk`, edgeLabelRemedy(edges[i]));
    if (p.mode === "numbered") {
      diagramFitNote("LABEL_NUMBERED", `label tepi '${edges[i].label}' tidak mendapat posisi bebas; diganti nomor ${p.number} + catatan`, edgeLabelRemedy(edges[i]));
    }
    if (p.mode === "unplaced") diagramFitNote("LABEL_UNPLACED", `label tepi '${edges[i].label}' tidak mendapat posisi bebas tabrakan`, edgeLabelRemedy(edges[i]));
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
