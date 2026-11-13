/**
 * Token, katalog, dan util geometri diagram Garis A (S26, port
 * `datum-house-style/datum_diagram.py` baris 70-247).
 *
 * Nilai token = salinan beku `datum-house-style/tokens.json` v2.0.0 (seksi
 * colour.interior, type.faces, type.scale_pt peran yang dipakai mesin diagram,
 * type.tracking_em, type.baseline_pt, grid_mm, rules_mm, marks, numerals).
 * Garis A membaca berkas itu tanpa templat; paritas DG (research/06 §6.2)
 * menuntut nilai identik, karena itu disalin, bukan diturunkan dari ParamMap.
 * Tidak ada hex/mm gaya lain di luar objek `DIAGRAM_TOKENS`.
 */
import type { DiagramEdgeKind, DiagramFamily, DiagramShape, ProvenanceMark } from "../../../contract";
import { FIGURE_BOUNDS } from "../../../contract/schema/figure-bounds";
import { DiagramDefect } from "./defect";
import { pyFixed, pyLen, pyRound0, pyStr } from "./pyfmt";

export interface DiagramRoleToken {
  readonly size: number;
  readonly leading?: number;
  readonly upper?: boolean;
  readonly track_em?: number;
  readonly face?: string;
  readonly weight?: number;
  readonly colour?: string;
}

/** Salinan beku tokens.json (HS) yang dibaca datum_diagram.py. */
export const DIAGRAM_TOKENS = {
  colour: {
    interior: {
      paper: "#FCFCFB",
      ink900: "#101418",
      ink700: "#2B3640",
      ink400: "#6B7783",
      ink200: "#C3CBD1",
      ink100: "#EFF2F4",
      signal: "#B45309",
      alert: "#9B1C1C",
      verd: "#2F6F6B",
      link: "#0563C1",
    } as Readonly<Record<string, string>>,
  },
  type: {
    faces: {
      serif: "IBM Plex Serif",
      condensed: "IBM Plex Sans Condensed",
      mono: "IBM Plex Mono",
      workbook_ui: "IBM Plex Sans",
    } as Readonly<Record<string, string>>,
    tracking_em: { display_tighter: -0.012, micro_label_wider: 0.09 },
    baseline_pt: 13.5,
    scale_pt: {
      chapter_title: { size: 16, leading: 20, face: "condensed", weight: 600, colour: "ink900" },
      chapter_kicker: { size: 6.8, upper: true, track_em: 0.16, face: "condensed", weight: 600, colour: "signal" },
      section_heading: { size: 11, leading: 13.5, face: "condensed", weight: 600, colour: "ink900" },
      body: { size: 9.5, leading: 13.5, face: "serif", weight: 400, colour: "ink700" },
      table_body: { size: 8.2, leading: 11.5, face: "serif", weight: 400, colour: "ink700" },
      table_numerals: { size: 7.8, face: "mono", weight: 400, colour: "ink900" },
      table_header: { size: 6.8, upper: true, track_em: 0.09, face: "condensed", weight: 600, colour: "ink400" },
      caption: { size: 7.6, leading: 11, face: "condensed", weight: 400, colour: "ink700" },
      source_line: { size: 6.6, leading: 9, face: "condensed", weight: 400, colour: "ink400" },
      evidence_rail: { size: 5.9, leading: 8.4, upper: true, face: "mono", weight: 400, colour: "ink400" },
      running_head: { size: 6.8, upper: true, face: "condensed", weight: 500, colour: "ink400" },
      register_block: { size: 6.2, face: "mono", weight: 400, colour: "ink400" },
      derivation: { size: 7.4, leading: 11.5, face: "mono", weight: 400, colour: "ink900" },
    } as Readonly<Record<string, DiagramRoleToken>>,
  },
  grid_mm: {
    text_column: 128,
    full_span: 166,
    horizontal_lattice: 10.6667,
    vertical_lattice: 4.7625,
  },
  rules_mm: { primary: 0.45, hair: 0.2, photocopy_floor: 0.18 },
  marks: { TERUKUR: "■", DITURUNKAN: "◈", PEMASOK: "◇", ASUMSI: "△" } as Readonly<
    Record<ProvenanceMark, string>
  >,
  numerals: { thousands: ".", decimal: "," },
  /** Basename sumber token yang dicetak di komentar generator (paritas teks). */
  sourceName: "tokens.json",
} as const;

export const INTERIOR = DIAGRAM_TOKENS.colour.interior;
export const FACES = DIAGRAM_TOKENS.type.faces;
export const SCALE = DIAGRAM_TOKENS.type.scale_pt;
export const TRACK = DIAGRAM_TOKENS.type.tracking_em;
export const MARKS = DIAGRAM_TOKENS.marks;
export const PAPER = INTERIOR.paper;
export const INK_TEXT = "ink700";

// Kisi dihitung ulang dari induknya (datum_diagram.py:94-103): 128/12 bukan 10,6667.
const LX_TOK = DIAGRAM_TOKENS.grid_mm.horizontal_lattice;
const LX_CALC = DIAGRAM_TOKENS.grid_mm.text_column / 12.0;
/** Kisi horizontal mm (= 128/12). */
export const LATTICE_X = Math.abs(LX_CALC - LX_TOK) < 1e-3 ? LX_CALC : LX_TOK;
const LY_TOK = DIAGRAM_TOKENS.grid_mm.vertical_lattice;
const LY_CALC = (DIAGRAM_TOKENS.type.baseline_pt * 25.4) / 72.0;
/** Kisi vertikal mm (= baseline 13,5 pt). */
export const LATTICE_Y = Math.abs(LY_CALC - LY_TOK) < 1e-3 ? LY_CALC : LY_TOK;
export const ALLOWED_WIDTHS: readonly number[] = [DIAGRAM_TOKENS.grid_mm.text_column, DIAGRAM_TOKENS.grid_mm.full_span];
export const STROKE_FLOOR_MM = DIAGRAM_TOKENS.rules_mm.photocopy_floor;
export const STROKE_PRIMARY = DIAGRAM_TOKENS.rules_mm.primary;
export const STROKE_HAIR = DIAGRAM_TOKENS.rules_mm.hair;
export const BASELINE_PT = DIAGRAM_TOKENS.type.baseline_pt;

/** Ambang cacat verbatim 000 RevA Tabel 8.1 (datum_diagram.py:111-118). */
export const LIMITS = {
  diagram_type_min_pt: 5.5,
  text_block_max_mm: 247.0,
  max_colour_values: 5,
  max_accented_subjects: 1,
  hop_radius_mm: 0.9,
  // Swarm 1.2.8 row 52 (VIS-0a, F-VISIO 01f §4.1; register N8-213, N8-253, N8-255, N8-259, N8-217, N8-264, N8-470,
  // N8-471, values per R20-C36/C42): limits and sizes of the 1.2.8 diagram contract fields. Read by the rows that draw
  // and check them (35c, 53-57); nothing reads them in row 52. Phases, pools and via alias the contract bounds.
  max_line_styles: 4,
  max_line_styles_with_mark: 3,
  max_phases: FIGURE_BOUNDS.diagramPhases,
  max_pools: FIGURE_BOUNDS.diagramPools,
  max_via: FIGURE_BOUNDS.diagramVia,
  curve_samples: 32,
  arrow_sizes_mm: { s: 2.5, m: 3.2, l: 4.0 },
  weight_mm: { thin: 0.3, normal: 0.45, thick: 0.7 },
  shape_glyph_mm: 2.4,
  label_at_fraction: { start: 0.2, middle: 0.5, end: 0.8 },
} as const;

/** Swarm 1.2.8 row 52 (VIS-0a): exported aliases of the LIMITS keys above (register names). */
export const LINE_STYLE_MAX = LIMITS.max_line_styles;
export const LINE_STYLE_MAX_WITH_MARK = LIMITS.max_line_styles_with_mark;
export const PHASES_MAX = LIMITS.max_phases;
export const POOLS_MAX = LIMITS.max_pools;
export const VIA_MAX = LIMITS.max_via;
export const CURVE_SAMPLES = LIMITS.curve_samples;
export const ARROW_SIZES_MM = LIMITS.arrow_sizes_mm;
/**
 * Swarm 1.2.8 row 57 (H-ARW, AC-HARW, register N8-216, value R20-C36): the shortest arrowhead length (mm) at print size.
 * Heads are drawn in `markerUnits="userSpaceOnUse"` mm (core/svg.ts), so every size of `ARROW_SIZES_MM` is a printed
 * length; the smallest (`s`) equals this floor.
 */
export const ARROW_HEAD_MIN_MM = 2.5;
export const WEIGHT_MM = LIMITS.weight_mm;
export const SHAPE_GLYPH_MM = LIMITS.shape_glyph_mm;
export const LABEL_AT_FRACTION = LIMITS.label_at_fraction;

/** Peran tipografi yang dicetak mesin (diuji DATUM-28). */
export const DIAGRAM_ROLES = ["caption", "source_line", "table_header", "evidence_rail", "register_block"] as const;
export type DiagramTextRole = keyof typeof DIAGRAM_TOKENS.type.scale_pt | (string & {});

/** P2: 9 keluarga, 7 mesin tata letak. */
export const FAMILIES: Readonly<Record<DiagramFamily, { drawWhen: string; engine: string }>> = {
  layered: { drawWhen: "komponen masuk strata: tingkat, zona, lapisan", engine: "layout_layered" },
  topology: { drawWhen: "perangkat dan tautan jaringan; setiap tautan berlabel", engine: "layout_layered" },
  stack: { drawWhen: "didaftarkan sebagai keluarga; tanpa layout/sampel sendiri", engine: "layout_layered" },
  flow: { drawWhen: "prosedur berurutan dengan gerbang keputusan", engine: "layout_flow" },
  swimlane: { drawWhen: "siapa yang bertindak adalah intinya; lajur = akuntabilitas", engine: "layout_swimlane" },
  sequence: { drawWhen: "urutan pesan atas waktu; waktu memiliki sumbu vertikal", engine: "layout_sequence" },
  sld: { drawWhen: "rantai daya/sinyul digantung dari rel bus", engine: "layout_sld" },
  rack: { drawWhen: "elevasi rak; posisi U menanggung beban", engine: "layout_rack" },
  graph: { drawWhen: "selain itu, ditempatkan lewat col dan row", engine: "layout_graph" },
};

/** Swarm 1.2.8 row 53a (H-D35, ruling D-V1, register N8-245): notation dialects of `SHAPES[s].notation_set`. */
const UNIVERSAL: readonly string[] = [];
const ISO: readonly string[] = ["ISO 5807"];
const BPMN: readonly string[] = ["BPMN"];

/**
 * P3: 10 bentuk simpul + Swarm 1.2.8 row 52 (VIS-0a, F-VISIO 01f §1): 14 bentuk Basic Flowchart / BPMN Basic / anotasi.
 * Bentuk baru digambar sebagai kotak sampai row 53/54 memasang garis luarnya.
 * Swarm 1.2.8 row 53a (H-D35, D-V1, 01f §1.4, N8-245): `notation_set` menggantikan string `notation`. `[]` = universal;
 * sebuah gambar sah bila irisan himpunan semua simpul non-universal tidak kosong (DATUM-35, `core/spec.ts`).
 */
export const SHAPES: Readonly<Record<DiagramShape, { means: string; notation_set: readonly string[]; radius: boolean }>> = {
  box: { means: "komponen, langkah proses, peralatan", notation_set: UNIVERSAL, radius: false },
  stadium: { means: "awal atau akhir; satu-satunya bentuk yang boleh beradius", notation_set: ISO, radius: true },
  diamond: { means: "keputusan; setiap keluaran berlabel", notation_set: ["ISO 5807", "BPMN"], radius: false },
  parallelogram: { means: "masukan atau keluaran", notation_set: ISO, radius: false },
  cylinder: { means: "data tersimpan, arsip", notation_set: UNIVERSAL, radius: false },
  hexagon: { means: "persiapan, gerbang", notation_set: ISO, radius: false },
  doubled: { means: "subsistem dengan struktur lanjutan", notation_set: ["UML component"], radius: false },
  shadowed: { means: "entitas eksternal di luar batas", notation_set: ["DFD Gane-Sarson"], radius: false },
  circle: { means: "persimpangan, penyambung luar-halaman", notation_set: UNIVERSAL, radius: false },
  bus: { means: "rel bus atau backplane, garis berat", notation_set: ["IEC 60617"], radius: false },
  predefined: { means: "subproses terdefinisi (proses dengan dua garis sisi)", notation_set: ISO, radius: false },
  document: { means: "dokumen", notation_set: ISO, radius: false },
  offpage: { means: "penyambung ke halaman lain", notation_set: ISO, radius: false },
  event_start: { means: "peristiwa awal (BPMN)", notation_set: BPMN, radius: false },
  event_intermediate: { means: "peristiwa antara (BPMN)", notation_set: BPMN, radius: false },
  event_end: { means: "peristiwa akhir (BPMN)", notation_set: BPMN, radius: false },
  task: { means: "tugas (BPMN)", notation_set: BPMN, radius: true },
  subprocess: { means: "subproses terlipat [+] (BPMN)", notation_set: BPMN, radius: true },
  gateway_exclusive: { means: "gerbang eksklusif X (BPMN); setiap keluaran berlabel", notation_set: BPMN, radius: false },
  gateway_parallel: { means: "gerbang paralel + (BPMN)", notation_set: BPMN, radius: false },
  gateway_inclusive: { means: "gerbang inklusif O (BPMN)", notation_set: BPMN, radius: false },
  gateway_complex: { means: "gerbang kompleks * (BPMN)", notation_set: BPMN, radius: false },
  data_object: { means: "objek data (BPMN)", notation_set: BPMN, radius: false },
  annotation: { means: "anotasi teks dengan kurung", notation_set: UNIVERSAL, radius: false },
};

export type DashPatternName = "solid" | "dashed" | "dotted" | "longdash" | "dashdot";

/** P4: 6 jenis konektor (pola garis dulu, warna = nama token). */
export const EDGE_KINDS: Readonly<
  Record<DiagramEdgeKind, { pattern: DashPatternName; colour: string; head: "solid" | "open"; iso: string; use: string }>
> = {
  data: { pattern: "solid", colour: "ink900", head: "solid", iso: "01.1", use: "substansi yang bergerak melalui sistem" },
  control: { pattern: "dashed", colour: "ink700", head: "open", iso: "02.1", use: "perintah, pemicu, orkestrasi" },
  sync: { pattern: "dotted", colour: "ink400", head: "open", iso: "-", use: "replikasi, mirroring, heartbeat" },
  accent: { pattern: "solid", colour: "signal", head: "solid", iso: "01.1", use: "satu jalur yang tidak boleh dilewatkan pembaca" },
  alert: { pattern: "longdash", colour: "alert", head: "open", iso: "-", use: "kegagalan, penolakan, jalur pengecualian" },
  verify: { pattern: "dashdot", colour: "verd", head: "open", iso: "04.1", use: "uji integritas, atestasi, audit" },
};

/** Pola garis ISO 128-2 dalam mm (atribut `stroke-dasharray`). */
export const DASH_PATTERNS: Readonly<Record<DashPatternName, string | null>> = {
  solid: null,
  dashed: "3.2,1.6",
  dotted: "0.2,1.1",
  longdash: "7.1,1.6",
  dashdot: "7.1,1.6,0.2,1.6",
};

/** P1 Tabel 6.1: bidang minimum diagram-spec (keluaran `--schema`). */
export const SPEC_FIELDS: Readonly<Record<string, string>> = {
  family: "salah satu keluarga Tabel 6.2; dipilih PRISMA, bukan DATUM",
  id: "nomor berawalan bab",
  title: "satu kalimat berakhir titik",
  classification: "diputuskan bersama dokumen induk, tidak sendiri",
  "nodes[]": "id, label, class (tier/lane/col/row), sub, mark, tag",
  "edges[]": "from, to, kind dan label — keempatnya wajib",
  "legend[]": "baris kunci saat glif rumah muncul; catatan khusus",
  "notes[]": "carve-out dan konvensi",
  "sources[]": "minimal satu dokumen dan klausul tempat gambar dibangun",
  labels_verified: "false berarti draft: render dan tinjau, jangan kirim",
  width_mm: "128 atau 166, jangan di antaranya",
  apparatus: "page untuk gambar di .docx/.pptx, figure untuk SVG berdiri sendiri",
};

/** Urutan terurut (Python `sorted(...)`) untuk pesan dan daftar. */
export const FAMILY_NAMES_SORTED = Object.keys(FAMILIES).sort() as DiagramFamily[];
export const SHAPE_NAMES_SORTED = Object.keys(SHAPES).sort() as DiagramShape[];
export const EDGE_KIND_NAMES_SORTED = Object.keys(EDGE_KINDS).sort() as DiagramEdgeKind[];
export const MARK_NAMES_SORTED = Object.keys(MARKS).sort() as ProvenanceMark[];

// ------------------------------------------------------------- util geometri
export function pt2mm(pt: number): number {
  return (pt * 25.4) / 72.0;
}

/** Kunci ke kisi terdekat (`round` Python setengah-ke-genap). */
export function snap(v: number, unit: number): number {
  return pyRound0(v / unit) * unit;
}

/** Bulatkan ke bawah pada kisi (lebar tidak pernah melewati tepi lembar). */
export function snapFloor(v: number, unit: number): number {
  const n = Math.floor(v / unit + 1e-9);
  return Math.max(n, 0) * unit;
}

/** Bulatkan ke atas pada kisi (posisi kiri kolom anti-tumpuan). */
export function snapCeil(v: number, unit: number): number {
  const n = Math.ceil(v / unit - 1e-9);
  return Math.max(n, 0) * unit;
}

/** Konvensi angka DATUM: ribuan '.', desimal ','. */
export function fmtNum(value: number, dec = 0): string {
  const s = pyFixed(value, Math.trunc(dec));
  const dot = s.indexOf(".");
  let ip = dot >= 0 ? s.slice(0, dot) : s;
  const dp = dot >= 0 ? s.slice(dot + 1) : "";
  const neg = ip.startsWith("-");
  ip = ip.replace(/^-+/, "");
  const rev = Array.from(ip).reverse().join("");
  const groups = rev.match(/\d{1,3}/g) ?? [];
  ip = Array.from(groups.join(DIAGRAM_TOKENS.numerals.thousands)).reverse().join("");
  const out = ip + (dp ? DIAGRAM_TOKENS.numerals.decimal + dp : "");
  return (neg ? "-" : "") + out;
}

export function role(name: string): DiagramRoleToken {
  const r = SCALE[name];
  if (!r) throw new DiagramDefect(`peran tipografi '${name}' tidak ada di tokens.json type.scale_pt`);
  return r;
}

export function faceOf(roleName: string): string {
  const key = role(roleName).face ?? "condensed";
  const face = FACES[key];
  if (!face) throw new DiagramDefect(`wajah '${key}' tidak ada di tokens.json type.faces`);
  return face;
}

/** Semua warna lewat nama token interior. */
export function colourOf(tokenName: string): string {
  const c = INTERIOR[tokenName];
  if (!c) throw new DiagramDefect(`token warna '${tokenName}' tidak ada di tokens.json colour.interior`);
  return c;
}

/**
 * Perkiraan lebar teks (mm) dari ukuran pt (HS `est_text_mm`):
 * `len(str(text)) * pt2mm(size) * 0.56`; `undefined` = "". Satu-satunya
 * definisi (core, build, layout-a/b/c; S84 #7).
 */
export function estTextPt(text: unknown, sizePt: number): number {
  return pyLen(pyStr(text === undefined ? "" : text)) * pt2mm(sizePt) * 0.56;
}

/** Perkiraan lebar teks (mm) dari ukuran peran: len x pt2mm(size) x 0,56. */
export function estTextMm(text: unknown, roleName: string): number {
  return estTextPt(text, role(roleName).size);
}
