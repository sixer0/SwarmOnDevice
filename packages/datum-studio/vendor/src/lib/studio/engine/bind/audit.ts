/**
 * Audit angka teks terhadap register (port `Register.audit_text` dan
 * `audit_retired` datumbind.py). Ekstraksi teks dari DOCX (`_text_of`) bukan
 * bagian modul ini: pemanggil (lint, layanan) menyerahkan teks polos.
 */
import type { AuditFinding, RegisterApi } from "../../contract";
import { BindDefect } from "./defect";
import { DEFAULT_NUMBER_LANGUAGE, escapeRegExp, fmt, numberConvention, type NumberLanguage } from "./format";
import { Register } from "./register";

/**
 * Pola angka beban keputusan (Python `Register.PAT`): angka berpemisah ribuan
 * "." (opsional desimal ",") atau angka berdesimal ",". `\w`/`\d` Python 3
 * sadar-Unicode, maka di sini `[\p{L}\p{N}_]` dan `\p{Nd}`. Bilangan bulat
 * polos < 1000 tanpa pemisah tidak diaudit (semantik arsip).
 */
const W = "[\\p{L}\\p{N}_";
export const BIND_NUMBER_PATTERN_SOURCE =
  `(?<!${W},.])\\p{Nd}{1,3}(?:\\.\\p{Nd}{3})+(?:,\\p{Nd}+)?(?!${W}.])|` +
  `(?<!${W},.])\\p{Nd}+,\\p{Nd}+(?!${W}.])`;

/** Escape satu pemisah di dalam kelas karakter `[...]`. */
function escClass(s: string): string {
  return s.replace(/[\]\\^-]/g, "\\$&");
}

/**
 * Pola audit untuk konvensi bahasa (S17, research/33 D-06). Bentuknya sama
 * dengan `Register.PAT` Python dengan pemisah dari tabel: lookbehind menolak
 * kedua pemisah, lookahead menolak pemisah ribuan (agar grup tidak terpotong).
 * Untuk ID hasilnya identik dengan `BIND_NUMBER_PATTERN_SOURCE`.
 */
export function bindNumberPatternSource(lang: NumberLanguage = DEFAULT_NUMBER_LANGUAGE): string {
  if (lang === DEFAULT_NUMBER_LANGUAGE) return BIND_NUMBER_PATTERN_SOURCE;
  const c = numberConvention(lang);
  const t = escapeRegExp(c.thousandsSeparator);
  const d = escapeRegExp(c.decimalSeparator);
  const behind = `(?<!${W}${escClass(c.decimalSeparator)}${escClass(c.thousandsSeparator)}])`;
  const ahead = `(?!${W}${escClass(c.thousandsSeparator)}])`;
  return (
    `${behind}\\p{Nd}{1,3}(?:${t}\\p{Nd}{3})+(?:${d}\\p{Nd}+)?${ahead}|` +
    `${behind}\\p{Nd}+${d}\\p{Nd}+${ahead}`
  );
}

function auditLanguage(reg: RegisterApi, lang: NumberLanguage | undefined): NumberLanguage {
  if (lang) return lang;
  return reg instanceof Register ? reg.language : DEFAULT_NUMBER_LANGUAGE;
}

function knownForms(reg: RegisterApi, lang: NumberLanguage): Set<string> {
  if (reg instanceof Register && reg.language === lang) return reg.knownForms();
  const out = new Set<string>();
  for (const k of reg.keys()) {
    const v = reg.get(k).v;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    for (let dec = 0; dec < 4; dec++) out.add(fmt(v, dec, lang));
  }
  return out;
}

// ── Penomoran struktural (D-605 (2)) ─────────────────────────────────────

/**
 * Konteks unit teks untuk pengecualian penomoran struktural:
 * - `heading`: judul bab/subbab/bagian; token nomor di awal baris selalu struktural.
 * - `body`: prosa, daftar, keterangan; token nomor di awal baris struktural
 *   hanya bila diikuti kata berhuruf kapital (nomor butir/pasal "4.2 The ...").
 * Di kedua konteks, nomor sesudah kata label (Table/Tabel 1.2, Figure 3.1,
 * Section 2.3.1, clause 4.2, §2.3) dan alamat bertingkat dua titik atau lebih
 * ("2.3.1", "4.10.2") struktural. Bentuk ID di dokumen EN ("1.250.000,5")
 * tetap diaudit karena grupnya 3 digit.
 */
export type AuditTextContext = "heading" | "body";

export interface AuditTextOptions {
  /** Tanpa konteks = port `Register.audit_text` apa adanya (tanpa pengecualian). */
  context?: AuditTextContext;
  /** Bahasa konvensi angka; absen = bahasa `Register`, bawaan ID. */
  lang?: NumberLanguage;
}

/**
 * Token nomor struktural: 1-3 digit lalu satu atau lebih grup "." + 1-2 digit
 * ("1.1", "2.3.1", "12.10"). Grup 1-2 digit sengaja: angka ID bergrup ribuan
 * "." selalu 3 digit, jadi token ini tidak pernah beririsan dengan kandidat
 * audit ID (perilaku ID tidak berubah); bentuk "1.250" tetap diaudit.
 */
const NUM = String.raw`\p{Nd}{1,3}(?:\.\p{Nd}{1,2})+(?!\p{Nd})`;
const NUM_BOUND = String.raw`(?<![\p{L}\p{N}_.,])`;
/** Spasi (`\s` regex JS sudah mencakup NBSP); `HS` = spasi tanpa ganti baris. */
const SP = String.raw`\s*`;
const HS = String.raw`[^\S\n]*`;
/** Kata label penomoran (EN dan ID; satu daftar tanpa cabang bahasa). */
const LABELS = [
  String.raw`tables?|tabel|figures?|figs?\.|gambar|charts?|grafik|diagrams?|sections?|sect\.|bagian|subbab|bab|chapters?`,
  String.raw`clauses?|pasal|ayat|articles?|art\.|annex(?:es)?|lampiran|appendix|appendices|parts?|items?|butir`,
  String.raw`paragraphs?|paras?\.|paragraf|steps?|langkah|equations?|eqs?\.|persamaan|rumus|box(?:es)?|kotak|nos?\.|nomor`,
].join("|");
/** Sambungan daftar nomor sesudah label ("Tables 1.2 and 1.3", "Pasal 4.1-4.3"). */
const JOIN = String.raw`${SP}(?:,|;|&|and|or|to|dan|atau|hingga|sampai|s\.d\.|[\-–—])${SP}`;
const LABELLED_RE = new RegExp(
  String.raw`(?:(?<![\p{L}\p{N}_])(?:${LABELS})${SP}|§§?${SP})${NUM_BOUND}${NUM}(?:${JOIN}${NUM_BOUND}${NUM})*`,
  "giu",
);
const NUM_RE = new RegExp(`${NUM_BOUND}${NUM}`, "gu");
/** Alamat bertingkat: token nomor dengan dua titik atau lebih (bukan desimal di konvensi mana pun). */
const ADDRESS_RE = new RegExp(String.raw`${NUM_BOUND}\p{Nd}{1,3}(?:\.\p{Nd}{1,2}){2,}(?!\p{Nd})`, "gu");
const HEADING_LEAD_RE = new RegExp(String.raw`^${HS}(${NUM})(?=[\s.):]|$)`, "gmu");
const BODY_LEAD_RE = new RegExp(String.raw`^${HS}(${NUM})[.)]?[^\S\n]+(?=\p{Lu}\p{Ll})`, "gmu");

type Span = readonly [start: number, end: number];

/** Rentang penomoran struktural di `text` untuk konteks unit teksnya. */
export function structuralNumberSpans(text: string, context: AuditTextContext): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(LABELLED_RE)) {
    for (const n of m[0].matchAll(NUM_RE)) {
      const start = (m.index ?? 0) + (n.index ?? 0);
      spans.push([start, start + n[0].length]);
    }
  }
  for (const m of text.matchAll(ADDRESS_RE)) spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  for (const m of text.matchAll(context === "heading" ? HEADING_LEAD_RE : BODY_LEAD_RE)) {
    const start = (m.index ?? 0) + m[0].indexOf(m[1]);
    spans.push([start, start + m[1].length]);
  }
  return spans;
}

/**
 * Setiap angka beban keputusan di `text` wajib tertelusur ke register.
 * Satu temuan per bentuk unik (indeks kemunculan pertama), urut seperti
 * Python `sorted(set(...))`. Bahasa: `opts.lang`, selain itu bahasa `Register`,
 * bawaan ID; bentuk dan pola angka hanya dari konvensi bahasa itu, jadi
 * varian EN hanya diterima untuk dokumen EN. Dengan `opts.context`, kandidat
 * yang beririsan dengan penomoran struktural (`structuralNumberSpans`) tidak
 * diaudit; tanpa konteks perilakunya sama dengan port Python.
 */
export function auditText(
  text: string,
  reg: RegisterApi,
  allow: readonly string[] = [],
  opts: AuditTextOptions = {},
): AuditFinding[] {
  const language = auditLanguage(reg, opts.lang);
  const known = knownForms(reg, language);
  const allowed = new Set(allow);
  const spans = opts.context ? structuralNumberSpans(text, opts.context) : [];
  const structural = (start: number, end: number) => spans.some(([s, e]) => start < e && s < end);
  const first = new Map<string, number>();
  const re = new RegExp(bindNumberPatternSource(language), "gu");
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (structural(m.index, m.index + m[0].length)) continue;
    if (!first.has(m[0])) first.set(m[0], m.index);
  }
  return [...first.keys()]
    .filter((s) => !known.has(s) && !allowed.has(s))
    .sort()
    .map((s) => ({
      kind: "unregistered" as const,
      text: s,
      index: first.get(s) ?? 0,
      detail: `angka "${s}" tidak tertelusur ke register`,
    }));
}

/**
 * Tolak teks yang masih memuat nilai yang sudah ditarik model. Urutan dan
 * duplikat mengikuti daftar `retired` (Python list comprehension).
 */
export function auditRetired(text: string, retired: readonly string[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const s of retired) {
    if (typeof s !== "string" || s === "") {
      throw new BindDefect("daftar nilai ditarik memuat entri kosong; setiap entri wajib teks angka tercetak.");
    }
    const index = text.indexOf(s);
    if (index >= 0) out.push({ kind: "retired", text: s, index, detail: `memuat angka yang sudah ditarik: ${s}` });
  }
  return out;
}
