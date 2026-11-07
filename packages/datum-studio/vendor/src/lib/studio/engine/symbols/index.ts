/**
 * engine/symbols (I21, 01_specs.md §8.2) — pustaka simbol DATUM, diisi S31.
 *
 * Port TypeScript HS `datumsimbol.py` (41 simbol: iec 16, isa 12, sec 7,
 * mil 6; lembar per dialek setinggi blok teks) ditambah `ports_in_mm` dari RL
 * `datum_symbols.py render` (:577). Geometri, urutan elemen, viewBox, tebal
 * garis dan warna setara Python (paritas kelas SY, research/06:259).
 *
 * Atribut peran (N2): akar SVG simbol dan grup petak di lembar membawa
 * `data-mark="node"` dan `data-symbol="<id>"`; akar lembar membawa
 * `data-dialect`. Atribut tidak menambah elemen, jadi jumlah elemen tetap
 * identik dengan acuan. Deterministik: keluaran hanya fungsi masukan.
 *
 * ID kanonis `dialek:nama` bertanda hubung (E-11). Alias garis bawah Rev F
 * (RL :559-561) dan huruf besar diterima lalu dikanonkan, tidak pernah didaftar.
 *
 * Ukuran lembar TURUNAN (D-158/D-245 H1): lebar = lebar figur blok (kelas templat;
 * A4 bentang 166 mm), tinggi = `grid.textBlockHeightMm` (A4 potret 247 mm), lewat
 * `SymbolSheetOptions.widthMm/heightMm`. Tata letak dihitung pada ukuran nyata itu
 * (tanpa skala pasca-render). Tanpa opsi = bawaan registri `grid.fullSpanMm` /
 * `grid.textBlockHeightMm` (profil kanonik A4): keluaran lama byte-identik.
 */
import { SYMBOL_DIALECTS, type SymbolDialect } from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { PARAMS_BY_KEY } from "../../params";
import { DIALECT_LIBS, DIALECT_NOTES } from "./dialects";
import { portsMm } from "./ports";
import { fitSheetMaxCols, symbolSheetFitSvg } from "./sheet-fit";
export { symbolLegendName } from "./sheet-fit";
import { CELL, g, HAIR, INK200, INK400, INK900, LABEL_MM, label, num, PAPER, r, round2, xmlEscape } from "./primitives";

/** Urutan `--list` HS (:366-371): dialek terurut, lalu id terurut. */
export const SYMBOL_IDS: readonly string[] = Object.freeze(
  [...SYMBOL_DIALECTS]
    .sort()
    .flatMap((d) => Object.keys(DIALECT_LIBS[d]).sort()),
);
export const SYMBOL_IDS_COUNT = 41;

/** Hitungan per dialek (research/03:288): iec 16, isa 12, sec 7, mil 6. */
export const SYMBOL_COUNTS_BY_DIALECT: Readonly<Record<SymbolDialect, number>> = Object.freeze({
  iec: Object.keys(DIALECT_LIBS.iec).length,
  isa: Object.keys(DIALECT_LIBS.isa).length,
  sec: Object.keys(DIALECT_LIBS.sec).length,
  mil: Object.keys(DIALECT_LIBS.mil).length,
});

const ALIASES: Readonly<Record<string, string>> = {
  "isa:shared_field": "isa:shared-field",
  "isa:valve_diaphragm": "isa:valve-diaphragm",
  "isa:valve_motor": "isa:valve-motor",
  "isa:valve_solenoid": "isa:valve-solenoid",
  "mil:friend_air": "mil:friend-air",
  "mil:hostile_air": "mil:hostile-air",
};

const SVG_NS = "http://www.w3.org/2000/svg";
/** Kunci turunan ukuran lembar bawaan: lebar (HS :318 = bentang A4) dan tinggi blok teks (HS :322, E-18). */
export const SYMBOL_SHEET_WIDTH_PARAM = "grid.fullSpanMm";
export const SYMBOL_SHEET_HEIGHT_PARAM = "grid.textBlockHeightMm";
const HEAD_H = 18.0;
const MAX_COLS = 6;
/** Acuan HS lebar bungkus catatan: 56 karakter pada lebar isi 158 mm (166 - 8). */
const HS_NOTE_REF_INNER_MM = 158.0;
const HS_NOTE_REF_CHARS = 56;
/** Ukuran huruf catatan HS (`LABEL_MM - 0.5`, mm) yang menjadi acuan 56 karakter itu. */
const HS_NOTE_REF_SIZE_MM = LABEL_MM - 0.5;
const MM_PER_PT = 25.4 / 72;

/**
 * Swarm patch (row 150c, C144 A): catatan kepala dan dua label petak lembar HS memakai skala
 * Caption DATUM 7,6 / 11 pt Cond (manual Rev A ID Tabel 8.2, LEMBAR 50 DARI 98; registri
 * `type.scale.caption.size` / `.leading`). HS menulis catatan 5,5 mm pada jarak baris 3,6 mm dan
 * label petak 6 + 5 mm pada 3,6 mm: baris saling menimpa saat dicetak (implementation/118). Jarak
 * baris >= ukuran huruf kini dijamin skala; byte-paritas dengan `sheet_svg` HS sengaja dilepas
 * (C23, implementation/119_row150c_c23_recorded_diff.json).
 */
function captionScaleMm(): { size: number; lead: number } {
  const size = PARAMS_BY_KEY.get("type.scale.caption.size")?.default;
  const lead = PARAMS_BY_KEY.get("type.scale.caption.leading")?.default;
  if (typeof size !== "number" || typeof lead !== "number" || !(size > 0) || !(lead >= size)) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "engine/symbols: skala caption (type.scale.caption.size/leading) tidak terbaca", {
      size: size ?? null,
      leading: lead ?? null,
    });
  }
  return { size: size * MM_PER_PT, lead: lead * MM_PER_PT };
}
const CAPTION = captionScaleMm();
/** Garis dasar baris catatan pertama (HS :337) dan label id petak di bawah sel (HS :349), mm. */
const NOTE_Y0 = 12;
const CELL_ID_DY = 4;

function isDialect(d: string): d is SymbolDialect {
  return (SYMBOL_DIALECTS as readonly string[]).includes(d);
}

/** Kanonkan id (trim, huruf kecil, alias) lalu pastikan dikenal; selain itu SCHEMA_INVALID. */
export function canonicalSymbolId(id: string): string {
  const k = String(id).trim().toLowerCase();
  const canon = ALIASES[k] ?? k;
  const d = canon.split(":", 1)[0];
  if (!isDialect(d) || !Object.prototype.hasOwnProperty.call(DIALECT_LIBS[d], canon)) {
    throw new StudioEngineError("SCHEMA_INVALID", `Simbol tidak dikenal: ${String(id)}`, {
      id: String(id),
      known: SYMBOL_IDS_COUNT,
    });
  }
  return canon;
}

function draw(canon: string): string {
  const d = canon.split(":", 1)[0] as SymbolDialect;
  return DIALECT_LIBS[d][canon]();
}

/**
 * Swarm patch (row 124, CP-45): canonical id, dialect and the bare drawing (24 x 24 mm cell, no
 * root element) of one symbol, so the diagram engine can draw the symbol a node specifies.
 * Unknown id = SCHEMA_INVALID, as {@link symbolSvg}.
 */
export function symbolBody(id: string): { id: string; dialect: SymbolDialect; markup: string; cellMm: number } {
  const canon = canonicalSymbolId(id);
  return { id: canon, dialect: canon.split(":", 1)[0] as SymbolDialect, markup: draw(canon), cellMm: CELL };
}

/** Satu simbol, SVG 24 x 24 mm (HS `symbol_svg`, :297-303). */
export function symbolSvg(id: string): string {
  const canon = canonicalSymbolId(id);
  const s = num(CELL);
  return (
    `<svg xmlns="${SVG_NS}" width="${s}mm" height="${s}mm" viewBox="0 0 ${s} ${s}" ` +
    `data-mark="node" data-symbol="${xmlEscape(canon)}">${draw(canon)}</svg>`
  );
}

/**
 * Setara `textwrap.wrap(text, width)` Python untuk teks catatan: potong di
 * spasi dan di tanda hubung di antara huruf (aturan `wordsep_re`), isi rakus.
 */
function wrapText(textIn: string, width: number): string[] {
  const chunks: string[] = [];
  for (const tok of textIn.split(/(\s+)/)) {
    if (tok === "") continue;
    if (/^\s+$/.test(tok)) {
      chunks.push(" ");
      continue;
    }
    // Pecah setelah '-' bila diapit >= 2 huruf di kiri dan >= 2 huruf di kanan.
    let start = 0;
    for (let i = 0; i < tok.length; i++) {
      if (tok[i] !== "-") continue;
      const left = tok.slice(Math.max(0, i - 2), i);
      const right = tok.slice(i + 1, i + 3);
      if (i - start >= 2 && /^\p{L}{2}$/u.test(left) && /^\p{L}{2}$/u.test(right)) {
        chunks.push(tok.slice(start, i + 1));
        start = i + 1;
      }
    }
    chunks.push(tok.slice(start));
  }
  const lines: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const ch of chunks) {
    if (ch === " " && cur.length === 0) continue;
    if (len + ch.length > width && cur.length > 0) {
      while (cur.length > 0 && cur[cur.length - 1] === " ") len -= cur.pop()!.length;
      lines.push(cur.join(""));
      cur = [];
      len = 0;
      if (ch === " ") continue;
    }
    cur.push(ch);
    len += ch.length;
  }
  while (cur.length > 0 && cur[cur.length - 1] === " ") cur.pop();
  if (cur.length > 0) lines.push(cur.join(""));
  return lines;
}

/** Opsi lembar simbol (IP-42a, D-137 opsi B; ukuran turunan D-245 H1). */
export interface SymbolSheetOptions {
  /**
   * true = lembar isi-pas RL Garis B `datum_symbols.py --sheet` (satu SVG,
   * tinggi mengikuti isi, kolom bawaan sebanyak yang muat (A4 6), label id + nama Indonesia);
   * false/tidak diisi = lembar HS setinggi blok teks (keluaran lama byte-identik).
   */
  fit?: boolean;
  /** Lebar lembar (mm) = lebar figur blok turunan; tidak diisi = bawaan registri `grid.fullSpanMm`. */
  widthMm?: number;
  /** Tinggi lembar HS (mm) = `grid.textBlockHeightMm` efektif; tidak diisi = bawaan registri. */
  heightMm?: number;
}

function sheetDim(v: number | undefined, key: string, what: string): number {
  const dim = v !== undefined ? v : PARAMS_BY_KEY.get(key)?.default;
  if (typeof dim !== "number" || !Number.isFinite(dim) || dim <= 0) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `engine/symbols: ${what} lembar simbol tidak terbaca (${key})`, { key, value: dim ?? null });
  }
  return dim;
}

/** Kolom HS terbanyak yang muat: lebar petak >= sel 24 mm (A4 166 mm: 6 = MAX_COLS). */
function hsMaxCols(sheetW: number): number {
  return Math.min(MAX_COLS, Math.floor((sheetW - 8.0) / CELL));
}

/**
 * Lembar satu dialek (HS `sheet_svg`, :313-355): kepala + petak berlabel di
 * bawah, dipagasi pada blok teks. Mengembalikan satu SVG per halaman.
 * Dengan `opts.fit` satu lembar isi-pas RL Garis B (`./sheet-fit`).
 * `cols` tidak diisi = 3 (HS) atau sebanyak yang muat (RL; A4 6). `cols` melebihi
 * kolom yang muat pada lebar turunan dibatasi ke kolom yang muat (pada A4 batasnya
 * = MAX_COLS, jadi perilaku lama tidak berubah); petak tidak pernah keluar lembar.
 */
export function symbolSheetSvg(d: SymbolDialect, colsIn?: number, opts: SymbolSheetOptions = {}): string[] {
  const fit = opts.fit === true;
  if (!isDialect(d)) {
    throw new StudioEngineError("SCHEMA_INVALID", `Dialek simbol tidak dikenal: ${String(d)}`, { dialect: String(d) });
  }
  if (colsIn !== undefined && (!Number.isInteger(colsIn) || colsIn < 1 || colsIn > MAX_COLS)) {
    throw new StudioEngineError("SCHEMA_INVALID", `Kolom lembar simbol harus bilangan bulat 1..${MAX_COLS}`, { cols: colsIn });
  }
  const sheetW = sheetDim(opts.widthMm, SYMBOL_SHEET_WIDTH_PARAM, "lebar");
  const maxCols = Math.min(MAX_COLS, fit ? fitSheetMaxCols(sheetW) : hsMaxCols(sheetW));
  if (maxCols < 1) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `engine/symbols: lebar lembar ${sheetW} mm tidak memuat satu petak simbol`, { widthMm: sheetW });
  }
  const cols = Math.min(colsIn ?? (fit ? maxCols : 3), maxCols);
  if (fit) return [symbolSheetFitSvg(d, cols, sheetW)];
  const sheetH = sheetDim(opts.heightMm, SYMBOL_SHEET_HEIGHT_PARAM, "tinggi");
  const lib = DIALECT_LIBS[d];
  const ids = Object.keys(lib).sort();
  const colW = (sheetW - 8.0) / cols;
  const cellH = CELL + 10.0;
  const perPage = Math.max(1, Math.floor((sheetH - HEAD_H - 12) / cellH));
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += perPage * cols) chunks.push(ids.slice(i, i + perPage * cols));
  // Lebar bungkus catatan sebanding lebar isi (HS: 56 karakter pada 158 mm) dan berbanding terbalik
  // dengan ukuran huruf (row 150c: ukuran caption, lebar baris dalam mm tetap ukuran HS).
  const noteChars = Math.max(
    16,
    Math.floor((HS_NOTE_REF_CHARS * (HS_NOTE_REF_SIZE_MM / CAPTION.size) * (sheetW - 8.0)) / HS_NOTE_REF_INNER_MM),
  );
  const noteLines = wrapText(DIALECT_NOTES[d], noteChars).slice(0, 2);
  const W = num(sheetW);
  const H = num(sheetH);
  const inset = round2((colW - CELL) / 2.0);
  const lx = round2(colW / 2.0);

  return chunks.map((chunk, pi) => {
    const parts: string[] = [
      `<svg xmlns="${SVG_NS}" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" data-dialect="${d}">`,
      `<rect x="0" y="0" width="${W}" height="${H}" fill="${PAPER}"/>`,
      label(`PUSTAKA SIMBOL ${d.toUpperCase()} LEMBAR ${pi + 1}/${chunks.length}`, 4, 6, LABEL_MM + 1.0, INK900, "start", true),
      g(4, 8, sheetW - 4, 8, INK200, HAIR),
    ];
    noteLines.forEach((ln, li) => parts.push(label(ln, 4, NOTE_Y0 + li * CAPTION.lead, CAPTION.size, INK400)));
    chunk.forEach((sid, j) => {
      const row = Math.floor(j / cols);
      const cidx = j % cols;
      const ox = 4 + cidx * colW;
      const oy = HEAD_H + row * cellH;
      parts.push(
        `<g transform="translate(${num(round2(ox))},${num(round2(oy))})" data-mark="node" data-symbol="${xmlEscape(sid)}">`,
      );
      parts.push(r(inset, 0, CELL, CELL, INK200, HAIR));
      parts.push(`<g transform="translate(${num(inset)},0)">${lib[sid]()}</g>`);
      parts.push(label(sid, lx, CELL + CELL_ID_DY, CAPTION.size, INK900, "middle", true));
      parts.push(label("geometri konvensional", lx, CELL + CELL_ID_DY + CAPTION.lead, CAPTION.size, INK400, "middle"));
      parts.push("</g>");
    });
    parts.push(label("SUMBER katalog-simbol.md SIM-nn · datumsimbol.py v1.0", 4, sheetH - 4, LABEL_MM - 1, INK400));
    parts.push("</svg>");
    return parts.join("");
  });
}

/** Terminal sambungan mm pada petak simbol 24 x 24 mm (RL `render` ports, :587). */
export function symbolPortsMm(id: string): Array<{ name: string; x: number; y: number }> {
  return portsMm(canonicalSymbolId(id));
}
