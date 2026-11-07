/**
 * Konvensi angka DATUM (DT-30; parameter kelas K P6-31, P6-32, P6-33, P6-39):
 * pemisah ribuan ".", pemisah desimal ",", spasi antara nilai dan satuan,
 * mata uang mendahului nilai. Port `fmt` dan `_withunit` datumbind.py.
 *
 * Pembulatan meniru Python `f"{v:,.{dec}f}"` persis: half-even terhadap nilai
 * biner EKSAK double (mis. 2.5 -> "2", 2.675 dec 2 -> "2,67"), tanda negatif
 * dipertahankan termasuk -0 ("-0"). `Number.prototype.toFixed` tidak dipakai
 * karena memutus seri ke atas.
 */
import { BindDefect } from "./defect";

/** Bahasa yang memiliki entri konvensi angka (S07 ID, S16 EN). */
export type NumberLanguage = "ID" | "EN";

/** Konvensi angka satu bahasa: pemisah dan satuan yang mendahului nilai. */
export interface NumberConvention {
  readonly thousandsSeparator: string;
  readonly decimalSeparator: string;
  /** P6-39: satuan (mata uang) yang mendahului nilai; satuan lain menyusul. */
  readonly leadingUnits: readonly string[];
  /** Satuan rupiah tercetak (`Register.rp`): ID "Rp", EN "IDR" (EN 6.8). */
  readonly currencyUnit: string;
  /** Satuan register yang ditulis ulang saat dicetak, mis. EN: "Rp" -> "IDR". */
  readonly unitAliases: Readonly<Record<string, string>>;
}

/**
 * Tabel konvensi angka per bahasa (DATUM Rev A, research/33 D-01, register
 * research/31 §5). Satu-satunya sumber pemisah angka di mesin; lint membangun
 * polanya dari sini. Satu konvensi per berkas (ID:1998-2006, EN 6.8).
 */
export const NUMBER_CONVENTIONS: Readonly<Record<NumberLanguage, NumberConvention>> = Object.freeze({
  ID: Object.freeze({
    thousandsSeparator: ".",
    decimalSeparator: ",",
    leadingUnits: Object.freeze(["Rp", "USD", "EUR", "SGD"]),
    currencyUnit: "Rp",
    unitAliases: Object.freeze({}),
  }),
  EN: Object.freeze({
    thousandsSeparator: ",",
    decimalSeparator: ".",
    leadingUnits: Object.freeze(["IDR", "USD", "EUR", "SGD"]),
    currencyUnit: "IDR",
    unitAliases: Object.freeze({ Rp: "IDR" }),
  }),
});

export const DEFAULT_NUMBER_LANGUAGE: NumberLanguage = "ID";

export function numberConvention(lang: NumberLanguage = DEFAULT_NUMBER_LANGUAGE): NumberConvention {
  const conv = Object.prototype.hasOwnProperty.call(NUMBER_CONVENTIONS, lang) ? NUMBER_CONVENTIONS[lang] : undefined;
  if (!conv) throw new BindDefect(`bahasa angka "${String(lang)}" tidak punya entri konvensi (ID, EN).`);
  return conv;
}

/**
 * Bahasa konvensi angka dari bahasa dokumen (`doc.meta.language`), resolusi
 * yang sama dengan renderer (`language === "EN" ? "EN" : "ID"`).
 */
export function numberLanguageOf(language: unknown): NumberLanguage {
  return language === "EN" ? "EN" : DEFAULT_NUMBER_LANGUAGE;
}

const ID = NUMBER_CONVENTIONS.ID;

/** Alias entri ID (ekspor lama, diekspor ulang engine/bind/index.ts). */
export const DATUM_THOUSANDS_SEPARATOR = ID.thousandsSeparator;
export const DATUM_DECIMAL_SEPARATOR = ID.decimalSeparator;
/** P6-39: satuan yang mendahului nilai (alias entri ID). */
export const DATUM_LEADING_UNITS: readonly string[] = ID.leadingUnits;
/** Batas jumlah desimal yang diterima fmt (Python tidak membatasi; ini penjaga masukan). */
export const DATUM_MAX_DECIMALS = 20;

const BIG0 = BigInt(0);
const BIG1 = BigInt(1);
const BIG2 = BigInt(2);
const BIG10 = BigInt(10);

interface DecomposedDouble {
  negative: boolean;
  /** Nilai mutlak = mantissa * 2^exp. */
  mantissa: bigint;
  exp: number;
}

function decompose(v: number): DecomposedDouble {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const negative = hi >>> 31 === 1;
  const biased = (hi >>> 20) & 0x7ff;
  const fracHi = hi & 0xfffff;
  let mantissa = (BigInt(fracHi) << BigInt(32)) | BigInt(lo);
  let exp: number;
  if (biased === 0) {
    exp = -1074; // subnormal
  } else {
    mantissa |= BIG1 << BigInt(52);
    exp = biased - 1075;
  }
  return { negative, mantissa, exp };
}

function pow10(n: number): bigint {
  let r = BIG1;
  for (let i = 0; i < n; i++) r *= BIG10;
  return r;
}

/**
 * Bulatkan |v| * 10^digits ke bilangan bulat, half-even terhadap nilai eksak.
 * `digits` boleh negatif (pembulatan ke puluhan, ratusan, ...).
 */
function roundScaledExact(v: number, digits: number): { negative: boolean; q: bigint } {
  const { negative, mantissa, exp } = decompose(v);
  let num = mantissa;
  let den = BIG1;
  if (exp >= 0) num <<= BigInt(exp);
  else den <<= BigInt(-exp);
  if (digits >= 0) num *= pow10(digits);
  else den *= pow10(-digits);
  let q = num / den;
  const r2 = (num % den) * BIG2;
  if (r2 > den || (r2 === den && q % BIG2 !== BIG0)) q += BIG1;
  return { negative, q };
}

function groupThousands(intDigits: string, conv: NumberConvention): string {
  let out = "";
  for (let i = 0; i < intDigits.length; i++) {
    if (i > 0 && (intDigits.length - i) % 3 === 0) out += conv.thousandsSeparator;
    out += intDigits[i];
  }
  return out;
}

function checkDec(dec: number): void {
  if (!Number.isInteger(dec) || dec < 0 || dec > DATUM_MAX_DECIMALS) {
    throw new BindDefect(`jumlah desimal "${dec}" tidak sah (bilangan bulat 0..${DATUM_MAX_DECIMALS}).`);
  }
}

/**
 * Ribuan dan desimal menurut konvensi bahasa (bawaan ID: "." dan ","), tidak
 * pernah terbalik (DATUM §10, DT-30).
 */
export function fmt(v: number, dec = 0, lang: NumberLanguage = DEFAULT_NUMBER_LANGUAGE): string {
  return formatWith(v, dec, lang === DEFAULT_NUMBER_LANGUAGE ? ID : numberConvention(lang));
}

export function formatWith(v: number, dec: number, conv: NumberConvention): string {
  checkDec(dec);
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new BindDefect(`nilai "${String(v)}" bukan bilangan hingga; tidak dapat diformat.`);
  }
  const { negative, q } = roundScaledExact(v, dec);
  let digits = q.toString();
  if (dec > 0 && digits.length <= dec) digits = "0".repeat(dec - digits.length + 1) + digits;
  const intPart = dec > 0 ? digits.slice(0, digits.length - dec) : digits;
  const fracPart = dec > 0 ? digits.slice(digits.length - dec) : "";
  const body = groupThousands(intPart, conv) + (dec > 0 ? conv.decimalSeparator + fracPart : "");
  return (negative ? "-" : "") + body;
}

/**
 * Padanan Python `round(x, n)` untuk float: half-even terhadap nilai eksak.
 * Tanpa `n` hasilnya bilangan bulat (Python `round(x)`).
 */
export function pyRound(x: number, n = 0): number {
  if (!Number.isFinite(x)) {
    throw new BindDefect(`round() atas nilai tak hingga "${String(x)}".`);
  }
  if (!Number.isInteger(n) || Math.abs(n) > 308) {
    throw new BindDefect(`round(): jumlah digit "${n}" tidak sah.`);
  }
  const { negative, q } = roundScaledExact(x, n);
  const s = q.toString();
  let mag: number;
  if (n > 0) {
    const padded = s.length <= n ? "0".repeat(n - s.length + 1) + s : s;
    mag = Number(`${padded.slice(0, padded.length - n)}.${padded.slice(padded.length - n)}`);
  } else {
    mag = Number(s + "0".repeat(-n));
  }
  return negative ? -mag : mag;
}

/**
 * Mata uang mendahului, satuan lain menyusul, selalu dipisah satu spasi
 * (DATUM §10). Satuan beralias konvensi ditulis ulang (EN: "Rp" -> "IDR").
 */
export function withUnit(s: string, unit?: string | null, lang: NumberLanguage = DEFAULT_NUMBER_LANGUAGE): string {
  return withUnitFor(s, unit, lang === DEFAULT_NUMBER_LANGUAGE ? ID : numberConvention(lang));
}

export function withUnitFor(s: string, unit: string | null | undefined, conv: NumberConvention): string {
  if (!unit) return s;
  const u = Object.prototype.hasOwnProperty.call(conv.unitAliases, unit) ? conv.unitAliases[unit] : unit;
  return conv.leadingUnits.includes(u) ? `${u} ${s}` : `${s} ${u}`;
}

/**
 * Semantik `Number.prototype.toFixed` (tanpa pengelompokan ribuan) dengan
 * pemisah desimal konvensi. Khusus angka di pesan diagnosis lint; angka
 * dokumen memakai `fmt` (half-even, paritas Python).
 */
export function fmtFixed(n: number, digits = 2, conv: NumberConvention = ID): string {
  return n.toFixed(digits).replace(".", conv.decimalSeparator);
}

/** Escape teks untuk badan regex (di luar kelas karakter); satu helper untuk format dan audit (L3). */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Potongan sumber regex angka berpemisah untuk satu konvensi. */
export interface NumberPatternSources {
  /** Pemisah ribuan, sudah di-escape. */
  readonly thousands: string;
  /** Pemisah desimal, sudah di-escape. */
  readonly decimal: string;
  /** Angka berpemisah ribuan (minimal satu grup), desimal opsional. */
  readonly grouped: string;
  /** Digit tanpa pemisah ribuan, desimal opsional. */
  readonly plain: string;
}

export function numberPatternSources(conv: NumberConvention = ID): NumberPatternSources {
  const thousands = escapeRegExp(conv.thousandsSeparator);
  const decimal = escapeRegExp(conv.decimalSeparator);
  return {
    thousands,
    decimal,
    grouped: `\\d{1,3}(?:${thousands}\\d{3})+(?:${decimal}\\d+)?`,
    plain: `\\d+(?:${decimal}\\d+)?`,
  };
}
