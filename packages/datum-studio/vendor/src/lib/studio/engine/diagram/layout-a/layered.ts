/**
 * Port `layout_layered` (`HS/datum_diagram.py:452-479`): tingkat vertikal, satu
 * lebar per tingkat (P5). Dipakai keluarga layered, topology, stack.
 */
import type { DiagramBox, DiagramNode, DiagramSheet, LayoutResult, StudioDiagramV1 } from "../../../contract";
import { diagramFitActive, diagramFitAllows, diagramFitNote, diagramFitQuiet } from "../fit/state";
import { fitTierWidth, grownHeight, planNodeText } from "../fit/text";
import { baselineStepMm, latticeOf, nodeSize, pyStr, sheetHeight, snap, type Lattice } from "./geometry";
import { textNeedMm } from "../core/geometry";
import { DiagramDefect } from "../core/defect";
import { svgTextLines } from "../core/svg";
import { pt2mm, role } from "../core/tokens";
import { measure, wrap } from "../../chart/core/textfit";
import { elkPlanFor, elkTierOrder, elkTierXs } from "../elk/plan";

/** `n.get("class", {}).get("tier", n.get("class", {}).get("row", 0))` lalu `str()`. Row 162: exported for the ELK adapter. */
export function tierKey(n: DiagramNode): string {
  const cls = (n.class ?? {}) as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(cls, k);
  const v = has("tier") ? cls.tier : has("row") ? cls.row : 0;
  return pyStr(v);
}

/**
 * FIX-B2 (D-277, D-242 "ubah mesin ke ukuran BM"): jarak antartingkat keluarga
 * `layered`, diukur pada satu-satunya acuan layered BM Manual 000 (Gambar 2.1,
 * `assets/image4__g21.png`, digambar `datum_diagram.py keluarga layered`;
 * 1961 px = 166 mm, 1 baseline = 56,3 px): tepi bawah simpul tingkat n ke tepi
 * atas simpul tingkat n+1 = 280 px = 5 baseline, tersusun dari rem pita
 * tingkat 1 baseline + koridor label konektor 3 baseline (169 px, di antara
 * garis pita) + rem pita 1 baseline; sama pada kedua celah. Keluarga topology
 * dan stack (berbagi mesin ini, tanpa pita tingkat) tetap 2 baseline (K-1).
 * Berlaku untuk SEMUA spec layered (D-139: tanpa pengecualian per figur).
 */
export const LAYERED_TIER_GAP_BASELINES = 5;

/**
 * Swarm 1.3.3 row 47 (ST-3 item 7): default node width in lattice columns. It is the floor every family already gives
 * a node (`nodeSize`: `max(snap(text), 3 columns)`), named here because a node alone on its tier now takes it.
 */
export const LONE_NODE_WIDTH_COLS = 3;

/** Row 47: families whose one-node tier takes the default node width (`stack` keeps its full-width bar: a stack layer is a band). */
export const LONE_NODE_FAMILIES: ReadonlySet<string> = new Set(["layered", "topology"]);

/**
 * Row 47: width (mm) of a node alone on its tier: the default width, or the lattice width that holds its own label
 * and sub on one line when that is wider (locked up, so the text keeps its caption margin); never more than `cap`
 * (the shared tier width it had before). Label fit may still widen it for a shape whose text area is narrower.
 */
function loneNodeWidthMm(n: DiagramNode, lat: Pick<Lattice, "x">, cap: number): number {
  const text = Math.ceil((textNeedMm(n) - 1e-9) / lat.x) * lat.x;
  return Math.min(Math.max(text, lat.x * LONE_NODE_WIDTH_COLS), cap);
}

/**
 * Nominal tier node width (mm) before label fit; row 162: one formula shared with the ELK adapter.
 * Row 47: with `lone` (the single node of a tier that `loneNarrowTiers` cleared) the tier takes `loneNodeWidthMm`
 * instead of the stretched share. Every call without `lone` returns the same number as before.
 */
export function tierWidthMm(m: number, W: number, lat: Pick<Lattice, "x">, lone?: DiagramNode): number {
  const w = snap((W - (m - 1) * lat.x) / m, lat.x);
  const shared = Math.max(Math.min(w, lat.x * 10), lat.x * 3);
  return lone && m === 1 ? loneNodeWidthMm(lone, lat, shared) : shared;
}

/**
 * Swarm 1.3.3 row 139 (ST-1, E3 of row 36): the most nodes one tier holds on `W` mm (the sheet width, or the width right
 * of a tier label band): m nodes of the 3-column floor of `tierWidthMm` plus m - 1 one-column gaps. At 128 mm 3, at
 * 166 mm 4; a band takes one node at either width (row 56). `layoutLayered` refuses a fuller tier before it places a
 * node, so the plain placement never anchors a node on (or past) the right edge.
 */
export function tierCapacity(W: number, latX: number): number {
  return Math.max(1, Math.floor((W / latX + 1 + 1e-9) / 4));
}

/** Row 139: families `layoutLayered` places (contract dispatch DIAGRAM_LAYOUTS). */
export const TIERED_FAMILIES: ReadonlySet<string> = new Set(["layered", "topology", "stack"]);

/**
 * Row 139: the fullest tier of `s` and the nodes one tier holds at figure width `widthMm` (label band included), for
 * the capacity refusal and its two-width advice (build/capacity.ts).
 */
export function tierLoad(s: StudioDiagramV1, widthMm: number, latX: number): { tier: string; count: number; perTier: number } {
  const per = new Map<string, number>();
  for (const n of s.nodes ?? []) per.set(tierKey(n), (per.get(tierKey(n)) ?? 0) + 1);
  const [tier, count] = [...per].reduce((a, b) => (b[1] > a[1] ? b : a), ["", 0] as [string, number]);
  return { tier, count, perTier: tierCapacity(widthMm - (tierLabelBand(s, latX)?.widthMm ?? 0), latX) };
}

/**
 * Swarm 1.3.3 row 56 (ST-5): labelled tiers. `tiers[] {tier, label}` (contract row 26) is printed for these two families
 * only; every other family refuses the field (`assertTierLabels`, called once per build from `build/place.ts`).
 */
export const TIER_LABEL_FAMILIES: ReadonlySet<string> = new Set(["layered", "topology"]);

/** Row 56: check id of every `tiers[]` refusal. */
export const TIER_LABEL_CHECK = "P1-tiers";

/**
 * Row 56: the typographic role of a tier label: `table_header` (IBM Plex Sans Condensed 6.8 pt, SemiBold, tracking
 * 0.09 em, ink400), the role of container titles and lane heads, printed with `upper: false` so the author's letter
 * case is kept.
 */
export const TIER_LABEL_ROLE = "table_header";

/** Row 56: widest text column of the tier label band, in lattice columns; a longer label wraps (at most 3 lines). */
export const TIER_LABEL_MAX_COLS = 3;
export const TIER_LABEL_MAX_LINES = 3;

/** Row 56: line step of a wrapped tier label, in label sizes. */
const TIER_LABEL_LEADING = 1.25;

/** Row 56: the tier label band a layout reserved (absent when the spec has no `tiers[]` entry). */
export interface TierLabelBand {
  /** Band width (mm) at the left edge of the sheet: nodes of every tier start at or right of it. */
  widthMm: number;
  /** One entry per labelled tier: the tier key (`tierKey`) and the label lines, letter case as written. */
  labels: Array<{ tier: string; lines: string[] }>;
}

/** Row 56: what `layoutLayered` adds to its `LayoutResult` when a band is reserved. */
export interface TierLabelLayoutExtras {
  tierBand?: TierLabelBand;
}

function tierLabelFont() {
  const r = role(TIER_LABEL_ROLE);
  return { pt: r.size, bold: (r.weight ?? 400) >= 600, trackMm: pt2mm(r.size) * (r.track_em ?? 0) };
}

/**
 * Row 56 (ST-5: an accepted field is printed or refused). Refuses `tiers[]` with at least one entry on a family that
 * does not print it (by field name), an entry whose tier holds no node (with the entry index and tier), and a tier
 * named twice. An empty array, or no field, passes for every family (nothing to print). Pure; throws `DiagramDefect`.
 */
export function assertTierLabels(s: StudioDiagramV1): void {
  const tiers = s.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) return;
  const fam = String(s.family);
  if (!TIER_LABEL_FAMILIES.has(fam)) {
    throw new DiagramDefect(
      `tiers: keluarga '${fam}' tidak mencetak label tingkat; medan tiers hanya untuk keluarga layered dan topology (hapus tiers, atau pakai keluarga layered/topology)`,
      { checkId: TIER_LABEL_CHECK, pointer: "/tiers" },
    );
  }
  const used = [...new Set((s.nodes ?? []).map(tierKey))];
  const seen = new Set<string>();
  tiers.forEach((t, i) => {
    const k = pyStr(t.tier);
    if (seen.has(k)) {
      throw new DiagramDefect(`tiers[${i}]: tingkat ${k} sudah diberi label oleh entri sebelumnya; satu entri per tingkat`, {
        checkId: TIER_LABEL_CHECK,
        pointer: `/tiers/${i}/tier`,
      });
    }
    seen.add(k);
    if (!used.includes(k)) {
      throw new DiagramDefect(
        `tiers[${i}]: tingkat ${k} tidak punya simpul (class.tier yang dipakai: ${used.join(", ")}); hapus entri ini atau beri simpul class.tier ${k}`,
        { checkId: TIER_LABEL_CHECK, pointer: `/tiers/${i}/tier` },
      );
    }
  });
}

/**
 * Row 56: the band the labels of `s.tiers` need, or undefined (no entry, or a family that does not print tiers).
 * Band = the widest label on one line (capped at `TIER_LABEL_MAX_COLS` columns, longer labels wrap) plus half a lattice
 * column of clearance, rounded up to whole lattice columns so every node stays on the lattice.
 */
function tierLabelBand(s: StudioDiagramV1, latX: number): TierLabelBand | undefined {
  if (!Array.isArray(s.tiers) || s.tiers.length === 0 || !TIER_LABEL_FAMILIES.has(String(s.family))) return undefined;
  const font = tierLabelFont();
  const cap = TIER_LABEL_MAX_COLS * latX - latX / 2;
  const text = Math.min(cap, Math.max(...s.tiers.map((t) => measure(String(t.label), font.pt, "struct", font))));
  const widthMm = Math.ceil((text + latX / 2 - 1e-9) / latX) * latX;
  const labels = s.tiers.map((t, i) => {
    const r = wrap(String(t.label), widthMm - latX / 2, TIER_LABEL_MAX_LINES, font);
    const joined = r.lines.join(" ").replace(/\s+/g, " ").trim();
    if (!r.fits || joined !== String(t.label).replace(/\s+/g, " ").trim()) {
      throw new DiagramDefect(
        `tiers[${i}]: label tingkat ${pyStr(t.tier)} tidak muat dalam ${TIER_LABEL_MAX_LINES} baris selebar ${(widthMm - latX / 2).toFixed(1)} mm; persingkat label`,
        { checkId: TIER_LABEL_CHECK, pointer: `/tiers/${i}/label` },
      );
    }
    return { tier: pyStr(t.tier), lines: r.lines };
  });
  return { widthMm, labels };
}

/** Row 56: line step (mm) of a tier label and the height its `n` lines take (first cap top to last baseline). */
function tierLabelMetrics(n: number): { size: number; step: number; height: number } {
  const size = pt2mm(role(TIER_LABEL_ROLE).size);
  const step = size * TIER_LABEL_LEADING;
  return { size, step, height: (n - 1) * step + size * 0.72 };
}

/**
 * Row 56: the SVG of the tier labels, one `<text>` per labelled tier at the left edge of the band (x 0, anchor start),
 * vertically centred on the tier's node row. Drawn by `build/svg.ts` from the placed nodes; nothing when no band.
 */
export function tierLabelSvgs(s: StudioDiagramV1, band: TierLabelBand | undefined, nodes: Iterable<{ spec: DiagramNode; y: number; h: number }>): string[] {
  if (!band) return [];
  const rows = new Map<string, { y0: number; y1: number }>();
  for (const nd of nodes) {
    const k = tierKey(nd.spec);
    const r = rows.get(k);
    rows.set(k, r ? { y0: Math.min(r.y0, nd.y), y1: Math.max(r.y1, nd.y + nd.h) } : { y0: nd.y, y1: nd.y + nd.h });
  }
  const out: string[] = [];
  for (const l of band.labels) {
    const r = rows.get(l.tier);
    if (!r) continue; // refused before layout (assertTierLabels)
    const m = tierLabelMetrics(l.lines.length);
    const top = (r.y0 + r.y1) / 2 - m.height / 2;
    out.push(svgTextLines({ x: 0, y: top + m.size * 0.72, lines: l.lines, lineMm: m.step }, { role: TIER_LABEL_ROLE, upper: false, anchor: "start" }));
  }
  return out;
}

/** Row 47: x placement of one tier (no y yet): its nodes in drawing order, the shared width and height, the left x of each. */
interface TierRow {
  group: DiagramNode[];
  w: number;
  h: number;
  xs: number[];
}

/**
 * Row 47: the one-node tiers that take the default node width. `rows` is the layout with EVERY one-node tier at the
 * default width.
 * Swarm 1.3.3 row 136: a lone node that feeds nodes beyond its own outline (a hub) takes the default width too: the
 * router (`build/route.ts`, `narrowLoneNodes`) fans its links across its bottom or top and turns them in the tier gap.
 * One case keeps the shared tier width, as row 47 left it: a link across a tier gap that holds a zone title (the lower
 * tier of the gap is the top tier of a zone) to a node that does not lie under (or over) the lone node by at least one
 * lattice column. The fan's turn or drop would run through that title (GEOM_EDGE_HEADER, measured on round 2 `u1/1`
 * and round 1 `p4/18.3` at 128 mm; see implementation/136_st3_lone_hub_routing.md).
 */
function loneNarrowTiers(s: StudioDiagramV1, rows: readonly TierRow[], latX: number): Set<number> {
  const at = new Map<string, { ti: number; x0: number; x1: number }>();
  rows.forEach((r, ti) => r.group.forEach((n, i) => at.set(String(n.id), { ti, x0: r.xs[i], x1: r.xs[i] + r.w })));
  /** Tiers whose gap above holds a zone title: the top tier of each zone. */
  const titled = new Set((s.zones ?? []).map((z) => Math.min(...(z.members ?? []).map((id) => at.get(String(id))?.ti ?? Infinity))));
  const out = new Set<number>();
  rows.forEach((r, ti) => {
    if (r.group.length !== 1) return;
    const me = at.get(String(r.group[0].id))!;
    const ok = (s.edges ?? []).every((e) => {
      const a = at.get(String(e.from));
      const b = at.get(String(e.to));
      if (!a || !b || (a !== me && b !== me)) return true;
      const o = a === me ? b : a;
      if (Math.abs(o.ti - ti) !== 1) return true; // a longer link is routed around the tiers between, as before
      if (!titled.has(Math.max(o.ti, ti))) return true; // row 136: the router fans this link from the node's bottom or top
      return Math.min(me.x1, o.x1) - Math.max(me.x0, o.x0) >= latX - 1e-6;
    });
    if (ok) out.add(ti);
  });
  return out;
}

/**
 * Swarm 1.2.9 row 29 (AC-A06): tier width for a tier that holds a zone member. The zone frame runs half a column
 * outside its members (build/fitlabels.ts `zoneGeom`); a member laid out within half a column of a sheet side would put
 * the frame off the sheet (BASE: dg_topology `srv` at x 0, frame clipped 0.13 mm from its outline). The tier then
 * narrows one lattice column at a time (x stays centred and on the lattice, so the members move inward by at least half
 * a column) until every member keeps half a column to both sides, down to the 3-column floor of `tierWidthMm`. A tier
 * whose members already have that room keeps its width.
 */
function zoneTierWidth(
  group: readonly DiagramNode[],
  w0: number,
  gap: number,
  W: number,
  lat: Lattice,
  zoned: ReadonlySet<string>,
  elkXs: ((w: number) => number[] | undefined) | undefined,
): number {
  const m = group.length;
  const half = lat.x / 2;
  const leaves = (w: number): boolean => {
    const x = snap(Math.max(0.0, (W - (m * w + (m - 1) * gap)) / 2.0), lat.x);
    const xs = elkXs?.(w) ?? group.map((_, i) => x + i * (w + gap)); // as the layout below: no ELK xs = centred tier
    return group.some((n, i) => zoned.has(String(n.id)) && (xs[i] - half < -1e-6 || xs[i] + w + half > W + 1e-6));
  };
  let w = w0;
  while (leaves(w) && w - lat.x >= lat.x * 3 - 1e-6) w = snap(w - lat.x, lat.x);
  return w;
}

export function layoutLayered(s: StudioDiagramV1, sheet: DiagramSheet): LayoutResult & TierLabelLayoutExtras {
  const lat = latticeOf(sheet);
  // Swarm 1.3.3 row 56 (ST-5): a spec with `tiers[]` (layered, topology) reserves the label band at the left edge: the
  // tiers are laid out on the width right of it (`W`) and moved right by the band (`bandMm`). No band = 0 = as before.
  const band = tierLabelBand(s, lat.x);
  const bandMm = band?.widthMm ?? 0;
  const W = sheet.widthMm - bandMm;
  const tiers: DiagramNode[][] = [];
  const index = new Map<string, number>();
  for (const n of s.nodes) {
    const t = tierKey(n);
    let i = index.get(t);
    if (i === undefined) {
      i = tiers.length;
      index.set(t, i);
      tiers.push([]);
    }
    tiers[i].push(n);
  }
  // Swarm 1.3.3 row 139 (ST-1, E3): capacity before placement. A tier fuller than the width holds is refused here as a
  // capacity refusal (DATUM-37-sheet, measured in nodes per tier by build/capacity.ts), never placed with its last node
  // on the right edge. A tier within capacity is placed exactly as before.
  const cap = tierCapacity(W, lat.x);
  const axis = s.family === "stack" ? "lapis" : "tingkat";
  const full = tiers.findIndex((t) => t.length > cap);
  if (full >= 0) {
    throw new DiagramDefect(
      `DATUM-37-sheet: ${axis} ${[...index.keys()][full]} memuat ${tiers[full].length} simpul, maks ${cap} simpul per ${axis} pada ${sheet.widthMm} mm` +
        `${band ? ` (lebar di kanan pita label tingkat ${bandMm.toFixed(1)} mm tinggal ${W.toFixed(1)} mm)` : ""} (P8)`,
      { checkId: "DATUM-37-sheet" },
    );
  }

  // Swarm patch (row 162, U24 C): when the ELK adapter (engine/diagram/elk) has an active plan for
  // this spec and width, the order inside each tier and the node x come from ELK; tier y, sizes, fit
  // and snap stay as below. No plan (the default) = the original layout, unchanged.
  const elk = elkPlanFor(s, W);
  // Swarm 1.2.9 row 29 (AC-A06): ids of zone members (no zone = an empty set = the layout below, unchanged).
  const zoned = new Set((s.zones ?? []).flatMap((z) => (z.members ?? []).map((id) => String(id))));
  // D-242: dua baseline (Python: BASELINE_PT * 2 dibaca mm); keluarga layered
  // memakai langkah pita tingkat (FIX-B2, LAYERED_TIER_GAP_BASELINES).
  const tierStep = baselineStepMm(s.family === "layered" ? LAYERED_TIER_GAP_BASELINES : 2, lat);
  const keys = [...index.keys()];
  /** One tier's width, height and x values; `lone` = this one-node tier takes the default node width (row 47). */
  const tierRow = (ti: number, lone: boolean): TierRow => {
    const group = elk ? elkTierOrder(elk, keys[ti], tiers[ti]) : tiers[ti];
    const m = group.length;
    const gap = lat.x;
    let w = tierWidthMm(m, W, lat, lone ? group[0] : undefined);
    // Row 56: right of a label band the shared width (rounded to the lattice) may overshoot the width left; narrow it
    // one lattice column at a time, down to the 3-column floor (a tier that still does not fit is refused below).
    if (bandMm > 0) while (m * w + (m - 1) * gap > W + 1e-6 && w - lat.x >= lat.x * 3 - 1e-6) w = snap(w - lat.x, lat.x);
    let hmax = -Infinity;
    for (const n of group) {
      const [, h] = nodeSize(n, lat, group);
      if (h > hmax) hmax = h;
    }
    if (diagramFitActive()) {
      // FIG-02b P1-10: lebar berbasis label (bungkus <= 3 baris), tinggi tumbuh per baris.
      const wMax = Math.max(w, Math.floor((W - (m - 1) * gap) / m / lat.x + 1e-9) * lat.x);
      w = fitTierWidth(group, w, wMax, lat.x, hmax).w;
    }
    // Swarm 1.2.9 row 29 (AC-A06): a tier holding a zone member narrows (before the text plan below sees its width).
    if (zoned.size) w = zoneTierWidth(group, w, gap, W, lat, zoned, elk ? (ww) => elkTierXs(elk, group, ww, gap, W, lat.x) : undefined);
    if (diagramFitActive()) {
      let grown = hmax;
      for (const n of group) {
        const plan = planNodeText(n, w, hmax);
        if (diagramFitAllows("grow")) grown = Math.max(grown, grownHeight(hmax, plan, lat.y));
        if (plan.overflow) {
          diagramFitNote(
            "NODE_LABEL_LINES",
            `label simpul '${pyStr(n.id)}' butuh lebih dari 3 baris pada lebar ${w.toFixed(1)} mm (${m} simpul setingkat)`,
            "persingkat label simpul (maks ~40 karakter); detail ke `sub`",
          );
        }
      }
      hmax = grown;
    }
    const total = m * w + (m - 1) * gap;
    const x = snap(Math.max(0.0, (W - total) / 2.0), lat.x);
    const xs = (elk ? elkTierXs(elk, group, w, gap, W, lat.x) : undefined) ?? group.map((_, i) => x + i * (w + gap)); // row 162
    return { group, w, h: hmax, xs };
  };
  // Row 47 (ST-3 item 7): which one-node tiers take the default node width. Decided on a trial placement (no fit
  // notes kept) with every one-node tier at the default width; a spec without a one-node tier, and the stack family,
  // skip the trial and run the loop below exactly as before.
  const loneAt = LONE_NODE_FAMILIES.has(String(s.family)) ? tiers.map((t) => t.length === 1) : [];
  const narrow = loneAt.some(Boolean)
    ? loneNarrowTiers(s, diagramFitQuiet(() => tiers.map((_, ti) => tierRow(ti, loneAt[ti]))), lat.x)
    : new Set<number>();
  const nodes: Record<string, DiagramBox> = {};
  let y = lat.top;
  for (const ti of tiers.keys()) {
    const row = tierRow(ti, narrow.has(ti));
    // Row 56: with a label band the tier must fit right of it. A tier wider than the width left is refused here as a
    // capacity refusal (DATUM-37-sheet), not handed to the lattice clamp, which would shorten the last node.
    const right = Math.max(...row.xs.map((x) => x + row.w));
    if (band && right > W + 1e-6) {
      throw new DiagramDefect(
        `DATUM-37-sheet: tingkat ${keys[ti]} (${row.group.length} simpul) butuh ${right.toFixed(1)} mm, lebar di kanan pita label tingkat ${bandMm.toFixed(1)} mm tinggal ${W.toFixed(1)} mm (P8)`,
        { checkId: "DATUM-37-sheet" },
      );
    }
    row.group.forEach((n, i) => {
      nodes[n.id] = { x: row.xs[i] + bandMm, y, w: row.w, h: row.h };
    });
    // Row 56: a labelled tier's label lines fit inside its node row (no overprint of the gap above or below).
    const lab = band?.labels.find((l) => l.tier === keys[ti]);
    if (lab && tierLabelMetrics(lab.lines.length).height > row.h + 1e-6) {
      throw new DiagramDefect(`tiers: label tingkat ${lab.tier} (${lab.lines.length} baris) lebih tinggi dari baris simpulnya (${row.h.toFixed(1)} mm); persingkat label`, {
        checkId: TIER_LABEL_CHECK,
        pointer: "/tiers",
      });
    }
    // Python: `y = y + hmax + snap(...)` = (y + hmax) + langkah.
    y = y + row.h + tierStep;
  }
  const out: LayoutResult & TierLabelLayoutExtras = { nodes, widthMm: sheet.widthMm, heightMm: sheetHeight(lat, Object.values(nodes)) };
  if (band) out.tierBand = band;
  return out;
}
