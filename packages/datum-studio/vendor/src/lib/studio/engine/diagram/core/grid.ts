/**
 * Grid turunan templat untuk mesin diagram (FIX-B, D-245 / SR-56 H1 bagian
 * diagram; D-158 "himpunan lebar figur sah = TURUNAN, A4 tetap 128/166").
 *
 * Mesin tidak lagi hanya menerima konstanta A4 (128/166 mm, tinggi <= 247 mm):
 * pemanggil (compose/render) meneruskan nilai turunan templat
 *  - `allowedWidthsMm` = `grid.allowedFigureWidthsMm` ([kolom teks, bentang penuh]);
 *  - `maxHeightMm`     = `grid.textBlockHeightMm` (= `diagram.maxHeightMm`, DATUM-33);
 *  - `latticeXMm`      = `grid.latticeXMm` (opsional; bawaan kolom teks / 12).
 * Diagram digambar PADA lebar nyata (1 satuan SVG = 1 mm, ukuran huruf = token
 * pt), jadi tidak ada skala pasca-render dan lantai DATUM-28 tetap berlaku apa
 * adanya. Tanpa grid = A4 (nilai dan pesan bit-identik dengan sebelumnya).
 * Grid tidak sah = `BY_CONSTRUCTION_FAILED` bernama (tanpa cadangan diam-diam).
 */
import { DiagramDefect } from "./defect";
import { ALLOWED_WIDTHS, LATTICE_X, LIMITS } from "./tokens";

export interface DiagramGrid {
  /** Lebar figur sah (mm), urutan [kolom teks, bentang penuh]; `grid.allowedFigureWidthsMm`. */
  allowedWidthsMm: readonly number[];
  /** Tinggi gambar maksimum (mm) = blok teks; `grid.textBlockHeightMm` (DATUM-33). */
  maxHeightMm: number;
  /** Kisi horizontal (mm); `grid.latticeXMm`. Absen = lebar sah terkecil / 12. */
  latticeXMm?: number;
}

/** Grid A4 potret DATUM (128/166 mm, 247 mm, kisi 128/12): bawaan bila pemanggil tidak meneruskan grid. */
export const DIAGRAM_GRID_A4: Readonly<Required<DiagramGrid>> = Object.freeze({
  allowedWidthsMm: Object.freeze([...ALLOWED_WIDTHS]),
  maxHeightMm: LIMITS.text_block_max_mm,
  latticeXMm: LATTICE_X,
});

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Grid efektif. Kisi horizontal yang berselisih < 1e-3 mm dari `LATTICE_X`
 * dipakai sebagai `LATTICE_X` persis (aturan `latticeOf`, paritas A4).
 */
export function resolveDiagramGrid(grid?: DiagramGrid): Readonly<Required<DiagramGrid>> {
  if (grid === undefined) return DIAGRAM_GRID_A4;
  const widths = grid.allowedWidthsMm;
  if (!Array.isArray(widths) || widths.length === 0 || !widths.every(positive)) {
    throw new DiagramDefect(`grid diagram tidak sah: allowedWidthsMm ${JSON.stringify(widths)} harus daftar lebar mm > 0 (grid.allowedFigureWidthsMm)`, {
      checkId: "P1-width_mm",
    });
  }
  if (!positive(grid.maxHeightMm)) {
    throw new DiagramDefect(`grid diagram tidak sah: maxHeightMm ${String(grid.maxHeightMm)} harus mm > 0 (grid.textBlockHeightMm)`, { checkId: "DATUM-33" });
  }
  if (grid.latticeXMm !== undefined && !positive(grid.latticeXMm)) {
    throw new DiagramDefect(`grid diagram tidak sah: latticeXMm ${String(grid.latticeXMm)} harus mm > 0 (grid.latticeXMm)`, { checkId: "DATUM-37-lebar" });
  }
  const lx0 = grid.latticeXMm ?? Math.min(...widths) / 12.0;
  const latticeXMm = Math.abs(lx0 - LATTICE_X) < 1e-3 ? LATTICE_X : lx0;
  return { allowedWidthsMm: [...widths], maxHeightMm: grid.maxHeightMm, latticeXMm };
}

/** Angka lebar untuk pesan: bilangan bulat tanpa desimal (A4: "128", "166"). */
export function widthLabel(mm: number): string {
  return Number.isInteger(mm) ? String(mm) : String(Math.round(mm * 1000) / 1000);
}
