/**
 * Penjaga tabel G1-G3 dengan sub-cek G4 (port `datumcheck.table_guards`, HS
 * read-only; registri lint `G1`/`G2`/`G3`, research/01 §6.2).
 *
 * Python melempar CheckDefect pada pelanggaran pertama; di sini setiap cek
 * menghasilkan LintIssue: satu `PASS` per cek bila bersih, atau satu `FAIL` per
 * pelanggaran (pointer JSON relatif blok). G4 dilaporkan sebagai `G3` dengan
 * `detail` diawali "G4".
 */
import type { LintIssue, TableBlock } from "../../../contract";
import { cellPlain, rowSpan } from "./model";
import { DEFAULT_NUMERALS_PT, numFloorMm, numTokens, okWidthsMm, pyLen, solveWidthsImpl, twToMm } from "./widths";

/** Toleransi G2 (G-DQ-06). */
export const G2_TOLERANCE_MM = 0.05;

export interface TableGuardOptions {
  /** Lebar total (mm) untuk menurunkan kolom tanpa lebar (P5-14 `table.columnWidthSumMm` turunan); default = kolom teks registri. */
  totalMm?: number;
  /** Ukuran numeral tabel (pt) untuk lantai G4; default 7,8. */
  numeralsPt?: number;
  /**
   * Lebar sah G2 (mm) = `grid.allowedFigureWidthsMm` efektif (turunan kertas, D-245 H1);
   * tidak diisi = bawaan registri (profil kanonik A4 128/166).
   */
  okWidthsMm?: readonly number[];
}

function fmtMm(x: number, d: number): string {
  return x.toFixed(d);
}

/**
 * Lebar kolom (mm) seperti yang akan dipakai renderer: lebar eksplisit
 * (`widthTw` > `widthMm`), sisanya dari solver atas teks sel. `explicit` = semua
 * kolom berlebar eksplisit (G2 hanya bermakna untuk lebar yang dinyatakan).
 */
export function guardWidthsMm(b: TableBlock, totalMm: number): { widths: number[]; explicit: boolean } {
  const given = b.columns.map((c) => (c.widthTw !== undefined ? twToMm(c.widthTw) : c.widthMm));
  const missing = given.map((g, i) => (g === undefined ? i : -1)).filter((i) => i >= 0);
  if (missing.length === 0) return { widths: given as number[], explicit: true };
  const total = b.layout?.widthTw !== undefined ? twToMm(b.layout.widthTw) : totalMm;
  const rem = total - given.reduce<number>((s, g) => s + (g ?? 0), 0);
  const matrix = gridMatrix(b).map((r) => missing.map((i) => r[i]));
  const solved = rem > 0 ? solveWidthsImpl(matrix, rem) : missing.map(() => 0);
  const widths = given.map((g) => g ?? 0);
  missing.forEach((ci, k) => (widths[ci] = solved[k] ?? 0));
  return { widths, explicit: false };
}

/** Matriks teks per kolom grid (sel bergabung menyumbang "" ke kolom yang dibentang). */
export function gridMatrix(b: TableBlock): string[][] {
  const n = b.columns.length;
  const out: string[][] = [];
  for (const row of b.rows) {
    const r: string[] = new Array(n).fill("");
    let ci = 0;
    for (const cell of row.cells) {
      const span = Math.max(1, cell.gridSpan ?? 1);
      if (span === 1 && ci < n) r[ci] = cellPlain(cell);
      ci += span;
    }
    out.push(r);
  }
  return out;
}

export function tableGuards(b: TableBlock, opts: TableGuardOptions = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  const n = b.columns.length;
  // Tanpa lebar total: kolom teks bawaan registri (anggota pertama lebar sah; A4 128).
  const totalMm = opts.totalMm ?? okWidthsMm()?.[0] ?? 0;
  const numeralsPt = opts.numeralsPt ?? DEFAULT_NUMERALS_PT;

  // G1: setiap baris sama cacah sel (dengan gridSpan) dengan jumlah kolom.
  if (b.rows.length === 0) {
    issues.push({ checkId: "G1", status: "FAIL", detail: "tabel kosong", pointer: "/rows" });
  }
  let g1 = 0;
  b.rows.forEach((row, ri) => {
    const span = rowSpan(row);
    if (span !== n) {
      g1++;
      issues.push({
        checkId: "G1",
        status: "FAIL",
        detail: `baris ${ri + 1} memuat ${span} sel (dengan gridSpan), kolom ${n}`,
        pointer: `/rows/${ri}/cells`,
      });
    }
  });
  if (g1 === 0 && b.rows.length > 0) issues.push({ checkId: "G1", status: "PASS" });

  // G2: jumlah lebar kolom = anggota lebar sah turunan (hanya bila semua lebar dinyatakan).
  const { widths, explicit } = guardWidthsMm(b, totalMm);
  if (explicit) {
    const tot = widths.reduce((s, w) => s + w, 0);
    const ok = opts.okWidthsMm && opts.okWidthsMm.length > 0 ? [...opts.okWidthsMm] : okWidthsMm();
    if (!ok) {
      issues.push({ checkId: "G2", status: "FAIL", detail: "lebar sah tidak terbaca: grid.allowedFigureWidthsMm absen", pointer: "/columns" });
    } else if (Math.min(...ok.map((w) => Math.abs(tot - w))) > G2_TOLERANCE_MM) {
      issues.push({
        checkId: "G2",
        status: "FAIL",
        detail: `jumlah lebar kolom ${fmtMm(tot, 2)} mm bukan ${ok.map((w) => String(Math.round(w * 100) / 100)).join(" maupun ")} mm`,
        pointer: "/columns",
      });
    } else {
      issues.push({ checkId: "G2", status: "PASS" });
    }
  } else {
    issues.push({ checkId: "G2", status: "PASS", detail: `lebar diturunkan solveWidths ke ${fmtMm(totalMm, 0)} mm` });
  }

  // G3: teks sel jauh melebihi lebar kolom (~2,05 kar/mm, maks 3 baris wajar).
  let g3 = 0;
  b.rows.forEach((row, ri) => {
    if (row.kind === "header") return;
    let ci = 0;
    row.cells.forEach((cell, k) => {
      const span = Math.max(1, cell.gridSpan ?? 1);
      let w = 0;
      for (let j = ci; j < Math.min(n, ci + span); j++) w += widths[j] ?? 0;
      ci += span;
      const cap = Math.floor(w * 2.05) + 8;
      const len = pyLen(cellPlain(cell));
      if (len > cap * 3) {
        g3++;
        issues.push({
          checkId: "G3",
          status: "FAIL",
          detail: `teks baris ${ri + 1} kolom ${k + 1} (${len} kar) jauh melebihi lebar ${fmtMm(w, 1)} mm`,
          pointer: `/rows/${ri}/cells/${k}`,
        });
      }
    });
  });

  // G4 (sub G3): lantai lebar kolom berisi angka bergrup titik.
  const matrix = gridMatrix(b);
  for (let ci = 0; ci < n; ci++) {
    const toks = matrix.flatMap((r) => numTokens(r[ci] ?? ""));
    if (toks.length === 0) continue;
    let need = 0;
    let worst = toks[0];
    for (const t of toks) {
      const f = numFloorMm(t, numeralsPt);
      if (f > need) need = f;
      if (pyLen(t) > pyLen(worst)) worst = t;
    }
    const w = widths[ci] ?? 0;
    if (w + 1e-9 < need) {
      g3++;
      issues.push({
        checkId: "G3",
        status: "FAIL",
        detail: `G4 kolom ${ci + 1} lebar ${fmtMm(w, 1)} mm di bawah lantai token '${worst}' = ${fmtMm(need, 1)} mm`,
        pointer: `/columns/${ci}`,
      });
    }
  }
  if (g3 === 0) issues.push({ checkId: "G3", status: "PASS" });
  return issues;
}
