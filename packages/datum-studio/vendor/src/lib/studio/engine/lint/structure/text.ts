/**
 * Utilitas teks lint struktur: angka format DATUM (DT-30), terbilang bahasa
 * Indonesia (SG-L4-05, D05), waktu dan zona (D19), kalimat (D11), warna (A12,
 * A21). Murni, tanpa I/O.
 */
import { numberConvention, numberPatternSources } from "../../bind/format";

/** Pemisah dan pola angka dari entri ID tabel konvensi (engine/bind/format.ts). */
const ID_NUMBER = numberConvention("ID");
const ID_NUMBER_PATTERN = numberPatternSources(ID_NUMBER);
const DATUM_GROUPED_RE = new RegExp(`^-?${ID_NUMBER_PATTERN.grouped}$`);
const DATUM_PLAIN_RE = new RegExp(`^-?${ID_NUMBER_PATTERN.plain}$`);

/** "1.500.000" -> 1500000; "2,5" -> 2.5; "12" -> 12; selain itu NaN. */
export function parseDatumNumber(s: string): number {
  const t = s.trim().replace(/\s/g, "");
  if (DATUM_GROUPED_RE.test(t) || DATUM_PLAIN_RE.test(t)) {
    return Number(t.split(ID_NUMBER.thousandsSeparator).join("").replace(ID_NUMBER.decimalSeparator, "."));
  }
  return NaN;
}

const DIGITS: Readonly<Record<string, number>> = {
  nol: 0,
  satu: 1,
  dua: 2,
  tiga: 3,
  empat: 4,
  lima: 5,
  enam: 6,
  tujuh: 7,
  delapan: 8,
  sembilan: 9,
};
const SCALES: Readonly<Record<string, number>> = { ribu: 1e3, juta: 1e6, miliar: 1e9, milyar: 1e9, triliun: 1e12 };
const SE_SCALES: Readonly<Record<string, number>> = { seribu: 1e3, sejuta: 1e6, semiliar: 1e9, setriliun: 1e12 };
/** Kata penutup yang boleh mengikuti terbilang (satuan). */
const TAIL_WORDS: ReadonlySet<string> = new Set(["rupiah", "persen", "dolar", "sen"]);

/**
 * Terbilang Indonesia -> bilangan. `undefined` bila memuat kata di luar
 * kosakata terbilang (berarti bukan terbilang).
 */
export function parseTerbilang(words: string): number | undefined {
  const toks = words
    .toLowerCase()
    .replace(/[-,;]/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "");
  while (toks.length && TAIL_WORDS.has(toks[toks.length - 1])) toks.pop();
  if (toks.length === 0) return undefined;
  let total = 0;
  let small = 0;
  let last: number | undefined;
  let decimals: string | undefined;
  for (const t of toks) {
    if (decimals !== undefined) {
      if (DIGITS[t] === undefined) return undefined;
      decimals += String(DIGITS[t]);
      continue;
    }
    if (DIGITS[t] !== undefined) {
      small += DIGITS[t];
      last = DIGITS[t];
      continue;
    }
    switch (t) {
      case "sepuluh":
        small += 10;
        last = undefined;
        continue;
      case "sebelas":
        small += 11;
        last = undefined;
        continue;
      case "seratus":
        small += 100;
        last = undefined;
        continue;
      case "belas":
        if (last === undefined) return undefined;
        small += 10;
        last = undefined;
        continue;
      case "puluh":
        if (last === undefined) return undefined;
        small += last * 9;
        last = undefined;
        continue;
      case "ratus":
        if (last === undefined) return undefined;
        small += last * 99;
        last = undefined;
        continue;
      case "koma":
        total += small;
        small = 0;
        decimals = "";
        continue;
    }
    if (SE_SCALES[t] !== undefined) {
      total += SE_SCALES[t];
      last = undefined;
      continue;
    }
    if (SCALES[t] !== undefined) {
      total += (small === 0 ? 1 : small) * SCALES[t];
      small = 0;
      last = undefined;
      continue;
    }
    return undefined;
  }
  total += small;
  if (decimals !== undefined) {
    if (decimals === "") return undefined;
    return Number(`${total}.${decimals}`);
  }
  return total;
}

export interface TerbilangPair {
  numberText: string;
  wordsText: string;
  value: number;
  words: number;
  index: number;
}

/** Pasangan "angka [satuan] (terbilang)" di teks; hanya yang kurungnya terbilang sah. */
export function findTerbilangPairs(text: string): TerbilangPair[] {
  const out: TerbilangPair[] = [];
  const re = new RegExp(
    `(${ID_NUMBER_PATTERN.grouped}|${ID_NUMBER_PATTERN.plain})\\s*(?:[%\\p{L}.]{0,12}\\s*)?\\(([\\p{L}\\s,-]{3,240})\\)`,
    "gu",
  );
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const value = parseDatumNumber(m[1]);
    const words = parseTerbilang(m[2]);
    if (!Number.isFinite(value) || words === undefined) continue;
    out.push({ numberText: m[1], wordsText: m[2].trim(), value, words, index: m.index });
  }
  return out;
}

/** Zona waktu yang diterima di belakang waktu (SG-L4-05). */
export const TIME_ZONE_PATTERN = /^\s*(?:WIB|WITA|WIT|UTC(?:[+-]\d{1,2}(?::?\d{2})?)?|GMT(?:[+-]\d{1,2})?|Z\b|[+-]\d{2}:?\d{2})/;

export interface TimeHit {
  text: string;
  index: number;
}

/** Waktu jam tanpa zona: "14:30", "14:30:05", "pukul 14.30". */
export function timesWithoutZone(text: string): TimeHit[] {
  const out: TimeHit[] = [];
  const re = /(?<![\d:.,])(?:(?:pukul|jam)\s+([01]?\d|2[0-3])[.:]([0-5]\d)|([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?)(?![\d:])/giu;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (TIME_ZONE_PATTERN.test(rest)) continue;
    out.push({ text: m[0], index: m.index });
  }
  return out;
}

/** Jumlah kalimat (akhir = . ! ? diikuti spasi+huruf besar/angka atau akhir teks). */
export function sentenceCount(text: string): number {
  const t = text.replace(/\s+/g, " ").trim();
  if (t === "") return 0;
  const parts = t.split(/(?<=[.!?])\s+(?=[\p{Lu}\d"“(])/u).filter((p) => /\p{L}/u.test(p));
  return Math.max(1, parts.length);
}

/** Tanggal/periode berlaku: tahun 19xx/20xx, tanggal ISO, atau "dd bulan yyyy". */
export function hasDate(text: string): boolean {
  return /\b(?:19|20)\d{2}\b/.test(text);
}

/** Normalisasi hex "#aabbcc" -> "AABBCC"; selain hex 6 digit -> undefined. */
export function normHex(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(/^#/, "").toUpperCase();
  return /^[0-9A-F]{6}$/.test(t) ? t : undefined;
}

/** Cakupan tinta isian (0 = putih, 1 = hitam) dari rata-rata kanal. */
export function inkCoverage(hex: string): number {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return 1 - (r + g + b) / (3 * 255);
}

/** Tebal garis OOXML (1/8 pt) ke mm. */
export function eighthsToMm(sz: number): number {
  return (sz / 8) * (25.4 / 72);
}

/** Pola nilai Admiralty (keandalan A-F, kredibilitas 1-6), mis. "B2". */
export const ADMIRALTY_GRADE = /(?<![\p{L}\p{N}])[A-F][1-6](?![\p{L}\p{N}])/u;
