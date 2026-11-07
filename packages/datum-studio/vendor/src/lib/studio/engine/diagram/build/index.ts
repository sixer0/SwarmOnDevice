/**
 * Modul engine/diagram/build (I20, 01_specs.md §8.2), diisi S30.
 *
 * Port `HS/datum_diagram.py` Garis A: `route_edges` (jangkar dikipas, detur
 * mengelilingi kotak tak terkait), `add_crossing_hops` (r 0,9 mm), dan
 * `build_svg` (zona, lajur/garis kehidupan, legenda baris KUNCI, apparatus
 * page/figure, laporan `checks_run`, gerbang release `labels_verified`).
 * Tata letak lewat `DIAGRAM_LAYOUTS` dispatcher D01 (layout-a/b/c); validasi
 * spek dan primitif SVG dari core (I16, S26).
 */
import type { DiagramSheet, RoutedEdge, StudioDiagramV1 } from "../../../contract";
import { DIAGRAM_LAYOUTS } from "../../../contract/dispatch";
import { Sheet, validateSpec } from "../core";
import { placeDiagram } from "./place";
import { crossingHops, routePlaced, type HoppedEdge } from "./route";
import { buildDiagramSvgWith, routeFor, type DiagramBuildDeps, type DiagramBuildOptions, type DiagramSvgResult } from "./svg";

export { placeDiagram, type Placement } from "./place";
export { type HoppedEdge } from "./route";
export { buildDiagramSvgWith, routeFor, type DiagramBuildDeps, type DiagramBuildOptions, type DiagramBuildReport, type DiagramSvgResult } from "./svg";

const DEFAULT_DEPS: DiagramBuildDeps = {
  validate: (s, o) => validateSpec(s, o),
  // dibaca saat dipakai: peta dispatcher dibangun malas (siklus impor aman)
  get layouts() {
    return DIAGRAM_LAYOUTS;
  },
};

/**
 * Jangkar dikipas, hindari kotak tak terkait (HS `route_edges`; sequence =
 * baris waktu `route_sequence_messages`). `Sheet` core yang sudah tertempat
 * dipakai apa adanya (selain sequence); selain itu tata letak keluarga
 * dijalankan dulu pada lembar selebar `sheet.widthMm` lalu dikunci kisi.
 */
export function routeEdges(s: StudioDiagramV1, sheet: DiagramSheet): RoutedEdge[] {
  if (sheet instanceof Sheet && sheet.nodes.size > 0 && s.family !== "sequence") return routePlaced(s, sheet);
  const placement = placeDiagram(s, new Sheet(sheet.widthMm, undefined, sheet.colMm), DIAGRAM_LAYOUTS);
  return routeFor(s, placement).paths;
}

/**
 * Lompatan persilangan r 0,9 mm (HS `add_crossing_hops`). Jalur dikembalikan
 * dengan `d` terisi dan `hops` (pusat lompatan pada lintasan horizontalnya);
 * busur digambar terpisah setelah semua jalur, seperti Python.
 */
export function addCrossingHops(paths: readonly RoutedEdge[]): HoppedEdge[] {
  return crossingHops(paths);
}

/** Memakai DIAGRAM_LAYOUTS dari contract/dispatch (D01); gerbang release labels_verified. */
export function buildDiagramSvg(s: StudioDiagramV1, opts: DiagramBuildOptions): DiagramSvgResult {
  return buildDiagramSvgWith(s, opts, DEFAULT_DEPS);
}
