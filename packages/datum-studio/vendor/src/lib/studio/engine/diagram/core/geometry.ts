/**
 * Geometri bersama tata letak diagram Garis A — SATU modul untuk core, build,
 * dan layout-a/b/c (IP-39b, S84 #7; sebelumnya 4 salinan di `core/tokens.ts`,
 * `core/sheet.ts`, `layout-a/geometry.ts`, `layout-b/geometry.ts`,
 * `layout-c/geometry.ts`).
 *
 * Port persis utilitas `HS/datum_diagram.py`: pt2mm (:189), snap (:193),
 * snap_floor (:197), snap_ceil (:204), est_text_mm (:244), kisi
 * LATTICE_X/Y (:98-103), Sheet.top/height (:401-410), _node_size (:432-449).
 * Urutan operasi floating-point mengikuti Python baris per baris agar koordinat
 * setara bit-per-bit (`round()` = setengah-ke-genap, `len(str)` = titik kode).
 *
 * Nilai token tidak lagi disalin sebagai literal: `GARIS_A_TOKENS` diturunkan
 * dari salinan beku `DIAGRAM_TOKENS` (D-50) sehingga perubahan token cukup di
 * satu tempat. Primitif angka (`pt2mm`, `snap`, `snapFloor`, `snapCeil`,
 * `estTextPt`) tinggal di `tokens.ts` (tanpa siklus impor) dan diekspor ulang.
 * Modul murni dan deterministik.
 */
import type { DiagramNode, DiagramSheet } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { pyRound0, pyStr } from "./pyfmt";
import { DIAGRAM_TOKENS, estTextPt, pt2mm, role, snap, snapCeil, snapFloor } from "./tokens";

export { pyRound0, pt2mm, snap, snapCeil, snapFloor, estTextPt };

/**
 * Nilai token Garis A yang dibaca mesin tata letak (HS `tokens.json`):
 * `grid_mm.text_column`, `type.baseline_pt`, `type.scale_pt.caption.size`,
 * `type.scale_pt.source_line.size`. `LayoutFn` tidak menerima templat, jadi
 * nilainya tetap seperti Python. Diturunkan dari `DIAGRAM_TOKENS`.
 */
export const GARIS_A_TOKENS = Object.freeze({
  textColumnMm: DIAGRAM_TOKENS.grid_mm.text_column,
  baselinePt: DIAGRAM_TOKENS.type.baseline_pt,
  captionPt: role("caption").size,
  sourceLinePt: role("source_line").size,
});

/** Galat tata letak bernama: padanan `DiagramDefect` Python dengan prefiks layout. */
export function layoutDefect(message: string, checkId?: string): StudioEngineError {
  return new StudioEngineError("BY_CONSTRUCTION_FAILED", `DIAGRAM DEFECT: ${message}`, checkId ? { checkId } : undefined);
}

/** Python `bool(x)` untuk nilai JSON. */
export function pyTruthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** `n.get(key, dflt)` pada simpul (medan ada tetapi `undefined` tetap dikembalikan). */
export function nodeGet(n: DiagramNode, key: string, dflt: unknown): unknown {
  const rec = n as unknown as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : dflt;
}

/** `str(x)` Python untuk kunci kelompok/nama lajur (= `pyStr` pyfmt). */
export const pyScalarStr: (v: unknown) => string = pyStr;

/** Kisi efektif lembar; pemilihan sama dengan `LATTICE_X`/`LATTICE_Y` Python. */
export interface Lattice {
  /** `LATTICE_X` (mm). */
  x: number;
  /** `LATTICE_Y` (mm). */
  y: number;
  /** `Sheet.top` = `LATTICE_Y * 2`. */
  top: number;
  /** `Sheet.W` = `float(width_mm)`. */
  W: number;
}

/**
 * HS :98-103 dan `Sheet.__init__` :394-402. Kisi dihitung ulang dari induknya
 * (text_column/12 dan baseline pt->mm) bila nilai lembar berselisih < 1e-3,
 * persis aturan Python; nilai lembar dipakai apa adanya bila selisih lebih
 * besar. Kisi/lebar tidak sah = cacat bernama.
 */
export function latticeOf(sheet: DiagramSheet): Lattice {
  const lxCalc = GARIS_A_TOKENS.textColumnMm / 12.0;
  const lyCalc = (GARIS_A_TOKENS.baselinePt * 25.4) / 72.0;
  const x = Math.abs(lxCalc - sheet.colMm) < 1e-3 ? lxCalc : sheet.colMm;
  const y = Math.abs(lyCalc - sheet.rowMm) < 1e-3 ? lyCalc : sheet.rowMm;
  const W = Number(sheet.widthMm);
  if (!(x > 0) || !(y > 0) || !Number.isFinite(W) || !(W > 0)) {
    throw layoutDefect(`kisi/lembar tidak sah (colMm=${sheet.colMm}, rowMm=${sheet.rowMm}, widthMm=${sheet.widthMm})`);
  }
  return { x, y, top: y * 2, W };
}

/** Lebar teks satu simpul tanpa rem: `est(label)` dan `est(sub)` bila sub truthy. */
function labelSubWidths(n: DiagramNode): [number, number] {
  const labelW = estTextPt(nodeGet(n, "label", ""), GARIS_A_TOKENS.captionPt);
  const sub = nodeGet(n, "sub", undefined);
  const subW = pyTruthy(sub) ? estTextPt(sub, GARIS_A_TOKENS.sourceLinePt) : 0.0;
  return [labelW, subW];
}

/** Rem caption simpul: `pt2mm(caption) * 1.2`. */
function capPad(): number {
  return pt2mm(GARIS_A_TOKENS.captionPt) * 1.2;
}

/** Lebar teks label/sub ditambah rem caption (bagian bersama `_node_size` dan `_graph_min_width`). */
export function textNeedMm(n: DiagramNode): number {
  const [labelW, subW] = labelSubWidths(n);
  return Math.max(labelW, subW) + capPad();
}

/**
 * D-242 (K-1, keputusan user "ubah mesin ke ukuran BM"): ukuran vertikal
 * berbasis teks dihitung dalam BASELINE, satu aturan untuk semua keluarga.
 * Garis A Python membaca dua kuirk yang kini SENGAJA diputus (paritas byte
 * dengan skrip Python Garis A tidak lagi dijaga untuk geometri vertikal):
 *  - tinggi simpul `units * LATTICE_Y * 2` (dua baseline per unit teks) ->
 *    `units * LATTICE_Y` (satu baseline per unit: label, sub, tag + 2 rem);
 *  - jarak tingkat/baris `BASELINE_PT * k` yang dibaca sebagai mm (27 mm ->
 *    28,575 mm setelah snap) -> `pt2mm(BASELINE_PT * k)` = k baseline.
 * Lebar, kisi, tepi lembar, dan aturan DATUM tidak berubah.
 */
export function textUnitsHeightMm(units: number, L: Pick<Lattice, "y">): number {
  return snap(units * L.y, L.y);
}

/** D-242: jarak vertikal `k` baseline (pt dikonversi ke mm), dikunci kisi vertikal. */
export function baselineStepMm(k: number, L: Pick<Lattice, "y">): number {
  return snap(pt2mm(GARIS_A_TOKENS.baselinePt * k), L.y);
}

/**
 * Rem vertikal bawaan simpul (unit baseline di luar baris teks): 2 = aturan
 * K-1 (D-242) untuk semua keluarga kecuali yang menyatakan aturan sendiri.
 */
export const NODE_PAD_UNITS = 2;

/**
 * HS `_node_size(n, sheet, tier_nodes=None)` (:432-449): `[w, h]` mm. Lebar
 * kelipatan kisi, satu lebar per tingkat bila `tierNodes` diberikan
 * (Python menjumlahkan label + sub di cabang ini, dipertahankan); tinggi
 * = (baris teks 1 + sub + tag + `padUnits`) x satu baseline (D-242; Python:
 * x dua baseline). `padUnits` bawaan 2 (= unit 3 + sub + tag); keluarga
 * graph memakai 1 (FIX-B2, `layout-c/graph.ts`).
 */
export function nodeSize(
  n: DiagramNode,
  L: Pick<Lattice, "x" | "y">,
  tierNodes?: readonly DiagramNode[],
  padUnits: number = NODE_PAD_UNITS,
): [number, number] {
  const pad = capPad();
  let w = snap(textNeedMm(n), L.x);
  if (tierNodes && tierNodes.length > 0) {
    let widest = -Infinity;
    for (const t of tierNodes) {
      const [lw, sw] = labelSubWidths(t);
      const v = lw + sw + pad;
      if (v > widest) widest = v;
    }
    w = Math.max(snap(widest, L.x), L.x * 3);
  }
  w = Math.max(w, L.x * 3);
  let units = 1 + padUnits;
  if (pyTruthy(nodeGet(n, "sub", undefined))) units += 1;
  if (pyTruthy(nodeGet(n, "tag", undefined))) units += 1;
  const h = textUnitsHeightMm(units, L);
  return [w, h];
}

/**
 * HS `Sheet.height()` (:404-410): `snap(max(ys) or top, LATTICE_Y) +
 * LATTICE_Y * 2 + foot`, ys = tepi bawah simpul, lajur, dan `msg_end` bila
 * truthy. Tata letak memanggilnya dengan `foot` = 0 (cadangan kaki apparatus
 * ditambahkan build setelah snap akhir, seperti `build_svg`).
 */
export function sheetHeight(
  L: Pick<Lattice, "y" | "top">,
  nodes: Iterable<{ y: number; h: number }>,
  lanes: Iterable<{ y: number; h: number }> = [],
  msgEnd?: number | null,
  footMm = 0.0,
): number {
  const ys: number[] = [];
  for (const n of nodes) ys.push(n.y + n.h);
  for (const l of lanes) ys.push(l.y + l.h);
  if (msgEnd) ys.push(msgEnd); // Python: `if getattr(self, "msg_end", None)`
  const top = ys.length > 0 ? Math.max(...ys) : L.top;
  return snap(top, L.y) + L.y * 2 + footMm;
}

