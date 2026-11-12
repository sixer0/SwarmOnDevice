/**
 * Kapasitas yang membantu (FIG-02b2, audit research/18 §6 P1-14).
 *
 * Bila render pertama ditolak DATUM-37 (graph / swimlane), rakitan diulang di dalam fit dengan
 * `capacity: true` (tata letak beradaptasi: pitch graph dipadatkan, swimlane kolom waktu bersama
 * lalu bungkus dalam lajur). Hasil dengan skor lint terkecil dipakai dan dilaporkan REPORT
 * `CAPACITY_ADAPT`, tetapi hanya hasil yang lolos `capacityAcceptable` (D-503: tanpa teks
 * bertumpuk, persilangan + berimpit <= 3). Bila semua gagal atau tidak ada yang lolos, penolakan
 * asli dilempar ulang (kelas, kode, checkId sama) dengan saran aksi konkret di pesannya.
 *
 * Swarm patch (row 158, U24 B): (1) a capacity layout is used only when it is CLEAN (geometry lint
 * score 0); one that would render with crossings/overlaps is refused instead of squeezed;
 * (2) every capacity refusal (DATUM-33 height, DATUM-37* width) is re-thrown as a
 * `DiagramOverCapacity` (code FIGURE_OVER_CAPACITY, class DiagramDefect, checkId kept) whose
 * details carry {limit, measured, unit, suggestion}; other defects keep their code (withAction).
 */
import { StudioEngineError } from "../../../contract/errors";
import type { StudioDiagramV1 } from "../../../contract";
import { DiagramDefect, LATTICE_X } from "../core";
import { GRAPH_EDGE_INSET_MM, footReserveMm } from "../core/sheet";
import { flowDirectionOf, flowRankOverload, flowRanks } from "../layout-a/flow";
import { DiagramOverCapacity, type FigureOverCapacityDetails } from "../../figure-capacity";
import { lintDiagramGeometry, type DiagramGeomLint } from "../fit/lint";
import { withDiagramFit, type DiagramFitState } from "../fit/state";
import { diagramGeometryIssues, type DiagramGeometryIssue } from "./autofit";
import type { DiagramSvgResult } from "./svg";

const ADAPTIVE = new Set(["graph", "swimlane"]);

function checkIdOf(e: unknown): string {
  const d = (e as { details?: { checkId?: string } } | null)?.details;
  return d?.checkId ?? (e as { checkId?: string } | null)?.checkId ?? "";
}

/** Penolakan kapasitas yang boleh dicoba ulang dengan adaptasi tata letak. */
export function isCapacityReject(e: unknown, s: StudioDiagramV1): boolean {
  return e instanceof StudioEngineError && checkIdOf(e).startsWith("DATUM-37") && ADAPTIVE.has(String(s.family));
}

/** Saran aksi konkret per keluarga untuk penolakan kapasitas/tinggi. */
export function capacityAction(s: StudioDiagramV1, checkId: string): string | null {
  const W = Number(s.width_mm) || 166;
  const fam = String(s.family);
  if (checkId.startsWith("DATUM-33")) {
    // Swarm 1.2.6 row 46 (T-11, 01e §6.8): a flow too tall gains the direction alternative.
    if (fam === "flow") {
      const dir = flowDirectionOf(s);
      const alt = dir === "TB" ? 'direction "LR" (peringkat kiri-kanan)' : dir === "LR" ? 'direction "TB"' : 'direction "TB" (cabang paralel berdampingan)';
      return `kurangi simpul per gambar, pakai ${alt}, atau pecah menjadi 2 diagram`;
    }
    return "kurangi simpul/pesan per gambar atau pecah menjadi 2 diagram";
  }
  if (!checkId.startsWith("DATUM-37")) return null;
  if (fam === "graph") {
    const cols = [...new Set((s.nodes ?? []).map((n) => Number((n.class as Record<string, unknown> | undefined)?.col ?? 0)))].sort((a, b) => a - b);
    const gap = cols.some((c, i) => i > 0 && c !== cols[i - 1] + 1);
    const maxCols = Math.floor((W - 2 * GRAPH_EDGE_INSET_MM - LATTICE_X * 2) / (LATTICE_X * 3) + 1e-9) + 1; // row 59: inside the T-02 inset
    return gap
      ? `rapatkan class.col (ada kolom kosong di antara kolom ${cols.join(", ")}); maks ${maxCols} kolom pada ${W} mm`
      : `maks ${maxCols} kolom pada ${W} mm; bagi menjadi dua gambar atau pakai layered`;
  }
  if (fam === "swimlane") return `kurangi simpul per lajur, bagi lajur, atau pecah menjadi 2 diagram (lebar ${W} mm)`;
  if (fam === "sld") return `maks 3 cabang per tingkat pada ${W} mm; pecah rel atau bagi menjadi dua gambar`;
  // Swarm 1.2.6 row 46 (T-11): the flow text names `direction` (ranked flow) beside per_row.
  if (fam === "flow") {
    return flowDirectionOf(s)
      ? `kurangi simpul per peringkat, pakai width_mm 166, ganti direction, atau pecah menjadi 2 diagram (lebar ${W} mm)`
      : 'persingkat label keputusan (maks ~40 karakter), pakai direction "TB"/"LR" (menata menurut konektor) atau per_row';
  }
  return `persingkat label atau pecah menjadi 2 diagram (lebar ${W} mm)`;
}

/** Row 158: check ids that mean "the figure does not fit the sheet" (height or width). */
export function isCapacityCheck(checkId: string): boolean {
  return checkId.startsWith("DATUM-33") || checkId.startsWith("DATUM-37");
}

type Measure = Pick<FigureOverCapacityDetails, "quantity" | "unit" | "limit" | "measured">;

const n1 = (v: string | undefined): number | null => (v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Swarm 1.2.6 row 67 (T-12): a `DATUM-37-tinggi` refusal (build/svg.ts `assertInsideSheet`): the sheet height is the
 * limit, the height the drawn elements need (sheet height plus what reaches below it and above 0) is the measure.
 * Both 1.2.5's text "(tinggi H mm)" and 1.2.6's "(tinggi H mm, kaki aparatus F mm)" are read.
 */
function measureSheetHeight(msg: string): Measure | null {
  const t = /unsur keluar lembar \w+ \(tinggi ([\d.]+) mm(?:, kaki aparatus [\d.]+ mm)?\): ([^(]*)/.exec(msg);
  const H = n1(t?.[1]);
  if (!t || H === null) return null;
  const vals = [...t[2].matchAll(/=(-?[\d.]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  const below = Math.max(0, ...vals.map((v) => v - H));
  const above = Math.max(0, ...vals.map((v) => -v));
  return { quantity: "tinggi gambar (lembar)", unit: "mm", measured: Number((H + below + above).toFixed(3)), limit: H };
}

/** Swarm 1.2.6 row 67 (T-12, N-019): the furniture height the engine printed ("kaki aparatus F mm"), else null. */
function furnitureFromMessage(msg: string): number | null {
  return n1(/kaki aparatus ([\d.]+) mm/.exec(msg)?.[1]);
}

/** mm figures the engine already printed in its own DATUM-33/37 message (fallback measure). */
function measureFromMessage(msg: string): Measure | null {
  const sh = measureSheetHeight(msg);
  if (sh) return sh;
  // Swarm 1.2.6 row 59 (T-02): content wider than W - 2 x GRAPH_EDGE_INSET_MM (column or rank named in the text).
  const i = /melewati inset tepi [\d.]+ mm: isi ([\d.]+) mm > batas ([\d.]+) mm/.exec(msg);
  if (i) return { quantity: "lebar isi gambar di dalam inset tepi", unit: "mm", measured: n1(i[1]), limit: n1(i[2]) };
  const h = /tinggi gambar ([\d.]+) mm melewati blok teks ([\d.]+) mm/.exec(msg);
  if (h) return { quantity: "tinggi gambar", unit: "mm", measured: n1(h[1]), limit: n1(h[2]) };
  const w = /\(([\d.]+)\.\.([\d.]+) dari ([\d.]+) mm\)/.exec(msg);
  if (w) return { quantity: "tepi kanan simpul", unit: "mm", measured: n1(w[2]), limit: n1(w[3]) };
  const r = /tidak muat di ([\d.]+) mm .*butuh ([\d.]+) mm/.exec(msg);
  if (r) return { quantity: "lebar baris graph", unit: "mm", measured: n1(r[2]), limit: n1(r[1]) };
  return null;
}

/** Graph: contiguous column span vs the most columns that fit at the figure width. */
function graphColumns(s: StudioDiagramV1): { cols: number[]; span: number; maxCols: number; width: number } {
  const W = Number(s.width_mm) || 166;
  const cols = [...new Set((s.nodes ?? []).map((n) => Number((n.class as Record<string, unknown> | undefined)?.col ?? 0)))].sort((a, b) => a - b);
  const span = cols.length ? cols[cols.length - 1] - cols[0] + 1 : 0;
  const maxCols = Math.floor((W - 2 * GRAPH_EDGE_INSET_MM - LATTICE_X * 2) / (LATTICE_X * 3) + 1e-9) + 1; // row 59: inside the T-02 inset
  return { cols, span, maxCols, width: W };
}

/** Swimlane: busiest lane vs the nodes one wrapped lane row holds (layout-b/swimcap.ts `perRow`). */
function swimlaneLoad(s: StudioDiagramV1): { lane: string; count: number; perRow: number; width: number } {
  const W = Number(s.width_mm) || 166;
  const per = new Map<string, number>();
  for (const n of s.nodes ?? []) {
    const lane = String((n.class as Record<string, unknown> | undefined)?.lane ?? "");
    per.set(lane, (per.get(lane) ?? 0) + 1);
  }
  let lane = "";
  let count = 0;
  for (const [k, v] of per) if (v > count) [lane, count] = [k, v];
  // gutter 3 kisi + 1 kisi tepi, simpul 3 kisi + 1 kisi jarak (swimlane.ts gutter, swimcap.ts x0/pitch)
  const perRow = Math.max(1, Math.floor((W - LATTICE_X * 4 + LATTICE_X) / (LATTICE_X * 4) + 1e-9));
  return { lane, count, perRow, width: W };
}

/**
 * Row 158: `e` as a FIGURE_OVER_CAPACITY refusal (measured value, limit, concrete suggestion), or
 * null when `e` is not a capacity defect. `note` is appended to the engine text (e.g. why the
 * capacity layout was not used).
 */
export function overCapacityOf(e: unknown, s: StudioDiagramV1, note?: string): DiagramOverCapacity | null {
  if (!(e instanceof StudioEngineError)) return null;
  if (e instanceof DiagramOverCapacity) return e;
  const checkId = checkIdOf(e);
  if (!isCapacityCheck(checkId)) return null;
  const fam = String(s.family);
  const action = capacityAction(s, checkId) ?? "pecah menjadi 2 diagram";
  let m: Measure | null = null;
  let suggestion = action;
  // Swarm 1.2.6 row 67 (T-12): a height refusal (DATUM-33, DATUM-37-tinggi) is measured in mm from its own message,
  // never as graph columns / ranks / lane load (those are width measures).
  const height = checkId.startsWith("DATUM-33") || checkId.startsWith("DATUM-37-tinggi");
  if (height) {
    m = measureFromMessage(e.message);
  } else if (checkId.startsWith("DATUM-37") && fam === "graph") {
    const g = graphColumns(s);
    if (g.span > g.maxCols) m = { quantity: "kolom graph", unit: "kolom", measured: g.span, limit: g.maxCols };
  } else if (checkId.startsWith("DATUM-37") && flowDirectionOf(s)) {
    // Swarm 1.2.6 row 46 (T-11, 01e §6.5-6.7): ranked flow measured in nodes per rank / ranks.
    const o = flowRankOverload(flowDirectionOf(s)!, flowRanks(s).ranks, Number(s.width_mm) || 166, LATTICE_X);
    if (o) {
      m = { quantity: o.quantity, unit: o.unit, measured: o.measured, limit: o.limit };
      suggestion = o.suggestion;
    }
  } else if (checkId.startsWith("DATUM-37") && fam === "swimlane") {
    const l = swimlaneLoad(s);
    m = { quantity: "simpul per baris lajur", unit: "simpul", measured: l.count, limit: l.perRow };
    suggestion = `${action}; lajur "${l.lane}" memuat ${l.count} simpul, maks ${l.perRow} per baris lajur pada ${l.width} mm (bungkus lajur hanya dipakai bila hasilnya bersih)`;
  }
  m ??= measureFromMessage(e.message) ?? { quantity: height ? "tinggi gambar" : "lebar gambar", unit: "mm", measured: null, limit: null };
  if (checkId.startsWith("DATUM-33")) suggestion = `${action} (${(s.nodes ?? []).length} simpul, ${(s.edges ?? []).length} konektor dalam gambar ini)`;
  if (checkId.startsWith("DATUM-37-tinggi")) suggestion = `${action}; atau kurangi baris kaki (caption, KUNCI, SUMBER)`;
  // Swarm 1.2.6 row 67 (T-12, N-019): furniture apart from content, from the engine text or (1.2.5 text) the spec.
  const furnitureMm = height ? (furnitureFromMessage(e.message) ?? footReserveMm(s, Number(s.width_mm) || 166)) : undefined;
  const pointer = e instanceof DiagramDefect ? e.pointer : undefined;
  const base = note ? `${e.message}; ${note}` : e.message;
  return new DiagramOverCapacity(base, { checkId, family: fam, ...m, suggestion, ...(pointer ? { pointer } : {}), ...(furnitureMm !== undefined ? { furnitureMm } : {}) });
}

/** Lempar ulang `e` dengan saran aksi (kelas, kode, checkId, pointer dipertahankan). */
export function withAction(e: unknown, s: StudioDiagramV1): unknown {
  if (!(e instanceof StudioEngineError)) return e;
  // Row 158 (U24 B): capacity defects become FIGURE_OVER_CAPACITY with limit/measured/suggestion.
  const over = overCapacityOf(e, s);
  if (over) return over;
  const action = capacityAction(s, checkIdOf(e));
  if (!action || e.message.includes("saran:")) return e;
  const msg = `${e.message}; saran: ${action}`;
  if (e instanceof DiagramDefect) return new DiagramDefect(msg, { checkId: e.checkId, pointer: e.pointer, code: e.code });
  const out = new StudioEngineError(e.code, msg, e.details as never);
  out.name = e.name;
  return out;
}

const MODES: ReadonlyArray<{ grow: boolean; capMode?: string }> = [
  { grow: true, capMode: "time" },
  { grow: true, capMode: "pack" },
  { grow: false, capMode: "time" },
  { grow: false, capMode: "pack" },
];

/** D-503 (3): batas rute bercacat untuk render hasil adaptasi kapasitas (persilangan + berimpit). */
export const CAPACITY_MAX_ROUTE_DEFECTS = 3;

/**
 * D-503 (3): render hasil adaptasi kapasitas hanya dipakai bila lint tanpa teks bertumpuk dan
 * persilangan + segmen berimpit <= 3. Selain itu penolakan lama dipertahankan (dokumen klien
 * tidak boleh memuat diagram rusak diam-diam).
 */
export function capacityAcceptable(g: DiagramGeomLint): boolean {
  return (g.counts.textOverlap ?? 0) === 0 && (g.counts.edgeCross ?? 0) + (g.counts.edgeCollinear ?? 0) <= CAPACITY_MAX_ROUTE_DEFECTS;
}

/**
 * Coba ulang rakitan yang ditolak kapasitas; lempar penolakan asli (+ saran) bila semua gagal
 * atau bila tidak ada hasil yang lolos `capacityAcceptable`.
 */
export function capacityRetry(s: StudioDiagramV1, original: unknown, rebuild: () => DiagramSvgResult): DiagramSvgResult {
  let best: { res: DiagramSvgResult; g: DiagramGeomLint; state: DiagramFitState } | undefined;
  const tried: string[] = [];
  const modes = s.family === "swimlane" ? MODES : MODES.filter((m) => m.capMode === "time");
  for (const m of modes) {
    const state: DiagramFitState = { notes: [], grow: m.grow, numbered: true, capacity: true, capMode: m.capMode, defects: {} };
    try {
      const res = withDiagramFit(state, rebuild);
      const g = lintDiagramGeometry(res.svg);
      // Row 158 (U24 B): only a CLEAN capacity layout (lint score 0) is used; D-503's looser
      // `capacityAcceptable` (<= 3 route defects) stays exported for its pinned unit test.
      const ok = capacityAcceptable(g) && g.score === 0;
      tried.push(`${m.capMode}${m.grow ? "" : ", tanpa tumbuh"}: ${g.score}${ok ? "" : " (ditolak: tidak bersih)"}`);
      if (ok && (!best || g.score < best.g.score)) best = { res, g, state };
      if (g.score === 0) break;
    } catch (e) {
      tried.push(`${m.capMode}${m.grow ? "" : ", tanpa tumbuh"}: gagal ${checkIdOf(e)}`);
    }
  }
  if (!best) throw overCapacityOf(original, s, `tata letak kapasitas tidak bersih (dicoba: ${tried.join("; ")})`) ?? withAction(original, s);
  const geometry: DiagramGeometryIssue[] = [
    {
      checkId: "AUTO_FIT",
      status: "REPORT",
      detail: `render pertama ditolak ${checkIdOf(original)}; tata letak kapasitas -> sisa ${best.g.score}; dicoba: ${tried.join("; ")}`,
      suggest: best.g.score ? "lihat isu GEOM_* berikut" : "tidak ada",
    },
    ...best.state.notes.map((n) => ({ checkId: n.checkId, status: "REPORT" as const, detail: n.suggest ? `${n.detail}; saran: ${n.suggest}` : n.detail, suggest: n.suggest ?? "tidak ada" })),
    ...diagramGeometryIssues(best.g),
  ];
  return { ...best.res, report: { ...best.res.report, geometry } };
}
