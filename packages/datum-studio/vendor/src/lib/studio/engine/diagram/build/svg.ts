/**
 * Rakitan SVG diagram (S30): port `build_svg` (`HS/datum_diagram.py`
 * :1115-1360) dan `_label_pos`/`_mid_label` (:1375-1407) di atas primitif
 * core S26 (Sheet, nodeSvg, edgePathSvg, hopSvg, edgeLabelSvg, diagramDefs,
 * svgText, lineSvg, diagramColourValues, tokenFloorChecks).
 *
 * Urutan elemen = Python: deklarasi, root mm, komentar generator, komentar
 * apparatus (page), defs, kertas, lajur, garis kehidupan, zona, semua jalur
 * konektor, busur lompatan, pita knockout + label tepi, simpul, kaki apparatus
 * (caption/KEY/SUMBER). Atribut `data-mark` (node/link) ditambahkan core
 * setelah atribut Python. Deterministik: tanpa jam, acak, atau I/O.
 */
import type { DiagramFamily, LayoutFn, LintIssue, RoutedEdge, StudioDiagramV1, SvgResult } from "../../../contract";
import {
  APPARATUS_REQUIRED_COMMENT,
  captionSvg,
  checksRunOf,
  keyLineTexts,
  nodeSymbolId,
  DASH_PATTERNS,
  DiagramDefect,
  diagramDefs,
  snapCeil,
  drawsSvgKeyRow,
  EDGE_KINDS,
  edgeLabelSvg,
  edgePathSvg,
  escText,
  estTextMm,
  footReserveMm,
  generatorComment,
  hopSvg,
  LATTICE_Y,
  LIMITS,
  lineSvg,
  nodeSvg,
  paperRectSvg,
  polylineD,
  pt2mm,
  pyFixed,
  pyInt,
  pyNum,
  role,
  Sheet,
  STROKE_HAIR,
  STROKE_PRIMARY,
  pyStr,
  svgColourValues,
  svgText,
  svgTextLines,
  tokenFloorChecks,
  TRACK,
  colourOf,
  MARKS,
  MARK_COLOUR_TOKENS,
  type DiagramGrid,
  resolveDiagramGrid,
  type SheetNode,
  type ValidateSpecOptions,
} from "../core";
import { diagramFitActive, diagramFitNote, diagramFitRoute } from "../fit/state";
import { footLines } from "./footwrap";
import { measure, wrap } from "../../chart/core/textfit"; // row 54 (ST-5): note rows wrap to the sheet width
import { routeSequenceMessages, type SequenceLayout } from "../layout-b";
import { flowDirectionOf, flowSerialisedNote } from "../layout-a/flow";
import { tierLabelSvgs, type TierLabelLayoutExtras } from "../layout-a/layered";
import { autoFitDiagram, type DiagramGeometryIssue } from "./autofit";
import type { EdgeLabelPlan } from "../fit/labels";
import { fitEdgeLabels, noteRows, planBands, shiftPlan, zoneClearOn, zoneGeom } from "./fitlabels";
import { placeDiagram, type Placement } from "./place";
import { poolFlowCrossesNotes, type SwimFrame, type SwimPool } from "../layout-b/swimlane";
import { reorderPlaced } from "./order";
import { capacityRetry, isCapacityReject, withAction } from "./capacity";
import { crossingHops, routePlaced, routeStyleOfPath, type HoppedEdge } from "./route";
import { canonicalSymbolId } from "../../symbols";
import { colourBudgetDetail, diagramColourSources, svgColourBudget } from "../core/colour"; // row 62 (T-06); 1.3.3 row 57 (ST-6)
import { edgeArrowsOfPaths, edgeLineDash, nodeShadowSvg, type EdgeArrows } from "../core/svg"; // row 57 (VIS-7); row 57b: shared path-edge matching; row 57c: node shadow; 1.2.9 row 27: edgeLineDash
import { labelAtBaseline, runOrder, spotClear } from "../fit/labels"; // row 57b (VIS-9); row 57c: runOrder, spotClear
import type { HeadSize } from "../fit/lint"; // row 57c
import { ARROW_SIZES_MM } from "../core/tokens"; // row 57c

/**
 * Laporan rakitan (HS `report`) di atas `SvgResult.report`.
 *
 * Basis tiap id di `checksRun` (S84 #14): DATUM-25 dan DATUM-37-lebar diukur
 * pada keluaran (SVG terpancar / geometri ter-snap); DATUM-32 ditegakkan detur
 * rute; DATUM-27/28 adalah cek KONSTRUKSI atas konstanta token (bukan pemindaian
 * keluaran); DATUM-29/30 dan DATUM-36 memeriksa string yang baru dipancarkan
 * fungsi ini sendiri (cek konstruksi, nyaris tautologis). Id `checksRun` tetap
 * = Python demi paritas laporan.
 */
export interface DiagramBuildReport {
  checksRun: string[];
  issues: LintIssue[];
  colourValues: string[];
  nColour: number;
  nHops: number;
  nNodes: number;
  nEdges: number;
  apparatus: "page" | "figure";
  family: DiagramFamily;
  /**
   * FIG-02b: temuan lint geometri dan catatan tata letak otomatis (selalu REPORT, tidak pernah
   * FAIL), masing-masing dengan `suggest`. Absen bila render pertama lint-bersih. Sengaja tidak
   * digabung ke `issues` (uji kontrak `issues == []` per fixture; keputusan controller).
   */
  geometry?: DiagramGeometryIssue[];
  /**
   * Swarm 1.2.7 row 36b (T-12, N7-138): apparatus furniture the SVG draws itself, only for apparatus "figure":
   * KUNCI lines, SUMBER lines (after wrapping) and the furniture height in mm (caption, KUNCI, SUMBER).
   * Report only; the SVG bytes are unchanged.
   */
  furniture?: { keyLines: number; sourceLines: number; heightMm: number; noteLines?: number };
}

export interface DiagramSvgResult extends SvgResult {
  report: DiagramBuildReport;
}

/**
 * Opsi rakit. `grid` (D-245) = nilai turunan templat (`grid.allowedFigureWidthsMm`,
 * `grid.textBlockHeightMm`, `grid.latticeXMm`); absen = A4 128/166/247.
 */
export interface DiagramBuildOptions {
  release: boolean;
  grid?: DiagramGrid;
  /**
   * Swarm patch (row 124, CP-28/48): caption label word of an `apparatus: "figure"` SVG, printed
   * bold before the number (DT-15 ID p.41). Default `GAMBAR` (Indonesian edition); an English
   * document passes `FIGURE`.
   */
  figureLabel?: string;
  /**
   * Row 124: first word of the key line drawn inside the SVG. Default `KEY` (the original word, so
   * output is unchanged); the key language itself is CP-35 (row 123), which can pass `KUNCI` here
   * without editing this file.
   */
  keyLabel?: string;
  /**
   * Row 124b (CP-35, C69; ID p.13, p.67 Tabel 10.4): wording of each key row in the document
   * language, applied before the rows are packed into lines (an Indonesian document passes
   * `keyLineText(row, "ID")`: DATA -> PENUH, CONTROL -> PUTUS-PUTUS, SYNC -> TITIK-TITIK). Absent =
   * rows as written (output unchanged).
   */
  keyRowText?: (row: string) => string;
  /**
   * Swarm row 165P (C205, CP-28/48; ID p.41 DT-15 "baris SUMBER yang diakhiri PROVENANS untuk tabel data", p.57): the
   * PROVENANS part an `apparatus: "figure"` SVG prints after its SUMBER text, as the page apparatus does
   * (html/tables/apparatus.ts `sourceInner`: label, then glyph + label per mark joined by " · "). `label` = the
   * document-language word (PROVENANS / PROVENANCE), `marks` = the figure's marks with their label text. Absent or no
   * mark = SUMBER as before.
   */
  provenance?: { label: string; marks: ReadonlyArray<{ mark: keyof typeof MARKS; text: string }> };
  /**
   * Swarm 1.3.3 row 54 (ST-5): label word of the note rows printed from `spec.notes[]`. Default `CATATAN`
   * (`DEFAULT_NOTE_LABEL`), written like KUNCI and SUMBER; an English document can pass `NOTE`.
   */
  noteLabel?: string;
}

/** Row 54 (ST-5): default label word of an author note row. */
export const DEFAULT_NOTE_LABEL = "CATATAN";
/** Row 54: attribute on every line of an author note row; its value is the 1-based index of the entry in `notes[]`. */
export const NOTE_MARK_ATTR = "data-st-note";
/** Row 54: a note is never cut; this only bounds the search of the wrap. Past it the last line holds the rest. */
const NOTE_MAX_LINES = 40;

/**
 * Swarm 1.3.3 row 54 (ST-5, gap matrix section 5 #5): the lines of the author's `notes[]`, top to bottom. One entry =
 * one row `LABEL  text` in role `source_line` (not capitalised: the author's letter case is printed), wrapped to the
 * sheet width `W` when it is wider (continuation lines carry no label). Wrapping does not depend on the fit pass, so
 * the first render and the fitted render print the same lines. A blank entry prints nothing. The text is never cut:
 * when the wrap would lose or change a character, or a word has no place to break, the entry stays one line.
 * These are the AUTHOR's notes; the numbered edge-label notes the engine makes itself are `noteRows` (fitlabels.ts).
 */
function specNoteLines(s: Pick<StudioDiagramV1, "notes">, W: number, label: string): Array<{ text: string; note: number }> {
  const out: Array<{ text: string; note: number }> = [];
  const pt = role("source_line").size;
  const maxW = W - 0.5 - measure(" ", pt); // the label keeps its two spaces; the wrap counts one
  (s.notes ?? []).forEach((entry, i) => {
    if (typeof entry !== "string" || entry.trim() === "") return;
    const one = `${label}  ${entry}`;
    let lines = [one];
    if (measure(one, pt) > W - 0.5) {
      const r = wrap(`${label} ${entry}`, maxW, NOTE_MAX_LINES, { pt });
      const squash = (t: string): string => t.replace(/\s+/g, "");
      const head = `${label} `;
      if (r.lines.length > 1 && r.lines[0].startsWith(head) && squash(r.lines.join("")) === squash(one)) {
        lines = [`${label}  ${r.lines[0].slice(head.length)}`, ...r.lines.slice(1)];
      }
    }
    for (const text of lines) out.push({ text, note: i + 1 });
  });
  return out;
}

/** Row 124 (CP-28/48): default caption label word (manual Rev A ID edition, DT-15). */
export const DEFAULT_FIGURE_LABEL = "GAMBAR";

/**
 * Swarm patch (row 124, CP-45; SM-01 / SM-04, ID p.66): every node symbol must be a library symbol
 * (unknown id = SCHEMA_INVALID from `canonicalSymbolId`) and one figure uses one symbol dialect.
 */
function assertNodeSymbols(s: StudioDiagramV1): void {
  const dialects = new Set<string>();
  for (const n of s.nodes ?? []) {
    const sid = nodeSymbolId(n);
    if (!sid) continue;
    dialects.add(canonicalSymbolId(sid).split(":", 1)[0]);
  }
  if (dialects.size > 1) {
    throw new DiagramDefect(`SM-04: satu dialek simbol per gambar; spec memakai ${[...dialects].sort().join(", ")} (lint 35)`, { checkId: "SM-04" });
  }
}

/** Ketergantungan rakitan (disuntik untuk uji; bawaan = `validateSpec` core I16 + `DIAGRAM_LAYOUTS` D01). */
export interface DiagramBuildDeps {
  validate: (s: StudioDiagramV1, opts: ValidateSpecOptions) => LintIssue[];
  layouts: Readonly<Record<DiagramFamily, LayoutFn>>;
}

// ------------------------------------------------------------- label tepi
type Seg = readonly [readonly [number, number], readonly [number, number]];
const segLen = (s: Seg): number => Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);

function segsOf(pts: RoutedEdge["points"]): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i], pts[i + 1]]);
  return out;
}

/** HS `_mid_label`: titik tengah segmen terpanjang (maks pertama). */
function midLabel(pts: RoutedEdge["points"]): [number, number] {
  const segs = segsOf(pts);
  if (!segs.length) return [0, 0];
  let best = segs[0];
  for (const s of segs.slice(1)) if (segLen(s) > segLen(best)) best = s;
  return [(best[0][0] + best[1][0]) / 2.0, (best[0][1] + best[1][1]) / 2.0];
}

/**
 * HS `_label_pos`: titik tengah tiap segmen (terpanjang dulu, urut stabil),
 * pilih yang pertama di luar kotak simpul mana pun (diperbesar setengah kotak
 * label); semua bertabrakan = titik tengah terpanjang.
 */
function labelPos(pts: RoutedEdge["points"], nodes: readonly SheetNode[], lw: number, lh: number, heads?: LabelHeads, dash?: readonly number[]): [number, number] {
  const segs = segsOf(pts);
  if (!segs.length) return [0.0, 0.0];
  const order = segs.map((_, i) => i).sort((a, b) => segLen(segs[b]) - segLen(segs[a]) || a - b);
  const padX = lw / 2.0 + 0.8;
  const padY = lh / 2.0 + 0.4;
  const hit = (mx: number, my: number) => nodes.some((nd) => nd.x - padX <= mx && mx <= nd.x + nd.w + padX && nd.y - padY <= my && my <= nd.y + nd.h + padY);
  let first: [number, number] | null = null;
  for (const i of order) {
    const [[ax, ay], [bx, by]] = segs[i];
    const mx = (ax + bx) / 2.0;
    const my = (ay + by) / 2.0;
    if (!hit(mx, my)) {
      first = [mx, my];
      break;
    }
  }
  if (!first) return midLabel(pts);
  if (!heads) return first;
  // Row 57c (C71/C101/C102): the band (`labelKnockoutSvg`: lw + 1.6 wide, baseline = point - 1.2 pt) must keep the
  // connector's own heads visible and leave no stray piece; else the nearest spot that does, on the longest segment
  // run first (straight runs, `runOrder`; 0.25 mm steps out from the midpoint). None: the spot above (auto-fit then
  // re-places it).
  const rail = pt2mm(role("evidence_rail").size);
  const band = (x: number, y: number): [number, number, number, number] => {
    const base = y - pt2mm(1.2);
    return [x - (lw + 1.6) / 2, base - rail * 1.15, x + (lw + 1.6) / 2, base + rail * 0.55];
  };
  // the band also stays 0.3 mm off every node box (the point test above only pads by half the label height)
  // Swarm 1.2.9 row 27 (AC-A04): `dash` = the drawn pattern, so the first render leaves no dash fragment beside the band
  // (the auto-fit path already passes it, build/fitlabels.ts); solid connectors pass none.
  const clear = (x: number, y: number) => {
    const b = band(x, y);
    return spotClear(pts, heads, b, dash) && !nodes.some((nd) => b[0] < nd.x + nd.w + 0.3 && b[2] > nd.x - 0.3 && b[1] < nd.y + nd.h + 0.3 && b[3] > nd.y - 0.3);
  };
  if (clear(first[0], first[1])) return first;
  for (const run of runOrder(pts)) {
    const [[ax, ay], [bx, by]] = run;
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.floor(len / 2 / 0.25));
    for (let k = 0; k <= n; k++) {
      for (const sgn of k === 0 ? [1] : [-1, 1]) {
        const t = 0.5 + (sgn * k * 0.25) / Math.max(len, 1e-9);
        if (t < 0 || t > 1) continue;
        const mx = ax + (bx - ax) * t;
        const my = ay + (by - ay) * t;
        if (!hit(mx, my) && clear(mx, my)) return [mx, my];
      }
    }
  }
  return first;
}

/** Row 57c: marker sizes of a connector's heads (core/svg.ts `arrowMarkerSvg`: L by size, W = 0.89 L). */
type LabelHeads = { end?: HeadSize | null; start?: HeadSize | null };

function headSizeOf(h: EdgeArrows["end"] | EdgeArrows["start"]): HeadSize | null {
  if (!h) return null;
  const L = ARROW_SIZES_MM[h === "kind" ? "m" : h.size];
  return { L, W: 0.89 * L };
}

/** Row 57c: the drawn heads of each routed connector, for `labelPos`. */
function labelHeadsOf(s: StudioDiagramV1, paths: readonly RoutedEdge[]): LabelHeads[] {
  return edgeArrowsOfPaths(s.edges ?? [], paths).map((a) => ({ end: headSizeOf(a.end), start: headSizeOf(a.start) }));
}

/**
 * Swarm 1.2.9 row 27 (AC-A04): the drawn dash pattern of each routed connector in mm, for `labelPos` (as
 * build/fitlabels.ts builds it for auto-fit); undefined = solid. A legacy flow (family `flow` without `direction`) is
 * frozen at its 1.2.5 bytes (01e A15, C10(a), C12): it gets no dash here, so its first render stays as before.
 */
function labelDashOf(s: StudioDiagramV1, paths: readonly RoutedEdge[]): Array<number[] | undefined> {
  if (s.family === "flow" && !flowDirectionOf(s as StudioDiagramV1 & { direction?: unknown })) return paths.map(() => undefined);
  return edgeArrowsOfPaths(s.edges ?? [], paths).map((a, i) => {
    const dash = edgeLineDash(paths[i].kind, a.line)?.split(",").map(Number).filter((v) => Number.isFinite(v));
    return dash?.length ? dash : undefined;
  });
}

// ------------------------------------------------------- D-290 lembar graph
/**
 * D-290 (FIX-B2 siklus 3): keluarga graph memakai margin lembar = kotak pembatas
 * SEMUA unsur + rem tetap `GRAPH_SHEET_PAD_BASELINES` baseline, bukan tepi tetap
 * Garis A (atas 2 kisi, bawah 2 kisi). Unsur: simpul (termasuk tag di dalamnya),
 * titik rute konektor, pita knockout label konektor (posisi = `labelPos`),
 * zona kepercayaan (+/- 2 kisi seperti gambar zona), lalu kaki aparatus (KEY /
 * caption / SUMBER) di bawah isi. Isi digeser vertikal kelipatan kisi (simpul
 * tetap di kisi); geser negatif = turun (mis. zona di tepi atas). Rem 1 baseline
 * = satu langkah kisi vertikal: menampung setengah tebal garis, busur lompatan
 * r 0,9 mm, dan kepala/ekor glif teks di tepi. Acuan: BM Gambar 3.1 (g31) tanpa
 * tepi atas dan sekitar 2 mm di bawah isi.
 */
export const GRAPH_SHEET_PAD_BASELINES = 1;

interface GraphFit {
  paths: RoutedEdge[];
  /** Geser vertikal isi (mm; positif = naik). */
  dy: number;
  /** Tepi bawah isi setelah geser (kelipatan kisi ke atas). */
  contentBottom: number;
  pad: number;
}

function graphFit(s: StudioDiagramV1, sheet: Sheet, paths: readonly RoutedEdge[], bands?: ReadonlyArray<readonly [number, number]>): GraphFit {
  const pad = LATTICE_Y * GRAPH_SHEET_PAD_BASELINES;
  const nodes = [...sheet.nodes.values()];
  const ys: number[] = [];
  for (const nd of nodes) ys.push(nd.y, nd.y + nd.h);
  const railMm = pt2mm(role("evidence_rail").size);
  const fixedAt = edgeArrowsOfPaths(s.edges ?? [], paths).map((a) => a.labelAt); // row 57b (VIS-9)
  const heads = labelHeadsOf(s, paths); // row 57c
  const dashes = labelDashOf(s, paths); // 1.2.9 row 27 (AC-A04)
  paths.forEach((p, i) => {
    for (const [, y] of p.points) ys.push(y);
    if (bands) {
      ys.push(bands[i][0], bands[i][1]); // FIG-02b: rentang label hasil penempatan fit
      return;
    }
    // pita knockout `labelKnockoutSvg`: y = my - 1,15 size, tinggi 1,7 size; my = labelPos - pt2mm(1,2)
    // Row 57b (VIS-9): a `label_at` label sits at its fixed baseline (`labelAtBaseline`), no lift.
    const at = fixedAt[i];
    const my = at ? labelAtBaseline(p.points, at)[1] : labelPos(p.points, nodes, estTextMm(p.label, "evidence_rail"), railMm * 1.4, heads[i], dashes[i])[1] - pt2mm(1.2);
    ys.push(my - railMm * 1.15, my - railMm * 1.15 + railMm * 1.7);
  });
  for (const z of s.zones ?? []) {
    const members = (z.members ?? []).map((m) => sheet.nodes.get(m)).filter((m): m is SheetNode => m !== undefined);
    if (!members.length) continue; // zona tanpa anggota = cacat P5 saat digambar
    ys.push(Math.min(...members.map((m) => m.y)) - LATTICE_Y * 2, Math.max(...members.map((m) => m.y + m.h)) + LATTICE_Y * 2);
  }
  const minY = ys.length ? Math.min(...ys) : sheet.top;
  const maxY = ys.length ? Math.max(...ys) : sheet.top;
  const dy = Math.floor((minY - pad) / LATTICE_Y + 1e-9) * LATTICE_Y;
  for (const nd of nodes) nd.y -= dy;
  const shifted = paths.map((p) => {
    const points = p.points.map(([x, y]) => [x, y - dy] as [number, number]);
    return { ...p, points, d: polylineD(points) };
  });
  return { paths: shifted, dy, contentBottom: snapCeil(maxY - dy - 1e-9, LATTICE_Y), pad };
}

/**
 * Swarm 1.3.3 row 40 (ST-3.1): rise of a foot row above its baseline, in em of the largest foot text (the key row,
 * role `table_header`): cap height 0.70 em plus a stroke margin. A foot row "starts" at baseline minus this rise.
 */
const FOOT_ROW_RISE_EM = 0.75;

/**
 * Row 40 (ST-3.1): how far the foot block (edge-label notes, KUNCI, SUMBER, caption) moves down so that its first row
 * starts below every drawn element. The first foot baseline sits one lattice row below `contentBottom`, which the
 * sheet derives from the nodes (graph: from nodes, routes, label bands and nominal zones). `bottoms` are the lower
 * edges of everything else that is drawn: container frames, lifelines, lane and pool frames, connector points and
 * edge-label bands. Whole lattice rows; 0 when the first row is already clear (a figure without containers or
 * lifelines keeps its bytes).
 */
function footDropMm(contentBottom: number, bottoms: readonly number[]): number {
  if (!bottoms.length) return 0;
  const rise = FOOT_ROW_RISE_EM * pt2mm(role("table_header").size);
  const over = Math.max(...bottoms) + rise - (contentBottom + LATTICE_Y);
  return over > 1e-6 ? Math.ceil(over / LATTICE_Y - 1e-9) * LATTICE_Y : 0;
}

/** Row 40: lower edge of the swimlane frame and of its pool boxes (a pool spans y only on a horizontal frame). */
function frameBottoms(s: StudioDiagramV1, place: Placement): number[] {
  const frame = s.family === "swimlane" ? (place.layout as { frame?: SwimFrame }).frame : undefined;
  if (!frame) return [];
  return [frame.bottom, ...(frame.orientation === "horizontal" ? (frame.pools ?? []).map((p) => p.hi) : [])];
}

/**
 * Row 40: lower edge of each edge-label band as it is drawn: the placed plan when the fit placement ran (`planBands`,
 * leaders included), else the default position (`orig`) or the fixed `label_at` baseline; band = knockout of
 * `labelKnockoutSvg` (baseline + 0.55 size). An edge without label text draws no band.
 */
function labelBottoms(
  s: StudioDiagramV1,
  paths: readonly HoppedEdge[],
  plan: EdgeLabelPlan | undefined,
  origOf: (ps: readonly RoutedEdge[]) => Array<[number, number]>,
): number[] {
  if (plan) return planBands(plan).flatMap(([, hi], i) => (String(paths[i]?.label ?? "") ? [hi] : []));
  const rail = pt2mm(role("evidence_rail").size);
  const fixedAt = edgeArrowsOfPaths(s.edges ?? [], paths).map((a) => a.labelAt);
  const orig = origOf(paths);
  return paths.flatMap((p, i) => {
    if (!String(p.label ?? "")) return [];
    const at = fixedAt[i];
    return [(at ? labelAtBaseline(p.points, at)[1] : orig[i][1]) + rail * 0.55];
  });
}

/**
 * Swarm 1.2.6 row 67 (T-12): tolerance of the D-290 sheet check. Coordinates are printed to at most 0.01 mm
 * (`pyNum(v, 2)`; the paper rect to 0.001 mm), so a value on the sheet edge reads up to half that unit beyond the
 * unrounded height H. The rev-198 stand-alone figure was refused for its own paper rect (height printed 100.013 against
 * H 100.0125): a print rounding, not an element outside the sheet.
 */
const SHEET_EDGE_TOLERANCE_MM = 0.005 + 1e-6;

/**
 * D-290: cek otomatis, semua koordinat y yang dipancarkan berada di [0, H] (graph).
 * Swarm 1.2.6 row 67 (T-12, register N-019): the refusal names the apparatus furniture height (caption, KUNCI and
 * SUMBER lines, `furnitureMm`) apart from the sheet height, so the over-capacity details report it separately.
 */
function assertInsideSheet(svg: string, H: number, furnitureMm: number): void {
  const bad: string[] = [];
  const check = (v: number, what: string) => {
    if (v < -SHEET_EDGE_TOLERANCE_MM || v > H + SHEET_EDGE_TOLERANCE_MM) bad.push(`${what}=${pyFixed(v, 3)}`);
  };
  for (const m of svg.matchAll(/\s(y|y1|y2|cy)="(-?[\d.]+)"/g)) check(Number(m[2]), m[1]);
  for (const m of svg.matchAll(/<rect [^>]*?\sy="(-?[\d.]+)"[^>]*?\sheight="([\d.]+)"/g)) check(Number(m[1]) + Number(m[2]), "rect bawah");
  // titik M/L jalur (busur lompatan A r 0,9 mm berpusat di jalur dan sudah tercakup rem)
  for (const m of svg.matchAll(/\sd="([^"]+)"/g)) {
    for (const q of m[1].matchAll(/[ML]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g)) check(Number(q[2]), "path y");
  }
  if (bad.length) {
    throw new DiagramDefect(`DATUM-37-tinggi: unsur keluar lembar graph (tinggi ${pyFixed(H, 3)} mm, kaki aparatus ${pyFixed(furnitureMm, 3)} mm): ${bad.slice(0, 5).join(", ")} (P8, D-290)`, {
      checkId: "DATUM-37-tinggi",
    });
  }
}

/**
 * Swarm 1.2.8 row 57c: the swimlane decoration in drawing order (frame, pools, plain lanes with their gutter rule), the
 * elements the sheet draws under the connectors. Empty for other families.
 */
function laneDecorSvg(s: StudioDiagramV1, place: Placement, sheet: Sheet, W: number): string[] {
  const out: string[] = [];
  const gutter = sheet.gutterW ?? 0;
  // Swarm 1.2.8 row 55 (VIS-2a, 01f §2.3): fase dan lajur vertikal dari bingkai layout-b; tanpa bingkai = lama.
  const frame = s.family === "swimlane" ? (place.layout as { frame?: SwimFrame }).frame : undefined;
  if (frame) out.push(...swimFrameSvg(frame, W));
  // Row 55b (VIS-2b): kolam menggambar lajurnya sendiri (strip kepala kolam + kolom label lajur).
  if (frame?.pools) out.push(...swimPoolsSvg(frame, frame.pools, W));
  for (const lane of frame?.orientation === "vertical" || frame?.pools ? [] : sheet.lanes) {
    out.push(lineSvg(pyInt(0), lane.y, W, lane.y, "ink200", STROKE_HAIR));
    out.push(
      svgText(0.5, lane.y + pt2mm(role("table_header").size) + LATTICE_Y / 2.0, lane.name, {
        role: "table_header",
        colourToken: "ink400",
        anchor: "start",
      }),
    );
    if (gutter) out.push(lineSvg(gutter, lane.y, gutter, lane.y + lane.h, "ink200", STROKE_HAIR));
  }
  return out;
}

/**
 * Swarm 1.2.8 row 55 (VIS-2a, 01f §2.3): dekorasi bingkai swimlane, tanpa data-mark (G-2). Pemisah = garis rambut
 * ink200 (aturan garis lajur); teks kepala memakai peran label lajur (table_header, ink400, DATUM-28), lewat `svgText`
 * yang meloloskan XML (SR8-23). Horizontal: fase = kepala di baris atas (tengah pita) + pemisah tegak; garis dan label
 * lajur tetap digambar jalur lama. Vertikal (transpos): lajur = kolom dengan kepala di baris atas, garis tegak di kiri
 * tiap kolom; fase = kepala di kolom kiri + pemisah mendatar selebar lembar.
 */
function swimFrameSvg(f: SwimFrame, W: number): string[] {
  const hdr = pt2mm(role("table_header").size) + LATTICE_Y / 2.0;
  const text = (x: number, y: number, label: string, anchor: "start" | "middle") =>
    svgText(x, y, label, { role: "table_header", colourToken: "ink400", anchor });
  const out: string[] = [];
  if (f.orientation === "horizontal") {
    f.phases.forEach((p, i) => {
      if (i > 0) out.push(lineSvg(p.lo, f.top, p.lo, f.bottom, "ink200", STROKE_HAIR));
      out.push(text((p.lo + p.hi) / 2.0, f.top + hdr, p.label, "middle"));
    });
    return out;
  }
  for (const ln of f.pools ? [] : f.lanes) {
    // row 55b: with pools the lanes are drawn per pool (swimPoolsSvg)
    if (ln.lo > 1e-6) out.push(lineSvg(ln.lo, f.top, ln.lo, f.bottom, "ink200", STROKE_HAIR));
    out.push(lineSvg(ln.lo, f.headBottom, ln.hi, f.headBottom, "ink200", STROKE_HAIR));
    out.push(text((ln.lo + ln.hi) / 2.0, f.top + hdr, ln.label, "middle"));
  }
  f.phases.forEach((p, i) => {
    if (i > 0) out.push(lineSvg(pyInt(0), p.lo, W, p.lo, "ink200", STROKE_HAIR));
    out.push(text(0.5, p.lo + hdr, p.label, "start"));
  });
  return out;
}

type RoutedPaths = Parameters<typeof crossingHops>[0];
type PathPt = RoutedPaths[number]["points"][number];

/** Row 55c: a polyline without repeated vertices and without straight-through vertices of an axis-parallel run. */
function straightRuns(pts: readonly PathPt[]): PathPt[] {
  const out: PathPt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q[0] - p[0]) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9) continue;
    const o = out[out.length - 2];
    // q lies between o and p on one vertical or horizontal line: q is no bend
    if (o && q) {
      const vert = Math.abs(o[0] - q[0]) < 1e-9 && Math.abs(q[0] - p[0]) < 1e-9 && (q[1] - o[1]) * (p[1] - q[1]) > 0;
      const hor = Math.abs(o[1] - q[1]) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9 && (q[0] - o[0]) * (p[0] - q[0]) > 0;
      if (vert || hor) out.pop();
    }
    out.push(p);
  }
  return out;
}

/**
 * Swarm 1.2.8 row 55c (C133, VIS-9 jumps, 01f §3.3): line jumps as Visio draws them. `crossingHops` (HS port) tests a
 * crossing strictly inside one segment of each path, so a crossing on a vertex where the router left a repeated or
 * straight-through point (vis9's crossing at 128 mm: the horizontal link has the vertex x = 64.0 twice, right on the
 * vertical link) drew no hop. The hop test now runs on the straight runs of each path; the drawn paths are unchanged.
 * A real bend at a crossing is an overlap (orthogonal legs), never a hop. A hop whose arc would reach past a bend of its
 * run (centre closer than the hop radius) moves along the run so the arc stays on the straight piece (still over the
 * crossing); a run shorter than the arc takes it at its middle. Paths without such vertices keep their hops byte for byte.
 */
/** @internal test seam */
export function jumpHops(paths: RoutedPaths): HoppedEdge[] {
  const runs = paths.map((p) => ({ ...p, points: straightRuns(p.points) }));
  const found = crossingHops(runs);
  const r = LIMITS.hop_radius_mm;
  return paths.map((p, i) => {
    const pts = runs[i].points;
    const hops = found[i].hops.map(([hx, hy]): readonly [number, number] => {
      for (let u = 0; u + 1 < pts.length; u++) {
        const [ax, ay] = pts[u];
        const [bx, by] = pts[u + 1];
        if (Math.abs(ay - by) >= 1e-9 || Math.abs(ay - hy) >= 1e-9) continue;
        const lo = Math.min(ax, bx);
        const hi = Math.max(ax, bx);
        if (!(lo < hx && hx < hi)) continue;
        // a run end is a bend unless it is the path's own end (node border)
        const loBend = ax < bx ? u > 0 : u + 2 < pts.length;
        const hiBend = ax < bx ? u + 2 < pts.length : u > 0;
        const min = loBend ? lo + r : -Infinity;
        const max = hiBend ? hi - r : Infinity;
        if (min > max) return [(lo + hi) / 2, hy];
        return [Math.min(Math.max(hx, min), max), hy];
      }
      return [hx, hy];
    });
    return { ...p, d: p.d ?? polylineD(p.points), hops };
  });
}

/**
 * Swarm 1.2.8 row 55b (VIS-2b, 01f §2.3): kolam dan lajurnya, tanpa data-mark (G-2). Tepi kolam = kotak garis utama
 * (STROKE_PRIMARY) berwarna garis tepi simpul (ink700, tanpa warna baru); strip kepala kolam dibatasi garis utama yang
 * sama. Horizontal: strip kiri selebar parit (label kolam), lalu kolom label lajur (parit kedua, garis rambut), garis
 * rambut ink200 di antara lajur satu kolam. Vertikal: baris kepala kolam di atas baris kepala lajur, garis rambut di
 * antara kolom lajur satu kolam. Label kolam dan lajur memakai peran label lajur (table_header, ink400) lewat
 * `svgText`; label kolam yang lebih lebar dari stripnya dibungkus per kata.
 */
function swimPoolsSvg(f: SwimFrame, pools: readonly SwimPool[], W: number): string[] {
  const hdr = pt2mm(role("table_header").size) + LATTICE_Y / 2.0;
  const opt = { role: "table_header", colourToken: "ink400" } as const;
  const edge = (x1: number, y1: number, x2: number, y2: number) => lineSvg(x1, y1, x2, y2, "ink700", STROKE_PRIMARY);
  const box = (x: number, y: number, w: number, h: number) =>
    `<rect x="${pyNum(x, 2)}" y="${pyNum(y, 2)}" width="${pyNum(w, 2)}" height="${pyNum(h, 2)}" fill="none" stroke="${colourOf("ink700")}" stroke-width="${pyNum(STROKE_PRIMARY, 2)}"/>`;
  const label = (x: number, y: number, text: string, width: number, anchor: "start" | "middle") => {
    const lines = wrapHeader(text, width);
    return svgTextLines({ x, y, lines, lineMm: pt2mm(role("table_header").size) * 1.25 }, { ...opt, anchor });
  };
  const out: string[] = [];
  const half = STROKE_PRIMARY / 2;
  if (f.orientation === "horizontal") {
    const strip = f.poolHead ?? 0;
    const laneHead = f.gutter;
    for (const p of pools) {
      out.push(box(half, p.lo, W - STROKE_PRIMARY, p.hi - p.lo));
      out.push(edge(strip, p.lo, strip, p.hi));
      out.push(lineSvg(laneHead, p.lo, laneHead, p.hi, "ink200", STROKE_HAIR));
      out.push(label(0.5 + half, p.lo + LATTICE_Y / 2.0 + hdr, p.label, strip - 1.0 - half, "start"));
      p.lanes.forEach((li, j) => {
        const ln = f.lanes[li];
        if (j > 0) {
          const y = (f.lanes[p.lanes[j - 1]].hi + ln.lo) / 2.0;
          out.push(lineSvg(strip, y, W, y, "ink200", STROKE_HAIR));
        }
        if (ln.label) out.push(svgText(strip + 0.5, ln.lo + hdr, ln.label, { ...opt, anchor: "start" }));
      });
    }
    return out;
  }
  const head = f.poolHead ?? f.top;
  for (const p of pools) {
    out.push(box(p.lo, f.top + half, p.hi - p.lo, f.bottom - f.top - half));
    out.push(edge(p.lo, head, p.hi, head));
    out.push(label((p.lo + p.hi) / 2.0, f.top + hdr, p.label, p.hi - p.lo - 1.0, "middle"));
    p.lanes.forEach((li, j) => {
      const ln = f.lanes[li];
      if (j > 0) out.push(lineSvg(ln.lo, head, ln.lo, f.bottom, "ink200", STROKE_HAIR));
      // row 55c (G3-15): no lane header row when no lane is named (headBottom = pool header rule)
      if (f.headBottom > head + 1e-6) out.push(lineSvg(ln.lo, f.headBottom, ln.hi, f.headBottom, "ink200", STROKE_HAIR));
      if (ln.label) out.push(svgText((ln.lo + ln.hi) / 2.0, head + hdr, ln.label, { ...opt, anchor: "middle" }));
    });
  }
  return out;
}

/** Row 55b: kata-kata label kepala (huruf besar, peran table_header) dibungkus ke lebar `width` mm; >= 1 baris. */
function wrapHeader(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const w of pyStr(text).split(/\s+/).filter(Boolean)) {
    const cur = lines.length ? `${lines[lines.length - 1]} ${w}` : w;
    if (lines.length && estTextMm(cur.toUpperCase(), "table_header") <= width) lines[lines.length - 1] = cur;
    else lines.push(w);
  }
  return lines.length ? lines : [""];
}

// ------------------------------------------------------------------ rute
/** Rute keluarga: sequence = baris waktu (layout-b `routeSequenceMessages`), lainnya = `route_edges`. */
export function routeFor(s: StudioDiagramV1, p: Placement): { paths: RoutedEdge[]; msgEnd?: number } {
  if (s.family === "sequence") {
    const lay = p.layout as SequenceLayout;
    if (!Array.isArray(lay.lifelines) || typeof lay.msgY !== "number") {
      throw new DiagramDefect("tata letak sequence tanpa garis kehidupan/baris waktu (P2)", { checkId: "P2-sequence-time-vertical" });
    }
    const run = routeSequenceMessages(s, lay);
    return { paths: run.paths.map((e) => ({ ...e, d: e.d ?? polylineD(e.points) })), msgEnd: run.msgEnd };
  }
  return { paths: routePlaced(s, p.sheet) };
}

/**
 * Row 55 (ST-5): the engine prints the label "SUMBER" itself. When the author's first source text already starts with
 * that word (SUMBER, Sumber, sumber, Source; "Sources" too), strip the word and its separator so the label prints once;
 * the rest stays verbatim, in the author's case. With a colon or dash any case counts; without a separator only the
 * all-capitals word does, so "Sumber daya listrik ..." is not mistaken for a label. A text that merely contains the word
 * later is untouched.
 */
export function stripSourceLead(text: string): string {
  const m = /^\s*(?:(?:sumber|sources?)\s*[:\u2013\u2014-]+\s*|(?:SUMBER|SOURCES?)(?=\s|$)\s*)/i.exec(text);
  if (!m) return text;
  const bare = !/[:\u2013\u2014-]/.test(m[0]);
  if (bare && !/^\s*(?:SUMBER|SOURCES?)/.test(m[0])) return text;
  return text.slice(m[0].length);
}

function sourcesOf(s: StudioDiagramV1): string[] {
  if (Array.isArray(s.sources) && s.sources.length) return s.sources.map(String);
  const src: unknown = s.source;
  if (src === undefined || src === null) return [];
  return Array.isArray(src) ? src.map(String) : [String(src)];
}

// ------------------------------------------------------------------ Swarm row 165P: figure apparatus order
/** Swarm row 165P: attribute on each caption line of an `apparatus: "figure"` SVG (moved by `withCaptionAbove`). */
export const CAPTION_MARK_ATTR = 'data-st-caption="1"';

/**
 * Swarm row 165P (C205, CP-29/CP-48): in a SUMBER line that ends with the PROVENANS part, the label is set SemiBold and
 * each mark glyph in its Table 7.1 colour (`MARK_COLOUR_TOKENS`, the node glyph colours: ◈ signal), as the page prints
 * them; the text stays one `<text>` element (the fit lint reads its tspans).
 */
function provenanceTspans(el: string, prov: NonNullable<DiagramBuildOptions["provenance"]>): string {
  const label = escText(prov.label);
  const at = el.indexOf(label, el.indexOf(">") + 1);
  if (at < 0) return el;
  let tail = el.slice(at + label.length);
  for (const m of prov.marks) {
    const g = MARKS[m.mark];
    tail = tail.split(g).join(`<tspan fill="${colourOf(MARK_COLOUR_TOKENS[m.mark] ?? "signal")}">${g}</tspan>`);
  }
  return `${el.slice(0, at)}<tspan font-weight="600">${label}</tspan>${tail}`;
}

/**
 * Swarm row 165P (C205, CP-28/48; ID p.41 DT-15 "Caption satu kalimat ... di atas gambar", research/14 CP-28 "A
 * one-sentence caption ... above the figure"; the page apparatus prints it above, html/tables/figure.ts): an
 * `apparatus: "figure"` SVG prints its caption ABOVE the drawing. `buildOnce` draws the caption as the lowest foot line
 * (lint, DATUM-29/30 and every size check run on that sheet, unchanged); this moves it: the caption lines go to the top
 * band (one lattice line each), and everything after the paper rect is drawn one band lower in a `translate` group. The
 * band the caption left at the foot takes the shift exactly, so the sheet height is unchanged. Idempotent; an SVG
 * without marked caption lines (apparatus page) is returned as is.
 */
export function withCaptionAbove(r: DiagramSvgResult): DiagramSvgResult {
  if (r.report.apparatus !== "figure" || !r.svg.includes(CAPTION_MARK_ATTR)) return r;
  const found: Array<{ el: string; y: number }> = [];
  const body = r.svg.replace(new RegExp(`<text ${CAPTION_MARK_ATTR} [\\s\\S]*?</text>\\n?`, "g"), (m) => {
    found.push({ el: m.trimEnd(), y: Number(/ y="(-?[\d.]+)"/.exec(m)?.[1] ?? 0) });
    return "";
  });
  // Swarm 1.2.6 row 67 (BUG routed from row 28): `buildOnce` draws the caption lines bottom-up (last line first), so
  // their emission order is reversed; the reading order is their order on the sheet (top line = the GAMBAR label line).
  const caps = found.sort((a, b) => a.y - b.y).map((c) => c.el);
  const paper = paperRectSvg(r.widthMm, r.heightMm);
  const paperAt = body.indexOf(paper);
  const paperEnd = paperAt < 0 ? -1 : paperAt + paper.length - 2;
  const close = body.lastIndexOf("</svg>");
  if (paperEnd < 0 || close < 0 || caps.length === 0) return r;
  const band = caps.length * LATTICE_Y;
  // Baseline of caption line i: 0.8 lattice line into its band (the caption 7.6 pt ascends ~2.7 mm, so the first line
  // clears the sheet top; the drawing below starts one band lower than before).
  const moved = caps.map((c, i) => c.replace(CAPTION_MARK_ATTR, "data-caption-above=\"1\"").replace(/ y="[^"]*"/, ` y="${pyNum((i + 0.8) * LATTICE_Y, 2)}"`));
  const head = body.slice(0, paperEnd + 2);
  const rest = body.slice(paperEnd + 2, close).replace(/^\n/, "");
  const svg = `${head}\n${moved.join("\n")}\n<g transform="translate(0 ${pyNum(band, 3)})">\n${rest}</g>\n${body.slice(close)}`;
  return { ...r, svg };
}

// ------------------------------------------------------------------ rakit
/**
 * Rakit diagram (FIG-02b): render apa adanya; bila lint geometri menemukan cacat, rakit ulang
 * dengan tata letak otomatis dan pakai hasilnya hanya bila cacatnya lebih sedikit
 * (`./autofit.ts`). Render lint-bersih dikembalikan byte-identik.
 */
export function buildDiagramSvgWith(s: StudioDiagramV1, opts: DiagramBuildOptions, deps: DiagramBuildDeps): DiagramSvgResult {
  let first: DiagramSvgResult;
  try {
    first = buildOnce(s, opts, deps);
  } catch (e) {
    // FIG-02b2 P1-14: penolakan kapasitas -> coba tata letak adaptif; selain itu saran aksi konkret.
    if (isCapacityReject(e, s)) return withPoolNotes(s, capacityRetry(s, e, () => buildOnce(s, opts, deps)));
    throw withAction(e, s);
  }
  const out = autoFitDiagram(first, () => buildOnce(s, opts, deps));
  // Swarm 1.2.6 row 47 (T-11, 01e §4.4, N-160): a legacy flow that serialises parallel branches
  // gets one FLOW_SERIALISED REPORT line; layout and SVG bytes unchanged (U3).
  const serial = flowSerialisedNote(s);
  return withPoolNotes(s, serial ? { ...out, report: { ...out.report, geometry: [...(out.report.geometry ?? []), serial] } } : out);
}

/**
 * Swarm 1.2.8 row 55b (C12 OP-18-5, N8-481): one POOL_FLOW_CROSSES REPORT line per non-control edge across pools,
 * appended to `report.geometry` (a warning: the figure is drawn, the SVG bytes are unchanged). No pools = as before.
 */
function withPoolNotes(s: StudioDiagramV1, r: DiagramSvgResult): DiagramSvgResult {
  const notes = poolFlowCrossesNotes(s);
  return notes.length ? { ...r, report: { ...r.report, geometry: [...(r.report.geometry ?? []), ...notes] } } : r;
}

function buildOnce(s: StudioDiagramV1, opts: DiagramBuildOptions, deps: DiagramBuildDeps): DiagramSvgResult {
  // D-245: grid turunan templat (lebar sah, tinggi maks, kisi X); absen = A4.
  const grid = resolveDiagramGrid(opts.grid);
  // validate_spec + gerbang rilis (I16): pelanggaran pertama = cacat, seperti Python.
  const vIssues = deps.validate(s, opts.grid ? { release: opts.release, grid: opts.grid } : { release: opts.release });
  const fail = vIssues.find((i) => i.status === "FAIL");
  if (fail) throw new DiagramDefect(fail.detail ?? fail.checkId, { checkId: fail.checkId, pointer: fail.pointer });
  const ran = checksRunOf(vIssues);
  assertNodeSymbols(s); // row 124 (CP-45)
  const issues: LintIssue[] = [];
  if (!opts.release && s.labels_verified !== true) {
    issues.push({ checkId: "P1-labels_verified", status: "NOT_RUN", detail: "draft: release=false, gerbang labels_verified tidak dijalankan" });
  }

  const sheet = new Sheet(Number(s.width_mm), undefined, grid.latticeXMm);
  const place = placeDiagram(s, sheet, deps.layouts);
  if (diagramFitActive()) reorderPlaced(s, sheet); // FIG-02b2 P1-11: hanya bila persilangan terukur
  ran.push("DATUM-37-lebar");
  const W = sheet.widthMm;

  const { paths, msgEnd } = routeFor(s, place);
  if (s.family === "sequence") {
    sheet.msgEnd = msgEnd;
    ran.push("P2-sequence-time-vertical");
  }
  // Row 57c: the lane / phase / pool decoration is built once, before the labels: the fit placement keeps label bands
  // off its rules and header texts (`fitEdgeLabels` decoration), and the sheet draws the same elements below.
  const laneDecor = laneDecorSvg(s, place, sheet, W);
  // FIG-02b: saat fit, label tepi ditempatkan tanpa tabrakan (posisi bawaan = `labelPos`).
  const fitOn = diagramFitActive();
  if (fitOn && s.family !== "graph" && s.family !== "sequence" && diagramFitRoute("lineThroughText")) {
    // FIG-02b2: rute yang turun di bawah simpul terbawah (mis. sld "ke beban") mendorong kaki ke bawah.
    const nb = Math.max(...[...sheet.nodes.values()].map((n) => n.y + n.h));
    const rb = Math.max(...paths.flatMap((p) => p.points.map(([, y]) => y)));
    if (Number.isFinite(rb) && rb > nb + 1e-6) sheet.routeBottom = rb;
  }
  const rail = pt2mm(role("evidence_rail").size);
  const origOf = (ps: readonly RoutedEdge[]): Array<[number, number]> => {
    const heads = labelHeadsOf(s, ps); // row 57c
    const dashes = labelDashOf(s, ps); // 1.2.9 row 27 (AC-A04)
    return ps.map((p, i) => {
      const [mx, my] = labelPos(p.points, [...sheet.nodes.values()], estTextMm(p.label, "evidence_rail"), rail * 1.4, heads[i], dashes[i]);
      return [mx, my - pt2mm(1.2)];
    });
  };
  let plan: EdgeLabelPlan | undefined;
  if (fitOn && s.family === "graph") {
    // Lembar graph (D-290) pas isi: label dijaga di dalam rentang y isi bawaan (simpul, rute,
    // pita label bawaan, zona) agar tepi atas dan tinggi lembar tidak bergeser karena label.
    const orig = origOf(paths);
    const ys: number[] = [];
    for (const nd of sheet.nodes.values()) ys.push(nd.y, nd.y + nd.h);
    for (const p of paths) for (const [, y] of p.points) ys.push(y);
    for (const [, by] of orig) ys.push(by - rail * 1.15, by + rail * 0.55);
    for (const z of s.zones ?? []) {
      const ms = (z.members ?? []).map((m) => sheet.nodes.get(m)).filter((m): m is SheetNode => m !== undefined);
      if (ms.length) ys.push(Math.min(...ms.map((m) => m.y)) - LATTICE_Y * 2, Math.max(...ms.map((m) => m.y + m.h)) + LATTICE_Y * 2);
    }
    plan = fitEdgeLabels({ s, sheet, nodes: [...sheet.nodes.values()], paths, orig, yMin: Math.min(...ys), yMax: Math.max(...ys), decoration: laneDecor });
  }
  // D-290: graph = lembar pas kotak pembatas semua unsur + rem tetap.
  const fit = s.family === "graph" ? graphFit(s, sheet, paths, plan ? planBands(plan) : undefined) : undefined;
  if (plan && fit) plan = shiftPlan(plan, fit.dy);
  // Row 57b (VIS-9, 01f §3.3, N8-266): `jumps: "off"` draws no hop; "on" or absent = today's crossingHops.
  // Row 55c (C133): a crossing on a collinear vertex of a run (vis9 at 128 mm) also hops (`jumpHops`).
  const hopped: HoppedEdge[] = jumpHops(fit ? fit.paths : paths).map((p) => (s.jumps === "off" ? { ...p, hops: [] } : p));
  const arrows = arrowsOfPaths(s, hopped); // row 57 (VIS-7): heads per drawn connector
  ran.push("DATUM-32"); // ditegakkan detur rute (gagal = lempar)

  ran.push(...tokenFloorChecks()); // DATUM-28, DATUM-27

  sheet.foot = footReserveMm(s, W, opts.keyLabel, opts.keyRowText); // row 124 (CP-46): every line of a wrapped key is reserved; 124b: in the document language
  // FIG-02b2 P2-15: caption/SUMBER berbungkus saat fit bila melewati lebar lembar (+1 kisi per baris).
  // Row 124 (CP-28/48): the caption starts with the bold label "GAMBAR n.m" (DT-15 ID p.41).
  const capLabel = `${opts.figureLabel ?? DEFAULT_FIGURE_LABEL} ${s.id}`;
  const captionText = `${capLabel}  ${s.title}`;
  // Swarm row 165P (C205, CP-28/48): the figure's PROVENANS part after its SUMBER text (page apparatus form).
  const prov = (s.apparatus ?? "page") === "figure" && opts.provenance && opts.provenance.marks.length > 0 ? opts.provenance : undefined;
  const provText = prov ? `    ${prov.label}  ${prov.marks.map((m) => `${MARKS[m.mark]} ${m.text}`).join(" · ")}` : "";
  const sourceList = sourcesOf(s);
  if (sourceList.length) sourceList[0] = stripSourceLead(sourceList[0]);
  const sourceText = "SUMBER  " + sourceList.join("; ") + provText;
  const capLines = (s.apparatus ?? "page") === "figure" ? footLines(captionText, "caption", W) : [captionText];
  const srcLines = (s.apparatus ?? "page") === "figure" ? footLines(sourceText, "source_line", W) : [sourceText];
  const footExtra = capLines.length - 1 + srcLines.length - 1;
  if (footExtra > 0) {
    sheet.foot += footExtra * LATTICE_Y;
    diagramFitNote("CAPTION_WRAP", `caption ${capLines.length} baris, SUMBER ${srcLines.length} baris (dibungkus ke lebar ${W} mm)`, "persingkat judul gambar (maks ~100 karakter)");
  }
  // Swarm 1.3.3 row 54 (ST-5): the author's `notes[]` are foot rows, one lattice row per printed line, in both
  // apparatus modes. Reserved here, before H (row 40's seam), so the clearance, DATUM-33 and the sheet height see them.
  const noteLines = specNoteLines(s, W, opts.noteLabel ?? DEFAULT_NOTE_LABEL);
  sheet.foot += noteLines.length * LATTICE_Y;
  // Swarm 1.2.6 row 67 (T-12, N-019): apparatus furniture (caption, CATATAN, KUNCI, SUMBER lines), before edge-label notes.
  const furnitureMm = sheet.foot;
  let H = fit ? fit.contentBottom + sheet.foot + fit.pad : sheet.height();
  let notes: ReturnType<typeof noteRows> | undefined;
  let notesY0 = 0;
  if (fitOn) {
    if (!fit) {
      const nFoot = Math.round(sheet.foot / LATTICE_Y);
      const yMax = nFoot > 0 ? H - LATTICE_Y * 2 - (nFoot - 1) * LATTICE_Y - 3.0 : H;
      plan = fitEdgeLabels({ s, sheet, nodes: [...sheet.nodes.values()], paths: hopped, orig: origOf(hopped), yMax, decoration: laneDecor });
    }
    if (plan && plan.numbered.length) {
      // Baris catatan menempati posisi kaki lama; kaki turun sebanyak baris catatan.
      notes = noteRows(plan, W);
      notesY0 = (fit ? fit.contentBottom : H - LATTICE_Y * 2 - sheet.foot) + LATTICE_Y;
      sheet.foot += notes.rows * LATTICE_Y;
      H = fit ? fit.contentBottom + sheet.foot + fit.pad : sheet.height();
    }
  }
  // Swarm 1.3.3 row 40 (ST-3.1): the foot rows start below every drawn element, not only below the lowest node.
  // `zoneGeoms` is measured once here (it can add a ZONE_LABEL_CLAMP note) and drawn from below.
  const zoneGeoms = (s.zones ?? []).map((z) => {
    const members = (z.members ?? []).map((m) => sheet.nodes.get(m)).filter((m): m is SheetNode => m !== undefined);
    return members.length ? zoneGeom(z, members, sheet, fitOn, zoneClearOn(s)) : undefined;
  });
  const contentBottom = fit ? fit.contentBottom : H - LATTICE_Y * 2 - sheet.foot;
  // A lifeline ends one lattice row below the content, where it ended on a sheet without foot rows.
  const lifelineEnd = contentBottom + LATTICE_Y;
  const footDrop =
    sheet.foot > 0
      ? footDropMm(contentBottom, [
          ...zoneGeoms.flatMap((g) => (g ? [g.y + g.h] : [])),
          ...(sheet.lifelines.length ? [lifelineEnd] : []),
          ...sheet.lanes.map((lane) => lane.y + lane.h),
          ...frameBottoms(s, place),
          ...hopped.flatMap((p) => p.points.map(([, y]) => y)),
          ...labelBottoms(s, hopped, plan, origOf),
        ])
      : 0;
  H += footDrop;
  notesY0 += footDrop;
  if (H > grid.maxHeightMm + 1e-6) {
    throw new DiagramDefect(`DATUM-33: tinggi gambar ${pyFixed(H, 2)} mm melewati blok teks ${pyFixed(grid.maxHeightMm, 1)} mm (kaki aparatus ${pyFixed(furnitureMm, 2)} mm) (P8)`, {
      checkId: "DATUM-33",
    });
  }
  ran.push("DATUM-33");

  const apparatus = s.apparatus ?? "page";
  const nodes = [...sheet.nodes.values()];
  sheet.add(generatorComment(String(s.family)));
  if (apparatus === "page") sheet.add(APPARATUS_REQUIRED_COMMENT);
  // Row 124 (CP-43 / C23 check 25): define only the hatches and arrow heads this figure uses.
  // Row 165C (F113-10, CP-47): hatches are vector lines drawn with each node (core/svg.ts hatchLinesSvg), so no
  // `<pattern>` is defined any more (Chromium printed the pattern fill into the PDF as a raster image).
  sheet.addAll(
    diagramDefs({
      kinds: hopped.map((p) => p.kind),
      arrows,
      hatch45: false,
      hatch135: false,
    }),
  );
  sheet.add(paperRectSvg(W, H));

  // lajur akuntabilitas + pemisah rambut (P2 swimlane), urutan kemunculan lajur (row 57c: built before the labels)
  sheet.addAll(laneDecor);
  for (const ll of sheet.lifelines) {
    sheet.add(lineSvg(ll.x, ll.top, ll.x, lifelineEnd, "ink200", STROKE_HAIR, DASH_PATTERNS.dashed)); // row 40: ends above the foot rows
  }

  // zona kepercayaan: penutupan garis putus + tab label, tanpa isian (P5)
  // Swarm 1.3.3 row 42 request (drawn by row 40): every zone frame first, then per zone the plain ground of its label
  // and the label, so no frame runs through a label. A legacy flow has no ground and keeps its order (frame, label per
  // zone; frozen at its 1.2.5 bytes, C10(a), C12).
  const zoneLabels: string[] = [];
  for (const [zi, z] of (s.zones ?? []).entries()) {
    const geom = zoneGeoms[zi];
    if (!geom) throw new DiagramDefect(`zona '${String(z.id)}' tanpa anggota dikenal (P5 trust zone)`, { checkId: "P5-zone" });
    // P2-16: label dijepit saat fit. 1.2.9 row 29 (AC-A06): pads keep ZONE_CLEAR_MM off non-members (not legacy flows).
    const { x: zx, y: zy, w: zw, h: zh, lx, ly } = geom; // row 40: measured once above (`zoneGeoms`)
    // Swarm 1.2.8 row 55b (VIS-2b, 01f §1 Group, N8-252): style "group" = BPMN group, rounded (rx 1.6 mm) dashdot;
    // absent or "zone" = today's dashed rect, byte-identical.
    const group = (z as { style?: unknown }).style === "group";
    // Swarm 1.2.8 row 55c (C133): a member on the sheet edge put the zone half a column past it (dg_topology x -5.33);
    // the rect is clipped to the figure box, half a stroke inside, only where it ran outside (others byte-identical).
    const inset = STROKE_HAIR / 2;
    const zx0 = zx < 0 ? inset : zx;
    const zy0 = zy < 0 ? inset : zy;
    const zx1 = zx + zw > W ? W - inset : zx + zw;
    const zy1 = zy + zh;
    sheet.add(
      `<rect x="${pyNum(zx0, 2)}" y="${pyNum(zy0, 2)}" width="${pyNum(zx0 === zx && zx1 === zx + zw ? zw : zx1 - zx0, 2)}" height="${pyNum(zy0 === zy ? zh : zy1 - zy0, 2)}" ${group ? 'rx="1.6" ry="1.6" ' : ""}fill="none" ` +
        `stroke="${colourOf("ink400")}" stroke-width="${pyNum(STROKE_HAIR, 2)}" stroke-dasharray="${group ? DASH_PATTERNS.dashdot : DASH_PATTERNS.dashed}"/>`,
    );
    const label = z.label !== undefined ? z.label : z.id !== undefined ? z.id : "zona";
    // row 55b: a group label sits 0.8 mm lower so its capitals clear the rounded top edge (zones: unchanged)
    const labelSvg = svgText(lx, group ? ly + 0.8 : ly, label, { role: "table_header", colourToken: "ink400", anchor: "start" });
    if (!zoneClearOn(s)) {
      sheet.add(labelSvg);
      continue;
    }
    if (geom.ground) zoneLabels.push(geom.ground);
    zoneLabels.push(labelSvg);
  }
  sheet.addAll(zoneLabels);
  // Swarm 1.3.3 row 56 (ST-5): tier labels in the band the layout reserved at the left edge (none without `tiers[]`).
  sheet.addAll(tierLabelSvgs(s, (place.layout as TierLabelLayoutExtras).tierBand, nodes));

  // Row 57c (C123 item 1): shadows of `shadowed` nodes before the connectors (a connector and its label lie over them).
  const canvas = { widthMm: W, heightMm: H };
  const shadows = nodes.map((nd) => nodeShadowSvg(nd, canvas));
  for (const sh of shadows) if (sh) sheet.add(sh);
  // konektor: semua jalur + busur dulu, baru pita knockout dan label (garis tak menimpa teks)
  const labels: Array<[number, number, string, RoutedEdge["kind"]]> = [];
  const railMm = pt2mm(role("evidence_rail").size);
  if (plan) {
    const placed = plan.placed;
    hopped.forEach((p, i) => sheet.add(edgePathSvg(p.points, p.kind, { index: i, route: routeStyleOfPath(p), arrows: arrows[i] })));
    hopped.forEach((p, i) => p.hops.forEach(([hx, hy]) => sheet.add(hopSvg(hx, hy, p.kind, arrows[i])))); // row 57b: hop stroke = weight
    hopped.forEach((p, i) => {
      const pl = placed[i];
      if (pl.leader) sheet.add(lineSvg(pl.leader[0], pl.leader[1], pl.leader[2], pl.leader[3], EDGE_KINDS[p.kind].colour, STROKE_HAIR));
      sheet.addAll(edgeLabelSvg(pl.x, pl.y, pl.text, p.kind, W, pl.kw));
    });
  } else {
    const heads = labelHeadsOf(s, hopped); // row 57c
    const dashes = labelDashOf(s, hopped); // 1.2.9 row 27 (AC-A04)
    hopped.forEach((p, i) => {
      sheet.add(edgePathSvg(p.points, p.kind, { index: i, route: routeStyleOfPath(p), arrows: arrows[i] }));
      const lw = estTextMm(p.label, "evidence_rail");
      // Row 57b (VIS-9, 01f §3.4): `label_at` = fixed centre at LABEL_AT_FRACTION of the path (no lift, never moved).
      const at = arrows[i].labelAt;
      if (at) {
        const [ax, ay] = labelAtBaseline(p.points, at);
        labels.push([ax, ay, p.label, p.kind]);
        return;
      }
      const [mx, my] = labelPos(p.points, nodes, lw, railMm * 1.4, heads[i], dashes[i]);
      labels.push([mx, my - pt2mm(1.2), p.label, p.kind]);
    });
    hopped.forEach((p, i) => p.hops.forEach(([hx, hy]) => sheet.add(hopSvg(hx, hy, p.kind, arrows[i])))); // row 57b: hop stroke = weight
    for (const [mx, my, lab, kind] of labels) sheet.addAll(edgeLabelSvg(mx, my, lab, kind, W));
  }

  // simpul + label + glif asal + tag
  // Row 165C (F113-9, CP-37): the sheet size lets nodeSvg keep every outline stroke inside the canvas.
  // 1.2.9 row 66a (gate 66 F1): a marked circle gets the connector ends, so its mark stays off a connector's axis.
  // `zoneClearOn` is false for a legacy flow (family `flow` without `direction`), frozen at its 1.2.5 bytes (C10(a), C12).
  // Each end pairs with the nearest point that differs from it (a route can repeat a vertex), so the end has a direction.
  const markEnds = zoneClearOn(s)
    ? hopped.flatMap((p) =>
        [p.points, [...p.points].reverse()].flatMap((pts) => {
          const outer = pts.find((q) => Math.hypot(q[0] - pts[0][0], q[1] - pts[0][1]) > 1e-6);
          return outer ? [[outer, pts[0]] as const] : [];
        }),
      )
    : [];
  nodes.forEach((nd, i) =>
    sheet.addAll(
      nodeSvg(nd, {
        index: i,
        canvas,
        ...(shadows[i] ? { shadowDrawn: true } : {}),
        ...(markEnds.length && nd.spec.mark && nd.spec.shape === "circle" ? { markEnds } : {}),
      }),
    ),
  );

  // apparatus figure: SVG memikul caption, baris KUNCI dan SUMBER sendiri (P6)
  // D-288: baris KEY tidak digambar bila halaman mencetak baris KUNCI figur ini (satu aparatus).
  const hasLegend = drawsSvgKeyRow(s);
  // Row 124 (CP-46, CP-45): key = legend rows plus symbol rows, wrapped to the sheet width; the
  // lines are drawn top to bottom ending on the given baseline `y`.
  const keyTexts = hasLegend ? keyLineTexts(s, W, opts.keyLabel, opts.keyRowText) : [];
  const keyLine = (y: number): string =>
    keyTexts
      .map((t, i) =>
        svgText(pyInt(0), y - (keyTexts.length - 1 - i) * LATTICE_Y, t, {
          role: "table_header",
          upper: false, // Swarm 1.3.3 row 43 request (ST-3.4), applied by row 54: the key prints `legend[]` as written; the label arrives in capitals
          colourToken: "ink400",
          anchor: "start",
          track: TRACK.micro_label_wider,
        }),
      )
      .join("");
  // Baris kaki terbawah = tepi isi + cadangan kaki (= H - 2 kisi pada lembar Garis A).
  // Row 40: `footDrop` (already in H and notesY0) moves the whole foot block down past containers and lifelines. The
  // rows are drawn bottom-up from `foot`; a new kind of foot row adds its height to `sheet.foot` before H is computed
  // (as CAPTION_WRAP does) and takes its place in this chain. The clearance needs no change: it places the first row.
  if (notes) sheet.addAll(notes.svg(notesY0)); // FIG-02b: catatan label tepi bernomor
  let foot = fit ? fit.contentBottom + footDrop + sheet.foot : H - LATTICE_Y * 2;
  // Swarm 1.3.3 row 54 (ST-5): the author's note rows, above the key (gap matrix line 65: "a note line above the key
  // row") and below the engine-made label notes. Order top to bottom: numbered label notes, CATATAN, KUNCI, SUMBER
  // (then the caption, which `withCaptionAbove` moves above the drawing). They are added to the sheet before the rows
  // below them, so the key lines stay the last texts of the document (readers take "the key line and what follows").
  if (noteLines.length) {
    const below = (apparatus === "figure" ? capLines.length + srcLines.length : 0) + (hasLegend ? keyTexts.length : 0);
    const last = foot - below * LATTICE_Y; // baseline of the last note line
    noteLines.forEach((line, i) => {
      const el = svgText(pyInt(0), last - (noteLines.length - 1 - i) * LATTICE_Y, line.text, { role: "source_line", upper: false, colourToken: "ink400", anchor: "start" }); // as written
      sheet.add(el.replace(/^<text /, `<text ${NOTE_MARK_ATTR}="${line.note}" `));
    });
  }
  if (apparatus === "figure") {
    for (let i = capLines.length - 1; i >= 0; i--) {
      const capOpts = { role: "caption", colourToken: "ink700", anchor: "start" } as const;
      // Swarm row 165P: caption lines are marked so `withCaptionAbove` can move them above the drawing.
      const el = i === 0 ? captionSvg(pyInt(0), foot, capLines[i], capLabel, capOpts) : svgText(pyInt(0), foot, capLines[i], capOpts);
      sheet.add(el.replace(/^<text /, `<text ${CAPTION_MARK_ATTR} `));
      foot -= LATTICE_Y;
    }
    // Swarm row 165P (C205, CP-28/48): the page apparatus order under the drawing, KUNCI then SUMBER/PROVENANS
    // (html/tables/figure.ts "Caption di atas, baris KUNCI lalu SUMBER/PROVENANS di bawah"): SUMBER is the lowest line
    // once the caption has moved above the drawing (`withCaptionAbove`); before, SUMBER sat above the key.
    srcLines.forEach((line, i) => {
      const el = svgText(pyInt(0), foot - (srcLines.length - 1 - i) * LATTICE_Y, line, { role: "source_line", colourToken: "ink400", anchor: "start" });
      sheet.add(prov ? provenanceTspans(el, prov) : el);
    });
    foot -= LATTICE_Y * srcLines.length;
    if (hasLegend) sheet.add(keyLine(foot));
  } else if (hasLegend) {
    sheet.add(keyLine(foot));
  }
  if (fit || footDrop > 0) sheet.fixHeight(H); // akar SVG memakai tinggi lembar pas (D-290); row 40: or the lowered foot
  const svg = sheet.toSvg();
  if (fit) assertInsideSheet(svg, H, furnitureMm);

  // DATUM-25 dari SVG NYATA (IP-39b, S84 #2): semua fill/stroke tercetak di luar
  // <defs> + definisi yang dirujuk, kertas dibuang. DEVIASI SENGAJA dari Garis A,
  // yang menghitung dari model token tidak lengkap (label ink900 dan garis luar
  // shadowed ink200 tak terhitung) sehingga 6 warna bisa lulus batas 5.
  // Swarm 1.3.3 row 57 (ST-6): the count is the colour budget of the printed values: fill and accent colours once each,
  // the neutral ink once (line patterns in ink are not colours), value-origin marks not counted.
  const used = svgColourValues(svg); // printed values, reported as before (`colourValues`, `nColour`)
  const budget = svgColourBudget(svg);
  if (budget.count > LIMITS.max_colour_values) {
    throw new DiagramDefect(
      // Swarm 1.2.6 row 62 (T-06): name each counted value, its sources and the remainder.
      `DATUM-25: ${budget.count} nilai warna dalam satu gambar, maksimum ${LIMITS.max_colour_values} (temuan E-16: plafon ini nyata) (P5/P8); ${colourBudgetDetail(budget, diagramColourSources(s, sheet), LIMITS.max_colour_values)}`,
      { checkId: "DATUM-25" },
    );
  }
  ran.push("DATUM-25");

  // DATUM-29/30 pada keluaran sendiri; caption dibandingkan dalam bentuk ter-escape.
  if (apparatus === "figure") {
    // Row 124: the caption label sits in its own <tspan>; compare against the text without tspan tags.
    const plain = svg.replace(/<\/?tspan\b[^>]*>/g, "");
    if (!svg.includes("SUMBER") || !capLines.every((l) => plain.includes(escText(l)))) {
      throw new DiagramDefect("DATUM-29/30: apparatus figure tanpa caption bernomor atau baris SUMBER di SVG (P6/P8)", { checkId: "DATUM-29/30" });
    }
  } else if (!svg.includes("DATUM-APPARATUS-REQUIRED")) {
    throw new DiagramDefect("DATUM-36 kewajiban apparatus tidak tercatat pada apparatus page (P6)", { checkId: "DATUM-36" });
  }
  ran.push("DATUM-29/30");

  return {
    svg,
    widthMm: W,
    heightMm: H,
    report: {
      checksRun: ran,
      issues,
      colourValues: used,
      nColour: used.length,
      nHops: hopped.reduce((a, p) => a + p.hops.length, 0),
      nNodes: nodes.length,
      nEdges: paths.length,
      apparatus,
      family: s.family,
      // Swarm 1.2.7 row 36b (T-12, N7-138): furniture counts for the stand-alone figure (feeds N7-068).
      // Row 54: `noteLines` only when the spec has printed notes, so a report without notes is unchanged.
      ...(apparatus === "figure"
        ? { furniture: { keyLines: keyTexts.length, sourceLines: srcLines.length, heightMm: furnitureMm, ...(noteLines.length ? { noteLines: noteLines.length } : {}) } }
        : {}),
    },
  };
}

/**
 * Swarm 1.2.8 row 57 (VIS-7, 01f §5.2): the arrowheads of each drawn connector from its spec edge. Routers keep the
 * spec order; a path whose ends differ from the edge at its index (a router that reorders) takes the first unused edge
 * with the same ends and kind. No match = the kind head (today's drawing).
 */
function arrowsOfPaths(s: StudioDiagramV1, paths: readonly HoppedEdge[]): EdgeArrows[] {
  // Row 57b: the matching lives in core/svg.ts `edgeArrowsOfPaths` (shared with the label placement).
  return edgeArrowsOfPaths(s.edges ?? [], paths);
}
