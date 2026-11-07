/**
 * Geometri tata letak swimlane/sequence (S28, I18). Seluruh utilitas (kisi
 * `LATTICE_X/Y`, `_node_size`, `Sheet.top`/`Sheet.height`, `snap`,
 * `est_text_mm`, `str()`) kini berasal dari SATU modul `../core/geometry`
 * (IP-39b, S84 #7); berkas ini hanya mengekspor ulang nama lama agar impor
 * swimlane/sequence dan ekspor publik `layout-b` tetap sama.
 */
export {
  GARIS_A_TOKENS,
  type Lattice,
  baselineStepMm,
  estTextPt as estTextMm,
  latticeOf,
  nodeSize,
  pt2mm,
  pyRound0 as pyRound,
  pyScalarStr as pyStr,
  sheetHeight,
  snap,
  textUnitsHeightMm,
} from "../core/geometry";
