/**
 * Ukuran kertas dari kenop (SR-60; research/09 §6.2 butir 1, register
 * 03_structural_sections_specs §13.3 DV-01 dan §13.4, D-158, KD-25).
 *
 * Satu sumber ukuran halaman: `page.size` + `page.orientation` (+
 * `page.customSizeMm`) -> `page.sizeMm`. Dimensi kertas dibaca dari kontrak
 * (E38 `PAPER_SIZE_MM`). Tidak ada fallback A4: bila kenop tidak terbaca, hasil
 * `undefined` dan nilai `page.sizeMm` yang ada dipertahankan pemanggil.
 */
import { PAPER_SIZE_MM, type PaperSize, type ParamMap, type ParamValue } from "../../contract";

/** Kunci kenop ukuran halaman (register R-44..R-46). */
export const PAGE_KNOB = {
  size: "page.size",
  orientation: "page.orientation",
  customSizeMm: "page.customSizeMm",
} as const;

function positivePair(v: ParamValue | undefined): [number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const [a, b] = v;
  return typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0
    ? [a, b]
    : undefined;
}

function paperMm(name: ParamValue | undefined): readonly [number, number] | undefined {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(PAPER_SIZE_MM, name)
    ? PAPER_SIZE_MM[name as PaperSize]
    : undefined;
}

/**
 * `pageSizeFromPaper` (register DV-01; nama kanonik D-172, alias research/09
 * dihapus IP-50):
 * dasar = `page.customSizeMm` bila terisi, selain itu `PAPER_SIZE_MM[page.size]`;
 * portrait -> [sisi pendek, sisi panjang], landscape -> [panjang, pendek].
 * Orientasi berlaku per unit (cakupan `slot`): pemanggil per slot cukup
 * menimpa `page.orientation` di petanya lalu menurunkan ulang.
 */
export function pageSizeFromPaper(p: ParamMap): [number, number] | undefined {
  const base = positivePair(p[PAGE_KNOB.customSizeMm]) ?? paperMm(p[PAGE_KNOB.size]);
  if (!base) return undefined;
  const short = Math.min(base[0], base[1]);
  const long = Math.max(base[0], base[1]);
  return p[PAGE_KNOB.orientation] === "landscape" ? [long, short] : [short, long];
}
