/**
 * Tata letak swimlane (S28, I18): port persis HS `layout_swimlane`
 * (`datum_diagram.py:535-562`). Lajur = akuntabilitas (P2 swimlane).
 *
 * Nilai yang dikembalikan adalah keadaan lembar Python tepat setelah mesin
 * layout (sebelum lintasan snap/clamp `build_svg` :1124-1136, milik S30).
 * Spek masukan tidak dimutasi (Python menulis `n["_lane_i"]`; di sini peta lokal).
 */
import type { DiagramBox, DiagramNode, DiagramSheet, LayoutResult, StudioDiagramV1 } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { baselineStepMm, latticeOf, nodeSize, pyStr, sheetHeight, snap, textUnitsHeightMm } from "./geometry";
import { diagramFitActive, diagramFitAllows, diagramFitCapacity, diagramFitCapMode, diagramFitNote } from "../fit/state";
import { layoutSwimCapacity } from "./swimcap";
import { grownHeight, planNodeText } from "../fit/text";

export interface SwimlaneLayout extends LayoutResult {
  family: "swimlane";
  /** Pita lajur: x = 0, w = lebar lembar (Python menyimpan y/h saja). */
  lanes: Record<string, DiagramBox>;
  /** Urutan lajur kemunculan pertama (kunci numerik di `Record` JS diurutkan ulang; pakai ini untuk menggambar). */
  laneOrder: string[];
  /** Nama lajur per id simpul (pengganti `_lane_i`). */
  nodeLane: Record<string, string>;
  /** `sheet.gutter_w`: lebar parit label lajur (mm). */
  gutterMm: number;
}

const NO_LANE = "tanpa lajur";

function laneName(n: DiagramNode): string {
  const cls = (n.class ?? {}) as Record<string, unknown>;
  // Python: str(n.get("class", {}).get("lane", "tanpa lajur")) — null menjadi "None".
  return Object.prototype.hasOwnProperty.call(cls, "lane") && cls.lane !== undefined ? pyStr(cls.lane) : NO_LANE;
}

export function layoutSwimlane(s: StudioDiagramV1, sheet: DiagramSheet): SwimlaneLayout {
  const L = latticeOf(sheet);
  const specNodes = s.nodes ?? [];
  if (!specNodes.length) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "DIAGRAM DEFECT: swimlane tanpa simpul (P1 nodes[])");
  }

  const lanes: string[] = [];
  const li = new Map<string, number>();
  const nodeLane: Record<string, string> = {};
  for (const n of specNodes) {
    const ln = laneName(n);
    if (!li.has(ln)) {
      li.set(ln, lanes.length);
      lanes.push(ln);
    }
    nodeLane[n.id] = ln;
  }
  const gutter = snap(L.x * 3, L.x);
  const perLane = new Map<string, DiagramNode[]>(lanes.map((ln) => [ln, []]));
  for (const n of specNodes) perLane.get(nodeLane[n.id])!.push(n);

  /** FIG-02b2: saat fit, label yang tidak muat dibungkus (<= 3 baris) dan tinggi simpul tumbuh. */
  const sizeOf = (n: DiagramNode): [number, number] => {
    const [w0, h] = nodeSize(n, L);
    if (!diagramFitActive()) return [w0, h];
    // lebar dibatasi bagian adil lajur (kelipatan kisi, >= 3 kisi) agar tidak dijepit lembar
    const k = perLane.get(nodeLane[n.id])!.length;
    const share = Math.floor((L.W - gutter - L.x - (k - 1) * L.x) / k / L.x + 1e-9) * L.x;
    const w = Math.min(w0, Math.max(L.x * 3, share));
    const plan = planNodeText(n, w, h);
    return [w, diagramFitAllows("grow") ? grownHeight(h, plan, L.y) : h];
  };
  if (diagramFitCapacity()) {
    // FIG-02b2 P1-14: render pertama ditolak DATUM-37 -> kolom waktu bersama / bungkus dalam lajur.
    const mode = diagramFitCapMode() === "pack" ? "pack" : "time";
    const c = layoutSwimCapacity(s, sheet, lanes, nodeLane, gutter, mode);
    diagramFitNote(
      "CAPACITY_ADAPT",
      `swimlane tidak muat satu baris per lajur di ${L.W.toFixed(1)} mm; ${mode === "time" ? "kolom waktu bersama dibungkus" : "simpul dibungkus dalam lajur"} (maks ${c.perRow} simpul per baris)`,
      `maks ${c.perRow} simpul per baris lajur pada ${L.W.toFixed(0)} mm; bagi lajur atau pecah menjadi 2 diagram`,
    );
    return { family: "swimlane", nodes: c.nodes, lanes: c.laneBoxes, laneOrder: lanes, nodeLane, gutterMm: gutter, widthMm: L.W, heightMm: c.heightMm };
  }
  const nodes: Record<string, DiagramBox> = {};
  const laneBoxes: Record<string, DiagramBox> = {};
  const laneList: DiagramBox[] = [];
  // D-242: satu baseline (HS memakai pt sebagai mm di sini: 13,5 -> 14,2875 mm).
  const laneStep = baselineStepMm(1, L);
  let y = L.top;
  for (const ln of lanes) {
    const group = perLane.get(ln)!;
    const hs = group.map((n) => sizeOf(n)[1]);
    const lh = hs.length ? Math.max(...hs) : textUnitsHeightMm(3, L); // D-242: 3 unit x 1 baseline
    let x = gutter + L.x;
    for (const n of group) {
      const [nw, nh] = sizeOf(n);
      // Python: id ganda menimpa entri sebelumnya (validate_spec menolaknya lebih dulu).
      nodes[n.id] = { x, y: y + (lh - nh) / 2.0, w: nw, h: nh };
      x += nw + L.x;
    }
    const box: DiagramBox = { x: 0, y, w: L.W, h: lh };
    laneBoxes[ln] = box;
    laneList.push(box);
    y += lh + laneStep;
  }

  return {
    family: "swimlane",
    nodes,
    lanes: laneBoxes,
    laneOrder: lanes,
    nodeLane,
    gutterMm: gutter,
    widthMm: L.W,
    heightMm: sheetHeight(L, Object.values(nodes), laneList),
  };
}
