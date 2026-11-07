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
  svgColourValues,
  svgText,
  tokenFloorChecks,
  TRACK,
  colourOf,
  type DiagramGrid,
  resolveDiagramGrid,
  type SheetNode,
  type ValidateSpecOptions,
} from "../core";
import { diagramFitActive, diagramFitNote, diagramFitRoute } from "../fit/state";
import { footLines } from "./footwrap";
import { routeSequenceMessages, type SequenceLayout } from "../layout-b";
import { autoFitDiagram, type DiagramGeometryIssue } from "./autofit";
import type { EdgeLabelPlan } from "../fit/labels";
import { fitEdgeLabels, noteRows, planBands, shiftPlan, zoneGeom } from "./fitlabels";
import { placeDiagram, type Placement } from "./place";
import { reorderPlaced } from "./order";
import { capacityRetry, isCapacityReject, withAction } from "./capacity";
import { crossingHops, routePlaced, type HoppedEdge } from "./route";
import { canonicalSymbolId } from "../../symbols";

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
function labelPos(pts: RoutedEdge["points"], nodes: readonly SheetNode[], lw: number, lh: number): [number, number] {
  const segs = segsOf(pts);
  if (!segs.length) return [0.0, 0.0];
  const order = segs.map((_, i) => i).sort((a, b) => segLen(segs[b]) - segLen(segs[a]) || a - b);
  const padX = lw / 2.0 + 0.8;
  const padY = lh / 2.0 + 0.4;
  for (const i of order) {
    const [[ax, ay], [bx, by]] = segs[i];
    const mx = (ax + bx) / 2.0;
    const my = (ay + by) / 2.0;
    const hit = nodes.some((nd) => nd.x - padX <= mx && mx <= nd.x + nd.w + padX && nd.y - padY <= my && my <= nd.y + nd.h + padY);
    if (!hit) return [mx, my];
  }
  return midLabel(pts);
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
  paths.forEach((p, i) => {
    for (const [, y] of p.points) ys.push(y);
    if (bands) {
      ys.push(bands[i][0], bands[i][1]); // FIG-02b: rentang label hasil penempatan fit
      return;
    }
    // pita knockout `labelKnockoutSvg`: y = my - 1,15 size, tinggi 1,7 size; my = labelPos - pt2mm(1,2)
    const [, ly] = labelPos(p.points, nodes, estTextMm(p.label, "evidence_rail"), railMm * 1.4);
    const my = ly - pt2mm(1.2);
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

/** D-290: cek otomatis, semua koordinat y yang dipancarkan berada di [0, H] (graph). */
function assertInsideSheet(svg: string, H: number): void {
  const bad: string[] = [];
  const check = (v: number, what: string) => {
    if (v < -1e-6 || v > H + 1e-6) bad.push(`${what}=${pyFixed(v, 3)}`);
  };
  for (const m of svg.matchAll(/\s(y|y1|y2|cy)="(-?[\d.]+)"/g)) check(Number(m[2]), m[1]);
  for (const m of svg.matchAll(/<rect [^>]*?\sy="(-?[\d.]+)"[^>]*?\sheight="([\d.]+)"/g)) check(Number(m[1]) + Number(m[2]), "rect bawah");
  // titik M/L jalur (busur lompatan A r 0,9 mm berpusat di jalur dan sudah tercakup rem)
  for (const m of svg.matchAll(/\sd="([^"]+)"/g)) {
    for (const q of m[1].matchAll(/[ML]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g)) check(Number(q[2]), "path y");
  }
  if (bad.length) {
    throw new DiagramDefect(`DATUM-37-tinggi: unsur keluar lembar graph (tinggi ${pyFixed(H, 3)} mm): ${bad.slice(0, 5).join(", ")} (P8, D-290)`, {
      checkId: "DATUM-37-tinggi",
    });
  }
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

function sourcesOf(s: StudioDiagramV1): string[] {
  if (Array.isArray(s.sources) && s.sources.length) return s.sources.map(String);
  const src: unknown = s.source;
  if (src === undefined || src === null) return [];
  return Array.isArray(src) ? src.map(String) : [String(src)];
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
    if (isCapacityReject(e, s)) return capacityRetry(s, e, () => buildOnce(s, opts, deps));
    throw withAction(e, s);
  }
  return autoFitDiagram(first, () => buildOnce(s, opts, deps));
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
  // FIG-02b: saat fit, label tepi ditempatkan tanpa tabrakan (posisi bawaan = `labelPos`).
  const fitOn = diagramFitActive();
  if (fitOn && s.family !== "graph" && s.family !== "sequence" && diagramFitRoute("lineThroughText")) {
    // FIG-02b2: rute yang turun di bawah simpul terbawah (mis. sld "ke beban") mendorong kaki ke bawah.
    const nb = Math.max(...[...sheet.nodes.values()].map((n) => n.y + n.h));
    const rb = Math.max(...paths.flatMap((p) => p.points.map(([, y]) => y)));
    if (Number.isFinite(rb) && rb > nb + 1e-6) sheet.routeBottom = rb;
  }
  const rail = pt2mm(role("evidence_rail").size);
  const origOf = (ps: readonly RoutedEdge[]): Array<[number, number]> =>
    ps.map((p) => {
      const [mx, my] = labelPos(p.points, [...sheet.nodes.values()], estTextMm(p.label, "evidence_rail"), rail * 1.4);
      return [mx, my - pt2mm(1.2)];
    });
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
    plan = fitEdgeLabels({ s, sheet, nodes: [...sheet.nodes.values()], paths, orig, yMin: Math.min(...ys), yMax: Math.max(...ys) });
  }
  // D-290: graph = lembar pas kotak pembatas semua unsur + rem tetap.
  const fit = s.family === "graph" ? graphFit(s, sheet, paths, plan ? planBands(plan) : undefined) : undefined;
  if (plan && fit) plan = shiftPlan(plan, fit.dy);
  const hopped: HoppedEdge[] = crossingHops(fit ? fit.paths : paths);
  ran.push("DATUM-32"); // ditegakkan detur rute (gagal = lempar)

  ran.push(...tokenFloorChecks()); // DATUM-28, DATUM-27

  sheet.foot = footReserveMm(s, W, opts.keyLabel, opts.keyRowText); // row 124 (CP-46): every line of a wrapped key is reserved; 124b: in the document language
  // FIG-02b2 P2-15: caption/SUMBER berbungkus saat fit bila melewati lebar lembar (+1 kisi per baris).
  // Row 124 (CP-28/48): the caption starts with the bold label "GAMBAR n.m" (DT-15 ID p.41).
  const capLabel = `${opts.figureLabel ?? DEFAULT_FIGURE_LABEL} ${s.id}`;
  const captionText = `${capLabel}  ${s.title}`;
  const sourceText = "SUMBER  " + sourcesOf(s).join("; ");
  const capLines = (s.apparatus ?? "page") === "figure" ? footLines(captionText, "caption", W) : [captionText];
  const srcLines = (s.apparatus ?? "page") === "figure" ? footLines(sourceText, "source_line", W) : [sourceText];
  const footExtra = capLines.length - 1 + srcLines.length - 1;
  if (footExtra > 0) {
    sheet.foot += footExtra * LATTICE_Y;
    diagramFitNote("CAPTION_WRAP", `caption ${capLines.length} baris, SUMBER ${srcLines.length} baris (dibungkus ke lebar ${W} mm)`, "persingkat judul gambar (maks ~100 karakter)");
  }
  let H = fit ? fit.contentBottom + sheet.foot + fit.pad : sheet.height();
  let notes: ReturnType<typeof noteRows> | undefined;
  let notesY0 = 0;
  if (fitOn) {
    if (!fit) {
      const nFoot = Math.round(sheet.foot / LATTICE_Y);
      const yMax = nFoot > 0 ? H - LATTICE_Y * 2 - (nFoot - 1) * LATTICE_Y - 3.0 : H;
      plan = fitEdgeLabels({ s, sheet, nodes: [...sheet.nodes.values()], paths: hopped, orig: origOf(hopped), yMax });
    }
    if (plan && plan.numbered.length) {
      // Baris catatan menempati posisi kaki lama; kaki turun sebanyak baris catatan.
      notes = noteRows(plan, W);
      notesY0 = (fit ? fit.contentBottom : H - LATTICE_Y * 2 - sheet.foot) + LATTICE_Y;
      sheet.foot += notes.rows * LATTICE_Y;
      H = fit ? fit.contentBottom + sheet.foot + fit.pad : sheet.height();
    }
  }
  if (H > grid.maxHeightMm + 1e-6) {
    throw new DiagramDefect(`DATUM-33: tinggi gambar ${pyFixed(H, 2)} mm melewati blok teks ${pyFixed(grid.maxHeightMm, 1)} mm (P8)`, {
      checkId: "DATUM-33",
    });
  }
  ran.push("DATUM-33");

  const apparatus = s.apparatus ?? "page";
  const nodes = [...sheet.nodes.values()];
  sheet.add(generatorComment(String(s.family)));
  if (apparatus === "page") sheet.add(APPARATUS_REQUIRED_COMMENT);
  // Row 124 (CP-43 / C23 check 25): define only the hatches and arrow heads this figure uses.
  const nodeClasses = nodes.map((n) => n.spec.class ?? {});
  sheet.addAll(
    diagramDefs({
      kinds: hopped.map((p) => p.kind),
      hatch45: nodeClasses.some((c) => c.accent),
      hatch135: nodeClasses.some((c) => !c.accent && c.secondary),
    }),
  );
  sheet.add(paperRectSvg(W, H));

  // lajur akuntabilitas + pemisah rambut (P2 swimlane), urutan kemunculan lajur
  const gutter = sheet.gutterW ?? 0;
  for (const lane of sheet.lanes) {
    sheet.add(lineSvg(pyInt(0), lane.y, W, lane.y, "ink200", STROKE_HAIR));
    sheet.add(svgText(0.5, lane.y + pt2mm(role("table_header").size) + LATTICE_Y / 2.0, lane.name, {
      role: "table_header",
      colourToken: "ink400",
      anchor: "start",
    }));
    if (gutter) sheet.add(lineSvg(gutter, lane.y, gutter, lane.y + lane.h, "ink200", STROKE_HAIR));
  }
  for (const ll of sheet.lifelines) {
    sheet.add(lineSvg(ll.x, ll.top, ll.x, H - LATTICE_Y, "ink200", STROKE_HAIR, DASH_PATTERNS.dashed));
  }

  // zona kepercayaan: penutupan garis putus + tab label, tanpa isian (P5)
  for (const z of s.zones ?? []) {
    const members = (z.members ?? []).map((m) => sheet.nodes.get(m)).filter((m): m is SheetNode => m !== undefined);
    if (!members.length) throw new DiagramDefect(`zona '${String(z.id)}' tanpa anggota dikenal (P5 trust zone)`, { checkId: "P5-zone" });
    const { x: zx, y: zy, w: zw, h: zh, lx, ly } = zoneGeom(z, members, sheet, fitOn); // P2-16: label dijepit saat fit
    sheet.add(
      `<rect x="${pyNum(zx, 2)}" y="${pyNum(zy, 2)}" width="${pyNum(zw, 2)}" height="${pyNum(zh, 2)}" fill="none" ` +
        `stroke="${colourOf("ink400")}" stroke-width="${pyNum(STROKE_HAIR, 2)}" stroke-dasharray="${DASH_PATTERNS.dashed}"/>`,
    );
    const label = z.label !== undefined ? z.label : z.id !== undefined ? z.id : "zona";
    sheet.add(svgText(lx, ly, label, { role: "table_header", colourToken: "ink400", anchor: "start" }));
  }

  // konektor: semua jalur + busur dulu, baru pita knockout dan label (garis tak menimpa teks)
  const labels: Array<[number, number, string, RoutedEdge["kind"]]> = [];
  const railMm = pt2mm(role("evidence_rail").size);
  if (plan) {
    const placed = plan.placed;
    hopped.forEach((p, i) => sheet.add(edgePathSvg(p.points, p.kind, { index: i })));
    for (const p of hopped) for (const [hx, hy] of p.hops) sheet.add(hopSvg(hx, hy, p.kind));
    hopped.forEach((p, i) => {
      const pl = placed[i];
      if (pl.leader) sheet.add(lineSvg(pl.leader[0], pl.leader[1], pl.leader[2], pl.leader[3], EDGE_KINDS[p.kind].colour, STROKE_HAIR));
      sheet.addAll(edgeLabelSvg(pl.x, pl.y, pl.text, p.kind, W, pl.kw));
    });
  } else {
    hopped.forEach((p, i) => {
      sheet.add(edgePathSvg(p.points, p.kind, { index: i }));
      const lw = estTextMm(p.label, "evidence_rail");
      const [mx, my] = labelPos(p.points, nodes, lw, railMm * 1.4);
      labels.push([mx, my - pt2mm(1.2), p.label, p.kind]);
    });
    for (const p of hopped) for (const [hx, hy] of p.hops) sheet.add(hopSvg(hx, hy, p.kind));
    for (const [mx, my, lab, kind] of labels) sheet.addAll(edgeLabelSvg(mx, my, lab, kind, W));
  }

  // simpul + label + glif asal + tag
  nodes.forEach((nd, i) => sheet.addAll(nodeSvg(nd, { index: i })));

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
          colourToken: "ink400",
          anchor: "start",
          track: TRACK.micro_label_wider,
        }),
      )
      .join("");
  // Baris kaki terbawah = tepi isi + cadangan kaki (= H - 2 kisi pada lembar Garis A).
  if (notes) sheet.addAll(notes.svg(notesY0)); // FIG-02b: catatan label tepi bernomor
  let foot = fit ? fit.contentBottom + sheet.foot : H - LATTICE_Y * 2;
  if (apparatus === "figure") {
    for (let i = capLines.length - 1; i >= 0; i--) {
      const capOpts = { role: "caption", colourToken: "ink700", anchor: "start" } as const;
      sheet.add(i === 0 ? captionSvg(pyInt(0), foot, capLines[i], capLabel, capOpts) : svgText(pyInt(0), foot, capLines[i], capOpts));
      foot -= LATTICE_Y;
    }
    if (hasLegend) {
      sheet.add(keyLine(foot));
      foot -= LATTICE_Y * keyTexts.length;
    }
    srcLines.forEach((line, i) => {
      sheet.add(svgText(pyInt(0), foot - (srcLines.length - 1 - i) * LATTICE_Y, line, { role: "source_line", colourToken: "ink400", anchor: "start" }));
    });
  } else if (hasLegend) {
    sheet.add(keyLine(foot));
  }
  if (fit) sheet.fixHeight(H); // akar SVG memakai tinggi lembar pas (D-290)
  const svg = sheet.toSvg();
  if (fit) assertInsideSheet(svg, H);

  // DATUM-25 dari SVG NYATA (IP-39b, S84 #2): semua fill/stroke tercetak di luar
  // <defs> + definisi yang dirujuk, kertas dibuang. DEVIASI SENGAJA dari Garis A,
  // yang menghitung dari model token tidak lengkap (label ink900 dan garis luar
  // shadowed ink200 tak terhitung) sehingga 6 warna bisa lulus batas 5.
  const used = svgColourValues(svg);
  if (used.length > LIMITS.max_colour_values) {
    throw new DiagramDefect(
      `DATUM-25: ${used.length} nilai warna dalam satu gambar, maksimum ${LIMITS.max_colour_values} (temuan E-16: plafon ini nyata) (P5/P8)`,
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
    },
  };
}
