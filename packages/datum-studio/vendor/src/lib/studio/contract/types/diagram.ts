/**
 * `studio.diagram/v1` (01_specs.md §3.6, Garis A A4/D-10): bentuk = SPEC_FIELDS
 * Garis A (research/03:232) dengan `class{}` pada simpul. Nama medan snake_case
 * dipertahankan apa adanya demi paritas. Spec Mermaid ditolak 422 `DATUM-31`.
 */
import type { DiagramEdgeKind, DiagramFamily, DiagramShape, ProvenanceMark } from "../enums";

export interface DiagramNodeClass {
  tier?: number;
  lane?: number | string;
  col?: number;
  row?: number;
  accent?: boolean;
  secondary?: boolean;
  external?: boolean;
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
}

export interface DiagramEdge {
  from: string;
  to: string;
  kind: DiagramEdgeKind;
  label: string;
}

export interface DiagramZone {
  id: string;
  label: string;
  members: string[];
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
  /** Delta S03-d2 (D-89): opsi keluarga sld; diabaikan keluarga lain. */
  sld?: DiagramSldOptions;
  /**
   * INTERNAL compose (D-288): sinyal bahwa halaman mencetak baris KUNCI figur ini,
   * jadi mesin tidak menggambar baris KEY di dalam SVG. Diisi `services/compose/blocks.ts`
   * pada spec terkomposisi; BUKAN medan agen (skema menolaknya; adaptor v1 membuangnya).
   */
  keyRowOnPage?: boolean;
}
