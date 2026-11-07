/**
 * Tokenisasi bahasa Indonesia sederhana untuk pemindai grup C (S47).
 *
 * Definisi (terdokumentasi, deterministik, tanpa kamus morfologi):
 *  - Kata: deret huruf/angka Unicode (`\p{L}\p{N}`), boleh tersambung oleh
 *    `-`, `'`, `’`, `.`, `,`, `/` bila diapit huruf/angka. Jadi reduplikasi
 *    (`anak-anak`), angka Indonesia (`1.250`, `3,5`), dan URL/DOI dihitung
 *    satu kata; tanda baca tidak dihitung.
 *  - Kalimat: berakhir pada `.`, `!`, `?`, `…` (boleh diikuti kutip/kurung
 *    tutup) yang disusul spasi atau akhir teks, dan pada batas paragraf.
 *    Titik BUKAN akhir kalimat bila: (a) kata sebelumnya singkatan umum
 *    (`ABBREVIATIONS`), (b) kata sebelumnya satu huruf (inisial nama),
 *    kecuali huruf itu didahului kata rujukan (`Lampiran A.`, `Tabel B.`;
 *    `REFERENCE_NOUNS`),
 *    (c) karakter non-spasi berikutnya huruf kecil (kalimat Indonesia
 *    diawali kapital), (d) titik menutup penanda butir di awal kalimat
 *    (`1.`, `12.` dalam enumerasi sebaris "1. Setiap ... 2. Setiap ..."):
 *    penanda butir bukan kalimat satu kata (FIX-L, F-062).
 *  - Koma: koma desimal (digit,digit) tidak dihitung sebagai koma kalimat.
 *  - Pembuka kalimat: kata pertama kalimat, huruf kecil.
 */

const WORD_RE = /[\p{L}\p{N}]+(?:[-‐'’.,/][\p{L}\p{N}]+)*/gu;

/** Akhir kalimat kandidat: tanda akhir + penutup opsional, disusul spasi/akhir. */
const END_RE = /[.!?…]+["'”’)\]]*(?=\s|$)/gu;

/**
 * Singkatan yang tidak pernah mengakhiri kalimat (gelar, sapaan, penunjuk),
 * huruf kecil tanpa titik akhir. Singkatan yang lazim menutup kalimat
 * (`dll.`, `dsb.`, `dst.`, `dkk.`, `Tbk.`) sengaja tidak dimuat: batasnya
 * diputus aturan (c) — kapital berikutnya berarti kalimat baru.
 */
export const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "yth", "mis", "no", "hlm", "hal", "bpk", "sdr", "sdri", "ir", "dr", "drs", "dra", "prof",
  "pt", "cv", "jl", "jln", "kab", "kec", "kel", "prov", "telp", "tel", "tgl", "vol", "ed", "rev",
  "cf", "vs", "a.n", "u.p", "s.t", "m.t", "s.h", "m.m", "s.e", "s.kom", "e.g", "i.e", "ttd",
  "lamp", "nmr", "s.d", "ref",
]);

/** Penanda butir enumerasi sebaris: hanya numeral 1-3 digit sebelum titik (FIX-L). */
const ENUM_MARKER = /^\d{1,3}$/u;

/** Kata rujukan yang lazim diikuti satu huruf penanda (bukan inisial nama). */
const REFERENCE_NOUNS: ReadonlySet<string> = new Set([
  "lampiran", "bagian", "tabel", "gambar", "huruf", "kolom", "baris", "tipe", "kelas", "seri", "revisi", "blok", "zona",
]);

export function words(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

export function countWords(text: string): number {
  return words(text).length;
}

/** Kata terakhir (huruf kecil, termasuk titik dalam singkatan seperti `a.n`) sebelum posisi `end`. */
function lastTokenBefore(text: string, end: number): string {
  const m = /([\p{L}\p{N}.]+)$/u.exec(text.slice(0, end));
  return m ? m[1].replace(/\.+$/u, "").toLowerCase() : "";
}

/** Kata sebelum token terakhir (huruf kecil), untuk aturan inisial. */
function wordBefore(text: string, end: number): string {
  const m = /([\p{L}\p{N}]+)[^\p{L}\p{N}]+[\p{L}\p{N}]+$/u.exec(text.slice(0, end));
  return m ? m[1].toLowerCase() : "";
}

/** Memecah satu paragraf menjadi kalimat (lihat definisi di kepala berkas). */
export function splitSentences(paragraph: string): string[] {
  const text = paragraph.replace(/\s+/gu, " ").trim();
  if (text === "") return [];
  const out: string[] = [];
  let start = 0;
  END_RE.lastIndex = 0;
  for (let m = END_RE.exec(text); m !== null; m = END_RE.exec(text)) {
    const endIdx = m.index + m[0].length;
    const isDotOnly = /^\.+["'”’)\]]*$/u.test(m[0]) && !m[0].startsWith("..");
    if (isDotOnly) {
      const prev = lastTokenBefore(text, m.index);
      const next = text.slice(endIdx).trimStart().charAt(0);
      if (ABBREVIATIONS.has(prev)) continue;
      if (/^\p{L}$/u.test(prev) && !REFERENCE_NOUNS.has(wordBefore(text, m.index))) continue; // inisial nama
      if (next !== "" && /\p{Ll}/u.test(next)) continue;
      if (next !== "" && ENUM_MARKER.test(text.slice(start, m.index).trim())) continue; // penanda butir (d)
    }
    const s = text.slice(start, endIdx).trim();
    if (countWords(s) > 0) out.push(s);
    start = endIdx;
  }
  const tail = text.slice(start).trim();
  if (countWords(tail) > 0) out.push(tail);
  return out;
}

/** Koma kalimat: koma yang tidak diapit dua digit (koma desimal dikecualikan). */
export function countSentenceCommas(sentence: string): number {
  return (sentence.match(/(?<!\p{N}),|,(?!\p{N})/gu) ?? []).length;
}

export function countSemicolons(text: string): number {
  return (text.match(/;/gu) ?? []).length;
}

/** Kata pertama kalimat (huruf kecil), atau "" bila tidak ada kata. */
export function opener(sentence: string): string {
  const w = words(sentence)[0];
  return w ? w.toLowerCase() : "";
}

/** Regex kata utuh Unicode (pengganti `\b` yang hanya ASCII). */
export function wholeWordRe(word: string, flags = "giu"): RegExp {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, flags);
}
