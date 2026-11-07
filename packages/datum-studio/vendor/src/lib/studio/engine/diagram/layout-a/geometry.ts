/**
 * Geometri tata letak layered/flow (S27, I17). Utilitas bersama (kisi,
 * `_node_size`, `Sheet.height`, `snap`, `est_text_mm`, truthiness, `str()`)
 * kini berasal dari SATU modul `../core/geometry` (IP-39b, S84 #7); berkas ini
 * hanya mengekspor ulangnya dan memuat helper khusus layout-a. Urutan operasi
 * floating-point tetap = Python (`HS/datum_diagram.py`):
 *  - `round()` Python = pembulatan setengah-ke-genap (bukan Math.round);
 *  - `a // b` pada float = algoritme floordiv CPython (fmod lalu floor);
 *  - `len(str)` = jumlah code point, bukan unit UTF-16.
 */
export { BASELINE_PT } from "../core/tokens";
export { type Lattice, baselineStepMm, latticeOf, nodeSize, pyScalarStr as pyStr, pyTruthy, sheetHeight, snap } from "../core/geometry";

/** Python `a // b` untuk float (CPython `_float_div_mod`); `b` bukan nol. */
export function pyFloorDiv(a: number, b: number): number {
  let mod = a % b; // fmod C
  let div = (a - mod) / b;
  if (mod !== 0 && b < 0 !== mod < 0) {
    mod += b;
    div -= 1.0;
  }
  if (div === 0) return 0;
  let floordiv = Math.floor(div);
  if (div - floordiv > 0.5) floordiv += 1.0;
  return floordiv;
}

/** Python `int(x)` untuk bilangan: potong menuju nol. */
export function pyInt(x: number): number {
  return Math.trunc(x);
}
