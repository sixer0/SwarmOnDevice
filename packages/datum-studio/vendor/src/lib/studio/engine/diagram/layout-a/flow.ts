/**
 * Port `layout_flow` (`HS/datum_diagram.py:482-532`): rantai berurutan, simpul
 * melebar untuk keputusan (P2 flow). `per_row` (ENH-D, E-30) membungkus rantai
 * menjadi baris (baris-dulu, kiri-kanan lalu turun); tanpa `per_row` satu kolom
 * vertikal terpusat.
 */
import type { DiagramBox, DiagramSheet, LayoutResult, StudioDiagramV1 } from "../../../contract";
import { diagramFitActive, diagramFitAllows, diagramFitNote } from "../fit/state";
import { grownHeight, planNodeText } from "../fit/text";
import { baselineStepMm, latticeOf, nodeSize, pyFloorDiv, pyInt, pyStr, pyTruthy, sheetHeight, snap } from "./geometry";

export function layoutFlow(s: StudioDiagramV1, sheet: DiagramSheet): LayoutResult {
  const lat = latticeOf(sheet);
  const W = sheet.widthMm;
  // D-242: dua baseline (Python: BASELINE_PT * 2 dibaca mm).
  const step = baselineStepMm(2, lat);
  const nodes: Record<string, DiagramBox> = {};
  const perRow = s.per_row;

  if (pyTruthy(perRow) && pyInt(Number(perRow)) > 0) {
    const gap = lat.x;
    // per_row adalah ATASAN: kolom dibatasi yang muat dengan lebar minimum 3 kisi.
    const kMax = pyInt(pyFloorDiv(W + gap, lat.x * 3 + gap));
    const k = Math.max(1, Math.min(pyInt(Number(perRow)), kMax));
    const rows = [];
    for (let i = 0; i < s.nodes.length; i += k) rows.push(s.nodes.slice(i, i + k));
    let y = lat.top;
    for (const group of rows) {
      const m = group.length;
      let w = snap((W - (m - 1) * gap) / m, lat.x);
      // snap bisa membulat ke atas dan meluapkan baris: susut sampai muat.
      while (m * w + (m - 1) * gap > W && w > lat.x * 3) w -= lat.x;
      w = Math.max(w, lat.x * 3);
      const hs: number[] = [];
      for (const n of group) {
        let [, h] = nodeSize(n, lat, group);
        if (n.shape === "diamond") h = snap(h * 1.25, lat.y);
        if (diagramFitActive()) {
          // FIG-02b P1-10: lebar baris sudah maksimum; bungkus label <= 3 baris, tinggi tumbuh.
          const plan = planNodeText(n, w, h);
          if (diagramFitAllows("grow")) h = grownHeight(h, plan, lat.y);
          if (plan.overflow) {
            diagramFitNote(
              "NODE_LABEL_LINES",
              `label simpul '${pyStr(n.id)}' butuh lebih dari 3 baris pada lebar ${w.toFixed(1)} mm (${m} simpul per baris)`,
              "persingkat label simpul (maks ~40 karakter); detail ke `sub`",
            );
          }
        }
        hs.push(h);
      }
      let hmax = -Infinity;
      for (const h of hs) if (h > hmax) hmax = h;
      const total = m * w + (m - 1) * gap;
      const x = snap(Math.max(0.0, (W - total) / 2.0), lat.x);
      group.forEach((n, i) => {
        const nx = x + i * (w + gap);
        const ww = Math.min(w, W - nx); // tidak boleh melewati tepi lembar
        nodes[n.id] = { x: nx, y, w: ww, h: hs[i] };
      });
      // Python: `y += hmax + snap(...)` = y + (hmax + langkah).
      y += hmax + step;
    }
    return { nodes, widthMm: W, heightMm: sheetHeight(lat, Object.values(nodes)) };
  }

  // Python juga menghitung `w = snap(W * 0.42, LATTICE_X)` di sini tetapi tidak
  // memakainya; dihilangkan tanpa efek pada koordinat.
  let y = lat.top;
  for (const n of s.nodes) {
    const [w0, nh] = nodeSize(n, lat);
    let nw = w0;
    if (n.shape === "diamond") nw = snap(nw * 1.6, lat.x);
    nodes[n.id] = { x: snap((W - nw) / 2.0, lat.x), y, w: nw, h: nh };
    y += nh + step;
  }
  return { nodes, widthMm: W, heightMm: sheetHeight(lat, Object.values(nodes)) };
}
