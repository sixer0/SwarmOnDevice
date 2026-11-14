/**
 * `studio.diagram/v1` (01_specs.md §3.6, Garis A A4/D-10): bentuk = SPEC_FIELDS
 * Garis A (research/03:232) dengan `class{}` pada simpul. Nama medan snake_case
 * dipertahankan apa adanya demi paritas. Spec Mermaid ditolak 422 `DATUM-31`.
 */
import type {
  DiagramArrowSize,
  DiagramArrowType,
  DiagramEdgeDash,
  DiagramEdgeKind,
  DiagramEdgeRoute,
  DiagramEdgeSide,
  DiagramEdgeWeight,
  DiagramEventType,
  DiagramFamily,
  DiagramJumps,
  DiagramLabelAt,
  DiagramLaneOrientation,
  DiagramShape,
  DiagramZoneStyle,
  ProvenanceMark,
} from "../enums";

export interface DiagramNodeClass {
  tier?: number;
  lane?: number | string;
  col?: number;
  row?: number;
  accent?: boolean;
  secondary?: boolean;
  external?: boolean;
  /** Swarm 1.2.8 row 52 (VIS-0a, N8-248): id of a `phases[]` entry (swimlane family). */
  phase?: string;
  /** Swarm 1.2.8 row 52 (VIS-0a, N8-251): id of a `pools[]` entry (swimlane family). */
  pool?: string;
}

export interface DiagramNode {
  id: string;
  label: string;
  sub?: string;
  shape?: DiagramShape;
  mark?: ProvenanceMark;
  tag?: string;
  u?: number;
  external?: boolean;
  /**
   * Swarm patch (row 124b, CP-45; manual Rev A Table 10.1 and SM-01/03/04, ID p.63, 66): library
   * symbol the node is drawn with, e.g. `iec:battery` (DATUM spec `nodes[].symbol`). Optional and
   * additive; the diagram engine refuses an unknown id and two dialects in one figure, draws the
   * symbol inside the node box and adds a key row for it.
   */
  symbol?: string;
  class: DiagramNodeClass;
  /** Swarm 1.2.8 row 52 (VIS-0a, N8-236): BPMN event trigger on event_start/_intermediate/_end; absent = "none". */
  event_type?: DiagramEventType;
}

export interface DiagramEdge {
  from: string;
  to: string;
  kind: DiagramEdgeKind;
  label: string;
  /**
   * Swarm 1.2.8 row 52 (VIS-0a, F-VISIO 01f §3.1, N8-254..N8-265): connector style. Absent = today's drawing
   * (orthogonal route, sides and slots chosen by the router, end head and dash from `kind`, normal weight, computed
   * label place); an explicit default is drawn exactly like the absent field.
   */
  route?: DiagramEdgeRoute;
  from_side?: DiagramEdgeSide;
  to_side?: DiagramEdgeSide;
  /** Glue point along the side, 0 < v < 1; needs an explicit side. */
  from_slot?: number;
  to_slot?: number;
  /** Bend points on the layout lattice, in order. */
  via?: DiagramViaPoint[];
  arrow_start?: DiagramArrowType;
  arrow_end?: DiagramArrowType;
  arrow_start_size?: DiagramArrowSize;
  arrow_end_size?: DiagramArrowSize;
  dash?: DiagramEdgeDash;
  weight?: DiagramEdgeWeight;
  label_at?: DiagramLabelAt;
}

/** Swarm 1.2.8 row 52 (VIS-0a, N8-258): one bend point in lattice units (figure.lattice of the preview). */
export interface DiagramViaPoint {
  col: number;
  row: number;
}

/** Swarm 1.2.8 row 52 (VIS-0a, N8-247, N8-250): a swimlane phase or pool band. */
export interface DiagramContainer {
  id: string;
  label: string;
}

export interface DiagramZone {
  id: string;
  label: string;
  members: string[];
  /** Swarm 1.2.8 row 52 (VIS-0a, N8-252): "group" = BPMN group; absent = "zone". */
  style?: DiagramZoneStyle;
}

/**
 * Opsi khusus keluarga `sld` (delta S03-d2, D-89; dibaca engine/diagram/layout-c
 * S29/INT-J). `multiBus: true` = opt-in tata letak multi-rel (rel ditumpuk
 * vertikal); absen/false = perilaku Python acuan (satu rel; multi-rel ditolak).
 */
export interface DiagramSldOptions {
  multiBus?: boolean;
}

export interface StudioDiagramV1 {
  $schema: "studio.diagram/v1";
  family: DiagramFamily;
  /** Memuat `\d+\.\d+`. */
  id: string;
  /** Diakhiri titik. */
  title: string;
  classification: string;
  /**
   * Lebar figur (mm) = anggota himpunan lebar turunan kertas `grid.allowedFigureWidthsMm`
   * (D-158, D-245 H1; A4 128/166). Keanggotaan ditegakkan mesin diagram (grid, `P1-width_mm`).
   */
  width_mm: number;
  apparatus?: "page" | "figure";
  labels_verified?: boolean;
  /** minItems 1. */
  sources: string[];
  source?: string;
  nodes: DiagramNode[];
  edges?: DiagramEdge[];
  zones?: DiagramZone[];
  legend?: string[];
  notes?: string[];
  per_row?: number;
  /** Swarm 1.2.6 row 45 (T-11, N-109): ranked flow direction, family flow only; absent = legacy list layout. */
  direction?: "TB" | "LR";
  /** Delta S03-d2 (D-89): opsi keluarga sld; diabaikan keluarga lain. */
  sld?: DiagramSldOptions;
  /** Swarm 1.2.8 row 52 (VIS-0a, N8-249): swimlane lanes as horizontal bands (absent) or vertical columns. */
  lane_orientation?: DiagramLaneOrientation;
  /** Swarm 1.2.8 row 52 (VIS-0a, N8-247): swimlane phase bands, in order. */
  phases?: DiagramContainer[];
  /** Swarm 1.2.8 row 52 (VIS-0a, N8-250): swimlane pools, in order. */
  pools?: DiagramContainer[];
  /** Swarm 1.2.8 row 52 (VIS-0a, N8-266): line jumps at crossings; absent = "on". */
  jumps?: DiagramJumps;
  /**
   * INTERNAL compose (D-288): sinyal bahwa halaman mencetak baris KUNCI figur ini,
   * jadi mesin tidak menggambar baris KEY di dalam SVG. Diisi `services/compose/blocks.ts`
   * pada spec terkomposisi; BUKAN medan agen (skema menolaknya; adaptor v1 membuangnya).
   */
  keyRowOnPage?: boolean;
}
