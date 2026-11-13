/**
 * Baca dan validasi diagram-spec (port `datum_diagram.py:250-387`).
 *
 * - `loadSpec`: tolak Mermaid (DATUM-31, 422), parse JSON, cerminkan
 *   `source`/`sources`.
 * - `validateSpec`: SEMUA cek kontrak P1 + cek tahap-build P8 yang bisa diputus
 *   dari spek saja, dengan id cek identik dengan daftar `ran` Python. Satu entri
 *   PASS per cek yang lolos; satu entri FAIL per pelanggaran (pesan = teks Python).
 *   Urutan entri = urutan eksekusi Python, sehingga FAIL pertama = cacat yang
 *   dilempar Python.
 * - `assertValidSpec`: perilaku Python persis (lempar `DiagramDefect` pada FAIL
 *   pertama, kembalikan daftar `ran`), dipakai build (S30) dan `estimate`.
 */
import type { DiagramEdgeKind, LintIssue, ProvenanceMark, StudioDiagramV1 } from "../../../contract";
import {
  DIAGRAM_ARROW_SIZES,
  DIAGRAM_ARROW_TYPES,
  DIAGRAM_EDGE_DASHES,
  DIAGRAM_EDGE_ROUTES,
  DIAGRAM_EDGE_SIDES,
  DIAGRAM_EDGE_WEIGHTS,
  DIAGRAM_EVENT_TYPES,
  DIAGRAM_JUMPS,
  DIAGRAM_LABEL_AT,
  DIAGRAM_LANE_ORIENTATIONS,
} from "../../../contract/enums";
import { DiagramDefect } from "./defect";
import { type DiagramGrid, resolveDiagramGrid, widthLabel } from "./grid";
import { pyRepr, pyReprFloat, pyStr } from "./pyfmt";
import {
  EDGE_KINDS,
  EDGE_KIND_NAMES_SORTED,
  FAMILIES,
  FAMILY_NAMES_SORTED,
  LIMITS,
  MARKS,
  MARK_NAMES_SORTED,
  SHAPES,
  SHAPE_NAMES_SORTED,
} from "./tokens";

/**
 * Penanda teks Mermaid (P7, `datum_diagram.py:251`). Daftar ini kini hanya
 * label pesan/dokumentasi; pencocokan memakai `MERMAID_FENCE` dan
 * `MERMAID_HEADER_LINE` (IP-39b, S84 #6, menantang D-50).
 */
export const MERMAID_TELL = [
  "```mermaid",
  "graph TD",
  "graph LR",
  "flowchart TD",
  "flowchart LR",
  "sequenceDiagram",
  "stateDiagram",
] as const;

/** Pagar blok kode Mermaid (```mermaid / ~~~mermaid), di mana pun, tanpa beda huruf. */
export const MERMAID_FENCE = /(?:```|~~~)[ \t]*mermaid\b/i;

/**
 * Baris kepala diagram Mermaid NYATA: di awal baris (boleh diawali spasi),
 * kata kunci kepala lalu arah, dan baris itu tidak memuat teks lain kecuali
 * pernyataan Mermaid setelah ";" (bentuk satu baris `graph TD; A-->B`).
 * Tanpa beda huruf (niat D-50 dipertahankan), tetapi terikat posisi + batas kata.
 * Positif: "graph TD", "  flowchart LR", "graph TD; A-->B", "sequenceDiagram",
 * "stateDiagram-v2". Negatif: "Alur data paragraph TD-3.", "graph TD-3 rev",
 * "Diagram sequenceDiagram lama", "Telegraph LR".
 */
export const MERMAID_HEADER_LINE =
  /^[ \t]*(?:(?:graph|flowchart)[ \t]+(?:TD|TB|BT|LR|RL)|sequenceDiagram|stateDiagram(?:-v2)?)[ \t]*(?:;.*)?$/im;

/** Penanda Mermaid yang cocok pada satu teks, atau null. */
export function mermaidTellOf(text: string): string | null {
  const fence = MERMAID_FENCE.exec(text);
  if (fence) return fence[0];
  const head = MERMAID_HEADER_LINE.exec(text);
  return head ? head[0].trim() : null;
}

function* stringValues(v: unknown): Generator<string> {
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* stringValues(x);
  else if (isObj(v)) for (const x of Object.values(v)) yield* stringValues(x);
}

/** Urutan id cek validasi spek Garis A (`ran` dari validate_spec). */
export const SPEC_CHECK_IDS = [
  "P1-family",
  "P1-id",
  "P1-title",
  "P1-classification",
  "P1-width_mm",
  "P1-apparatus",
  "P1-sources",
  "P1-direction",
  "P1-nodes+P3-shapes",
  // Swarm 1.2.8 row 52c (01f §1.5, §2.2, §3.3, §3.6; N8-267..N8-271): run only when the spec carries the field.
  "P1-event_type",
  "P1-containers",
  "DATUM-35",
  "DATUM-24",
  "DATUM-26",
  "P1-edge-style",
  "P1-via",
  "P3-via-family",
  "DATUM-34",
  // Swarm 1.2.8 row 35c (H-T06, D-H1, N8-212): line-style budget; runs only above LINE_STYLE_MAX_WITH_MARK styles.
  "DATUM-25L",
  "P3-diamond-exits",
] as const;
export const RELEASE_CHECK_ID = "P1-labels_verified";

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function has(o: Json, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** `x or []` Python untuk medan larik. */
function listOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Python truthiness untuk nilai JSON. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return Object.keys(v).length > 0;
  return true;
}

/** `%r` Python atas nilai JSON (pesan cacat identik dengan Garis A). */
const reprish = pyRepr;

/** `float(x)` Python yang toleran (string angka diterima; selain itu NaN). */
function pyFloat(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return n;
  }
  return Number.NaN;
}

/** P1/Tabel 6.1 SOURCE: cerminkan `source` <-> `sources[]` (memutasi objek). */
export function mirrorSource<T extends Json>(spec: T): T {
  const s = spec as Json;
  if (has(s, "source") && !has(s, "sources")) {
    s.sources = Array.isArray(s.source) ? s.source : [s.source];
  } else if (has(s, "sources") && !has(s, "source")) {
    s.source = s.sources;
  }
  return spec;
}

export interface LoadSpecOptions {
  /** Nama berkas asal (ekstensi `.mmd`/`.mermaid` ditolak). */
  fileName?: string;
}

/**
 * Baca spek dari teks JSON, byte UTF-8, atau objek. Objek disalin dalam
 * (masukan pemanggil tidak dimutasi). Mermaid ditolak 422 `DATUM-31`.
 *
 * Aturan DATUM-31 (IP-39b, S84 #6; menggantikan substring D-50): Mermaid
 * terdeteksi bila (a) ada pagar ```mermaid/~~~mermaid, atau (b) ada BARIS yang
 * merupakan kepala diagram Mermaid (`MERMAID_HEADER_LINE`). Diperiksa pada teks
 * mentah (sebelum parse; menangkap sumber .mmd yang ditempel) dan pada setiap
 * nilai string spek hasil parse (baris di dalam label/judul berbaris ganda).
 * Kata biasa yang kebetulan berakhir "graph" (paragraph, telegraph) diikuti
 * TD/LR di tengah kalimat tidak lagi ditolak. Tanpa beda huruf seperti D-50
 * (Garis A hanya pernah mencocokkan "```mermaid").
 */
export function loadSpec(input: unknown, opts: LoadSpecOptions = {}): StudioDiagramV1 {
  const name = opts.fileName ?? "";
  const lowName = name.toLowerCase();
  if (lowName.endsWith(".mmd") || lowName.endsWith(".mermaid")) {
    throw new DiagramDefect(`DATUM-31: sumber Mermaid (${name}) dilarang dalam keluaran (P7)`, {
      checkId: "DATUM-31",
      code: "DATUM-31",
    });
  }
  let raw: string;
  if (typeof input === "string") raw = input;
  else if (input instanceof Uint8Array) raw = new TextDecoder("utf-8").decode(input);
  else if (isObj(input)) raw = JSON.stringify(input);
  else {
    throw new DiagramDefect("diagram-spec harus objek JSON", { code: "SCHEMA_INVALID" });
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const mermaid = (tell: string): DiagramDefect =>
    new DiagramDefect(
      `DATUM-31: sumber Mermaid terdeteksi ('${tell}') — gambar dibangun dari diagram-spec.json, bukan Mermaid (P7)`,
      { checkId: "DATUM-31", code: "DATUM-31" },
    );
  const rawTell = mermaidTellOf(raw);
  if (rawTell !== null) throw mermaid(rawTell);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (ex) {
    const msg = ex instanceof Error ? ex.message : String(ex);
    throw new DiagramDefect(`diagram-spec bukan JSON valid: ${msg}`, { code: "JSON_MALFORMED" });
  }
  if (!isObj(parsed)) {
    throw new DiagramDefect("diagram-spec harus objek JSON", { code: "SCHEMA_INVALID" });
  }
  for (const v of stringValues(parsed)) {
    const tell = mermaidTellOf(v);
    if (tell !== null) throw mermaid(tell);
  }
  return mirrorSource(parsed) as unknown as StudioDiagramV1;
}

export interface ValidateSpecOptions {
  /** Gerbang rilis: `labels_verified` wajib true (cek `P1-labels_verified`). */
  release?: boolean;
  /** D-245: grid turunan templat (lebar sah `P1-width_mm`); absen = A4 128/166. */
  grid?: DiagramGrid;
}

/** Swarm 1.2.6 row 45 (T-11, N-109): values of the ranked flow `direction` (schema enum, mirrored here). */
const DIRECTION_VALUES: ReadonlySet<unknown> = new Set(["TB", "LR"]);

/**
 * Swarm 1.2.6 row 45 (T-11, N-159, 01e §6.3-6.4): the `P1-direction` defect of a diagram spec, or null.
 * One text for `validateSpec` (build/preview) and the by-construction gate at submit (D-271 pattern).
 * `pointer` is relative to the spec. Absent `direction` = legacy flow = null (no change for stored figures).
 * A value outside TB/LR is refused here too (defence in depth behind the schema enum, SEC-23), so a spec that
 * bypassed the schema never reaches a layout or ELK option with it.
 */
export function directionIssue(spec: unknown): { detail: string; pointer: string } | null {
  if (!isObj(spec) || !has(spec, "direction") || spec.direction === undefined) return null;
  const v = spec.direction;
  if (!DIRECTION_VALUES.has(v)) {
    const shown = typeof v === "string" ? JSON.stringify(v.slice(0, 16)) : typeof v;
    return { detail: `direction ${shown} harus "TB" atau "LR" (arah kanan-ke-kiri atau bawah-ke-atas tidak didukung)`, pointer: "/direction" };
  }
  const fam = typeof spec.family === "string" ? spec.family : pyStr(spec.family);
  if (fam !== "flow") {
    const hint =
      fam === "layered" || fam === "topology" || fam === "stack"
        ? `arah tingkat (class.tier) tetap atas-bawah; untuk alur kiri-kanan pakai family flow + direction "LR", atau graph + class.col/row`
        : fam === "graph"
          ? "kolom diatur class.col/row; hapus direction"
          : "hapus direction";
    return { detail: `direction hanya untuk family flow (family '${fam.slice(0, 32)}'); ${hint}`, pointer: "/direction" };
  }
  if (has(spec, "per_row") && spec.per_row !== undefined) {
    return { detail: "per_row membungkus urutan daftar, direction menata menurut konektor; pakai salah satu", pointer: "/per_row" };
  }
  return null;
}

/**
 * Swarm 1.2.8 row 53a (H-D35, 01f §1.4): DATUM-35 message entries, each dialect once with one example node, in node
 * order: `ISO 5807 (n1: stadium); BPMN (n4: task)`. Single-dialect nodes name the dialects; a multi-dialect node
 * (diamond) is listed only when none of its dialects is already named, as `ISO 5807 / BPMN (n2: diamond)`.
 */
function notationEntries(nodes: ReadonlyArray<{ id: string; shape: string; set: readonly string[] }>): string {
  const covered = new Set<string>();
  const entries: Array<{ at: number; text: string }> = [];
  const add = (i: number) => {
    const n = nodes[i];
    if (n.set.some((d) => covered.has(d))) return;
    n.set.forEach((d) => covered.add(d));
    entries.push({ at: i, text: `${n.set.join(" / ")} (${n.id}: ${n.shape})` });
  };
  nodes.forEach((n, i) => n.set.length === 1 && add(i));
  nodes.forEach((n, i) => n.set.length > 1 && add(i));
  return entries
    .sort((a, b) => a.at - b.at)
    .map((e) => e.text)
    .join("; ");
}

// ---------------------------------------------------------------------------------------------------------------
// Swarm 1.2.8 row 52c (contributor to AC-VIS2a, VIS3a, VIS3b, VIS4, VIS5, VIS6, VIS7; plan P-20, P-24): the M3
// field-level spec checks. Each runs (and is listed in `ran`) only when the spec carries one of its fields, the
// P1-direction pattern, so a spec without the 1.2.8 fields keeps its report byte-for-byte. The contract refuses most
// bad values first (SCHEMA_INVALID); these repeat the rules for v1 artefacts and specs that bypass the schema.
// ---------------------------------------------------------------------------------------------------------------

/** 01f §1.5 (N8-271): shapes that may carry `event_type`. */
const EVENT_SHAPES: ReadonlySet<string> = new Set(["event_start", "event_intermediate", "event_end"]);
/** 01f §1.5: decision shapes checked by `P3-diamond-exits` (diamond + the four BPMN gateways). */
const DECISION_SHAPES: ReadonlySet<string> = new Set([
  "diamond",
  "gateway_exclusive",
  "gateway_parallel",
  "gateway_inclusive",
  "gateway_complex",
]);
/** 01f §3.1: edge fields whose values or combinations `P1-edge-style` checks (`via` is `P1-via`). */
const EDGE_STYLE_ENUMS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["route", DIAGRAM_EDGE_ROUTES],
  ["from_side", DIAGRAM_EDGE_SIDES],
  ["to_side", DIAGRAM_EDGE_SIDES],
  ["arrow_start", DIAGRAM_ARROW_TYPES],
  ["arrow_end", DIAGRAM_ARROW_TYPES],
  ["arrow_start_size", DIAGRAM_ARROW_SIZES],
  ["arrow_end_size", DIAGRAM_ARROW_SIZES],
  ["dash", DIAGRAM_EDGE_DASHES],
  ["weight", DIAGRAM_EDGE_WEIGHTS],
  ["label_at", DIAGRAM_LABEL_AT],
];
const EDGE_STYLE_FIELDS: readonly string[] = [...EDGE_STYLE_ENUMS.map(([k]) => k), "from_slot", "to_slot"];
/**
 * Swarm 1.2.8 row 57b (AC-VIS8, 01f §3.5, N8-212): DATUM-25L line-style key of one edge = (kind, effective dash,
 * effective weight). The kind's own pattern and width are the absent fields (`normal` on a non-accent kind; on `accent`
 * absent = its 1.6 x width, `normal` = 0.45 mm, a style of its own). Shown as the kind alone when both are the kind's,
 * else `kind/dash/weight` with the effective values.
 */
function lineStyleKey(kind: DiagramEdgeKind, dash: unknown, weight: unknown): string {
  const meta = EDGE_KINDS[kind];
  const d = typeof dash === "string" ? dash : meta.pattern;
  const w = typeof weight === "string" && !(weight === "normal" && kind !== "accent") ? weight : kind === "accent" ? "accent" : "normal";
  return d === meta.pattern && w === (kind === "accent" ? "accent" : "normal") ? kind : `${kind}/${d}/${w}`;
}

/** 01f §3.3 (D-V3): families where an author may place bend points (`flow` only without `direction`). */
const VIA_FAMILIES = "flow tanpa direction, graph, swimlane";

/** Present and not `undefined` (JSON has no undefined; an object literal may). */
function given(o: Json, k: string): boolean {
  return has(o, k) && o[k] !== undefined;
}

/** Short quoted form of a refused value for a message (no long user text echoed). */
function shown(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v.slice(0, 32)) : pyStr(v).slice(0, 32);
}

/**
 * Validasi penuh spek. Mengembalikan entri per cek (PASS) atau per pelanggaran
 * (FAIL, `detail` = pesan Python, `pointer` = JSON pointer medan).
 */
export function validateSpec(s: StudioDiagramV1, opts: ValidateSpecOptions = {}): LintIssue[] {
  const spec = (isObj(s) ? s : {}) as Json;
  const out: LintIssue[] = [];
  const fail = (checkId: string, detail: string, pointer?: string): void => {
    out.push(pointer === undefined ? { checkId, status: "FAIL", detail } : { checkId, status: "FAIL", detail, pointer });
  };
  const pass = (checkId: string, before: number): void => {
    if (!out.slice(before).some((i) => i.checkId === checkId && i.status === "FAIL")) {
      out.push({ checkId, status: "PASS" });
    }
  };
  let mark = 0;

  // P1-family
  mark = out.length;
  const fam = spec.family;
  if (typeof fam !== "string" || !has(FAMILIES, fam)) {
    fail("P1-family", `family '${pyStr(fam)}' bukan salah satu dari ${FAMILY_NAMES_SORTED.join("/")} (P1/P2)`, "/family");
  }
  pass("P1-family", mark);

  // P1-id
  mark = out.length;
  const fid = pyStr(has(spec, "id") ? spec.id : "");
  if (!/\d+\.\d+/.test(fid)) fail("P1-id", `id '${fid}' bukan nomor berawalan bab seperti 4.2 (P1)`, "/id");
  pass("P1-id", mark);

  // P1-title
  mark = out.length;
  const title = pyStr(has(spec, "title") ? spec.title : "").trim();
  if (!title.endsWith(".")) fail("P1-title", `title harus satu kalimat berakhir titik (P1): '${title}'`, "/title");
  pass("P1-title", mark);

  // P1-classification
  mark = out.length;
  if (!pyStr(has(spec, "classification") ? spec.classification : "").trim()) {
    fail("P1-classification", "classification wajib diputuskan bersama dokumen induk (P1)", "/classification");
  }
  pass("P1-classification", mark);

  // P1-width_mm
  mark = out.length;
  const w = pyFloat(has(spec, "width_mm") ? spec.width_mm : 0);
  // D-245: lebar sah = turunan templat (`grid.allowedFigureWidthsMm`); A4 = 128/166 (pesan identik).
  const allowed = resolveDiagramGrid(opts.grid).allowedWidthsMm;
  if (!allowed.some((a) => Math.abs(w - a) < 1e-6)) {
    const labels = allowed.map(widthLabel);
    fail(
      "P1-width_mm",
      `width_mm ${pyReprFloat(w)} harus salah satu dari [${labels.join(", ")}] (P1: ${labels.join(" atau ")}, jangan di antaranya)`,
      "/width_mm",
    );
  }
  pass("P1-width_mm", mark);

  // P1-apparatus (P9 E-20: default page)
  mark = out.length;
  const apparatus = has(spec, "apparatus") ? spec.apparatus : "page";
  if (apparatus !== "page" && apparatus !== "figure") {
    fail("P1-apparatus", `apparatus '${pyStr(apparatus)}' harus page atau figure (P1/P9-E-20)`, "/apparatus");
  }
  pass("P1-apparatus", mark);

  // P1-sources
  mark = out.length;
  const srcs = spec.sources;
  if (!Array.isArray(srcs) || srcs.length === 0) {
    fail("P1-sources", "sumber wajib: minimal satu dokumen+klausul (P1 sources[])", "/sources");
  }
  pass("P1-sources", mark);

  // P1-direction (Swarm 1.2.6 row 45, T-11, N-159): flow only, never with per_row, value TB or LR. Runs (and is
  // listed in `ran`) only when the spec carries `direction`, so a legacy spec keeps its 1.2.5 report unchanged.
  if (has(spec, "direction")) {
    mark = out.length;
    const dir = directionIssue(spec);
    if (dir) fail("P1-direction", dir.detail, dir.pointer);
    pass("P1-direction", mark);
  }

  // P1-nodes+P3-shapes
  mark = out.length;
  const nodes = listOf(spec.nodes);
  const ids = new Set<unknown>();
  // Swarm 1.2.8 row 53a (H-D35, D-V1, N8-245): node id + notation_set of every non-universal node, in node order.
  const notations: Array<{ id: string; shape: string; set: readonly string[] }> = [];
  const marksUsed = new Set<ProvenanceMark>();
  if (nodes.length === 0) {
    fail("P1-nodes+P3-shapes", "nodes[] kosong — gambar tanpa komponen nyata melanggar MAT-09 (P8)", "/nodes");
  }
  nodes.forEach((raw, i) => {
    const ptr = `/nodes/${i}`;
    const n = isObj(raw) ? raw : {};
    const nid = n.id;
    if (!truthy(nid) || !pyStr(has(n, "label") ? n.label : "").trim()) {
      fail("P1-nodes+P3-shapes", `simpul wajib id dan label (P1 nodes[]): ${reprish(raw)}`, ptr);
      return;
    }
    if (ids.has(nid)) {
      fail("P1-nodes+P3-shapes", `id simpul ganda: ${pyStr(nid)}`, `${ptr}/id`);
      return;
    }
    ids.add(nid);
    const shp = has(n, "shape") ? n.shape : "box";
    if (typeof shp !== "string" || !has(SHAPES, shp)) {
      fail("P1-nodes+P3-shapes", `bentuk '${pyStr(shp)}' bukan salah satu dari ${SHAPE_NAMES_SORTED.join("/")} (P3)`, `${ptr}/shape`);
      return;
    }
    if (!isObj(n.class)) {
      fail("P1-nodes+P3-shapes", `simpul ${pyStr(nid)} wajib class (tier/lane/col/row) (P1)`, `${ptr}/class`);
      return;
    }
    const set = SHAPES[shp as keyof typeof SHAPES].notation_set;
    if (set.length) notations.push({ id: pyStr(nid), shape: shp, set });
    const mk = n.mark;
    if (mk !== undefined && mk !== null) {
      if (typeof mk !== "string" || !has(MARKS, mk)) {
        fail("P1-nodes+P3-shapes", `glif asal '${pyStr(mk)}' bukan glif rumah ${MARK_NAMES_SORTED.join("/")} (T marks)`, `${ptr}/mark`);
        return;
      }
      marksUsed.add(mk as ProvenanceMark);
    }
  });
  pass("P1-nodes+P3-shapes", mark);
  const nodeObjs = nodes.map((raw) => (isObj(raw) ? raw : {}));
  const shapeOf = new Map<unknown, unknown>(nodeObjs.map((n) => [n.id, has(n, "shape") ? n.shape : "box"]));

  // P1-event_type (row 52c, 01f §1.5, N8-271): only on event_* shapes, value none/message/timer.
  if (nodeObjs.some((n) => given(n, "event_type"))) {
    mark = out.length;
    nodeObjs.forEach((n, i) => {
      if (!given(n, "event_type")) return;
      const ptr = `/nodes/${i}/event_type`;
      if (typeof n.shape !== "string" || !EVENT_SHAPES.has(n.shape)) {
        fail(
          "P1-event_type",
          `event_type hanya untuk event_start/event_intermediate/event_end (simpul '${pyStr(n.id).slice(0, 64)}': ${shown(has(n, "shape") ? n.shape : "box")})`,
          ptr,
        );
      } else if (!(DIAGRAM_EVENT_TYPES as readonly unknown[]).includes(n.event_type)) {
        fail("P1-event_type", `event_type ${shown(n.event_type)} bukan salah satu dari ${DIAGRAM_EVENT_TYPES.join("/")}`, ptr);
      }
    });
    pass("P1-event_type", mark);
  }

  // P1-containers (row 52c, 01f §2.2, N8-270): phases, pools, lane_orientation of the swimlane family.
  const classOf = (n: Json): Json => (isObj(n.class) ? n.class : {});
  if (
    ["phases", "pools", "lane_orientation"].some((k) => given(spec, k)) ||
    nodeObjs.some((n) => given(classOf(n), "phase") || given(classOf(n), "pool"))
  ) {
    mark = out.length;
    for (const k of ["phases", "pools", "lane_orientation"]) {
      // Cause 1: a container field outside the swimlane family.
      if (given(spec, k) && fam !== "swimlane") {
        fail("P1-containers", `${k} hanya untuk family swimlane (family '${pyStr(fam).slice(0, 32)}')`, `/${k}`);
      }
    }
    if (given(spec, "lane_orientation") && !(DIAGRAM_LANE_ORIENTATIONS as readonly unknown[]).includes(spec.lane_orientation)) {
      fail("P1-containers", `lane_orientation ${shown(spec.lane_orientation)} harus ${DIAGRAM_LANE_ORIENTATIONS.join(" atau ")}`, "/lane_orientation");
    }
    for (const [list, key, max] of [
      ["phases", "phase", LIMITS.max_phases],
      ["pools", "pool", LIMITS.max_pools],
    ] as const) {
      const declared = new Set<string>();
      if (given(spec, list)) {
        const items = spec[list];
        if (!Array.isArray(items) || items.length === 0) {
          fail("P1-containers", `${list} harus larik [{id, label}] berisi 1..${max} entri`, `/${list}`);
        } else {
          // Cause 5: over PHASES_MAX / POOLS_MAX.
          if (items.length > max) fail("P1-containers", `${list}: ${items.length} entri, maksimum ${max}`, `/${list}`);
          items.forEach((it, j) => {
            const id = isObj(it) ? it.id : undefined;
            if (typeof id !== "string" || id.length < 1 || id.length > 64 || !pyStr(isObj(it) ? it.label : "").trim()) {
              fail("P1-containers", `${list}[${j}] wajib id (1..64 karakter) dan label`, `/${list}/${j}`);
              return;
            }
            // Cause 2: duplicate id.
            if (declared.has(id)) fail("P1-containers", `id ${key} ganda: ${shown(id)}`, `/${list}/${j}/id`);
            declared.add(id);
          });
        }
      }
      nodeObjs.forEach((n, i) => {
        const c = classOf(n);
        if (given(c, key)) {
          // Cause 3: class.phase / class.pool naming an unknown id.
          if (typeof c[key] !== "string" || !declared.has(c[key] as string)) {
            fail("P1-containers", `class.${key} ${shown(c[key])} pada simpul '${pyStr(n.id).slice(0, 64)}' bukan id di ${list}[]`, `/nodes/${i}/class/${key}`);
          }
        } else if (given(spec, list)) {
          // Cause 4: all-or-nothing, every node names its phase / pool when the list is present.
          fail("P1-containers", `${list} ada tetapi simpul '${pyStr(n.id).slice(0, 64)}' tanpa class.${key} (semua atau tidak sama sekali)`, `/nodes/${i}/class`);
        }
      });
    }
    // Cause 6 (01f §2.2): a pool whose nodes carry no class.lane, and a lane name repeated across pools, are allowed.
    pass("P1-containers", mark);
  }

  // DATUM-35: satu dialek simbol per gambar (universal boleh berdampingan). Swarm 1.2.8 row 53a (H-D35, D-V1, 01f §1.4):
  // sah bila irisan notation_set semua simpul non-universal tidak kosong (diamond = {ISO 5807, BPMN} cocok dengan
  // keduanya). Pesan: setiap dialek sekali dengan satu simpul contoh, pemisah "; " (dulu join koma atas string berkoma).
  mark = out.length;
  const common = notations.reduce<readonly string[] | null>((acc, n) => (acc === null ? n.set : acc.filter((d) => n.set.includes(d))), null);
  if (common !== null && common.length === 0) {
    fail("DATUM-35", `DATUM-35: notasi bentuk tidak dapat digabung: ${notationEntries(notations)} — satu notasi per gambar (P3/P5)`, "/nodes");
  }
  pass("DATUM-35", mark);

  // DATUM-24 + DATUM-26
  mark = out.length;
  const edges = listOf(spec.edges);
  let accented = 0;
  edges.forEach((raw, i) => {
    const ptr = `/edges/${i}`;
    const e = isObj(raw) ? raw : {};
    for (const key of ["from", "to", "kind", "label"]) {
      if (!has(e, key) || e[key] === null || e[key] === "") {
        fail("DATUM-24", `DATUM-24: konektor wajib keempat bidang from/to/kind/label (P1/P8): ${reprish(raw)}`, `${ptr}/${key}`);
        return;
      }
    }
    if (!ids.has(e.from) || !ids.has(e.to)) {
      fail("DATUM-24", `konektor merujuk simpul tak dikenal: ${pyStr(e.from)}->${pyStr(e.to)}`, ptr);
    }
    if (typeof e.kind !== "string" || !has(EDGE_KINDS, e.kind)) {
      fail("DATUM-24", `jenis konektor '${pyStr(e.kind)}' bukan salah satu dari ${EDGE_KIND_NAMES_SORTED.join("/")} (P4)`, `${ptr}/kind`);
      return;
    }
    if ((e.kind as DiagramEdgeKind) === "accent") accented += 1;
  });
  pass("DATUM-24", mark);
  mark = out.length;
  if (accented > LIMITS.max_accented_subjects) {
    fail("DATUM-26", `DATUM-26: ${accented} subjek beraksen, maksimum ${LIMITS.max_accented_subjects} per gambar (P5/P8)`, "/edges");
  }
  pass("DATUM-26", mark);

  const edgeObjs = edges.map((raw) => (isObj(raw) ? raw : {}));
  // P1-edge-style (row 52c, 01f §3.6, N8-267). Pointer /edges/<i>/<field>.
  if (edgeObjs.some((e) => EDGE_STYLE_FIELDS.some((k) => given(e, k))) || given(spec, "jumps")) {
    mark = out.length;
    if (given(spec, "jumps") && !(DIAGRAM_JUMPS as readonly unknown[]).includes(spec.jumps)) {
      fail("P1-edge-style", `jumps ${shown(spec.jumps)} harus ${DIAGRAM_JUMPS.join(" atau ")}`, "/jumps");
    }
    edgeObjs.forEach((e, i) => {
      const ptr = `/edges/${i}`;
      // Cause 6: an unknown enum value (the contract refuses it first with SCHEMA_INVALID).
      for (const [k, allowed] of EDGE_STYLE_ENUMS) {
        if (given(e, k) && !(allowed as readonly unknown[]).includes(e[k])) {
          fail("P1-edge-style", `${k} ${shown(e[k])} bukan salah satu dari ${allowed.join("/")}`, `${ptr}/${k}`);
        }
      }
      for (const end of ["from", "to"] as const) {
        const slotKey = `${end}_slot`;
        const sideKey = `${end}_side`;
        if (!given(e, slotKey)) continue;
        const v = e[slotKey];
        // Cause 2: a slot outside (0, 1).
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v >= 1) {
          fail("P1-edge-style", `${slotKey} ${shown(v)} harus angka di antara 0 dan 1 (tidak termasuk)`, `${ptr}/${slotKey}`);
        }
        // Cause 1: a slot needs its side (not absent, not "auto").
        if (!given(e, sideKey) || e[sideKey] === "auto") {
          fail("P1-edge-style", `${slotKey} perlu ${sideKey} selain auto (titik sambung diukur sepanjang sisi itu)`, `${ptr}/${slotKey}`);
        }
      }
      // Cause 3: a head size without a head. Start: absent = none; end: absent = the kind head, only "none" refuses.
      if (given(e, "arrow_start_size") && (!given(e, "arrow_start") || e.arrow_start === "none")) {
        fail("P1-edge-style", "arrow_start_size tanpa arrow_start (kepala awal tidak ada)", `${ptr}/arrow_start_size`);
      }
      if (given(e, "arrow_end_size") && e.arrow_end === "none") {
        fail("P1-edge-style", 'arrow_end_size dengan arrow_end "none" (kepala akhir tidak ada)', `${ptr}/arrow_end_size`);
      }
      // Cause 4: curved + via (a curve has no bend points; P-24 moved this refusal here from row 56).
      if (e.route === "curved" && given(e, "via")) {
        fail("P1-edge-style", 'route "curved" tidak dapat digabung dengan via; pakai orthogonal atau straight', `${ptr}/via`);
      }
      // Cause 5: an explicit side on an edge touching a bus node (bus taps are fixed, route.ts).
      if (shapeOf.get(e.from) === "bus" || shapeOf.get(e.to) === "bus") {
        for (const sideKey of ["from_side", "to_side"]) {
          if (given(e, sideKey) && e[sideKey] !== "auto") {
            fail("P1-edge-style", `${sideKey} tidak boleh pada konektor ke/dari simpul bus (titik tap bus tetap)`, `${ptr}/${sideKey}`);
          }
        }
      }
    });
    pass("P1-edge-style", mark);
  }

  // P1-via + P3-via-family (row 52c, 01f §3.3, N8-268, N8-269, D-V3).
  if (edgeObjs.some((e) => given(e, "via"))) {
    mark = out.length;
    const hint = "titik via = {col,row} kisi; lihat figure.lattice pada pratinjau";
    edgeObjs.forEach((e, i) => {
      if (!given(e, "via")) return;
      const ptr = `/edges/${i}/via`;
      const via = e.via;
      if (!Array.isArray(via) || via.length === 0) {
        fail("P1-via", `via harus larik 1..${LIMITS.max_via} titik {col,row}; ${hint}`, ptr);
        return;
      }
      if (via.length > LIMITS.max_via) {
        fail("P1-via", `via: ${via.length} titik, maksimum ${LIMITS.max_via}; ${hint}`, ptr);
      }
      via.forEach((p, j) => {
        const ok =
          isObj(p) &&
          ["col", "row"].every((k) => typeof p[k] === "number" && Number.isInteger(p[k]) && (p[k] as number) >= 0);
        if (!ok) fail("P1-via", `via[${j}] ${reprish(p).slice(0, 64)} bukan bilangan bulat col,row >= 0; ${hint}`, `${ptr}/${j}`);
      });
    });
    pass("P1-via", mark);

    mark = out.length;
    const ranked = fam === "flow" && given(spec, "direction");
    if (!(fam === "graph" || fam === "swimlane" || (fam === "flow" && !ranked))) {
      const first = edgeObjs.findIndex((e) => given(e, "via"));
      const named = ranked ? "flow + direction" : pyStr(fam).slice(0, 32);
      fail("P3-via-family", `via tidak berlaku pada family '${named}' (tata letak otomatis); via hanya untuk ${VIA_FAMILIES}`, `/edges/${first}/via`);
    }
    pass("P3-via-family", mark);
  }

  // DATUM-34: glif rumah wajib baris kunci terbit
  mark = out.length;
  if (marksUsed.size > 0) {
    const legendText = listOf(spec.legend).map((x) => pyStr(x)).join(" ");
    const missing = [...marksUsed].sort().filter((m) => !legendText.includes(m) && !legendText.includes(MARKS[m]));
    if (missing.length > 0) {
      fail("DATUM-34", `DATUM-34: glif rumah ${missing.join(", ")} dipakai tanpa baris kunci terbit (P5/P8)`, "/legend");
    }
  }
  pass("DATUM-34", mark);

  // DATUM-25L (Swarm 1.2.8 row 35c, H-T06, D-H1, N8-212/N8-213): distinct line styles <= LINE_STYLE_MAX (4), <= 3 when
  // a node carries a mark. Not the closure DATUM-25 (colours). Runs and is listed in `ran` only above the lower limit,
  // so a spec within 3 styles keeps its verdict and check list (52c rule).
  // Row 57b (AC-VIS8, 01f §3.5): the style key is (kind, effective dash, effective weight); a style that only differs
  // from its kind by a non-default dash or weight is named `kind/dash/weight`, so a kind-only spec keeps its message.
  const lineStyles = new Set(
    edgeObjs.filter((e) => typeof e.kind === "string" && has(EDGE_KINDS, e.kind)).map((e) => lineStyleKey(e.kind as DiagramEdgeKind, e.dash, e.weight)),
  );
  if (lineStyles.size > LIMITS.max_line_styles_with_mark) {
    mark = out.length;
    const max = marksUsed.size > 0 ? LIMITS.max_line_styles_with_mark : LIMITS.max_line_styles;
    if (lineStyles.size > max) {
      const why = marksUsed.size > 0 ? `${max} bila ada simpul ber-mark` : `${max}`;
      fail("DATUM-25L", `DATUM-25L: ${lineStyles.size} gaya garis (${[...lineStyles].sort().join(", ")}), maksimum ${why} (P5)`, "/edges");
    }
    pass("DATUM-25L", mark);
  }

  // P3-diamond-exits: keputusan wajib keluaran berlabel. Swarm 1.2.8 row 52c (01f §1.5): also the four BPMN
  // gateways; the diamond text is unchanged, a gateway message names its shape.
  mark = out.length;
  nodes.forEach((raw, i) => {
    const n = isObj(raw) ? raw : {};
    if (typeof n.shape === "string" && DECISION_SHAPES.has(n.shape)) {
      const outs = edges.filter((e) => isObj(e) && e.from === n.id);
      if (outs.length === 0) {
        const what = n.shape === "diamond" ? "keputusan" : `keputusan ${n.shape}`;
        fail("P3-diamond-exits", `${what} '${pyStr(n.id)}' tanpa keluaran berlabel (P3: every exit labelled)`, `/nodes/${i}`);
      }
    }
  });
  pass("P3-diamond-exits", mark);

  if (opts.release) {
    mark = out.length;
    if (spec.labels_verified !== true) {
      fail(
        RELEASE_CHECK_ID,
        "labels_verified bukan true: gambar adalah draft, render dan tinjau, jangan kirim (P1)",
        "/labels_verified",
      );
    }
    pass(RELEASE_CHECK_ID, mark);
  }
  return out;
}

/** Id cek yang dijalankan dan lolos, urutan Python (`ran`). */
export function checksRunOf(issues: readonly LintIssue[]): string[] {
  const ran: string[] = [];
  for (const i of issues) if (i.status === "PASS" && !ran.includes(i.checkId)) ran.push(i.checkId);
  return ran;
}

/**
 * Perilaku `validate_spec` Python persis: lempar `DiagramDefect` pada
 * pelanggaran pertama; bila lolos kembalikan daftar `ran` (13 id, +1 rilis).
 */
export function assertValidSpec(s: StudioDiagramV1, opts: ValidateSpecOptions = {}): string[] {
  const issues = validateSpec(s, opts);
  const first = issues.find((i) => i.status === "FAIL");
  if (first) {
    throw new DiagramDefect(first.detail ?? first.checkId, { checkId: first.checkId, pointer: first.pointer });
  }
  return checksRunOf(issues);
}
