/**
 * IMPL-W3 butir 3 (D-534 akar 3): kelonggaran skema alat `write`. Sebelum validasi ajv, bentuk varian yang maksudnya
 * jelas dipetakan ke bentuk kanonik (setiap pemetaan = satu peringatan) dan properti tak dikenal dibuang dengan
 * peringatan, bukan ditolak. Tidak ada isi yang dikarang; nilai tidak pernah dipindah lintas dokumen. Batas ukuran
 * skema (string, larik, jumlah blok) tetap ditegakkan ajv sesudahnya. Kunci yang dibuang hanya dicetak sebagai token
 * aman (`tok`). Murni: tanpa I/O.
 */
import { McpToolError } from "./safety";
import { isRecord, tok, type Args, type ToolWarning } from "./tool-kit";

type Rec = Record<string, unknown>;

/** Penampung peringatan: kunci sejenis digabung agar hasil tetap ringkas. */
class Notes {
  private readonly ignored = new Set<string>();
  private readonly mapped = new Set<string>();
  private readonly coalesced: string[] = [];
  readonly list: ToolWarning[] = [];
  ignore(where: string, key: string): void {
    this.ignored.add(`${where}.${tok(key, "(kunci-tak-aman)")}`);
  }
  map(from: string, to: string): void {
    this.mapped.add(`${from} -> ${to}`);
  }
  coalesce(where: string): void {
    this.coalesced.push(where);
  }
  done(): ToolWarning[] {
    if (this.coalesced.length > 0) this.list.push({ code: "ROWS_COALESCED_TO_TABLE", message: `larik datar berurutan selebar sama digabung menjadi tabel (baris pertama = judul kolom): ${this.coalesced.slice(0, 12).join("; ")}. Bentuk kanonik tabel = satu blok [[judul...], [baris...]]` });
    if (this.mapped.size > 0) this.list.push({ code: "ARG_MAPPED", message: `bentuk varian dipetakan: ${[...this.mapped].slice(0, 12).join("; ")}` });
    if (this.ignored.size > 0) this.list.push({ code: "ARG_IGNORED", message: `properti tak dikenal diabaikan (tidak ditolak): ${[...this.ignored].slice(0, 12).join(", ")}` });
    return this.list;
  }
}

/** Ganti nama kunci alias -> kanonik bila kanonik belum ada. */
function alias(o: Rec, names: readonly string[], to: string, n: Notes, where: string): void {
  if (o[to] !== undefined) return;
  for (const k of names) {
    if (o[k] !== undefined) {
      o[to] = o[k];
      delete o[k];
      n.map(`${where}.${k}`, to);
      return;
    }
  }
}

/** Buang properti yang tidak ada di `allowed` (peringatan, bukan penolakan). */
function prune(o: Rec, allowed: readonly string[], n: Notes, where: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) {
      delete o[k];
      n.ignore(where, k);
    }
  }
}

const cell = (c: unknown): unknown => (typeof c === "string" || typeof c === "number" ? c : c === null || c === undefined ? "" : typeof c === "boolean" ? String(c) : JSON.stringify(c));
const isRowsLike = (v: unknown): v is unknown[][] => Array.isArray(v) && v.length > 0 && v.every((r) => Array.isArray(r));
const rows = (v: unknown[][]): unknown[][] => v.map((r) => r.map(cell));
const textOf = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

/**
 * IMPL-W7 (ronde 10 R12B): larik datar skalar dengan >= 2 sel. Agen yang menjatuhkan satu tingkat kurung tabel mengirim
 * setiap baris sebagai blok sendiri; dua atau lebih blok seperti ini BERURUTAN dengan lebar sama = satu tabel.
 */
const isFlatRow = (b: unknown): b is Array<string | number> => Array.isArray(b) && b.length >= 2 && b.every((x) => typeof x === "string" || typeof x === "number");

/**
 * IMPL-W7: gabungkan run >= 2 larik datar berurutan selebar sama menjadi satu blok tabel (Cell[][], urutan baris tetap,
 * baris pertama = judul kolom seperti blok tabel biasa). Perubahan lebar memutus run (tiap run digabung sendiri); larik
 * bersarang, larik lebar 1, dan blok lain tidak ikut. Larik datar tunggal tidak disentuh (tetap jadi daftar di
 * `normalizeBlock`). Mengembalikan pasangan blok + indeks asal (untuk jalur peringatan).
 */
function coalesceRows(blocks: readonly unknown[], n: Notes, where: string): Array<{ b: unknown; k: number }> {
  const out: Array<{ b: unknown; k: number }> = [];
  for (let i = 0; i < blocks.length; ) {
    const first = blocks[i];
    if (isFlatRow(first)) {
      let j = i + 1;
      while (j < blocks.length && isFlatRow(blocks[j]) && (blocks[j] as unknown[]).length === first.length) j++;
      if (j - i >= 2) {
        out.push({ b: (blocks.slice(i, j) as unknown[][]).map((r) => r.map(cell)), k: i });
        n.coalesce(`${where}[${i}..${j - 1}] ${j - i} baris x ${first.length} kolom`);
        i = j;
        continue;
      }
    }
    out.push({ b: first, k: i });
    i++;
  }
  return out;
}

const TABLE_KEYS = ["table", "caption", "source", "unit"];
const CHART_KEYS = ["type", "categories", "series", "caption", "source", "unit", "stacked"];

/** Satu blok -> bentuk kanonik (string | rows | {table} | {chart} | {list} | {subheading} | {ref}). */
export function normalizeBlock(b: unknown, n: Notes, where: string): unknown {
  if (typeof b === "number") return String(b);
  if (typeof b === "string") return b;
  if (Array.isArray(b)) {
    if (isRowsLike(b)) return rows(b);
    if (b.every((x) => typeof x === "string" || typeof x === "number")) {
      n.map(`${where}[teks...]`, "{list}");
      return { list: b.map(String) };
    }
    return b;
  }
  if (!isRecord(b)) return b;
  const o: Rec = { ...b };
  const type = typeof o.type === "string" ? o.type.trim().toLowerCase() : null;
  // Paragraf: {paragraph|text|p|para|content: "..."} (boleh dengan type paragraph/text).
  for (const k of ["paragraph", "text", "p", "para", "content", "body"]) {
    const t = textOf(o[k]);
    if (t !== null && (type === null || type === "paragraph" || type === "text" || type === "p") && o.table === undefined && o.rows === undefined && o.list === undefined && o.items === undefined) {
      n.map(`${where}.${k}`, "paragraf");
      return t;
    }
  }
  // Sub-judul: {heading|title|subheading} tanpa isi lain, atau type heading/subheading.
  const sub = textOf(o.subheading) ?? ((type === "heading" || type === "subheading" || Object.keys(o).every((k) => ["heading", "title", "type", "level"].includes(k))) ? (textOf(o.heading) ?? textOf(o.title) ?? textOf(o.text)) : null);
  if (sub !== null && o.table === undefined && o.rows === undefined && o.chart === undefined && o.list === undefined && o.items === undefined) {
    if (o.subheading === undefined) n.map(`${where}.heading`, "{subheading}");
    return { subheading: sub };
  }
  if (o.chart !== undefined || type === "chart") {
    const c: Rec = isRecord(o.chart) ? { ...o.chart } : { ...o };
    alias(c, ["labels", "x", "kategori"], "categories", n, `${where}.chart`);
    alias(c, ["data", "datasets", "seri"], "series", n, `${where}.chart`);
    for (const k of ["caption", "source", "unit", "stacked"]) if (o[k] !== undefined && c[k] === undefined && o.chart !== undefined) {
      c[k] = o[k];
      n.map(`${where}.${k}`, `chart.${k}`);
    }
    if (Array.isArray(c.series)) c.series = c.series.map((s) => (isRecord(s) ? (() => { const x: Rec = { ...s }; alias(x, ["label", "nama"], "name", n, `${where}.series`); alias(x, ["data", "nilai"], "values", n, `${where}.series`); prune(x, ["name", "values"], n, `${where}.series`); return x; })() : s));
    if (Array.isArray(c.categories)) c.categories = c.categories.map((x) => (typeof x === "string" || typeof x === "number" ? x : String(x)));
    if (c.type === "chart") delete c.type;
    prune(c, CHART_KEYS, n, `${where}.chart`);
    return { chart: c };
  }
  if (o.ref !== undefined) {
    prune(o, ["ref"], n, where);
    return o;
  }
  // Tabel: {rows}, {table: {rows, header, caption}}, {header, rows}, type table.
  if (o.table !== undefined || o.rows !== undefined || type === "table") {
    const inner: Rec = isRecord(o.table) ? { ...o.table } : {};
    const src: Rec = { ...o, ...inner };
    alias(src, ["title", "judul", "keterangan"], "caption", n, `${where}.table`);
    alias(src, ["sumber"], "source", n, `${where}.table`);
    alias(src, ["satuan"], "unit", n, `${where}.table`);
    let body = isRowsLike(o.table) ? o.table : isRowsLike(src.rows) ? src.rows : isRowsLike(src.data) ? src.data : null;
    const header = Array.isArray(src.header) ? src.header : Array.isArray(src.headers) ? src.headers : Array.isArray(src.columns) && (src.columns as unknown[]).every((x) => typeof x === "string") ? src.columns : null;
    if (body !== null && header !== null) body = [header as unknown[], ...body];
    if (body === null) return b;
    if (!isRowsLike(o.table)) n.map(`${where}.${isRecord(o.table) ? "table{rows}" : "rows"}`, "{table}");
    const out: Rec = { table: rows(body) };
    for (const k of ["caption", "source", "unit"]) if (textOf(src[k]) !== null) out[k] = textOf(src[k]);
    for (const k of Object.keys(src)) if (![...TABLE_KEYS, "rows", "data", "header", "headers", "columns", "type"].includes(k)) n.ignore(`${where}.table`, k);
    return out;
  }
  // Daftar: {items|bullets|list} (+ ordered/numbered).
  if (o.list !== undefined || o.items !== undefined || o.bullets !== undefined || type === "list") {
    alias(o, ["items", "bullets"], "list", n, where);
    alias(o, ["numbered"], "ordered", n, where);
    if (Array.isArray(o.list)) o.list = o.list.map((x) => (typeof x === "string" ? x : isRecord(x) && typeof x.text === "string" ? x.text : String(x)));
    if (typeof o.ordered !== "boolean") delete o.ordered;
    prune(o, ["list", "ordered"], n, where);
    return o;
  }
  return o;
}

/** Bagian: {heading|title|name, blocks|content|paragraphs|body}. */
function normalizeSection(s: unknown, i: number, n: Notes): unknown {
  if (!isRecord(s)) return s;
  const o: Rec = { ...s };
  const where = `sections[${i}]`;
  alias(o, ["title", "name", "judul", "header"], "heading", n, where);
  alias(o, ["content", "paragraphs", "body", "isi", "items"], "blocks", n, where);
  if (typeof o.blocks === "string" || isRecord(o.blocks)) {
    o.blocks = [o.blocks];
    n.map(`${where}.blocks`, "[blocks]");
  }
  if (o.blocks === undefined) o.blocks = [];
  if (Array.isArray(o.blocks)) {
    // Bagian bersarang {heading, blocks} di dalam blok -> {subheading} + bloknya (diratakan).
    o.blocks = coalesceRows(o.blocks, n, `${where}.blocks`).flatMap(({ b, k }) => {
      if (isRecord(b) && Array.isArray(b.blocks) && (textOf(b.heading) ?? textOf(b.title)) !== null) {
        n.map(`${where}.blocks[${k}]{heading,blocks}`, "{subheading} + blok");
        const inner = `${where}.blocks[${k}].blocks`;
        return [{ subheading: (textOf(b.heading) ?? textOf(b.title)) as string }, ...coalesceRows(b.blocks as unknown[], n, inner).map(({ b: x, k: j }) => normalizeBlock(x, n, `${inner}[${j}]`))];
      }
      return [normalizeBlock(b, n, `${where}.blocks[${k}]`)];
    });
  }
  if (typeof o.heading === "number") o.heading = String(o.heading);
  prune(o, ["heading", "blocks"], n, where);
  return o;
}

const META_MAX = 2000;

/** Prapemrosesan `studio_write`. Mengubah `a` di tempat; mengembalikan peringatan. */
export function normalizeWriteArgs(a: Args): ToolWarning[] {
  const n = new Notes();
  alias(a, ["doc_key", "key", "documentKey"], "docKey", n, "args");
  alias(a, ["missionFolder", "mission_folder", "folder"], "mission", n, "args");
  alias(a, ["chapters", "content", "bab"], "sections", n, "args");
  alias(a, ["templateSlug", "template_slug"], "template", n, "args");
  normalizeMetaArg(a, n);
  if (typeof a.title === "string" && a.title.trim() === "") delete a.title;
  if (Array.isArray(a.sections)) a.sections = a.sections.map((s, i) => normalizeSection(s, i, n));
  prune(a, ["mission", "docKey", "template", "title", "meta", "sections", "agentId", "detail"], n, "args");
  return n.done();
}

/** Prapemrosesan `studio_edit`. */
/** meta datar: angka/boolean -> teks, nilai lain dibuang, panjang dibatasi (studio_write dan saluran meta studio_edit). */
function normalizeMetaArg(a: Args, n: Notes): void {
  if (isRecord(a.meta)) {
    const meta: Rec = {};
    for (const [k, v] of Object.entries(a.meta)) {
      if (typeof v === "string") meta[k] = v.length > META_MAX ? v.slice(0, META_MAX) : v;
      else if (typeof v === "number" || typeof v === "boolean") {
        meta[k] = String(v);
        n.map(`meta.${tok(k, "?")}`, "teks");
      } else n.ignore("meta", k);
    }
    a.meta = meta;
  } else if (a.meta !== undefined) {
    delete a.meta;
    n.ignore("args", "meta");
  }
}

/** IMPL-W8 B: butir edits berbentuk tepat `{ meta: {...} }` (satu kunci, nilai objek). */
const isMetaItem = (e: unknown): e is { meta: Rec } => isRecord(e) && Object.keys(e).length === 1 && isRecord(e.meta);
const sameMetaValue = (x: unknown, y: unknown): boolean =>
  (x === null || typeof x !== "object") && (y === null || typeof y !== "object") ? String(x) === String(y) : JSON.stringify(x) === JSON.stringify(y);

/**
 * IMPL-W8 B (R11B): agen menaruh `{ meta: { status } }` sebagai butir `edits`. Butir berbentuk persis itu diangkat ke
 * `meta` puncak (saluran meta IMPL-W4); medan sama bernilai beda (puncak vs butir, atau antarbutir) -> INVALID_ARGUMENT
 * (dilempar sebelum jaringan, 0 tulis). `edits` yang habis dihapus (suntingan meta saja). Bentuk lain tidak disentuh.
 */
function liftMetaItems(a: Args, n: Notes): void {
  if (!Array.isArray(a.edits) || (a.meta !== undefined && !isRecord(a.meta))) return;
  const items = a.edits.filter(isMetaItem);
  if (items.length === 0) return;
  const meta: Rec = isRecord(a.meta) ? { ...a.meta } : {};
  for (const it of items) {
    for (const [k, v] of Object.entries(it.meta)) {
      if (k === "__proto__") continue;
      if (meta[k] !== undefined && !sameMetaValue(meta[k], v)) {
        throw new McpToolError("INVALID_ARGUMENT", `meta bentrok: medan ${tok(k, "(kunci-tak-aman)")} diberi nilai berbeda di meta dan di butir { meta } edits; kirim satu nilai di argumen meta. Tidak ada yang ditulis`);
      }
      meta[k] = v;
    }
  }
  a.meta = meta;
  a.edits = a.edits.filter((e) => !isMetaItem(e));
  if ((a.edits as unknown[]).length === 0) delete a.edits;
  n.list.push({ code: "META_LIFTED_FROM_EDITS", message: `${items.length} butir { meta } di edits dipindah ke argumen meta; kirim meta sebagai argumen meta, bukan butir edits` });
}

export function normalizeEditArgs(a: Args): ToolWarning[] {
  const n = new Notes();
  alias(a, ["changes", "patches", "patch", "edit"], "edits", n, "args");
  alias(a, ["doc_key", "key"], "docKey", n, "args");
  if (isRecord(a.edits)) a.edits = [a.edits];
  liftMetaItems(a, n);
  // IMPL-W4 butir 2: saluran meta (status/verdict/... laporan kerja; title/number/rev/date/... dokumen klien).
  normalizeMetaArg(a, n);
  if (Array.isArray(a.edits)) {
    a.edits = a.edits.map((e, i) => {
      if (!isRecord(e)) return e;
      const o: Rec = { ...e };
      const where = `edits[${i}]`;
      if (o.figure !== undefined) {
        prune(o, ["figure", "chart"], n, where);
        return o;
      }
      // IMPL-W5 E1: { section, append } (blok/larik blok; bentuk varian blok dipetakan seperti studio_write).
      if (o.append !== undefined || (o.blocks !== undefined && o.find === undefined && o.after === undefined)) {
        alias(o, ["blocks"], "append", n, where);
        alias(o, ["heading", "chapter", "bab", "under"], "section", n, where);
        const v = o.append;
        const rowsLike = Array.isArray(v) && v.length > 0 && v.every((r) => Array.isArray(r) && r.every((c) => typeof c === "string" || typeof c === "number"));
        // IMPL-W7: larik yang SELURUHNYA baris (rowsLike) tetap satu tabel seperti dulu; selain itu run baris datar digabung.
        o.append = Array.isArray(v) && !rowsLike ? coalesceRows(v, n, `${where}.append`).map(({ b, k }) => (typeof b === "string" ? b : normalizeBlock(b, n, `${where}.append[${k}]`))) : typeof v === "string" || rowsLike ? v : normalizeBlock(v, n, `${where}.append`);
        if (typeof o.section === "number") o.section = String(o.section);
        prune(o, ["section", "append"], n, where);
        return o;
      }
      // IMPL-W5 E2: { section, addRow, table? }.
      if (o.addRow !== undefined || o.addRows !== undefined || ((o.rows !== undefined || o.row !== undefined) && o.column === undefined && o.cell === undefined)) {
        alias(o, ["addRows", "rows", "row"], "addRow", n, where);
        alias(o, ["heading", "chapter", "bab"], "section", n, where);
        if (Array.isArray(o.addRow)) o.addRow = (o.addRow as unknown[]).map((r) => (Array.isArray(r) ? r.map(cell) : cell(r)));
        if (typeof o.table === "string" && /^\d{1,3}$/.test(o.table)) o.table = Number(o.table);
        if (typeof o.section === "number") o.section = String(o.section);
        prune(o, ["section", "addRow", "table"], n, where);
        return o;
      }
      if (o.pid !== undefined) {
        alias(o, ["offset", "position", "pos"], "at", n, where);
        alias(o, ["len", "count"], "length", n, where);
        alias(o, ["expected", "current", "old"], "expect", n, where);
        alias(o, ["new", "with", "to", "replacement", "value", "text"], "replace", n, where);
        for (const k of ["at", "length"]) if (typeof o[k] === "string" && /^\d{1,7}$/.test(o[k] as string)) o[k] = Number(o[k]);
        prune(o, ["pid", "at", "length", "replace", "expect"], n, where);
        return o;
      }
      if (o.cell === undefined && o.row !== undefined && o.column !== undefined) {
        o.cell = { ...(o.section !== undefined ? { section: o.section } : {}), row: o.row, column: o.column };
        delete o.row;
        delete o.column;
        delete o.section;
        n.map(`${where}.row/column`, "cell");
      }
      if (o.cell !== undefined) {
        alias(o, ["replace", "text", "new", "to"], "value", n, where);
        if (typeof o.value === "number") o.value = String(o.value);
        if (isRecord(o.cell)) {
          const c: Rec = { ...o.cell };
          alias(c, ["col", "header", "kolom"], "column", n, `${where}.cell`);
          alias(c, ["key", "baris"], "row", n, `${where}.cell`);
          for (const k of ["row", "column", "section"]) if (typeof c[k] === "number") c[k] = String(c[k]);
          prune(c, ["section", "row", "column"], n, `${where}.cell`);
          o.cell = c;
        }
        prune(o, ["cell", "value"], n, where);
        return o;
      }
      if (o.after !== undefined || o.insert !== undefined) {
        alias(o, ["text", "content", "paragraph"], "insert", n, where);
        prune(o, ["after", "insert", "section"], n, where);
        return o;
      }
      alias(o, ["old", "search", "from", "text"], "find", n, where);
      alias(o, ["new", "with", "to", "replacement", "value"], "replace", n, where);
      if (typeof o.replace === "number") o.replace = String(o.replace);
      if (o.occurrence === true || o.occurrence === "every" || o.all === true) {
        o.occurrence = "all";
        delete o.all;
      }
      if (o.occurrence !== undefined && o.occurrence !== "all") {
        delete o.occurrence;
        n.ignore(where, "occurrence");
      }
      prune(o, ["find", "replace", "section", "occurrence"], n, where);
      return o;
    });
  }
  prune(a, ["documentId", "mission", "docKey", "edits", "meta", "agentId", "adoptExisting", "detail"], n, "args");
  return n.done();
}
