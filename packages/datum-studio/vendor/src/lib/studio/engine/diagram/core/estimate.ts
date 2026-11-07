/**
 * Perkiraan geometri tanpa menulis SVG (P9 E-19; port `estimate` +
 * `render_hint` dan cek tahap-build non-rute dari `build_svg`,
 * `datum_diagram.py:1115-1202, 1424-1435`).
 *
 * Python `estimate` memanggil `build_svg` penuh. Di Studio, tata letak milik
 * S27-S29 dan rute milik S30, sedangkan modul ini tidak boleh mengimpor
 * dispatcher D01 (01_specs.md §8.3). Karena itu fungsi layout disuntikkan
 * (`DIAGRAM_LAYOUTS[spec.family]`). Cek yang butuh rute (DATUM-32) dan keluaran
 * SVG (DATUM-29/30) tidak dijalankan di sini; daftar `checksRun` jujur.
 */
import type { LayoutFn, StudioDiagramV1 } from "../../../contract";
import { DiagramDefect } from "./defect";
import { DiagramOverCapacity } from "../../figure-capacity";
import { pyFixed, pyRound0 } from "./pyfmt";
import { diagramColourValues } from "./colour";
import { Sheet, footReserveMm } from "./sheet";
import { assertValidSpec } from "./spec";
import { baselineStepMm } from "./geometry";
import { type DiagramGrid, resolveDiagramGrid } from "./grid";
import { BASELINE_PT, DIAGRAM_ROLES, LATTICE_Y, LIMITS, STROKE_FLOOR_MM, STROKE_HAIR, STROKE_PRIMARY, role } from "./tokens";

export interface DiagramEstimate {
  widthMm: number;
  heightMm: number;
  nColour: number;
  /**
   * Nilai heks yang akan dicetak, terurut, kertas dibuang. Model emisi
   * `diagramColourValues` (colour.ts) = hitungan SVG build; DEVIASI dari model
   * token Python yang tidak lengkap (IP-39b, S84 #2).
   */
  colourValues: string[];
  nNodes: number;
  nEdges: number;
  apparatus: "page" | "figure";
  family: StudioDiagramV1["family"];
  checksRun: string[];
}

/** Ordinat pesan sequence (penjumlahan berulang seperti Python). */
export function sequenceMessageYs(sheet: Sheet, nEdges: number): number[] {
  const ys: number[] = [];
  let y = sheet.msgY ?? sheet.top;
  // D-242: tiga baseline, sama dengan layout sequence.
  const step = sheet.msgStep ?? baselineStepMm(3, { y: LATTICE_Y });
  for (let i = 0; i < nEdges; i += 1) {
    ys.push(y);
    y += step;
  }
  return ys;
}

/** Cek token DATUM-28 (tipe >= 5,5 pt) dan DATUM-27 (garis >= lantai fotokopi). */
export function tokenFloorChecks(): ["DATUM-28", "DATUM-27"] {
  for (const rname of DIAGRAM_ROLES) {
    const size = role(rname).size;
    if (size < LIMITS.diagram_type_min_pt) {
      throw new DiagramDefect(
        `DATUM-28: peran ${rname} mencetak ${pyFixed(size, 2)} pt di bawah ambang ${pyFixed(LIMITS.diagram_type_min_pt, 1)} pt (P8)`,
        { checkId: "DATUM-28" },
      );
    }
  }
  for (const sw of [STROKE_PRIMARY, STROKE_HAIR, STROKE_PRIMARY * 3]) {
    if (sw < STROKE_FLOOR_MM - 1e-9) {
      throw new DiagramDefect(
        `DATUM-27: garis ${pyFixed(sw, 3)} mm di bawah lantai fotokopi ${pyFixed(STROKE_FLOOR_MM, 3)} mm (T rules_mm, P8)`,
        { checkId: "DATUM-27" },
      );
    }
  }
  return ["DATUM-28", "DATUM-27"];
}

/**
 * Perkirakan lebar, tinggi, dan jumlah nilai warna. `layout` = fungsi tata
 * letak keluarga spek (wajib; mis. `DIAGRAM_LAYOUTS[spec.family]`). Melempar
 * `DiagramDefect` untuk cacat yang juga dilempar Python sebelum rute.
 */
export function estimate(s: StudioDiagramV1, layout?: LayoutFn, opts: { grid?: DiagramGrid } = {}): DiagramEstimate {
  const grid = resolveDiagramGrid(opts.grid);
  const ran = assertValidSpec(s, opts.grid ? { grid: opts.grid } : {});
  if (!layout) {
    throw new DiagramDefect(
      `estimate: fungsi tata letak keluarga '${s.family}' wajib disuntikkan (DIAGRAM_LAYOUTS, 01_specs.md §8.3)`,
      { checkId: "P2-layout" },
    );
  }
  const sheet = new Sheet(Number(s.width_mm), undefined, grid.latticeXMm);
  const res = layout(s, sheet);
  if (res) sheet.applyLayout(res, s);
  ran.push(sheet.snapToLattice());

  const nEdges = (s.edges ?? []).length;
  if (s.family === "sequence") {
    const ys = sequenceMessageYs(sheet, nEdges);
    sheet.msgEnd = ys.length > 0 ? Math.max(...ys) : (sheet.msgY ?? sheet.top);
    ran.push("P2-sequence-time-vertical");
  }
  ran.push(...tokenFloorChecks());

  sheet.foot = footReserveMm(s, sheet.widthMm); // row 124 (CP-46): a wrapped key counts every line
  const H = sheet.height();
  if (H > grid.maxHeightMm + 1e-6) {
    // Swarm patch (row 158, U24 B): over-capacity refusal with the measured height and the limit.
    throw new DiagramOverCapacity(`DATUM-33: tinggi gambar ${pyFixed(H, 2)} mm melewati blok teks ${pyFixed(grid.maxHeightMm, 1)} mm (P8)`, {
      checkId: "DATUM-33",
      family: String(s.family),
      quantity: "tinggi gambar",
      unit: "mm",
      limit: Math.round(grid.maxHeightMm * 10) / 10,
      measured: Math.round(H * 100) / 100,
      suggestion: `kurangi simpul/pesan per gambar atau pecah menjadi 2 diagram (${(s.nodes ?? []).length} simpul, ${nEdges} konektor dalam gambar ini)`,
    });
  }
  ran.push("DATUM-33");

  const colourValues = diagramColourValues(s, sheet);
  if (colourValues.length > LIMITS.max_colour_values) {
    throw new DiagramDefect(
      `DATUM-25: ${colourValues.length} nilai warna dalam satu gambar, maksimum ${LIMITS.max_colour_values} (temuan E-16: plafon ini nyata) (P5/P8)`,
      { checkId: "DATUM-25" },
    );
  }
  ran.push("DATUM-25");

  return {
    widthMm: sheet.widthMm,
    heightMm: H,
    nColour: colourValues.length,
    colourValues,
    nNodes: sheet.nodes.size,
    nEdges,
    apparatus: s.apparatus ?? "page",
    family: s.family,
    checksRun: ran,
  };
}

/** P6: piksel PNG 300 dpi dari lebar/tinggi mm (`render_hint`). */
export function renderHint(rep: { widthMm: number; heightMm: number }): {
  dpi: 300;
  widthPx: number;
  heightPx: number;
  note: string;
} {
  const dpi = 300;
  const px = (mm: number): number => pyRound0((mm / 25.4) * dpi);
  return {
    dpi,
    widthPx: px(rep.widthMm),
    heightPx: px(rep.heightMm),
    note: `PNG dihasilkan datum_render.py (DHS-RB-05); helper .docx melepas spasi baris ${BASELINE_PT} pt (P6)`,
  };
}
