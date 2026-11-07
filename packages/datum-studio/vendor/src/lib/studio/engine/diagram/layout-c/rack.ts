/**
 * Port `layout_rack` (`HS/datum_diagram.py:605-617`): elevasi rak, posisi U
 * menanggung beban (P2 rack).
 */
import type { DiagramBox, DiagramSheet, LayoutResult, StudioDiagramV1 } from "../../../contract";
import { classGet, latticeOf, nodeGet, pyInt, sheetHeight, snap } from "./geometry";

export interface RackDetail {
  result: LayoutResult;
  /** Padanan `sheet.rack_x` Python: tepi kiri kolom rak. */
  rackX: number;
}

export function layoutRackDetail(s: StudioDiagramV1, sheet: DiagramSheet): RackDetail {
  const L = latticeOf(sheet);
  const colw = snap(L.x * 8, L.x);
  const x = snap((L.W - colw) / 2.0, L.x);
  // `sorted(..., key=int(row))`: kunci dihitung untuk semua simpul dulu; sort JS stabil seperti Python.
  const keyed = s.nodes.map((n) => ({ n, k: pyInt(classGet(n, "row", 0), `simpul ${n.id}: class.row`) }));
  keyed.sort((a, b) => a.k - b.k);
  const nodes: Record<string, DiagramBox> = {};
  let y = L.top;
  for (const { n } of keyed) {
    const u = pyInt(nodeGet(n, "u", 1), `simpul ${n.id}: u`);
    const nh = snap(u * L.y * 2, L.y);
    nodes[n.id] = { x, y, w: colw, h: nh };
    y += nh;
  }
  return { result: { nodes, widthMm: L.W, heightMm: sheetHeight(L, Object.values(nodes)) }, rackX: x };
}

export function layoutRack(s: StudioDiagramV1, sheet: DiagramSheet): LayoutResult {
  return layoutRackDetail(s, sheet).result;
}
