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
import { colourBudgetDetail, diagramColourBudget, diagramColourSources, diagramColourValues } from "./colour"; // INT-1 (row 62 twin); row 57
import { measure, wrap } from "../../chart/core/textfit";
import { Sheet, footReserveMm } from "./sheet";
import { assertValidSpec } from "./spec";
import { baselineStepMm } from "./geometry";
import { type DiagramGrid, resolveDiagramGrid } from "./grid";
import { BASELINE_PT, DIAGRAM_ROLES, LATTICE_Y, LIMITS, STROKE_FLOOR_MM, STROKE_HAIR, STROKE_PRIMARY, pt2mm, role } from "./tokens";

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
  // Swarm 1.3.3 row 57 (request of row 40): the foot as build/svg.ts reserves it: key and SUMBER (`footReserveMm`), the
  // author's note rows (row 54), then row 40's drop of the foot below zone frames, lifelines, lanes and pools.
  sheet.foot += noteLineCount(s, sheet.widthMm) * LATTICE_Y;
  const H0 = sheet.height();
  const H = H0 + (sheet.foot > 0 ? footDropMm(H0 - LATTICE_Y * 2 - sheet.foot, footBottoms(s, sheet, res)) : 0);
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
  const budget = diagramColourBudget(s, sheet); // Swarm 1.3.3 row 57 (ST-6): twin of the build count
  if (budget.count > LIMITS.max_colour_values) {
    throw new DiagramDefect(
      // Swarm 1.2.6 INT-1 (twin of build/svg.ts row 62, T-06): name each counted value, its sources and the remainder.
      `DATUM-25: ${budget.count} nilai warna dalam satu gambar, maksimum ${LIMITS.max_colour_values} (temuan E-16: plafon ini nyata) (P5/P8); ${colourBudgetDetail(budget, diagramColourSources(s, sheet), LIMITS.max_colour_values)}`,
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

/**
 * Swarm 1.3.3 row 57: printed lines of the author's `notes[]`, as build/svg.ts `specNoteLines` (row 54) counts them with
 * the default label `CATATAN`: one line per non-blank entry, more when the entry is wider than the sheet and the wrap
 * keeps every character. A caller of the build that passes another `noteLabel` can wrap differently.
 */
export function noteLineCount(s: Pick<StudioDiagramV1, "notes">, W: number, label = "CATATAN"): number {
  const pt = role("source_line").size;
  const maxW = W - 0.5 - measure(" ", pt);
  const squash = (t: string): string => t.replace(/\s+/g, "");
  return (s.notes ?? [])
    .filter((e): e is string => typeof e === "string" && e.trim() !== "")
    .map((entry) => {
      const one = `${label}  ${entry}`;
      if (measure(one, pt) <= W - 0.5) return 1;
      const r = wrap(`${label} ${entry}`, maxW, NOTE_MAX_LINES, { pt });
      return r.lines.length > 1 && r.lines[0].startsWith(`${label} `) && squash(r.lines.join("")) === squash(one) ? r.lines.length : 1;
    })
    .reduce((a, b) => a + b, 0);
}

/** Row 57: build/svg.ts `NOTE_MAX_LINES` (row 54). */
const NOTE_MAX_LINES = 40;
/** Row 57: build/svg.ts `FOOT_ROW_RISE_EM` (row 40). */
const FOOT_ROW_RISE_EM = 0.75;

/** Row 57: build/svg.ts `footDropMm` (row 40): whole lattice rows that put the first foot row below every bottom. */
function footDropMm(contentBottom: number, bottoms: readonly number[]): number {
  if (!bottoms.length) return 0;
  const over = Math.max(...bottoms) + FOOT_ROW_RISE_EM * pt2mm(role("table_header").size) - (contentBottom + LATTICE_Y);
  return over > 1e-6 ? Math.ceil(over / LATTICE_Y - 1e-9) * LATTICE_Y : 0;
}

/**
 * Row 57: the lower edges build/svg.ts passes to `footDropMm` that exist without routing: zone frames (members' box plus
 * the Garis A pad of two rows; a pad that `zonePads` caps lies above a node, hence above the content bottom, and cannot
 * move the foot), the lifeline end, lanes and the swimlane frame with its pools. Connector points and edge-label bands
 * need the router and are not mirrored: a connector or label drawn below the lowest node makes the build taller.
 */
function footBottoms(s: StudioDiagramV1, sheet: Sheet, res: unknown): number[] {
  const contentBottom = sheet.height() - LATTICE_Y * 2 - sheet.foot;
  const zones = (s.zones ?? []).flatMap((z) => {
    const members = (z.members ?? []).map((m) => sheet.nodes.get(m)).filter((m) => m !== undefined);
    return members.length ? [Math.max(...members.map((m) => m.y + m.h)) + LATTICE_Y * 2] : [];
  });
  type Frame = { orientation: string; bottom: number; pools?: Array<{ hi: number }> };
  const frame = s.family === "swimlane" && res && typeof res === "object" ? (res as { frame?: Frame }).frame : undefined;
  return [
    ...zones,
    ...(sheet.lifelines.length ? [contentBottom + LATTICE_Y] : []),
    ...sheet.lanes.map((lane) => lane.y + lane.h),
    ...(frame ? [frame.bottom, ...(frame.orientation === "horizontal" ? (frame.pools ?? []).map((p) => p.hi) : [])] : []),
  ];
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
