/**
 * SEC-FIX / SEC-FIX2 (D-501, D-505, D-506): batas kapasitas figur SEBELUM render, dipakai rute pratinjau, render
 * dokumen penuh (`services/render/figures.ts` `buildFigures`), dan render artefak mandiri R09
 * (`services/render/artifact.ts`), sehingga figur tersimpan sebelum batas ada dan artefak v1 juga terbatas.
 *
 * Mesin chart/diagram berjalan sinkron di event loop proses HQ; biayanya tumbuh super-linear menurut jumlah butir
 * (probe peninjau: P-02 5000 kategori = 21,7 s; diagram 5000 zona = 9,1 s, 10000 zona = heap habis). Nilai batas
 * = `FIGURE_BOUNDS` kontrak (satu sumber dengan `maxItems` skema v1/v2), dipilih dari kapasitas mesin terukur
 * (laporan `delegation_progress/coder_execution_secfix.md`, `coder_execution_secfix2.md`).
 *
 * Cek di sini memeriksa ulang spec TERSELESAIKAN (figur tersimpan sebelum batas ada, rujukan `artifactId`, spec
 * artefak v1) per larik yang dikenal, ditambah batas yang tidak dapat dinyatakan skema: sel matriks dari isi
 * `values`, total nilai distribusi, total butir panel komposit, total anggota zona, serta batas generik untuk SETIAP
 * larik (fallback per larik, total elemen, kedalaman), panjang string, dan ukuran serial spec/blok.
 */
import { CHART_INTENT_LIMITS } from "../../contract/enums";
import { StudioEngineError } from "../../contract/errors";
import { FIGURE_BOUNDS } from "../../contract/schema/figure-bounds";

export const FIGURE_LIMITS = { ...FIGURE_BOUNDS, labelShort: CHART_INTENT_LIMITS.labelShortItemsMax, depth: 32 } as const;

export interface CapacityIssue {
  pointer: string;
  keyword: "maxItems" | "maxLength" | "maxBytes" | "maxDepth";
  limit: number;
  actual: number;
  message: string;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const L = FIGURE_LIMITS;

class Counter {
  readonly issues: CapacityIssue[] = [];
  labelItems = 0;

  check(pointer: string, actual: number, limit: number, what: string, keyword: CapacityIssue["keyword"] = "maxItems"): void {
    if (actual > limit) this.issues.push({ pointer, keyword, limit, actual, message: `${what}: ${actual} > batas ${limit}` });
  }

  /** Larik berlabel: dihitung ke total panel komposit. */
  items(pointer: string, v: unknown, what: string, limit: number = L.items): void {
    this.labelItems += len(v);
    this.check(pointer, len(v), limit, what);
  }
}

/** Ukuran UTF-8 serial JSON tanpa `Buffer` (modul juga dimuat di luar Node murni). */
function jsonBytes(v: unknown): number {
  let s: string;
  try {
    s = JSON.stringify(v) ?? "";
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) n += c > 0x7ff && (c < 0xd800 || c > 0xdfff) ? 2 : 1;
  }
  return n;
}

/**
 * Batas generik untuk SETIAP larik/string spec (iteratif, tanpa rekursi): fallback per larik, `params` chart v1
 * (butir/kunci), panjang string, total elemen, kedalaman. Metadata `x` (objek) dilewati: mesin mengabaikannya dan
 * ukurannya sudah dihitung batas byte.
 */
function genericInto(c: Counter, spec: unknown, at: string): void {
  const stack: Array<{ v: unknown; p: string; d: number; params: boolean }> = [{ v: spec, p: at, d: 0, params: false }];
  let total = 0;
  let deep = false;
  while (stack.length > 0) {
    const { v, p, d, params } = stack.pop()!;
    if (d > L.depth) {
      if (!deep) c.check(p, d, L.depth, "kedalaman spec", "maxDepth");
      deep = true;
      continue;
    }
    if (typeof v === "string") {
      c.check(p, v.length, L.stringChars, "panjang string", "maxLength");
    } else if (Array.isArray(v)) {
      total += v.length;
      c.check(p, v.length, params ? L.paramItems : L.anyArray, params ? "butir larik params" : "butir larik");
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], p: `${p}/${i}`, d: d + 1, params });
    } else if (isRec(v)) {
      const keys = Object.keys(v);
      if (params) c.check(p, keys.length, L.paramProperties, "kunci params");
      for (const k of keys) {
        if (k === "x" && isRec(v[k])) continue;
        stack.push({ v: v[k], p: `${p}/${k}`, d: d + 1, params: params || k === "params" });
      }
    }
  }
  c.check(at || "/", total, L.totalElements, "total elemen larik");
}

function diagramInto(c: Counter, spec: unknown, at: string): void {
  if (!isRec(spec)) return;
  c.check(`${at}/nodes`, len(spec.nodes), L.diagramNodes, "simpul diagram");
  c.check(`${at}/edges`, len(spec.edges), L.diagramEdges, "tepi diagram");
  c.check(`${at}/zones`, len(spec.zones), L.diagramZones, "zona diagram");
  let members = 0;
  list(spec.zones).forEach((z, i) => {
    const n = isRec(z) ? len(z.members) : 0;
    members += n;
    c.check(`${at}/zones/${i}/members`, n, L.zoneMembers, "anggota zona");
  });
  c.check(`${at}/zones`, members, L.zoneMembersTotal, "total anggota zona");
  c.check(`${at}/legend`, len(spec.legend), L.diagramLegend, "butir legenda");
  c.check(`${at}/notes`, len(spec.notes), L.diagramNotes, "butir catatan");
  c.check(`${at}/sources`, len(spec.sources), L.diagramSources, "butir sumber");
  // Spec lama: `source` boleh larik (mesin menormalkannya menjadi `sources`, engine/diagram/core/spec.ts).
  c.check(`${at}/source`, len(spec.source), L.diagramSources, "butir sumber");
  diagramTextInto(c, spec, at);
}

const strLen = (v: unknown): number => (typeof v === "string" ? v.length : 0);

/**
 * SEC-FIX2: teks yang masuk loop tata letak mesin diagram (pembungkusan label simpul, judul, sumber) berbiaya
 * super-linear menurut panjangnya (laporan secfix2: label simpul 1000 karakter 0,4-3,1 s; judul/sumber graph
 * 2000 karakter 1,5 s). Batas = `maxLength` skema diagram v1, juga untuk spec terkomposisi dari blok v2 (judul dari
 * caption, sumber dari teks sumber) dan spec tersimpan.
 */
function diagramTextInto(c: Counter, spec: Rec, at: string): void {
  const T = L.diagramText;
  c.check(`${at}/title`, strLen(spec.title), T.title, "panjang judul diagram", "maxLength");
  if (typeof spec.source === "string") c.check(`${at}/source`, spec.source.length, T.source, "panjang sumber diagram", "maxLength");
  list(spec.sources).forEach((s, i) => c.check(`${at}/sources/${i}`, strLen(s), T.source, "panjang sumber diagram", "maxLength"));
  const srcTotal = (Array.isArray(spec.sources) ? spec.sources : Array.isArray(spec.source) ? spec.source : []).reduce((n: number, s) => n + strLen(s), 0);
  c.check(`${at}/sources`, srcTotal, T.sourcesTotal, "total karakter sumber diagram", "maxLength");
  list(spec.source).forEach((s, i) => c.check(`${at}/source/${i}`, strLen(s), T.source, "panjang sumber diagram", "maxLength"));
  list(spec.nodes).forEach((n, i) => {
    if (!isRec(n)) return;
    c.check(`${at}/nodes/${i}/label`, strLen(n.label), T.label, "panjang label simpul", "maxLength");
    c.check(`${at}/nodes/${i}/sub`, strLen(n.sub), T.label, "panjang sub simpul", "maxLength");
  });
  list(spec.edges).forEach((e, i) => c.check(`${at}/edges/${i}/label`, isRec(e) ? strLen(e.label) : 0, T.label, "panjang label tepi", "maxLength"));
  list(spec.zones).forEach((z, i) => c.check(`${at}/zones/${i}/label`, isRec(z) ? strLen(z.label) : 0, T.label, "panjang label zona", "maxLength"));
  list(spec.legend).forEach((s, i) => c.check(`${at}/legend/${i}`, strLen(s), T.item, "panjang butir legenda", "maxLength"));
  list(spec.notes).forEach((s, i) => c.check(`${at}/notes/${i}`, strLen(s), T.item, "panjang butir catatan", "maxLength"));
}

/** Setiap string di `data` chart (bukan `steps`: teks diagram punya batas sendiri) <= `chartDataChars`. */
function chartDataStringsInto(c: Counter, data: Rec, at: string): void {
  const stack: Array<{ v: unknown; p: string; d: number }> = [{ v: data, p: at, d: 0 }];
  while (stack.length > 0) {
    const { v, p, d } = stack.pop()!;
    if (typeof v === "string") c.check(p, v.length, L.chartDataChars, "panjang teks data chart", "maxLength");
    else if (d > L.depth) continue;
    else if (Array.isArray(v)) v.forEach((x, i) => stack.push({ v: x, p: `${p}/${i}`, d: d + 1 }));
    else if (isRec(v)) for (const k of Object.keys(v)) stack.push({ v: v[k], p: `${p}/${k}`, d: d + 1 });
  }
}

function chartDataInto(c: Counter, data: unknown, at: string): void {
  if (!isRec(data)) return;
  if (data.shape !== "steps") chartDataStringsInto(c, data, at);
  switch (data.shape) {
    case "categorical":
      c.items(`${at}/points`, data.points, "kategori");
      break;
    case "series": {
      c.items(`${at}/categories`, data.categories, "kategori");
      c.check(`${at}/series`, len(data.series), L.series, "seri");
      list(data.series).forEach((s, i) => c.check(`${at}/series/${i}/values`, isRec(s) ? len(s.values) : 0, L.items, "nilai seri"));
      break;
    }
    case "xy":
      c.check(`${at}/points`, len(data.points), L.xyPoints, "titik xy");
      break;
    case "matrix": {
      c.items(`${at}/rows`, data.rows, "baris matriks");
      c.items(`${at}/cols`, data.cols, "kolom matriks");
      c.check(`${at}/values`, len(data.values), L.items, "baris values matriks");
      // SEC-FIX2 N-3: sel dihitung dari isi `values` (yang dibaca mesin), bukan hanya `rows` x `cols` yang dideklarasikan.
      let cells = 0;
      list(data.values).forEach((r, i) => {
        cells += len(r);
        c.check(`${at}/values/${i}`, len(r), L.items, "kolom values matriks");
      });
      c.check(`${at}/values`, Math.max(cells, len(data.rows) * len(data.cols)), L.matrixCells, "sel matriks (isi values / baris x kolom)");
      break;
    }
    case "intervals":
    case "ohlc":
      c.items(`${at}/${data.shape === "ohlc" ? "points" : "items"}`, data.shape === "ohlc" ? data.points : data.items, "butir");
      break;
    case "graph":
      c.items(`${at}/nodes`, data.nodes, "simpul", L.graphNodes);
      c.check(`${at}/links`, len(data.links), L.graphLinks, "tautan");
      break;
    case "distribution": {
      const groups = list(data.groups);
      c.items(`${at}/groups`, groups, "grup distribusi", L.distributionGroups);
      let total = 0;
      groups.forEach((g, i) => {
        const n = isRec(g) ? len(g.values) : 0;
        total += n;
        c.check(`${at}/groups/${i}/values`, n, L.distributionValues, "nilai grup");
      });
      c.check(`${at}/groups`, total, L.distributionTotal, "total nilai distribusi");
      c.check(`${at}/binEdges`, len(data.binEdges), L.binEdges, "tepi bin");
      break;
    }
    case "tiles":
      c.items(`${at}/tiles`, data.tiles, "petak");
      c.check(`${at}/flows`, len(data.flows), L.tileFlows, "aliran");
      c.check(`${at}/dots`, len(data.dots), L.tileDots, "titik petak");
      break;
    case "sets":
      c.items(`${at}/sets`, data.sets, "himpunan", L.sets);
      c.check(`${at}/overlaps`, len(data.overlaps), L.setOverlaps, "irisan");
      list(data.overlaps).forEach((o, i) => c.check(`${at}/overlaps/${i}/sets`, isRec(o) ? len(o.sets) : 0, L.sets, "himpunan per irisan"));
      break;
    case "steps":
      diagramInto(c, data.spec, `${at}/spec`);
      break;
    default:
      break;
  }
}

/**
 * SEC-FIX3 N-4 (D-508): P-15 tanpa `data` membaca `params.tableRows` x `params.tableHead` sebagai matriks
 * (`engine/chart/family-p2/table.ts`), dengan biaya mesin yang sama dengan `data.matrix`; batasnya pun sama: baris
 * <= `items`, sel (baris x maks(kolom kepala, isi baris terlebar)) <= `matrixCells`. Petunjuk params lain berbentuk
 * larik datar (<= `paramItems`) atau kisi yang dibatasi mesin (K-07/K-08 <= 40x40, P-12 <= 6x6).
 */
function tableParamsInto(c: Counter, params: unknown, at: string): void {
  if (!isRec(params) || !Array.isArray(params.tableRows)) return;
  const rows = params.tableRows;
  let widest = len(params.tableHead);
  rows.forEach((r, i) => {
    widest = Math.max(widest, len(r));
    c.check(`${at}/tableRows/${i}`, len(r), L.items, "kolom tableRows");
  });
  c.check(`${at}/tableRows`, rows.length, L.items, "baris tableRows");
  c.check(`${at}/tableRows`, rows.length * widest, L.matrixCells, "sel tabel (baris tableRows x kolom)");
}

/** Batas byte satu spec/blok figur; [] bila di bawah batas. */
export function figureBytesIssues(value: unknown, pointer = "/"): CapacityIssue[] {
  const c = new Counter();
  c.check(pointer, jsonBytes(value), L.figureBytes, "ukuran serial figur (byte)", "maxBytes");
  return c.issues;
}

/** Pelanggaran batas spec chart v1 terselesaikan (`data`, atau `composite.panels[].spec.data`); [] = boleh dirender. */
export function chartCapacityIssues(spec: unknown): CapacityIssue[] {
  const bytes = figureBytesIssues(spec);
  if (bytes.length > 0) return bytes;
  const c = new Counter();
  if (!isRec(spec)) return c.issues;
  chartDataInto(c, spec.data, "/data");
  tableParamsInto(c, spec.params, "/params");
  if (isRec(spec.intent)) c.check("/intent/labelShort", len(spec.intent.labelShort), L.labelShort, "labelShort");
  const panels = isRec(spec.composite) ? list(spec.composite.panels) : [];
  c.check("/composite/panels", panels.length, L.panels, "panel komposit");
  panels.forEach((p, i) => {
    const ps = isRec(p) && isRec(p.spec) ? p.spec : undefined;
    chartDataInto(c, ps?.data, `/composite/panels/${i}/spec/data`);
    tableParamsInto(c, ps?.params, `/composite/panels/${i}/spec/params`);
  });
  if (panels.length > 0) c.check("/composite/panels", c.labelItems, L.panelItemsTotal, "total butir semua panel");
  genericInto(c, spec, "");
  return c.issues;
}

/** Pelanggaran batas spec diagram v1 terselesaikan; [] = boleh dirender. */
export function diagramCapacityIssues(spec: unknown): CapacityIssue[] {
  const bytes = figureBytesIssues(spec);
  if (bytes.length > 0) return bytes;
  const c = new Counter();
  diagramInto(c, spec, "");
  genericInto(c, spec, "");
  return c.issues;
}

/** Pelanggaran batas spec menurut jenis figur (artefak R09 / blok dokumen). */
export function figureCapacityIssuesFor(type: "chart" | "diagram", spec: unknown): CapacityIssue[] {
  return type === "chart" ? chartCapacityIssues(spec) : diagramCapacityIssues(spec);
}

/** Pesan aksi konkret (teks milik Studio) untuk 422 `FIGURE_CAPACITY`. */
export function capacityMessage(type: "chart" | "diagram", issues: readonly CapacityIssue[]): string {
  const first = issues.slice(0, 3).map((i) => `${i.pointer} ${i.message}`).join("; ");
  const action =
    type === "chart"
      ? "kurangi butir data (kategori: kirim topN + otherLabel, atau agregasikan), atau pecah menjadi beberapa gambar"
      : "kurangi simpul/tepi/zona/legenda/catatan/sumber atau pecah menjadi 2 diagram";
  return `Figur terlalu besar untuk dirender (${first}); ${action}`;
}

/**
 * Lempar 422 `BY_CONSTRUCTION_FAILED` (`details.checkId = "FIGURE_CAPACITY"`, `issues`) bila spec melampaui batas.
 * Dipakai render dokumen (`buildFigures`) dan render artefak R09 SEBELUM mesin dipanggil.
 */
export function assertFigureCapacity(type: "chart" | "diagram", spec: unknown, extra: readonly CapacityIssue[] = []): void {
  const issues = [...extra, ...figureCapacityIssuesFor(type, spec)];
  if (issues.length > 0) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", capacityMessage(type, issues), { checkId: "FIGURE_CAPACITY", issues });
  }
}
