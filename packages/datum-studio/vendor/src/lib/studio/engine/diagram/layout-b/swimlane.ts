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
import { baselineStepMm, type Lattice, latticeOf, nodeSize, pyStr, sheetHeight, snap, textUnitsHeightMm } from "./geometry";
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
  /**
   * Swarm 1.2.8 row 55 (VIS-2a, 01f §2.3, N8-247/N8-249): bingkai fase dan orientasi lajur; hanya ada bila
   * `phases` diberikan atau `lane_orientation` = "vertical" (tanpa keduanya: tata letak lama, byte-identik).
   */
  frame?: SwimFrame;
}

/** Satu pita bingkai: lajur (melintang) atau fase (sepanjang waktu); `lo`..`hi` dalam mm. */
export interface SwimBand {
  key: string;
  label: string;
  lo: number;
  hi: number;
}

/**
 * Swarm 1.2.8 row 55 (VIS-2a): geometri dekorasi swimlane (tanpa data-mark, G-2) yang digambar `build/svg.ts`.
 * Horizontal: lajur = pita y (digambar oleh jalur lajur lama), fase = pita x dengan baris kepala di atas.
 * Vertikal (transpos): lajur = pita x dengan baris kepala di atas, fase = pita y dengan kolom kepala di kiri.
 */
export interface SwimFrame {
  orientation: "horizontal" | "vertical";
  lanes: SwimBand[];
  phases: SwimBand[];
  /** Tepi atas strip kepala (fase pada horizontal, lajur pada vertikal) dan tepi bawahnya. */
  top: number;
  headBottom: number;
  /** Tepi bawah area lajur (ujung pemisah). */
  bottom: number;
  /** Lebar kolom kepala kiri: parit label lajur (horizontal) atau kolom kepala fase (vertikal, 0 tanpa fase). */
  gutter: number;
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
  // Swarm 1.2.8 row 55 (VIS-2a): fase atau lajur vertikal -> tata letak berbingkai; selain itu jalur lama apa adanya.
  if ((Array.isArray(s.phases) && s.phases.length > 0) || s.lane_orientation === "vertical") {
    return layoutSwimFramed(s, L, lanes, nodeLane, gutter);
  }

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

/**
 * Swarm 1.2.8 row 55 (VIS-2a, 01f §2.3, N8-247/N8-248/N8-249): lajur x fase.
 *
 * Horizontal: lajur = pita y seperti lama (parit label kiri 3 kisi), fase = pita x berurutan `phases[]` dengan
 * baris kepala 2 kisi di atas lajur. Lebar pita fase = (simpul fase itu terbanyak dalam satu lajur) x (lebar slot
 * + 1 kisi); urutan dalam sel = urutan `nodes[]`. Vertikal = transpos: lajur = kolom dengan baris kepala 2 kisi di
 * atas, fase = pita y dengan kolom kepala (lebar parit) di kiri; simpul satu sel ditumpuk ke bawah.
 * Tanpa `phases` (vertikal saja) semua simpul satu "fase" tanpa kepala dan tanpa pemisah.
 * Simpul tetap di kisi; pemisah (dekorasi) berada di tengah celah 1 kisi antarpita.
 * Kapasitas (`diagramFitCapacity`): hanya mode "time" (01f §2.3; "pack" memecah kolom fase): simpul 3 kisi
 * (label dibungkus, tinggi tumbuh) dan simpul satu sel ditumpuk dalam satu kolom.
 */
function layoutSwimFramed(
  s: StudioDiagramV1,
  L: Lattice,
  lanes: readonly string[],
  nodeLane: Readonly<Record<string, string>>,
  gutter: number,
): SwimlaneLayout {
  const specNodes = s.nodes ?? [];
  const vertical = s.lane_orientation === "vertical";
  const phases = Array.isArray(s.phases) ? s.phases : [];
  const keys = phases.length ? phases.map((p) => String(p.id)) : [""];
  const phaseOf = (n: DiagramNode): string => (phases.length ? pyStr(((n.class ?? {}) as Record<string, unknown>).phase) : "");
  const cap = diagramFitCapacity();
  const cell = new Map<string, DiagramNode[]>();
  const cellOf = (ln: string, ph: string): DiagramNode[] => cell.get(`${ln}\u0000${ph}`) ?? [];
  for (const n of specNodes) {
    const k = `${nodeLane[n.id]}\u0000${phaseOf(n)}`;
    const g = cell.get(k);
    if (g) g.push(n);
    else cell.set(k, [n]);
  }
  /** Simpul fase terbanyak dalam satu lajur (>= 1: fase kosong tetap satu slot agar kepalanya terbaca). */
  const depth = (ph: string): number => Math.max(1, ...lanes.map((ln) => cellOf(ln, ph).length));
  const startX = vertical ? (phases.length ? gutter : 0) : gutter;
  // lebar adil per slot saat fit (kelipatan kisi, >= 3 kisi)
  const slots = vertical ? lanes.length : keys.reduce((a, ph) => a + (cap ? 1 : depth(ph)), 0);
  const share = Math.floor(((L.W - startX) / slots - L.x) / L.x + 1e-9) * L.x;
  const sizeOf = (n: DiagramNode): [number, number] => {
    const [w0, h] = nodeSize(n, L);
    if (cap) {
      const w = L.x * 3;
      return [w, diagramFitAllows("grow") ? grownHeight(h, planNodeText(n, w, h), L.y) : h];
    }
    if (!diagramFitActive()) return [w0, h];
    const w = Math.min(w0, Math.max(L.x * 3, share));
    return [w, diagramFitAllows("grow") ? grownHeight(h, planNodeText(n, w, h), L.y) : h];
  };
  const size = new Map(specNodes.map((n) => [n.id, sizeOf(n)] as const));
  const W = (n: DiagramNode) => size.get(n.id)![0];
  const H = (n: DiagramNode) => size.get(n.id)![1];
  const emptyH = textUnitsHeightMm(3, L);
  const top = L.top;
  const headBottom = top + L.y * 2;
  const nodes: Record<string, DiagramBox> = {};
  const laneBoxes: Record<string, DiagramBox> = {};
  const laneList: DiagramBox[] = [];
  const laneBands: SwimBand[] = [];
  const phaseBands: SwimBand[] = [];
  const labelOf = (ph: string): string => pyStr(phases.find((p) => String(p.id) === ph)?.label ?? ph);

  if (!vertical) {
    // fase = pita x
    const xStart = new Map<string, number>();
    const slotW = new Map<string, number>();
    let x = gutter + L.x;
    keys.forEach((ph, i) => {
      const members = specNodes.filter((n) => phaseOf(n) === ph);
      const sw = members.length ? Math.max(...members.map(W)) : L.x * 3;
      slotW.set(ph, sw);
      xStart.set(ph, x);
      phaseBands.push({ key: ph, label: labelOf(ph), lo: i === 0 ? gutter : x - L.x / 2, hi: 0 });
      x += (cap ? 1 : depth(ph)) * (sw + L.x);
    });
    phaseBands.forEach((b, i) => (b.hi = i + 1 < phaseBands.length ? phaseBands[i + 1].lo : L.W));
    const laneStep = baselineStepMm(1, L);
    let y = headBottom;
    for (const ln of lanes) {
      let lh = 0;
      for (const ph of keys) {
        const g = cellOf(ln, ph);
        if (!g.length) continue;
        lh = Math.max(lh, cap ? g.reduce((a, n) => a + H(n), 0) + (g.length - 1) * L.y : Math.max(...g.map(H)));
      }
      if (lh === 0) lh = emptyH;
      for (const ph of keys) {
        const g = cellOf(ln, ph);
        let cy = y;
        g.forEach((n, i) => {
          if (cap) {
            nodes[n.id] = { x: xStart.get(ph)!, y: cy, w: W(n), h: H(n) };
            cy += H(n) + L.y;
          } else {
            nodes[n.id] = { x: xStart.get(ph)! + i * (slotW.get(ph)! + L.x), y: y + (lh - H(n)) / 2.0, w: W(n), h: H(n) };
          }
        });
      }
      const box: DiagramBox = { x: 0, y, w: L.W, h: lh };
      laneBoxes[ln] = box;
      laneList.push(box);
      laneBands.push({ key: ln, label: ln, lo: y, hi: y + lh });
      y += lh + laneStep;
    }
  } else {
    // lajur = pita x (kolom), fase = pita y
    const xStart = new Map<string, number>();
    const slotW = new Map<string, number>();
    let x = startX + L.x;
    lanes.forEach((ln, i) => {
      const members = specNodes.filter((n) => nodeLane[n.id] === ln);
      const sw = members.length ? Math.max(...members.map(W)) : L.x * 3;
      slotW.set(ln, sw);
      xStart.set(ln, x);
      laneBands.push({ key: ln, label: ln, lo: i === 0 ? startX : x - L.x / 2, hi: 0 });
      x += sw + L.x;
    });
    laneBands.forEach((b, i) => (b.hi = i + 1 < laneBands.length ? laneBands[i + 1].lo : L.W));
    const gapY = L.y * 2; // rute antarlajur mendatar lewat celah 2 kisi, bukan lewat baris kepala
    let y = headBottom + L.y;
    keys.forEach((ph, i) => {
      const members = specNodes.filter((n) => phaseOf(n) === ph);
      const sh = members.length ? Math.max(...members.map(H)) : emptyH;
      for (const ln of lanes) {
        cellOf(ln, ph).forEach((n, j) => {
          const dx = Math.floor((slotW.get(ln)! - W(n)) / 2 / L.x + 1e-9) * L.x;
          nodes[n.id] = { x: xStart.get(ln)! + dx, y: y + j * (sh + gapY) + (sh - H(n)) / 2.0, w: W(n), h: H(n) };
        });
      }
      phaseBands.push({ key: ph, label: labelOf(ph), lo: i === 0 ? headBottom : y - gapY / 2, hi: 0 });
      y += depth(ph) * (sh + gapY);
    });
    const bottom = y - gapY / 2;
    phaseBands.forEach((b, i) => (b.hi = i + 1 < phaseBands.length ? phaseBands[i + 1].lo : bottom));
    for (const b of laneBands) {
      const box: DiagramBox = { x: b.lo, y: top, w: b.hi - b.lo, h: bottom - top };
      laneBoxes[b.key] = box;
      laneList.push(box);
    }
  }
  if (cap) {
    diagramFitNote(
      "CAPACITY_ADAPT",
      `swimlane berfase tidak muat di ${L.W.toFixed(1)} mm; mode waktu: simpul 3 kisi, simpul satu sel lajur x fase ditumpuk`,
      `kurangi simpul per fase atau pecah menjadi 2 diagram (lebar ${L.W.toFixed(0)} mm)`,
    );
  }
  const bottom = vertical ? laneList[0].y + laneList[0].h : laneList[laneList.length - 1].y + laneList[laneList.length - 1].h;
  const frame: SwimFrame = {
    orientation: vertical ? "vertical" : "horizontal",
    lanes: laneBands,
    phases: phases.length ? phaseBands : [],
    top,
    headBottom,
    bottom,
    gutter: startX,
  };
  return {
    family: "swimlane",
    nodes,
    lanes: laneBoxes,
    laneOrder: [...lanes],
    nodeLane: { ...nodeLane },
    gutterMm: vertical ? startX : gutter,
    widthMm: L.W,
    heightMm: sheetHeight(L, Object.values(nodes), laneList),
    frame,
  };
}
