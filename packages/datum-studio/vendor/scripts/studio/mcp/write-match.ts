/**
 * IMPL-W3 butir 2 (D-534 akar 2): pencocokan `studio_edit` yang memaafkan + penargetan. Dipakai jalur laporan kerja
 * (`write-edit.ts`) dan dokumen klien (`write-client-edit.ts`) atas satuan SATU dokumen yang sudah dibaca (tidak pernah
 * lintas dokumen/pemilik). Tingkat: (1) persis, spasi dinormalkan; (2) tanpa markah inline (khusus laporan kerja);
 * (3) samar: huruf kecil, spasi, kutip/tanda pisah pintar vs lurus, markah emphasis, escape `\`, pemisah ribuan
 * (`1,000` = `1.000` = `1000`). Tingkat pertama yang mengenai menang. Lebih dari satu kecocokan tanpa
 * `occurrence: "all"` -> TEXT_AMBIGUOUS + kandidat (section/row/column) masing-masing dengan jendela unik >= 3 kata
 * (`find` siap salin) atau alamat `cell`; nol -> TEXT_NOT_FOUND + 3 kandidat terdekat.
 * Butir 14b: `find` bertanda baca dicocokkan PERSIS (hanya spasi dinormalkan dan escape `\` Markdown dibuang), tanpa
 * normalisasi kutip/tanda pisah/angka, agar tanda yang sedang diperbaiki tidak terhapus.
 * Murni: tanpa I/O.
 */
import { McpToolError } from "./safety";
import { normalize, plainOf, PLAIN_MAX } from "./write-edit";

export interface MatchUnit {
  text: string;
  /** judul section/bab satuan ("" = kepala/record). */
  section: string;
  /** nama bagian dokumen (mis. "bab 2", "record", "slot cover"). */
  part: string;
  kind: string;
  /** sel tabel: teks semua sel di baris ini (untuk penargetan row). */
  rowCells?: string[];
  /** sel tabel: judul kolom sel ini. */
  column?: string;
  /** sel tabel: baris judul (tidak pernah menjadi sasaran row). */
  headerRow?: boolean;
  /** lewati tingkat tanpa-markah (teks klien sudah polos). */
  noPlain?: boolean;
}

export type Tier = "exact" | "plain" | "fuzzy";
export interface MatchHit {
  index: number;
  /** rentang [awal, akhir) di teks asli satuan; null = cocok lewat proyeksi polos (tulis ulang polos). */
  spans: Array<[number, number]> | null;
  tier: Tier;
}

// ── lipatan samar ───────────────────────────────────────────────────────

const QUOTE1 = /[‘’‚‛′`´]/;
const QUOTE2 = /[“”„‟″«»]/;
const DASH = /[‐‑‒–—―−]/;
const DIGIT = /[0-9]/;
const MARKUP = new Set(["*", "~"]);

/** Teks samar + peta indeks (setiap karakter keluaran -> indeks karakter asli). */
export function fold(s: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let space = false;
  const word = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) {
      space = text.length > 0;
      continue;
    }
    if (c === "\\" && i + 1 < s.length && /[\p{P}\p{S}]/u.test(s[i + 1])) continue;
    if (MARKUP.has(c)) continue;
    if (c === "_" && !(word(s[i - 1]) && word(s[i + 1]))) continue;
    // Pemisah ribuan: 1,000 / 1.000 -> 1000 (digit sebelum, tepat 3 digit sesudah, lalu bukan digit).
    if ((c === "," || c === ".") && DIGIT.test(s[i - 1] ?? "") && DIGIT.test(s[i + 1] ?? "") && DIGIT.test(s[i + 2] ?? "") && DIGIT.test(s[i + 3] ?? "") && !DIGIT.test(s[i + 4] ?? "")) continue;
    let out = c;
    if (QUOTE1.test(c)) out = "'";
    else if (QUOTE2.test(c)) out = '"';
    else if (DASH.test(c)) out = "-";
    else out = c.toLowerCase();
    if (space) {
      text += " ";
      map.push(i - 1);
      space = false;
    }
    for (const ch of out) {
      text += ch;
      map.push(i);
    }
  }
  return { text, map };
}

/** Spasi dinormalkan + escape Markdown `\<tanda baca>` dibuang, dengan peta indeks (tingkat persis). */
export function exactView(s: string): { text: string; map: number[] } {
  let raw = "";
  const back: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length && /[\p{P}\p{S}]/u.test(s[i + 1])) continue;
    raw += s[i];
    back.push(i);
  }
  const n = normalize(raw);
  return { text: n.text, map: n.map.map((k) => back[k]) };
}

/** `find` memuat tanda baca -> cocok persis saja (butir 14b). */
export const hasPunct = (s: string): boolean => /[\p{P}…]/u.test(s);

function occurrences(hay: string, needle: string): number[] {
  const at: number[] = [];
  if (needle === "") return at;
  for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + needle.length)) at.push(k);
  return at;
}

/** Rentang asli dari kecocokan di teks terpeta. */
const spanOf = (map: number[], k: number, len: number): [number, number] => [map[k], map[k + len - 1] + 1];
/** Rentang yang dimulai tepat sesudah escape Markdown `\` ikut membawa `\` itu (tidak meninggalkan escape yatim). */
const withEscape = (text: string, [a, b]: [number, number]): [number, number] => (a > 0 && text[a - 1] === "\\" && /[\p{P}\p{S}]/u.test(text[a] ?? "") ? [a - 1, b] : [a, b]);

// ── penargetan section ──────────────────────────────────────────────────

const fk = (s: string) => fold(s).text.replace(/^(?:bab|chapter|bagian|section)\s+/, "").replace(/^\d+(?:\.\d+)*[.)]?\s+/, "").trim();

/** Satuan cocok dengan target section: judul (samar, sama atau memuat) atau nama bagian ("bab 2", "2"). */
export function inSection(u: MatchUnit, target: string): boolean {
  const t = fold(target).text.trim();
  if (t === "") return true;
  const part = fold(u.part).text;
  if (t === part || `bab ${t}` === part || t === part.replace(/^bab /, "")) return true;
  const s = fk(u.section);
  const tt = fk(target);
  return s !== "" && tt !== "" && (s === tt || s.includes(tt));
}

// ── kandidat ────────────────────────────────────────────────────────────

const snip = (s: string, at = 0): string => {
  const t = s.replace(/\s+/g, " ").trim();
  const from = Math.max(0, at - 40);
  return `${from > 0 ? "..." : ""}${t.slice(from, from + 120)}${t.length > from + 120 ? "..." : ""}`;
};

/** Deskripsi satuan untuk kandidat: bagian, section, jenis, teks, dan (sel) row + column. */
export function describeUnit(u: MatchUnit): Record<string, unknown> {
  const row = u.rowCells !== undefined ? u.rowCells.filter((c) => c.trim() !== "").slice(0, 2).join(" | ") : undefined;
  // IMPL-W5: teks kandidat tanpa escape Markdown (`\:` r6 membingungkan agen; `find` dicocokkan tanpa escape juga).
  return { part: u.part, section: snip(u.section), kind: u.kind, text: snip(exactView(u.text).text), ...(row !== undefined ? { row: snip(row) } : {}), ...(u.column !== undefined ? { column: snip(u.column) } : {}) };
}

/** 3 kandidat terdekat (irisan kata samar). */
export function nearestUnits(find: string, units: readonly MatchUnit[]): Array<Record<string, unknown>> {
  const words = new Set(fold(find).text.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2));
  return units
    .map((u) => ({ u, score: [...new Set(fold([u.text, u.column ?? ""].join(" ")).text.split(/[^\p{L}\p{N}]+/u))].filter((w) => words.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => describeUnit(x.u));
}

// ── pencarian teks ──────────────────────────────────────────────────────

export interface FindOpts {
  section?: string;
  all?: boolean;
  /** dokumen klien: semua kecocokan di teks depan (salinan meta) diganti bersama walau > 1. */
  sameCopies?: (hits: readonly MatchHit[]) => boolean;
}

function sectionScope(units: readonly MatchUnit[], section: string | undefined, label: string): number[] {
  const idx = units.map((_, i) => i);
  if (section === undefined) return idx;
  const kept = idx.filter((i) => inSection(units[i], section));
  if (kept.length === 0) {
    const names = [...new Set(units.map((u) => u.section).filter((s) => s.trim() !== ""))].slice(0, 20);
    throw new McpToolError("TEXT_NOT_FOUND", `${label}: section tidak ditemukan; daftar section dokumen ada di blok rincian. Tidak ada yang ditulis`, { untrusted: true, details: { edit: label, sections: names.map((n) => snip(n)) } });
  }
  return kept;
}

/**
 * Cari `find` di satuan (dibatasi section bila ada). Satu kecocokan (atau semua bila `all`) -> hit; selain itu galat
 * dengan kandidat. Tidak pernah mengembalikan lebih dari satu sasaran tanpa `all` (kecuali salinan meta klien).
 */
export function findText(find: string, units: readonly MatchUnit[], opts: FindOpts, label: string): { hits: MatchHit[]; tier: Tier } {
  const nf = normalize(find).text;
  if (nf === "") throw new McpToolError("INVALID_ARGUMENT", `${label}: teks find/after kosong`);
  const scope = sectionScope(units, opts.section, label);
  const punct = hasPunct(find);
  const tiers: Array<[Tier, (u: MatchUnit) => Array<[number, number]> | null | number]> = [
    ["exact", (u) => {
      const n = exactView(u.text);
      const ef = exactView(find).text;
      return occurrences(n.text, ef).map((k) => withEscape(u.text, spanOf(n.map, k, ef.length)));
    }],
    ["plain", (u) => {
      if (u.noPlain === true || u.text.length > PLAIN_MAX) return 0;
      const pf = normalize(plainOf(find)).text;
      return pf === "" ? 0 : occurrences(normalize(plainOf(u.text)).text, pf).length;
    }],
    ["fuzzy", (u) => {
      if (punct || u.text.length > PLAIN_MAX) return [];
      const ff = fold(find).text;
      const f = fold(u.text);
      return occurrences(f.text, ff).map((k) => withEscape(u.text, spanOf(f.map, k, ff.length)));
    }],
  ];
  for (const [tier, run] of tiers) {
    const hits: MatchHit[] = [];
    let count = 0;
    for (const i of scope) {
      const r = run(units[i]);
      if (typeof r === "number") {
        if (r > 0) hits.push({ index: i, spans: null, tier });
        count += r;
      } else if (r !== null && r.length > 0) {
        hits.push({ index: i, spans: r, tier });
        count += r.length;
      }
    }
    if (count === 0) continue;
    if (count === 1 || opts.all === true || (opts.sameCopies?.(hits) ?? false)) return { hits, tier };
    throw new McpToolError("TEXT_AMBIGUOUS", `${label}: teks muncul ${count} kali${opts.section !== undefined ? " di section itu" : ""}. Tambahkan section, pakai { cell: { section, row, column }, value }, atau occurrence: "all". 3 lokasi pertama (section, row, column) ada di blok rincian; tidak ada yang ditulis`, {
      untrusted: true,
      details: { edit: label, count, candidates: windowCandidates(hits, units, scope, 5) },
    });
  }
  throw new McpToolError("TEXT_NOT_FOUND", `${label}: teks tidak ditemukan (persis, tanpa markah, maupun samar: huruf besar/kecil, spasi, kutip, tanda pisah, angka 1,000/1000)${opts.section !== undefined ? " di section itu" : ""}. 3 kandidat terdekat (section, row, column) ada di blok rincian; tidak ada yang ditulis`, {
    untrusted: true,
    details: { edit: label, candidates: nearestUnits(find, scope.map((i) => units[i])) },
  });
}

// ── jendela unik (butir 14a) ────────────────────────────────────────────

/** Jumlah kemunculan teks (tingkat persis) di satuan lingkup. */
function countIn(text: string, units: readonly MatchUnit[], scope: readonly number[]): number {
  const t = exactView(text).text;
  return t === "" ? 0 : scope.reduce((n, i) => n + occurrences(exactView(units[i].text).text, t).length, 0);
}

/**
 * Jendela siap salin di sekitar rentang: kata utuh, diperlebar kiri/kanan sampai >= 3 kata DAN unik di lingkup (maks 15
 * kata). null bila tidak dapat unik di dalam satuan itu (mis. sel berisi satu kata: pakai alamat cell).
 */
export function uniqueWindow(u: MatchUnit, span: [number, number], units: readonly MatchUnit[], scope: readonly number[]): string | null {
  const toks: Array<[number, number]> = [];
  for (const m of u.text.matchAll(/\S+/g)) toks.push([m.index as number, (m.index as number) + m[0].length]);
  if (toks.length === 0) return null;
  let lo = toks.findIndex((t) => t[1] > span[0]);
  let hi = toks.length - 1 - [...toks].reverse().findIndex((t) => t[0] < span[1]);
  if (lo < 0) lo = 0;
  if (hi < lo) hi = lo;
  const text = () => exactView(u.text.slice(toks[lo][0], toks[hi][1])).text;
  for (let step = 0; step < 30; step++) {
    if (hi - lo + 1 >= 3 && countIn(text(), units, scope) === 1) return text();
    if (hi - lo + 1 >= 15 || (lo === 0 && hi === toks.length - 1)) break;
    if ((step % 2 === 0 && lo > 0) || hi === toks.length - 1) lo--;
    else hi++;
  }
  return hi - lo + 1 < 3 && countIn(text(), units, scope) === 1 ? text() : null;
}

/** Kandidat ambigu: lokasi + `find` jendela unik, atau alamat `cell` untuk sel tabel. */
function windowCandidates(hits: readonly MatchHit[], units: readonly MatchUnit[], scope: readonly number[], max: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const h of hits) {
    for (const sp of h.spans ?? [[0, 0] as [number, number]]) {
      if (out.length >= max) return out;
      const u = units[h.index];
      const base = describeUnit(u);
      if (u.kind === "cell" && u.column !== undefined && u.rowCells !== undefined) {
        const key = u.rowCells.find((c) => c.trim() !== "" && fold(c).text !== fold(u.text).text) ?? u.rowCells[0];
        out.push({ ...base, cell: { ...(u.section.trim() !== "" ? { section: snip(u.section) } : {}), row: snip(key ?? ""), column: snip(u.column) } });
        continue;
      }
      const w = h.spans !== null ? uniqueWindow(u, sp, units, scope) : null;
      out.push({ ...base, ...(w !== null ? { find: w } : {}) });
    }
  }
  return out;
}

// ── penargetan sel ──────────────────────────────────────────────────────

/** Sel sasaran `{cell:{section?,row,column}}`: tepat satu (kolom sama/memuat judul, baris dengan sel sama/memuat row). */
export function findCell(target: { section?: string; row: string; column: string }, units: readonly MatchUnit[], label: string): number {
  const scope = sectionScope(units, target.section, label).filter((i) => units[i].kind === "cell" && units[i].column !== undefined && units[i].headerRow !== true);
  const col = fold(target.column).text.trim();
  const row = fold(target.row).text.trim();
  const pick = (pred: (u: MatchUnit) => boolean) => scope.filter((i) => pred(units[i]));
  const colEq = (u: MatchUnit) => fold(u.column as string).text.trim() === col;
  const colIn = (u: MatchUnit) => fold(u.column as string).text.includes(col);
  const rowEq = (u: MatchUnit) => (u.rowCells ?? []).some((c) => fold(c).text.trim() === row);
  const rowIn = (u: MatchUnit) => (u.rowCells ?? []).some((c) => fold(c).text.includes(row));
  for (const [c, r] of [[colEq, rowEq], [colIn, rowEq], [colEq, rowIn], [colIn, rowIn]] as const) {
    const hit = pick((u) => c(u) && r(u));
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) {
      throw new McpToolError("TEXT_AMBIGUOUS", `${label}: ${hit.length} sel cocok dengan row + column itu; tambahkan section atau perpanjang row (mis. kunci baris). 3 kandidat ada di blok rincian; tidak ada yang ditulis`, {
        untrusted: true,
        details: { edit: label, candidates: hit.slice(0, 3).map((i) => describeUnit(units[i])) },
      });
    }
  }
  const columns = [...new Set(scope.map((i) => units[i].column as string))].slice(0, 20).map((c) => snip(c));
  const near = nearestUnits(`${target.row} ${target.column}`, scope.map((i) => units[i]));
  throw new McpToolError("TEXT_NOT_FOUND", `${label}: tidak ada sel dengan column dan row itu${target.section !== undefined ? " di section itu" : ""}. Judul kolom yang ada dan 3 kandidat ada di blok rincian; tidak ada yang ditulis`, {
    untrusted: true,
    details: { edit: label, columns, candidates: near },
  });
}

/** Ganti semua rentang (urut menurun agar indeks tetap sah); irisan indeks, tanpa pola `$`. */
export function spliceSpans(text: string, spans: ReadonlyArray<[number, number]>, repl: (at: number) => string): string {
  let out = text;
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + repl(a) + out.slice(b);
  return out;
}

/** Rentang samar memuat markah inline (`*`, `_`, `` ` ``, `[`, `]`, `~`) -> tulis ulang polos lebih aman. */
export const spansHaveMarkup = (text: string, spans: ReadonlyArray<[number, number]>): boolean => spans.some(([a, b]) => /[*_`[\]~]/.test(text.slice(a, b)));

// ── penargetan section untuk append/addRow (IMPL-W5) ────────────────────

/** Section sasaran `{ section, append }` / `{ section, addRow }`. */
export interface SectionEntry {
  /** judul section/bab (teks polos). */
  title: string;
  /** nama bagian dokumen ("bab 2", "references"). */
  part: string;
}

/**
 * IMPL-W5 E1/E2: section sasaran append/addRow. Tingkat: nama bagian ("bab 2", "2") -> section TERAKHIR bagian itu;
 * judul sama (samar, tanpa nomor) -> judul memuat teks. Tepat satu per tingkat; lebih -> TEXT_AMBIGUOUS, nol ->
 * TEXT_NOT_FOUND (daftar section di blok rincian; galat alamat = dapat diterapkan sebagian).
 */
export function findSection(target: string, entries: readonly SectionEntry[], label: string): number {
  const t = fold(target).text.trim();
  if (t === "") throw new McpToolError("INVALID_ARGUMENT", `${label}: section kosong`);
  const byPart = entries.map((e, i) => ({ e, i })).filter(({ e }) => {
    const part = fold(e.part).text;
    return t === part || `bab ${t}` === part || t === part.replace(/^bab /, "");
  });
  if (byPart.length > 0) return byPart[byPart.length - 1].i;
  const tt = fk(target);
  for (const pred of [(s: string) => s === tt, (s: string) => s !== "" && tt !== "" && s.includes(tt)]) {
    const hit = entries.map((e, i) => ({ s: fk(e.title), i })).filter((x) => pred(x.s));
    if (hit.length === 1) return hit[0].i;
    if (hit.length > 1) {
      throw new McpToolError("TEXT_AMBIGUOUS", `${label}: ${hit.length} section cocok; tulis judul section lengkap atau "bab N". Daftar ada di blok rincian; tidak ada yang ditulis untuk suntingan ini`, {
        untrusted: true,
        details: { edit: label, candidates: hit.slice(0, 5).map((x) => ({ part: entries[x.i].part, section: snip(entries[x.i].title) })) },
      });
    }
  }
  throw new McpToolError("TEXT_NOT_FOUND", `${label}: section tidak ditemukan; daftar section dokumen ada di blok rincian. Tidak ada yang ditulis untuk suntingan ini`, {
    untrusted: true,
    details: { edit: label, sections: entries.slice(0, 30).map((e) => ({ part: e.part, section: snip(e.title) })) },
  });
}

// ── terapkan sebagian (IMPL-W5 E4) ──────────────────────────────────────

/** Galat ALAMAT (teks/sel/baris/section/tabel tidak ketemu atau ganda): suntingan lain tetap diterapkan. */
export const ADDRESS_CODES: ReadonlySet<string> = new Set(["TEXT_NOT_FOUND", "TEXT_AMBIGUOUS"]);

export interface NotApplied {
  /** nomor suntingan (1 = pertama). */
  edit: number;
  code: string;
  /** keadaan yang dilihat suntingan itu saat dicari: isi tersimpan, atau sesudah suntingan sebelumnya di batch ini. */
  seenState: "tersimpan" | "sesudah-suntingan-sebelumnya";
  candidates: unknown;
}

/** Galat alamat -> entri notApplied (kandidat dari rincian galat; isi dokumen = tak tepercaya). Selain itu null. */
export function notAppliedOf(e: unknown, index: number, changedBefore: boolean): NotApplied | null {
  if (!(e instanceof McpToolError) || !ADDRESS_CODES.has(e.code)) return null;
  const d = e.extra.details !== null && typeof e.extra.details === "object" ? (e.extra.details as Record<string, unknown>) : {};
  const candidates = d.candidates ?? d.sections ?? d.figures ?? d.tables ?? null;
  return { edit: index + 1, code: e.code, seenState: changedBefore ? "sesudah-suntingan-sebelumnya" : "tersimpan", candidates: { ...(Array.isArray(d.columns) ? { columns: d.columns } : {}), list: candidates } };
}
