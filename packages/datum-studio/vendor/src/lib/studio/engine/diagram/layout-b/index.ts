/**
 * Modul engine/diagram/layout-b (I18, 01_specs.md §8.2), diisi S28.
 * Tata letak swimlane dan sequence, port persis Garis A
 * `datum-house-style/datum_diagram.py` (`layout_swimlane` :535,
 * `layout_sequence` :565, `route_sequence_messages` :912).
 *
 * Tanda tangan kontrak: `layoutSwimlane(s, sheet)`, `layoutSequence(s, sheet)`
 * : `LayoutResult` (tipe kembalian di sini adalah subtipe yang membawa
 * lajur/garis kehidupan; tetap memenuhi `LayoutFn`).
 */
export { layoutSwimlane, type SwimlaneLayout } from "./swimlane";
export { layoutSequence, routeSequenceMessages, type Lifeline, type SequenceLayout } from "./sequence";
export { GARIS_A_TOKENS, pyRound, snap, pt2mm, estTextMm, nodeSize, latticeOf, sheetHeight, type Lattice } from "./geometry";
