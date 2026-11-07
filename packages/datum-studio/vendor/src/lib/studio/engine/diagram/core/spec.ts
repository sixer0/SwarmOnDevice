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
  "P1-nodes+P3-shapes",
  "DATUM-35",
  "DATUM-24",
  "DATUM-26",
  "DATUM-34",
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

  // P1-nodes+P3-shapes
  mark = out.length;
  const nodes = listOf(spec.nodes);
  const ids = new Set<unknown>();
  const notations = new Set<string>();
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
    notations.add(SHAPES[shp as keyof typeof SHAPES].notation);
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

  // DATUM-35: satu dialek simbol per gambar (universal boleh berdampingan)
  mark = out.length;
  const dialects = [...notations].filter((t) => t !== "universal").sort();
  if (dialects.length > 1) {
    fail(
      "DATUM-35",
      `DATUM-35: lebih dari satu dialek simbol dalam satu gambar (${dialects.join(", ")}) — satu notasi per gambar (P3/P5)`,
      "/nodes",
    );
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

  // P3-diamond-exits: keputusan wajib keluaran berlabel
  mark = out.length;
  nodes.forEach((raw, i) => {
    const n = isObj(raw) ? raw : {};
    if (n.shape === "diamond") {
      const outs = edges.filter((e) => isObj(e) && e.from === n.id);
      if (outs.length === 0) {
        fail("P3-diamond-exits", `keputusan '${pyStr(n.id)}' tanpa keluaran berlabel (P3: every exit labelled)`, `/nodes/${i}`);
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
