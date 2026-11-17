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
import { FIGURE_BOUNDS } from "../../../contract/schema/figure-bounds";
import type { StudioDiagramV1 } from "../../../contract";
import { DiagramDefect, LATTICE_X, validateSpec } from "../core";
import { STROKE_PRIMARY } from "../core/tokens";
import { GRAPH_EDGE_INSET_MM, footReserveMm } from "../core/sheet";
import { CAPACITY_SPLIT_TEXT, FIGURE_FULL_WIDTH_MM, FIGURE_TEXT_WIDTH_MM, capacityWidthChoice, flowDirectionOf, flowRankOverload, flowRanks } from "../layout-a/flow";
import { TIERED_FAMILIES, tierLoad } from "../layout-a/layered";
import { sldBranchCapacity, sldBranchLoad } from "../layout-c/sld";
import { DiagramOverCapacity, type FigureOverCapacityDetails } from "../../figure-capacity";
import { lintDiagramGeometry, type DiagramGeomLint } from "../fit/lint";
import { withDiagramFit, type DiagramFitState } from "../fit/state";
import { autoFitRestText, diagramGeometryIssues, type DiagramGeometryIssue } from "./autofit";
import type { DiagramSvgResult } from "./svg";
// Row 140: the part check builds each part (a cycle with svg.ts through index.ts, used only at call time, as DEFAULT_DEPS there).
import { buildDiagramSvgRaw } from "./index";

const ADAPTIVE = new Set(["graph", "swimlane"]);

function checkIdOf(e: unknown): string {
  const d = (e as { details?: { checkId?: string } } | null)?.details;
  return d?.checkId ?? (e as { checkId?: string } | null)?.checkId ?? "";
}

/**
 * Swarm 1.3.3 row 34 (ST-1 item 4): the width the helper assumes when a spec carries no `width_mm` is the registry
 * default (`diagram.widthMm`, the text column), read from the diagram tokens; it was the full span (166) before.
 * Compose always sets `width_mm` (from the block's `width`, else the template parameter), so this only decides
 * the numbers of a spec that reaches the helper without a width.
 */
export const CAPACITY_DEFAULT_WIDTH_MM = FIGURE_TEXT_WIDTH_MM;

/** Row 34: the figure width the capacity numbers are computed from (the width in use, else the registry default). */
export function capacityWidthOf(s: StudioDiagramV1): number {
  return Number(s.width_mm) || CAPACITY_DEFAULT_WIDTH_MM;
}

/** Row 34: `capacityWidthChoice` (layout-a/flow.ts) and the split text, re-exported for callers of this module. */
export { CAPACITY_SPLIT_TEXT, capacityWidthChoice };

/** Graph: most columns at a figure width (row 59: inside the T-02 inset). */
function graphMaxColsAt(W: number): number {
  return Math.floor((W - 2 * GRAPH_EDGE_INSET_MM - LATTICE_X * 2) / (LATTICE_X * 3) + 1e-9) + 1;
}

/** Penolakan kapasitas yang boleh dicoba ulang dengan adaptasi tata letak. */
export function isCapacityReject(e: unknown, s: StudioDiagramV1): boolean {
  return e instanceof StudioEngineError && checkIdOf(e).startsWith("DATUM-37") && ADAPTIVE.has(String(s.family));
}

/** Saran aksi konkret per keluarga untuk penolakan kapasitas/tinggi. */
export function capacityAction(s: StudioDiagramV1, checkId: string): string | null {
  const W = capacityWidthOf(s);
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
    const maxCols = graphMaxColsAt(W);
    // Row 34: the contiguous span decides whether `full` holds the figure; both widths are computed.
    const span = cols.length ? cols[cols.length - 1] - cols[0] + 1 : 0;
    const choice = capacityWidthChoice({ unit: "kolom", at: graphMaxColsAt, width: W, need: gap ? cols.length : span });
    return gap
      ? `rapatkan class.col (ada kolom kosong di antara kolom ${cols.join(", ")}); maks ${maxCols} kolom pada ${W} mm; ${choice}`
      : `maks ${maxCols} kolom pada ${W} mm; bagi menjadi dua gambar atau pakai layered; ${choice}`;
  }
  if (fam === "swimlane") {
    // Swarm 1.2.8 row 57c (C71 R3, C116 D55b-1): with phases the remedy names the phase; horizontal pools (2 x gutter of
    // header) point to vertical pools. A swimlane without phases or pools keeps today's text.
    const phases = Array.isArray(s.phases) && s.phases.length > 0;
    const pools = Array.isArray(s.pools) && s.pools.length > 0;
    const vertical = (s as { lane_orientation?: unknown }).lane_orientation === "vertical";
    if (!phases && !pools) return `kurangi simpul per lajur, bagi lajur, atau pecah menjadi 2 diagram (lebar ${W} mm)`;
    const per = phases ? "kurangi simpul per lajur atau per fase, kurangi fase" : "kurangi simpul per lajur, bagi lajur";
    const alt = pools && !vertical ? ', pakai lane_orientation "vertical" (kolam tegak memuat lebih banyak kolom)' : "";
    return `${per}${alt}, atau pecah menjadi 2 diagram (lebar ${W} mm)`;
  }
  // Swarm 1.3.3 row 139 (E3/E4 of row 36): sld and the tiered families state the limit of the width in use (the layout's
  // own capacity function), and a full rail row or tier gets row 34's two-width text, so `width "full"` is offered
  // whenever 166 mm holds it (and the split skeleton is then not computed: withSplitSkeleton `fullWidthAdvised`).
  if (fam === "sld") {
    const l = sldBranchLoad(s);
    const at = (w: number) => sldBranchCapacity(w, LATTICE_X);
    if (l.count <= at(W)) return `maks ${at(W)} cabang per tingkat pada ${W} mm; pecah rel atau bagi menjadi dua gambar`;
    const choice = capacityWidthChoice({ unit: "cabang per tingkat", at, width: W, need: l.count, others: ["pecah rel"] });
    return `rel ${l.bus} memuat ${l.count} cabang, maks ${at(W)} cabang per tingkat pada ${W} mm; ${choice}`;
  }
  if (TIERED_FAMILIES.has(fam)) {
    const t = tierLoad(s, W, LATTICE_X);
    if (t.count > t.perTier) {
      const unit = tierUnit(fam);
      const choice = capacityWidthChoice({ unit, at: (w) => tierLoad(s, w, LATTICE_X).perTier, width: W, need: t.count });
      return `${fam === "stack" ? "lapis" : "tingkat"} ${t.tier} memuat ${t.count} simpul; ${choice}`;
    }
  }
  // Swarm 1.2.6 row 46 (T-11): the flow text names `direction` (ranked flow) beside per_row.
  if (fam === "flow") {
    return flowDirectionOf(s)
      ? `kurangi simpul per peringkat, ${W < FIGURE_FULL_WIDTH_MM ? `pakai width "full" (width_mm ${FIGURE_FULL_WIDTH_MM}), ` : ""}ganti direction, atau ${CAPACITY_SPLIT_TEXT} (lebar ${W} mm)`
      : 'persingkat label keputusan (maks ~40 karakter), pakai direction "TB"/"LR" (menata menurut konektor) atau per_row';
  }
  return `persingkat label atau pecah menjadi 2 diagram (lebar ${W} mm)`;
}

/** Row 139: the unit a tier is counted in (row 36's table: a stack tier is a layer). */
function tierUnit(fam: string): string {
  return fam === "stack" ? "simpul per lapis" : "simpul per tingkat";
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
  const W = capacityWidthOf(s);
  const cols = [...new Set((s.nodes ?? []).map((n) => Number((n.class as Record<string, unknown> | undefined)?.col ?? 0)))].sort((a, b) => a - b);
  const span = cols.length ? cols[cols.length - 1] - cols[0] + 1 : 0;
  return { cols, span, maxCols: graphMaxColsAt(W), width: W };
}

/**
 * Swarm 1.2.8 row 55g (C140, G3-21): vertical pools. The binding quantity is the lane COLUMNS across the width (one per
 * (pool, lane), swimlane.ts `poolLanes`), not nodes per lane row: lanes are keyed per pool, never by name across pools. The
 * columns that fit use the budget of swimlane.ts `fitPoolColumns` (>= 2 lattice per column, a lattice gap between columns,
 * 2 lattice between pools, half a lattice inside the frame, `L.W - STROKE_PRIMARY / 2`). The shown max is kept below the
 * measured count: the figure was refused, so a line reading "maks N ... terukur N" would be false.
 */
function verticalPoolLoad(s: StudioDiagramV1, widthMm?: number): { columns: number; pools: number; maxColumns: number; fit: number; width: number } {
  const W = widthMm ?? capacityWidthOf(s); // row 34: `widthMm` asks for the numbers at another width
  const cols = new Map<string, string[]>();
  for (const p of s.pools ?? []) cols.set(String(p.id), []);
  for (const n of s.nodes ?? []) {
    const c = (n.class ?? {}) as Record<string, unknown>;
    const pid = String(c.pool);
    const ln = Object.prototype.hasOwnProperty.call(c, "lane") && c.lane !== undefined ? String(c.lane) : "";
    const a = cols.get(pid);
    if (a && !a.includes(ln)) a.push(ln);
  }
  const perPool = [...cols.values()].map((a) => Math.max(1, a.length));
  const columns = perPool.reduce((a, b) => a + b, 0);
  const startX = Array.isArray(s.phases) && s.phases.length > 0 ? LATTICE_X * 3 : 0;
  let fit = 0;
  for (let k = 1; k <= columns; k++) {
    // the first k columns, pool by pool
    let left = k;
    let breaks = -1;
    for (const c of perPool) {
      if (left <= 0) break;
      breaks++;
      left -= c;
    }
    const room = W - STROKE_PRIMARY / 2 - (startX + LATTICE_X + (k - 1) * LATTICE_X + Math.max(0, breaks) * LATTICE_X * 2 + LATTICE_X / 2);
    if (room + 1e-6 >= LATTICE_X * 2 * k) fit = k;
    else break;
  }
  return { columns, pools: perPool.length, maxColumns: Math.max(1, Math.min(fit, columns - 1)), fit, width: W };
}

/** Swimlane: busiest lane vs the nodes one wrapped lane row holds (layout-b/swimcap.ts `perRow`). */
function swimlaneLoad(s: StudioDiagramV1, widthMm?: number): { lane: string; count: number; perRow: number; width: number } {
  const W = widthMm ?? capacityWidthOf(s); // row 34: `widthMm` asks for the numbers at another width
  const per = new Map<string, number>();
  for (const n of s.nodes ?? []) {
    const lane = String((n.class as Record<string, unknown> | undefined)?.lane ?? "");
    per.set(lane, (per.get(lane) ?? 0) + 1);
  }
  let lane = "";
  let count = 0;
  for (const [k, v] of per) if (v > count) [lane, count] = [k, v];
  // gutter 3 kisi + 1 kisi tepi, simpul 3 kisi + 1 kisi jarak (swimlane.ts gutter, swimcap.ts x0/pitch)
  let perRow = Math.max(1, Math.floor((W - LATTICE_X * 4 + LATTICE_X) / (LATTICE_X * 4) + 1e-9));
  // Swarm 1.2.8 row 55d (C135 R3): horizontal pools put a second gutter (the pool header strip, 3 lattice) left of the lane
  // headers (swimlane.ts startX = 2 x gutter) and keep half a lattice column inside the pool frame (the DATUM-37-sheet
  // limit W - x/2). Without this the line read "maks 2 ... terukur 2" next to a refusal. Figures
  // without pools keep the formula above (vertical pools: see verticalPoolLoad, row 55g).
  if (Array.isArray(s.pools) && s.pools.length > 0 && s.lane_orientation !== "vertical") {
    perRow = Math.max(1, Math.floor((W - LATTICE_X * 6 - LATTICE_X / 2 + LATTICE_X) / (LATTICE_X * 4) + 1e-9));
  }
  return { lane, count, perRow, width: W };
}

/**
 * Row 158: `e` as a FIGURE_OVER_CAPACITY refusal (measured value, limit, concrete suggestion), or
 * null when `e` is not a capacity defect. `note` is appended to the engine text (e.g. why the
 * capacity layout was not used).
 */
export function overCapacityOf(e: unknown, s: StudioDiagramV1, note?: string): DiagramOverCapacity | null {
  if (!(e instanceof StudioEngineError)) return null;
  // Row 51: a refusal thrown ready-made (flow.ts `assertRankCapacity`) gains the split skeleton here.
  if (e instanceof DiagramOverCapacity) return withSplitSkeleton(e, s);
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
    const o = flowRankOverload(flowDirectionOf(s)!, flowRanks(s).ranks, capacityWidthOf(s), LATTICE_X);
    if (o) {
      m = { quantity: o.quantity, unit: o.unit, measured: o.measured, limit: o.limit };
      suggestion = o.suggestion;
    }
  } else if (checkId.startsWith("DATUM-37") && fam === "sld") {
    // Row 139: branches of the fullest rail row against the width's own limit (layout-c/sld.ts).
    const l = sldBranchLoad(s);
    const cap = sldBranchCapacity(capacityWidthOf(s), LATTICE_X);
    if (l.count > cap) m = { quantity: "cabang per tingkat", unit: "cabang", measured: l.count, limit: cap };
  } else if (checkId.startsWith("DATUM-37") && TIERED_FAMILIES.has(fam)) {
    // Row 139: nodes of the fullest tier against the tier capacity (layout-a/layered.ts, label band included).
    const t = tierLoad(s, capacityWidthOf(s), LATTICE_X);
    if (t.count > t.perTier) m = { quantity: tierUnit(fam), unit: "simpul", measured: t.count, limit: t.perTier };
  } else if (checkId.startsWith("DATUM-37") && fam === "swimlane") {
    if (Array.isArray(s.pools) && s.pools.length > 0 && s.lane_orientation === "vertical") {
      // Swarm 1.2.8 row 55g (C140, G3-21): vertical pools are refused on lane columns across the width, counted per pool.
      const v = verticalPoolLoad(s);
      m = { quantity: "kolom lajur", unit: "kolom", measured: v.columns, limit: v.maxColumns };
      // Row 34: columns at both widths (the width in use shows the limit of the refusal); "pakai 166 mm" only when
      // the figure is narrower than the full width and the full width holds its columns.
      const fitAt = (w: number) => (w === v.width ? v.maxColumns : Math.max(1, verticalPoolLoad(s, w).fit));
      const full = v.width < FIGURE_FULL_WIDTH_MM && fitAt(FIGURE_FULL_WIDTH_MM) >= v.columns;
      const choice = capacityWidthChoice({ unit: "kolom lajur", at: fitAt, width: v.width, need: v.columns });
      suggestion = `${action}; ${v.columns} kolom lajur dalam ${v.pools} kolam, maks ${v.maxColumns} kolom pada ${v.width} mm; kurangi jumlah kolam per gambar, ${full ? `pakai ${FIGURE_FULL_WIDTH_MM} mm, ` : ""}atau ${CAPACITY_SPLIT_TEXT}; ${choice}`;
    } else {
      const l = swimlaneLoad(s);
      m = { quantity: "simpul per baris lajur", unit: "simpul", measured: l.count, limit: l.perRow };
      // Row 34: nodes per lane row at both widths.
      const choice = capacityWidthChoice({ unit: "simpul per baris lajur", at: (w) => (w === l.width ? l.perRow : swimlaneLoad(s, w).perRow), width: l.width, need: l.count });
      suggestion = `${action}; lajur "${l.lane}" memuat ${l.count} simpul, maks ${l.perRow} per baris lajur pada ${l.width} mm (bungkus lajur hanya dipakai bila hasilnya bersih); ${choice}`;
    }
  }
  m ??= measureFromMessage(e.message) ?? { quantity: height ? "tinggi gambar" : "lebar gambar", unit: "mm", measured: null, limit: null };
  if (checkId.startsWith("DATUM-33")) suggestion = `${action} (${(s.nodes ?? []).length} simpul, ${(s.edges ?? []).length} konektor dalam gambar ini)`;
  if (checkId.startsWith("DATUM-37-tinggi")) suggestion = `${action}; atau kurangi baris kaki (caption, KUNCI, SUMBER)`;
  // Swarm 1.2.6 row 67 (T-12, N-019): furniture apart from content, from the engine text or (1.2.5 text) the spec.
  const furnitureMm = height ? (furnitureFromMessage(e.message) ?? footReserveMm(s, capacityWidthOf(s))) : undefined;
  const pointer = e instanceof DiagramDefect ? e.pointer : undefined;
  // Row 34 seam, used by row 51 (ST-4 split skeleton): this is the one place every capacity refusal is assembled.
  // Code, message and `suggestion` are unchanged; the skeleton is the extra details field `split`.
  const base = note ? `${e.message}; ${note}` : e.message;
  return withSplitSkeleton(
    new DiagramOverCapacity(base, { checkId, family: fam, ...m, suggestion, ...(pointer ? { pointer } : {}), ...(furnitureMm !== undefined ? { furnitureMm } : {}) }),
    s,
  );
}

/**
 * Swarm 1.3.3 row 51 (ST-4, last sentence): what the agent writes in `ref.figure` of the skeleton's off-page nodes.
 * Part 1's connectors point to part 2 and the reverse. The `{{key}}` form is the register's unfilled-placeholder
 * convention (PLACEHOLDER_UNFILLED, row 52); it is also outside the block id pattern, so the schema refuses it unfilled.
 */
export const SPLIT_PLACEHOLDER_PART_1 = "{{id_blok_bagian_1}}";
export const SPLIT_PLACEHOLDER_PART_2 = "{{id_blok_bagian_2}}";

/** Row 51: the split rule, as stated in the skeleton (row 140: own off-page tier, one pair per node pair, parts checked). */
export const CAPACITY_SPLIT_RULE =
  "simpul diurutkan menurut sumbu keluarga (graph: class.col; flow ber-direction: peringkat; swimlane: fase, tanpa fase kolam, tanpa keduanya urutan simpul; " +
  "keluarga lain: class.tier bila ada, selain itu urutan simpul); potongan diletakkan di batas nilai sumbu yang paling dekat ke separuh jumlah simpul " +
  "dan tidak memisahkan anggota satu zona; tiap pasang simpul yang dihubungkan melintasi potongan diganti sepasang simpul offpage dengan ref.key yang sama " +
  "(beberapa konektor antara dua simpul yang sama memakai satu pasang, label tiap konektor tetap); pada layered, topology dan stack simpul offpage " +
  "berada di tingkat sendiri di tepi potongan; kerangka hanya ditawarkan bila kedua bagian lolos pemeriksaan kapasitas pada lebar yang dipakai";

/**
 * Swarm 1.3.3 row 140 (ST-4, E6 of row 36): the most parts a skeleton offers. The spec of ST-4 names "dua spec" and the
 * acceptance of ST-1 reads "paling banyak dua lembar"; a figure that two parts cannot hold is not cut into three.
 */
export const CAPACITY_SPLIT_MAX_PARTS = 2;

/** Row 140: families placed by `layoutLayered` (contract/dispatch DIAGRAM_LAYOUTS), where a tier is one row of the sheet. */
const OWN_TIER_FAMILIES = new Set(["layered", "topology", "stack"]);

/** Row 140: block ids the part check writes in place of the placeholders (PID_PATTERN ids; the agent writes its own). */
const PART_CHECK_IDS = ["blok-bagian-1", "blok-bagian-2"] as const;

/** Row 140: > 0 while a part is being built: a refusal of the part does not compute a skeleton of its own. */
let partCheckDepth = 0;

type SplitNode = StudioDiagramV1["nodes"][number];
type SplitEdge = NonNullable<StudioDiagramV1["edges"]>[number];

export interface DiagramSplitPair {
  /** `ref.key` of both off-page nodes. */
  key: string;
  /** The first cut connector's ends (row 140: the pair stands for every connector between these two nodes). */
  from: string;
  to: string;
  /** Ids of the off-page nodes: in part 1, in part 2. */
  offpage: [string, string];
  /**
   * Row 140: every original connector carried by this pair, in spec order. Each keeps its own half in both parts
   * (kind, label, arrows verbatim), both ending on the pair's one off-page node; the labels are listed here.
   */
  connectors: Array<{ from: string; to: string; label?: string }>;
}

export interface DiagramSplitSkeleton {
  rule: string;
  /** Axis the nodes were ordered by ("class.col", "class.tier", "peringkat", "fase", "kolam", "urutan simpul"). */
  axis: string;
  /** The texts to replace: [in part 2's off-page nodes = id of block 1, in part 1's off-page nodes = id of block 2]. */
  placeholders: [string, string];
  pairs: DiagramSplitPair[];
  /** Two specs holding every original node once and every original connector (cut ones as two halves). */
  specs: [StudioDiagramV1, StudioDiagramV1];
}

/** Row 51: details of a diagram capacity refusal; `split` is absent when width `full` is the advice or no clean cut exists. */
export type DiagramOverCapacityDetails = FigureOverCapacityDetails & { split?: DiagramSplitSkeleton };

/** Row 51: the message offers width `full` (row 34 texts): then the advice is the width, not a split. */
function fullWidthAdvised(suggestion: string): boolean {
  return suggestion.includes(`width "full" (width_mm`) || suggestion.includes(`pakai ${FIGURE_FULL_WIDTH_MM} mm`);
}

function withSplitSkeleton(over: DiagramOverCapacity, s: StudioDiagramV1): DiagramOverCapacity {
  const details = over.details as DiagramOverCapacityDetails;
  if (partCheckDepth > 0 || details.split || fullWidthAdvised(String(details.suggestion ?? ""))) return over;
  const plan = splitPlanOf(s);
  if (plan.split) {
    details.split = plan.split;
    return over;
  }
  if (!plan.unfit) return over;
  // Row 140: no cut gives two parts that pass. The refusal says so in its suggestion; it is rebuilt so that the message
  // (which carries the suggestion) and the details say the same. Code, class, checkId and measures are unchanged.
  const at = over.message.indexOf("; batas:");
  const { figure: _figure, ...rest } = details;
  return new DiagramOverCapacity(at >= 0 ? over.message.slice(0, at) : over.message, { ...rest, suggestion: `${details.suggestion}; ${plan.unfit}` });
}

const classOf = (n: SplitNode): Record<string, unknown> => (n.class ?? {}) as Record<string, unknown>;

function splitAxis(s: StudioDiagramV1): { name: string; of: (n: SplitNode, i: number) => number } {
  const fam = String(s.family);
  const byOrder = { name: "urutan simpul", of: (_: SplitNode, i: number) => i };
  if (fam === "graph") return { name: "class.col", of: (n) => Number(classOf(n).col ?? 0) };
  if (fam === "flow") {
    if (!flowDirectionOf(s)) return byOrder;
    const rank = new Map(flowRanks(s).ranks.flatMap((g, r) => g.map((n) => [n.id, r] as const)));
    return { name: "peringkat", of: (n) => rank.get(n.id) ?? 0 };
  }
  if (fam === "swimlane") {
    const band = (list: readonly { id: string }[] | undefined, key: "phase" | "pool", name: string) => {
      const ids = (list ?? []).map((c) => String(c.id));
      return ids.length ? { name, of: (n: SplitNode) => Math.max(0, ids.indexOf(String(classOf(n)[key]))) } : null;
    };
    return band(s.phases, "phase", "fase") ?? band(s.pools, "pool", "kolam") ?? byOrder;
  }
  if ((s.nodes ?? []).some((n) => Number.isFinite(Number(classOf(n).tier ?? NaN)))) return { name: "class.tier", of: (n) => Number(classOf(n).tier ?? 0) };
  return byOrder;
}

/**
 * Swarm 1.3.3 row 51 (ST-4): two specs that together hold `s`, cut by CAPACITY_SPLIT_RULE, or null when no cut keeps
 * every zone whole, a part would pass the node / connector bounds, or (row 140) no cut gives two parts that both pass
 * the build's capacity check at the width in use. Node ids, labels and classes are verbatim; root fields are copied to
 * both parts (title and id included: the agent tells them apart).
 */
export function splitSkeletonOf(s: StudioDiagramV1): DiagramSplitSkeleton | null {
  return splitPlanOf(s).split ?? null;
}

/**
 * Row 140: the skeleton of the first cut (in CAPACITY_SPLIT_RULE order) whose two parts both build, or, when none does,
 * the text that says which part of the preferred cut is still refused and by which limit (`unfit`). Neither when no
 * cut exists at all (the refusal then stands as before row 51).
 */
function splitPlanOf(s: StudioDiagramV1): { split?: DiagramSplitSkeleton; unfit?: string } {
  const all = s.nodes ?? [];
  if (all.length < 2) return {};
  const axis = splitAxis(s);
  const sorted = all.map((n, i) => ({ id: n.id, v: axis.of(n, i), i })).sort((a, b) => a.v - b.v || a.i - b.i);
  const zones = (s.zones ?? []).map((z) => new Set(z.members ?? []));
  const cuts = sorted
    .map((_, k) => k)
    .filter((k) => k > 0 && sorted[k - 1].v !== sorted[k].v)
    .filter((k) => {
      const first = new Set(sorted.slice(0, k).map((n) => n.id));
      return zones.every((z) => {
        const sides = new Set(sorted.filter((n) => z.has(n.id)).map((n) => first.has(n.id)));
        return sides.size < 2;
      });
    })
    .sort((a, b) => Math.abs(a - all.length / 2) - Math.abs(b - all.length / 2) || a - b);
  // The part check speaks for capacity only when the original passes the spec checks the build runs before placing
  // (every real capacity refusal comes after them). An original that fails them is refused for that reason anyway; it
  // gets the first cut unchecked, as in row 51.
  const checked = !validateSpec(s, { release: false }).some((i) => i.status === "FAIL");
  let unfit: string | undefined;
  for (const k of cuts) {
    const split = skeletonAt(s, axis.name, new Set(sorted.slice(0, k).map((n) => n.id)));
    if (!split) continue;
    if (!checked) return { split };
    const refusals = split.specs.map(partRefusal);
    if (refusals.every((e) => e === null)) return { split };
    unfit ??= unfitText(split, refusals);
  }
  return unfit ? { unfit } : {};
}

/** Row 140: the build's own refusal of one part (placeholders filled with valid ids), or null when the part builds. */
function partRefusal(part: StudioDiagramV1): unknown {
  const filled = JSON.parse(JSON.stringify(part).replaceAll(SPLIT_PLACEHOLDER_PART_1, PART_CHECK_IDS[0]).replaceAll(SPLIT_PLACEHOLDER_PART_2, PART_CHECK_IDS[1])) as StudioDiagramV1;
  partCheckDepth++;
  try {
    // the same build every capacity refusal comes from (build/index.ts, contract DIAGRAM_LAYOUTS), draft gate
    buildDiagramSvgRaw(filled, { release: false });
    return null;
  } catch (e) {
    return e;
  } finally {
    partCheckDepth--;
  }
}

/** Row 140: "part N is still refused by <check>: <limit>" for the parts of one cut, as one sentence for the suggestion. */
function unfitText(k: DiagramSplitSkeleton, refusals: unknown[]): string {
  const parts = refusals.flatMap((e, i) => (e === null ? [] : [`bagian ${i + 1} (${k.specs[i].nodes.length} simpul) tetap ditolak ${limitOf(e)}`]));
  return (
    `kerangka pecahan tidak ditawarkan: pada potongan terbaik (sumbu ${k.axis}) ${parts.join("; ")}; ` +
    `paling banyak ${CAPACITY_SPLIT_MAX_PARTS} bagian, jadi bagian itu harus dipersingkat atau ditipiskan lebih dulu`
  );
}

function limitOf(e: unknown): string {
  const id = checkIdOf(e) || String((e as { code?: unknown } | null)?.code ?? "galat");
  const d = (e as { details?: Partial<FigureOverCapacityDetails> } | null)?.details;
  if (d && typeof d.quantity === "string" && typeof d.limit === "number" && typeof d.measured === "number") {
    return `${id}: ${d.quantity} maks ${d.limit} ${d.unit}, terukur ${d.measured} ${d.unit}`;
  }
  const msg = String((e as { message?: unknown } | null)?.message ?? e).split("; batas:")[0].split("; saran:")[0].slice(0, 200);
  // most engine messages already open with their check id
  return msg.includes(id) ? msg : `${id}: ${msg}`;
}

/**
 * Row 51 split at one cut (`first` = ids of part 1), with row 140's placement and pairing. An off-page node of a tiered
 * family (OWN_TIER_FAMILIES, axis class.tier) sits on a tier of its own at the cut edge: in part 1 one past its last
 * tier, listed after its nodes (the layered layout orders tiers by first appearance); in part 2 one before its first
 * tier, listed before its nodes. Other families keep row 51's place: the place fields of the node it hangs on (graph:
 * the next free row of that column, so no graph column is added; swimlane: same lane and phase; flow: rank from the
 * connectors). Null when a part passes the node / connector bounds.
 */
function skeletonAt(s: StudioDiagramV1, axisName: string, first: ReadonlySet<string>): DiagramSplitSkeleton | null {
  const all = s.nodes ?? [];
  const taken = new Set(all.map((n) => n.id));
  const byId = new Map(all.map((n) => [n.id, n] as const));
  const parts = [0, 1].map((p) => ({
    nodes: structuredClone(all.filter((n) => first.has(n.id) === (p === 0))) as SplitNode[],
    lead: [] as SplitNode[],
    edges: [] as SplitEdge[],
  }));
  const ownTier = OWN_TIER_FAMILIES.has(String(s.family)) && axisName === "class.tier";
  // read as the axis reads it (splitAxis: a node without class.tier is tier 0), so each part has at least one value
  const tiers = parts.map((p) => p.nodes.map((n) => Number(classOf(n).tier ?? 0)).filter(Number.isFinite));
  const edgeTier = [Math.max(...tiers[0]) + 1, Math.min(...tiers[1]) - 1];
  const pairs: DiagramSplitPair[] = [];
  const byNodes = new Map<string, DiagramSplitPair>();
  const offpageNode = (p: number, id: string, key: string, near: SplitNode): void => {
    const ref = { figure: p === 0 ? SPLIT_PLACEHOLDER_PART_2 : SPLIT_PLACEHOLDER_PART_1, key };
    if (ownTier) {
      const node = { id, label: key, shape: "offpage", class: { tier: edgeTier[p] }, ref } as SplitNode;
      if (p === 0) parts[p].nodes.push(node);
      else parts[p].lead.push(node);
      return;
    }
    const c = classOf(near);
    const place = Object.fromEntries(["tier", "lane", "col", "row", "phase", "pool"].filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));
    if (String(s.family) === "graph") {
      const used = new Set(parts[p].nodes.map((n) => `${classOf(n).col ?? 0}:${classOf(n).row ?? 0}`));
      let row = Number(place.row ?? 0);
      while (used.has(`${place.col ?? 0}:${row}`)) row++;
      place.row = row;
    }
    parts[p].nodes.push({ id, label: key, shape: "offpage", class: place, ref } as SplitNode);
  };
  for (const e of s.edges ?? []) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    const pa = first.has(e.from) ? 0 : 1;
    const pb = first.has(e.to) ? 0 : 1;
    if (!a || !b || pa === pb) {
      // an edge naming an unknown node stays with the part of its known end (the build refuses it as before)
      parts[a ? pa : pb].edges.push(structuredClone(e));
      continue;
    }
    // row 140: one pair per pair of nodes joined across the cut, whatever the direction of the connector
    const [end1, end2] = pa === 0 ? [a, b] : [b, a];
    const nodesKey = JSON.stringify([end1.id, end2.id]);
    let pair = byNodes.get(nodesKey);
    if (!pair) {
      const key = `S${pairs.length + 1}`;
      // one id for both ends of the pair, not in use by any node of the original
      let id = `offpage-${key}`;
      while (taken.has(id)) id += "x";
      taken.add(id);
      offpageNode(0, id, key, end1); // stands for end2 in part 1
      offpageNode(1, id, key, end2); // stands for end1 in part 2
      pair = { key, from: e.from, to: e.to, offpage: [id, id], connectors: [] };
      pairs.push(pair);
      byNodes.set(nodesKey, pair);
    }
    pair.connectors.push({ from: e.from, to: e.to, ...(e.label !== undefined ? { label: e.label } : {}) });
    // `via` bend points belong to the undivided layout; the rest of the connector is kept on both halves
    const half = (): SplitEdge => {
      const c = structuredClone(e);
      delete c.via;
      return c;
    };
    parts[pa].edges.push({ ...half(), to: pair.offpage[0] });
    parts[pb].edges.push({ ...half(), from: pair.offpage[0] });
  }
  const nodesOf = parts.map((p) => [...p.lead, ...p.nodes]);
  if (parts.some((p, i) => nodesOf[i].length > FIGURE_BOUNDS.diagramNodes || p.edges.length > FIGURE_BOUNDS.diagramEdges)) return null;
  const specs = parts.map((p, i) => {
    const nodes = nodesOf[i];
    const ids = new Set(nodes.map((n) => n.id));
    // row 140: tier labels, phases and pools follow the original nodes; an own off-page tier gets no label of the original
    const usedClass = (k: string) => new Set(p.nodes.filter((n) => byId.has(n.id)).map((n) => classOf(n)[k]).filter((v) => v !== undefined).map(String));
    const out = structuredClone(s) as StudioDiagramV1;
    delete out.keyRowOnPage; // internal compose signal, not an agent field
    out.nodes = nodes;
    if (s.edges) out.edges = p.edges;
    if (s.zones) out.zones = structuredClone(s.zones).map((z) => ({ ...z, members: z.members.filter((m) => ids.has(m)) })).filter((z) => z.members.length > 0);
    if (s.phases) out.phases = structuredClone(s.phases).filter((c) => usedClass("phase").has(String(c.id)));
    if (s.pools) out.pools = structuredClone(s.pools).filter((c) => usedClass("pool").has(String(c.id)));
    if (s.tiers) out.tiers = structuredClone(s.tiers).filter((t) => usedClass("tier").has(String(t.tier)));
    return out;
  }) as [StudioDiagramV1, StudioDiagramV1];
  return { rule: CAPACITY_SPLIT_RULE, axis: axisName, placeholders: [SPLIT_PLACEHOLDER_PART_1, SPLIT_PLACEHOLDER_PART_2], pairs, specs };
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
      // Swarm 1.2.7 row 35b (N-7): the remainder counts the T-03 defects too (autoFitRestText).
      detail: `render pertama ditolak ${checkIdOf(original)}; tata letak kapasitas -> ${autoFitRestText(best.g).rest}; dicoba: ${tried.join("; ")}`,
      suggest: autoFitRestText(best.g).suggest,
    },
    ...best.state.notes.map((n) => ({ checkId: n.checkId, status: "REPORT" as const, detail: n.suggest ? `${n.detail}; saran: ${n.suggest}` : n.detail, suggest: n.suggest ?? "tidak ada" })),
    ...diagramGeometryIssues(best.g),
  ];
  return { ...best.res, report: { ...best.res.report, geometry } };
}
