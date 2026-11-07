/**
 * Paritas angka Python untuk keluaran SVG diagram (S26, paritas DG research/06 §6.2).
 *
 * Garis A (`datum_diagram.py`) menulis angka lewat `"%s" % round(x, n)`:
 * - `round(x, n)` = pembulatan desimal yang benar atas nilai biner eksak, seri
 *   tepat ke genap (CPython `float_round` -> `_Py_dg_dtoa` mode 3);
 * - `round(x)` tanpa digit = setengah-ke-genap, hasil int;
 * - `str(float)` = repr terpendek yang pulang-pergi, selalu memuat `.0` untuk
 *   bilangan bulat, notasi ilmiah bila eksponen < -4 atau >= 16;
 * - `round(int, n)` tetap int (mis. `_svg_text(0, ...)` menulis `x="0"`).
 * Modul ini murni dan deterministik.
 */

/** Penanda bilangan yang di Python bertipe `int` (dicetak tanpa `.0`). */
export class PyInt {
  constructor(readonly value: number) {}
}

/** Bilangan Python: float (number) atau int (PyInt). */
export type PyNumber = number | PyInt;

export function pyInt(n: number): PyInt {
  return new PyInt(Math.trunc(n));
}

/** `round(x)` Python: setengah ke genap, hasil bilangan bulat. */
export function pyRound0(x: number): number {
  if (!Number.isFinite(x)) return x;
  const f = Math.floor(x);
  const diff = x - f; // eksak untuk |x| < 2^52
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Pembulatan desimal eksak setengah-ke-genap menjadi string digit (tanpa tanda),
 * dasar `round(x, nd)` dan `"%.*f"` Python. `nd` 0..20.
 */
function roundDecimalString(absX: number, nd: number): string {
  // toFixed(100) = ekspansi desimal eksak nilai biner (ECMA-262: n/10^f - x minimum)
  // untuk rentang angka diagram (|x| < 1e21, digit pecahan double <= ~1074 tetapi
  // nilai berorde 1e-3..1e3 hanya punya < 70 digit pecahan, jadi tetap eksak).
  const s = absX.toFixed(100);
  const dot = s.indexOf(".");
  const intPart = s.slice(0, dot);
  const frac = s.slice(dot + 1);
  const keep = intPart + frac.slice(0, nd);
  const rest = frac.slice(nd);
  let up = false;
  const first = rest.charCodeAt(0) - 48;
  if (first > 5) up = true;
  else if (first === 5) {
    if (/[1-9]/.test(rest.slice(1))) up = true;
    else up = (keep.charCodeAt(keep.length - 1) - 48) % 2 === 1;
  }
  let digits = BigInt(keep);
  if (up) digits += BigInt(1);
  let ds = digits.toString();
  if (nd === 0) return ds;
  if (ds.length <= nd) ds = "0".repeat(nd - ds.length + 1) + ds;
  return `${ds.slice(0, ds.length - nd)}.${ds.slice(ds.length - nd)}`;
}

/** `round(x, nd)` Python untuk float (nd >= 0). Nol negatif dipertahankan. */
export function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0 || Object.is(x, -0);
  const str = roundDecimalString(Math.abs(x), nd);
  const v = Number(str);
  return neg ? -v : v;
}

/** `"%.{nd}f" % x` Python (pembulatan setengah-ke-genap eksak). */
export function pyFixed(x: number, nd: number): string {
  if (!Number.isFinite(x)) return x > 0 ? "inf" : x < 0 ? "-inf" : "nan";
  const neg = x < 0 || Object.is(x, -0);
  const str = roundDecimalString(Math.abs(x), nd);
  return neg ? `-${str}` : str;
}

/** `repr(float)` Python. */
export function pyReprFloat(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const ax = Math.abs(x);
  if (ax >= 1e16 || ax < 1e-4) {
    // Python: mantisa terpendek + "e" + tanda + eksponen minimal 2 digit
    const e = x.toExponential();
    const [mant, exp] = e.split("e");
    const sign = exp.startsWith("-") ? "-" : "+";
    const digits = exp.replace(/^[+-]/, "");
    return `${mant}e${sign}${digits.length < 2 ? `0${digits}` : digits}`;
  }
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** `"%s" % v` Python untuk bilangan (float -> repr, int -> desimal). */
export function pyStrNum(v: PyNumber): string {
  if (v instanceof PyInt) return String(v.value);
  return pyReprFloat(v);
}

/** `"%s" % round(v, nd)`: int tetap int, float dibulatkan lalu repr. */
export function pyNum(v: PyNumber, nd: number): string {
  if (v instanceof PyInt) return String(v.value);
  return pyReprFloat(pyRound(v, nd));
}

/** `str(v)` Python untuk nilai JSON (None/True/False/float). */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyReprFloat(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** `repr(str)` Python (kutip tunggal kecuali isi memuat ' tanpa "). */
export function pyReprStr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let body = s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  if (q === "'") body = body.replace(/'/g, "\\'");
  return q + body + q;
}

/** `repr(v)` Python untuk nilai JSON (dict, list, str, angka, None/True/False). */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyReprFloat(v);
  if (typeof v === "string") return pyReprStr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${pyReprStr(k)}: ${pyRepr(x)}`)
      .join(", ")}}`;
  }
  return String(v);
}

/** `len(str(v))` Python: jumlah titik kode, bukan unit UTF-16. */
export function pyLen(s: string): number {
  return Array.from(s).length;
}
