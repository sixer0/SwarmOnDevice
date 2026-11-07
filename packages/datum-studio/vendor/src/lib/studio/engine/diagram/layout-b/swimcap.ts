/**
 * Kapasitas swimlane yang membantu (FIG-02b2, audit research/18 §6 P1-14). Hanya dipakai bila
 * render pertama ditolak DATUM-37 (`diagramFitCapacity`). Dua mode, dicoba berurutan oleh build:
 *  - "time": kolom waktu bersama (lapis longest-path dari tepi), dibungkus per pita `k` kolom;
 *    tiap lajur mendapat satu baris per pita yang berisi simpulnya;
 *  - "pack": simpul per lajur berurutan, dibungkus ke baris berikutnya dalam lajur.
 * Lebar simpul 3 kisi (label dibungkus <= 3 baris lewat `fit/text`, tinggi tumbuh).
 */
import type { DiagramBox, DiagramNode, DiagramSheet, StudioDiagramV1 } from "../../../contract";
import { diagramFitAllows } from "../fit/state";
import { longestPathLayers } from "../fit/order";
import { grownHeight, planNodeText } from "../fit/text";
import { baselineStepMm, latticeOf, nodeSize, sheetHeight, snap, textUnitsHeightMm } from "./geometry";

export type SwimCapMode = "time" | "pack";

export interface SwimCapResult {
  nodes: Record<string, DiagramBox>;
  laneBoxes: Record<string, DiagramBox>;
  laneList: DiagramBox[];
  heightMm: number;
  /** Simpul per baris lajur (untuk laporan). */
  perRow: number;
}

export function layoutSwimCapacity(
  s: StudioDiagramV1,
  sheet: DiagramSheet,
  lanes: readonly string[],
  nodeLane: Readonly<Record<string, string>>,
  gutter: number,
  mode: SwimCapMode,
): SwimCapResult {
  const L = latticeOf(sheet);
  const specNodes = s.nodes ?? [];
  const w = L.x * 3;
  const pitch = w + L.x;
  const x0 = gutter + L.x;
  const perRow = Math.max(1, Math.floor((L.W - x0 + L.x) / pitch + 1e-9));
  const size = (n: DiagramNode): number => {
    const [, h] = nodeSize(n, L);
    return diagramFitAllows("grow") ? grownHeight(h, planNodeText(n, w, h), L.y) : h;
  };
  // (baris lajur, kolom) per simpul
  const slot = new Map<string, { row: number; col: number }>();
  if (mode === "time") {
    const ids = specNodes.map((n) => n.id);
    const rank = new Map<string, number>();
    longestPathLayers(ids, (s.edges ?? []).map((e) => [e.from, e.to] as const)).forEach((l, r) => l.forEach((id) => rank.set(id, r)));
    for (const ln of lanes) {
      const used = new Set<string>();
      for (const n of specNodes.filter((m) => nodeLane[m.id] === ln)) {
        let r = rank.get(n.id) ?? 0;
        while (used.has(`${Math.floor(r / perRow)}|${r % perRow}`)) r++; // simpul paralel selajur
        used.add(`${Math.floor(r / perRow)}|${r % perRow}`);
        slot.set(n.id, { row: Math.floor(r / perRow), col: r % perRow });
      }
    }
  } else {
    for (const ln of lanes) {
      specNodes.filter((m) => nodeLane[m.id] === ln).forEach((n, i) => slot.set(n.id, { row: Math.floor(i / perRow), col: i % perRow }));
    }
  }
  const nodes: Record<string, DiagramBox> = {};
  const laneBoxes: Record<string, DiagramBox> = {};
  const laneList: DiagramBox[] = [];
  const laneStep = baselineStepMm(1, L);
  let y = L.top;
  for (const ln of lanes) {
    const group = specNodes.filter((m) => nodeLane[m.id] === ln);
    const rows = [...new Set(group.map((n) => slot.get(n.id)!.row))].sort((a, b) => a - b);
    let ly = y;
    rows.forEach((r, ri) => {
      const inRow = group.filter((n) => slot.get(n.id)!.row === r);
      const rh = Math.max(...inRow.map(size));
      for (const n of inRow) {
        const nh = size(n);
        nodes[n.id] = { x: x0 + slot.get(n.id)!.col * pitch, y: snap(ly + (rh - nh) / 2.0, L.y), w, h: nh };
      }
      ly += rh + (ri + 1 < rows.length ? L.y : 0);
    });
    const lh = rows.length ? ly - y : textUnitsHeightMm(3, L);
    const box: DiagramBox = { x: 0, y, w: L.W, h: lh };
    laneBoxes[ln] = box;
    laneList.push(box);
    y += lh + laneStep;
  }
  return { nodes, laneBoxes, laneList, heightMm: sheetHeight(L, Object.values(nodes), laneList), perRow };
}
