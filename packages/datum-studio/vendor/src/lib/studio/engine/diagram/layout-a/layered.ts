/**
 * Port `layout_layered` (`HS/datum_diagram.py:452-479`): tingkat vertikal, satu
 * lebar per tingkat (P5). Dipakai keluarga layered, topology, stack.
 */
import type { DiagramBox, DiagramNode, DiagramSheet, LayoutResult, StudioDiagramV1 } from "../../../contract";
import { diagramFitActive, diagramFitAllows, diagramFitNote } from "../fit/state";
import { fitTierWidth, grownHeight, planNodeText } from "../fit/text";
import { baselineStepMm, latticeOf, nodeSize, pyStr, sheetHeight, snap } from "./geometry";

/** `n.get("class", {}).get("tier", n.get("class", {}).get("row", 0))` lalu `str()`. */
function tierKey(n: DiagramNode): string {
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

  const nodes: Record<string, DiagramBox> = {};
  // D-242: dua baseline (Python: BASELINE_PT * 2 dibaca mm); keluarga layered
  // memakai langkah pita tingkat (FIX-B2, LAYERED_TIER_GAP_BASELINES).
  const tierStep = baselineStepMm(s.family === "layered" ? LAYERED_TIER_GAP_BASELINES : 2, lat);
  let y = lat.top;
  for (const group of tiers) {
    const m = group.length;
    const gap = lat.x;
    let w = snap((W - (m - 1) * gap) / m, lat.x);
    w = Math.max(Math.min(w, lat.x * 10), lat.x * 3);
    let hmax = -Infinity;
    for (const n of group) {
      const [, h] = nodeSize(n, lat, group);
      if (h > hmax) hmax = h;
    }
    if (diagramFitActive()) {
      // FIG-02b P1-10: lebar berbasis label (bungkus <= 3 baris), tinggi tumbuh per baris.
      const wMax = Math.max(w, Math.floor((W - (m - 1) * gap) / m / lat.x + 1e-9) * lat.x);
      const fit = fitTierWidth(group, w, wMax, lat.x, hmax);
      w = fit.w;
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
    group.forEach((n, i) => {
      nodes[n.id] = { x: x + i * (w + gap), y, w, h: hmax };
    });
    // Python: `y = y + hmax + snap(...)` = (y + hmax) + langkah.
    y = y + hmax + tierStep;
  }
  return { nodes, widthMm: W, heightMm: sheetHeight(lat, Object.values(nodes)) };
}
