/**
 * Port `layout_layered` (`HS/datum_diagram.py:452-479`): tingkat vertikal, satu
 * lebar per tingkat (P5). Dipakai keluarga layered, topology, stack.
 */
import type { DiagramBox, DiagramNode, DiagramSheet, LayoutResult, StudioDiagramV1 } from "../../../contract";
import { diagramFitActive, diagramFitAllows, diagramFitNote } from "../fit/state";
import { fitTierWidth, grownHeight, planNodeText } from "../fit/text";
import { baselineStepMm, latticeOf, nodeSize, pyStr, sheetHeight, snap, type Lattice } from "./geometry";
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

/** Nominal tier node width (mm) before label fit; row 162: one formula shared with the ELK adapter. */
export function tierWidthMm(m: number, W: number, lat: Pick<Lattice, "x">): number {
  const w = snap((W - (m - 1) * lat.x) / m, lat.x);
  return Math.max(Math.min(w, lat.x * 10), lat.x * 3);
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

export function layoutLayered(s: StudioDiagramV1, sheet: DiagramSheet): LayoutResult {
  const lat = latticeOf(sheet);
  const W = sheet.widthMm;
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

  // Swarm patch (row 162, U24 C): when the ELK adapter (engine/diagram/elk) has an active plan for
  // this spec and width, the order inside each tier and the node x come from ELK; tier y, sizes, fit
  // and snap stay as below. No plan (the default) = the original layout, unchanged.
  const elk = elkPlanFor(s, W);
  // Swarm 1.2.9 row 29 (AC-A06): ids of zone members (no zone = an empty set = the layout below, unchanged).
  const zoned = new Set((s.zones ?? []).flatMap((z) => (z.members ?? []).map((id) => String(id))));
  const nodes: Record<string, DiagramBox> = {};
  // D-242: dua baseline (Python: BASELINE_PT * 2 dibaca mm); keluarga layered
  // memakai langkah pita tingkat (FIX-B2, LAYERED_TIER_GAP_BASELINES).
  const tierStep = baselineStepMm(s.family === "layered" ? LAYERED_TIER_GAP_BASELINES : 2, lat);
  let y = lat.top;
  for (const [ti, tierNodes] of tiers.entries()) {
    const group = elk ? elkTierOrder(elk, [...index.keys()][ti], tierNodes) : tierNodes;
    const m = group.length;
    const gap = lat.x;
    let w = tierWidthMm(m, W, lat);
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
    const xs = elk ? elkTierXs(elk, group, w, gap, W, lat.x) : undefined; // row 162
    group.forEach((n, i) => {
      nodes[n.id] = { x: xs ? xs[i] : x + i * (w + gap), y, w, h: hmax };
    });
    // Python: `y = y + hmax + snap(...)` = (y + hmax) + langkah.
    y = y + hmax + tierStep;
  }
  return { nodes, widthMm: W, heightMm: sheetHeight(lat, Object.values(nodes)) };
}
