/**
 * engine/symbols — primitif SVG milimeter dan token palet (S31, I21).
 *
 * Port 1:1 helper `_g`, `_r`, `_c`, `_p`, `_path`, `_lead`, `_label` dari
 * HS `datumsimbol.py:62-94, 306-310`. Palet dibaca dari default ParamDef
 * `color.interior.*` (P4C, research/04 T031) = nilai `tokens.json`
 * `colour.interior` HS; nol hex literal di modul ini (aturan HS baris 14-15).
 *
 * Format angka: dibulatkan 4 desimal lalu ditulis bentuk terpendek
 * (12, 0.3, 14.33). Python menulis `repr` float (12.0, 0.30000000000000004);
 * selisih numerik <= 5e-5 mm, di bawah toleransi paritas SY +/- 0,01 mm
 * (research/06:259). Keluaran deterministik: tanpa acak, tanpa waktu.
 */
import { PARAMS_BY_KEY } from "../../params";
import { StudioEngineError } from "../../contract/errors";
import { xmlEscapeText } from "../diagram/core/xml";

const HEX6 = /^[0-9A-Fa-f]{6}$/;

function token(name: string): string {
  const key = `color.interior.${name}`;
  const v = PARAMS_BY_KEY.get(key)?.default;
  if (typeof v !== "string" || !HEX6.test(v)) {
    throw new StudioEngineError("SCHEMA_INVALID", `engine/symbols: token palet ${key} tidak ada atau bukan hex 6 digit`, { key, value: v });
  }
  return `#${v.toUpperCase()}`;
}

/** Palet interior (HS datumsimbol.py:49-52). */
export const INK900 = token("ink900");
export const INK700 = token("ink700");
export const INK400 = token("ink400");
export const INK200 = token("ink200");
export const SIGNAL = token("signal");
export const ALERT = token("alert");
export const PAPER = token("paper");

/** mm, lantai fotokopi 0,18 + satu langkah (DT-11). HS :54 */
export const HAIR = 0.2;
/** mm, garis bentuk simbol. HS :55 */
export const STROKE_W = 0.35;
/** mm, petak simbol. HS :56 */
export const CELL = 24.0;
/**
 * Ukuran huruf label lembar dalam SATUAN PENGGUNA SVG = mm (viewBox 1 = 1 mm),
 * bukan pt: 6 mm ~ 17 pt, sehingga juga label terkecil `LABEL_MM - 1` = 5 mm
 * (~14 pt) jauh di atas lantai DATUM-28 5,5 pt. Nama HS `LABEL_PT` (:57)
 * menyesatkan; nilai dan keluaran tidak berubah (paritas SY). S84 #15.
 */
export const LABEL_MM = 6.0;

/** Angka SVG deterministik: 4 desimal, tanpa nol buntut, tanpa "-0". */
export function num(v: number): string {
  if (!Number.isFinite(v)) {
    throw new StudioEngineError("SCHEMA_INVALID", `engine/symbols: angka geometri tidak hingga (${v})`);
  }
  const r = Number(v.toFixed(4));
  return Object.is(r, -0) ? "0" : String(r);
}

/** Setara `round(v, 2)` Python untuk atribut transform lembar (HS :342-346). */
export function round2(v: number): number {
  return Number(v.toFixed(2));
}

/**
 * Escape teks/atribut XML (`& < > "`) setelah membuang karakter yang tidak sah
 * di XML 1.0 (S84 #4; helper tunggal `diagram/core/xml.ts`). Isi HS tidak
 * memuat karakter khusus; penjaga saja.
 */
export function xmlEscape(s: string): string {
  return xmlEscapeText(s, true);
}

/** `_g`: garis. */
export function g(x1: number, y1: number, x2: number, y2: number, col = INK900, w = STROKE_W, dash?: string): string {
  const d = dash ? ` stroke-dasharray="${dash}"` : "";
  return `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${col}" stroke-width="${num(w)}"${d}/>`;
}

/** `_r`: persegi panjang. */
export function r(x: number, y: number, wd: number, ht: number, col = INK900, w = STROKE_W, fill = "none"): string {
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(wd)}" height="${num(ht)}" fill="${fill}" stroke="${col}" stroke-width="${num(w)}"/>`;
}

/** `_c`: lingkaran. */
export function c(cx: number, cy: number, rad: number, col = INK900, w = STROKE_W, fill = "none"): string {
  return `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(rad)}" fill="${fill}" stroke="${col}" stroke-width="${num(w)}"/>`;
}

/** `_p`: poligon tertutup. */
export function p(pts: ReadonlyArray<readonly [number, number]>, col = INK900, w = STROKE_W, fill = "none"): string {
  const s = pts.map(([a, b]) => `${num(a)},${num(b)}`).join(" ");
  return `<polygon points="${s}" fill="${fill}" stroke="${col}" stroke-width="${num(w)}"/>`;
}

/** `_path`: path dengan data `d` literal (dari sumber HS). */
export function path(d: string, col = INK900, w = STROKE_W, fill = "none"): string {
  return `<path d="${d}" fill="${fill}" stroke="${col}" stroke-width="${num(w)}"/>`;
}

/** `text` monospace/condensed seperti literal HS. */
export function text(x: number, y: number, family: string, size: number, fill: string, body: string, anchor?: string): string {
  const a = anchor ? ` text-anchor="${anchor}"` : "";
  return `<text x="${num(x)}" y="${num(y)}" font-family="${family}" font-size="${num(size)}" fill="${fill}"${a}>${xmlEscape(body)}</text>`;
}

/** `_lead`: kaki sambungan standar di tengah tepi sel (t/b/l/r). HS :88-94 */
export function lead(side: "t" | "b" | "l" | "r"): string {
  const m = CELL / 2.0;
  switch (side) {
    case "t":
      return g(m, 0, m, 4, INK900, HAIR * 2);
    case "b":
      return g(m, CELL - 4, m, CELL, INK900, HAIR * 2);
    case "l":
      return g(0, m, 4, m, INK900, HAIR * 2);
    case "r":
      return g(CELL - 4, m, CELL, m, INK900, HAIR * 2);
  }
}

/** `_label`: teks lembar, IBM Plex Sans Condensed. HS :306-310 */
export function label(
  body: string,
  x: number,
  y: number,
  size: number = LABEL_MM,
  color: string = INK700,
  anchor: "start" | "middle" | "end" = "start",
  bold = false,
): string {
  const w = bold ? ' font-weight="600"' : "";
  return `<text x="${num(x)}" y="${num(y)}" font-family="IBM Plex Sans Condensed" font-size="${num(size)}" fill="${color}" text-anchor="${anchor}"${w}>${xmlEscape(body)}</text>`;
}
