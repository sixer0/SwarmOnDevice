/**
 * Tata letak sequence (S28, I18): port persis HS `layout_sequence`
 * (`datum_diagram.py:565-579`) dan `route_sequence_messages` (:912-927).
 * Waktu memiliki sumbu vertikal (P2 sequence): aktor = kolom, pesan = baris waktu.
 *
 * Nilai simpul adalah keadaan lembar Python setelah mesin layout (sebelum
 * lintasan snap/clamp `build_svg` :1124-1136, milik S30).
 */
import type { DiagramBox, DiagramSheet, LayoutResult, RoutedEdge, StudioDiagramV1 } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { baselineStepMm, latticeOf, nodeSize, sheetHeight, snap, type Lattice } from "./geometry";

export interface Lifeline {
  /** Id aktor (simpul) pemilik garis kehidupan. */
  id: string;
  /** x garis kehidupan (sudah di kisi, HS :576). */
  x: number;
  /** y awal garis = `top + head_h`; ujung bawah digambar build pada `H - LATTICE_Y`. */
  top: number;
}

export interface SequenceLayout extends LayoutResult {
  family: "sequence";
  lifelines: Lifeline[];
  /** `sheet.msg_y`: baris waktu pesan pertama. */
  msgY: number;
  /** `sheet.msg_step`: langkah baris waktu per pesan. */
  msgStep: number;
  /** `sheet.msg_end` (HS :1145): y pesan terakhir, atau `msgY` bila tanpa pesan. */
  msgEnd: number;
  /** Kisi yang dipakai (untuk `routeSequenceMessages`). */
  latticeXMm: number;
}

interface MessageRun {
  paths: RoutedEdge[];
  msgEnd: number;
}

function routeOn(s: StudioDiagramV1, lifelines: readonly Lifeline[], msgY: number, msgStep: number, L: Pick<Lattice, "x">): MessageRun {
  const order = new Map<string, number>();
  (s.nodes ?? []).forEach((n, i) => order.set(n.id, i));
  const xs = lifelines.map((ll) => ll.x);
  const paths: RoutedEdge[] = [];
  let y = msgY;
  // Python membaca spec["edges"] (KeyError bila tidak ada); di sini tanpa edges = tanpa pesan.
  for (const e of s.edges ?? []) {
    const a = order.get(e.from);
    const b = order.get(e.to);
    if (a === undefined || b === undefined) {
      throw new StudioEngineError(
        "BY_CONSTRUCTION_FAILED",
        `DIAGRAM DEFECT: DATUM-24: konektor ${e.from} -> ${e.to} merujuk simpul yang tidak ada (P1/P8)`,
      );
    }
    const xa = xs[a];
    let xb = xs[b];
    if (Math.abs(xa - xb) < 1e-9) xb = xa + L.x * 2; // pesan ke diri sendiri: lipatan kecil
    paths.push({ from: e.from, to: e.to, kind: e.kind, label: e.label, points: [[xa, y], [xb, y]] });
    y += msgStep;
  }
  const msgEnd = paths.length ? Math.max(...paths.map((p) => p.points[0][1])) : msgY;
  return { paths, msgEnd };
}

export function layoutSequence(s: StudioDiagramV1, sheet: DiagramSheet): SequenceLayout {
  const L = latticeOf(sheet);
  const actors = s.nodes ?? [];
  if (!actors.length) {
    // Python: max() atas urutan kosong -> ValueError; validate_spec menolak nodes kosong lebih dulu.
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "DIAGRAM DEFECT: sequence tanpa aktor (P1 nodes[])");
  }
  const m = Math.max(1, actors.length);
  const colw = snap(L.W / m, L.x);
  const headH = Math.max(...actors.map((n) => nodeSize(n, L)[1]));

  const nodes: Record<string, DiagramBox> = {};
  const lifelines: Lifeline[] = [];
  actors.forEach((n, i) => {
    let [nw] = nodeSize(n, L);
    nw = Math.min(nw, colw - L.x);
    nodes[n.id] = { x: snap(i * colw + (colw - nw) / 2.0, L.x), y: L.top, w: nw, h: headH };
    lifelines.push({ id: n.id, x: snap(i * colw + colw / 2.0, L.x), top: L.top + headH });
  });
  // D-242: dua dan tiga baseline (Python: BASELINE_PT * k dibaca mm).
  const msgY = L.top + headH + baselineStepMm(2, L);
  const msgStep = baselineStepMm(3, L);
  const { msgEnd } = routeOn(s, lifelines, msgY, msgStep, L);

  return {
    family: "sequence",
    nodes,
    lifelines,
    msgY,
    msgStep,
    msgEnd,
    latticeXMm: L.x,
    widthMm: L.W,
    // HS Sheet.height() dengan msg_end (build :1145) dan foot = 0.
    heightMm: sheetHeight(L, Object.values(nodes), [], msgEnd),
  };
}

/**
 * HS `route_sequence_messages` (:912-927): pesan = garis horizontal pada
 * baris waktu bertingkat, satu langkah per pesan, urutan `edges[]`.
 * Untuk dipakai `routeEdges` (S30) pada keluarga sequence.
 */
export function routeSequenceMessages(s: StudioDiagramV1, layout: SequenceLayout): MessageRun {
  return routeOn(s, layout.lifelines, layout.msgY, layout.msgStep, { x: layout.latticeXMm });
}
