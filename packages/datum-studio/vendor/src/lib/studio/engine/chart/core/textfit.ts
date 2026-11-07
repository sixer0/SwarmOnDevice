/**
 * engine/chart/core — `textfit`: ukur, bungkus, dan potong teks label secara deterministik
 * (FIG-02a, audit research/18 §6 P0-2). Modul bersama: grafik memakainya sekarang, diagram
 * (FIG-02b) boleh mengimpornya. Modul ini TIDAK mengimpor apa pun, sehingga aman diimpor dari
 * `engine/diagram/**` tanpa siklus impor.
 *
 * - `measure(s, pt, face, o)`: lebar teks (mm). Struct (IBM Plex Sans Condensed) memakai
 *   tabel lebar glif nyata (diukur di Chromium dari berkas fon terpasang, bobot 400 dan 600,
 *   211 glif ASCII + Latin-1 + tanda baca umum); glif di luar tabel = 0,5 em. Data/mono
 *   (IBM Plex Mono) = 0,6 em tetap. Kerning diabaikan (sedikit konservatif).
 * - `wrap(s, maxW, maxLines, font)`: pecah di batas kata; jumlah baris paling sedikit yang
 *   muat, lalu baris terlebar minimum (seimbang). Tidak muat -> `fits = false`.
 * - `ellipsize(s, maxW, font)`: jalan terakhir; potong di batas glif + "…" (teks lengkap
 *   ditaruh pemanggil di `<title>`, lihat `titleSvg`).
 * - `tspanLines(...)`: isi `<text>` multi-baris (`<tspan x dy>`): SATU elemen `<text>` per
 *   label, sehingga multiset teks tetap satu entri per label.
 *
 * Murni: tanpa acak, tanpa waktu, tanpa DOM.
 */

/** 1 pt = 25,4/72 mm (sama dengan `MM_PER_PT` svg.ts; diulang agar modul berdiri sendiri). */
const MM_PER_PT = 25.4 / 72;

export type TextFace = "struct" | "data";

/** Gaya huruf untuk pengukuran. `pt` = ukuran fisik pt; `trackMm` = letter-spacing (mm). */
export interface FitFont {
  pt: number;
  face?: TextFace;
  bold?: boolean;
  trackMm?: number;
  /** Teks digambar kapital (ukur versi kapital). */
  caps?: boolean;
}

/** Tinggi baris bawaan untuk teks multi-baris, kelipatan ukuran huruf. */
export const LINE_HEIGHT_EM = 1.2;
/** Ascent/descent IBM Plex (hhea 1025/-275 per 1000), dipakai kotak teks lint geometri. */
export const FONT_ASCENT_EM = 1.025;
export const FONT_DESCENT_EM = 0.275;
/** Lebar glif mono (IBM Plex Mono), per em. */
export const MONO_EM = 0.6;
/** Lebar glif di luar tabel, per em. */
export const FALLBACK_EM = 0.5;
export const ELLIPSIS = "…";

// Tabel lebar glif IBM Plex Sans Condensed, per 1000 em, urutan: U+0020..U+007E,
// U+00A0..U+00FF, lalu GLYPH_EXTRA. Sumber: canvas.measureText Chromium 1234 pada berkas
// IBMPlexSansCond-Regular.ttf / -SemiBold.ttf (harness FIG-02a `fig02a/glyphs.mjs`).
const GLYPH_EXTRA = "–—‘’“”•…−×≤≥±‰€→←↑↓·";
const ADV_400: readonly number[] = [
  212, 258, 382, 637, 538, 837, 626, 220, 302, 302, 414, 540, 248, 360, 248, 349, 540, 540, 540, 540, 540, 540, 540, 540,
  540, 540, 258, 258, 540, 540, 540, 431, 803, 579, 589, 561, 607, 526, 505, 627, 637, 362, 462, 574, 453, 730, 637, 638,
  548, 638, 578, 525, 516, 611, 549, 808, 555, 534, 524, 286, 349, 286, 540, 508, 540, 483, 524, 454, 524, 495, 294, 477,
  513, 228, 228, 477, 247, 787, 513, 504, 524, 524, 332, 439, 318, 513, 445, 698, 459, 451, 421, 310, 288, 310, 540, 212,
  258, 465, 535, 544, 546, 288, 526, 540, 700, 362, 463, 540, 0, 428, 540, 422, 540, 320, 320, 540, 518, 588, 296, 540,
  320, 360, 463, 732, 760, 722, 422, 579, 579, 579, 579, 579, 579, 820, 561, 526, 526, 526, 526, 362, 362, 362, 362, 610,
  637, 638, 638, 638, 638, 638, 540, 638, 611, 611, 611, 611, 534, 548, 579, 483, 483, 483, 483, 483, 483, 782, 454, 495,
  495, 495, 495, 228, 228, 228, 228, 502, 513, 504, 504, 504, 504, 504, 540, 504, 513, 513, 513, 513, 451, 524, 451, 528,
  702, 248, 248, 431, 431, 358, 729, 540, 540, 549, 549, 540, 1000, 563, 1000, 1000, 780, 780, 296,
];
const ADV_600: readonly number[] = [
  212, 284, 429, 582, 533, 870, 644, 235, 303, 303, 514, 540, 274, 362, 274, 401, 540, 540, 540, 540, 540, 540, 540, 540,
  540, 540, 282, 282, 540, 540, 540, 447, 811, 606, 600, 581, 625, 544, 523, 641, 651, 387, 494, 614, 473, 737, 651, 642,
  583, 642, 601, 546, 524, 624, 583, 861, 595, 566, 540, 299, 401, 299, 540, 502, 540, 507, 544, 464, 544, 505, 328, 492,
  532, 252, 255, 511, 268, 802, 532, 506, 544, 544, 357, 449, 334, 533, 476, 739, 488, 483, 452, 329, 346, 329, 540, 212,
  284, 491, 520, 560, 575, 346, 515, 540, 712, 395, 494, 540, 0, 420, 540, 422, 540, 319, 320, 540, 539, 603, 316, 540,
  320, 383, 494, 728, 757, 718, 439, 606, 606, 606, 606, 606, 606, 859, 581, 544, 544, 544, 544, 387, 387, 387, 387, 626,
  651, 642, 642, 642, 642, 642, 540, 641, 624, 624, 624, 624, 566, 582, 613, 507, 507, 507, 507, 507, 507, 782, 464, 505,
  505, 505, 505, 254, 254, 254, 254, 533, 532, 506, 506, 506, 506, 506, 540, 512, 533, 533, 533, 533, 483, 544, 483, 528,
  702, 269, 269, 474, 474, 380, 790, 540, 540, 549, 549, 540, 1000, 565, 1000, 1000, 810, 810, 316,
];

function buildAdvanceMap(adv: readonly number[]): ReadonlyMap<number, number> {
  const m = new Map<number, number>();
  let k = 0;
  for (let c = 0x20; c <= 0x7e; c++) m.set(c, adv[k++]);
  for (let c = 0xa0; c <= 0xff; c++) m.set(c, adv[k++]);
  for (const ch of GLYPH_EXTRA) {
    const cp = ch.codePointAt(0) as number;
    if (!m.has(cp)) m.set(cp, adv[k]);
    k++;
  }
  return m;
}

const ADV_REGULAR = buildAdvanceMap(ADV_400);
const ADV_SEMIBOLD = buildAdvanceMap(ADV_600);

/** Lebar teks dalam em (tanpa letter-spacing). */
export function measureEm(s: string, face: TextFace = "struct", bold = false): number {
  if (face === "data") return [...s].length * MONO_EM;
  const map = bold ? ADV_SEMIBOLD : ADV_REGULAR;
  let w = 0;
  for (const ch of s) {
    const a = map.get(ch.codePointAt(0) as number);
    w += a === undefined ? FALLBACK_EM : a / 1000;
  }
  return w;
}

/**
 * Lebar teks (mm) pada ukuran fisik `pt`. `o.caps` mengukur versi kapital, `o.trackMm`
 * menambah letter-spacing per glif (seperti renderer SVG).
 */
export function measure(s: string, pt: number, face: TextFace = "struct", o: { bold?: boolean; trackMm?: number; caps?: boolean } = {}): number {
  const t = o.caps ? s.toUpperCase() : s;
  return measureEm(t, face, o.bold ?? false) * pt * MM_PER_PT + [...t].length * (o.trackMm ?? 0);
}

/** Lebar teks (mm) untuk gaya `FitFont`. */
export function measureFont(s: string, font: FitFont): number {
  return measure(s, font.pt, font.face ?? "struct", font);
}

/** Tinggi baris (mm) untuk gaya huruf. */
export function lineHeightMm(font: Pick<FitFont, "pt">, em = LINE_HEIGHT_EM): number {
  return font.pt * MM_PER_PT * em;
}

export interface WrapResult {
  /** Baris hasil (tanpa spasi tepi). */
  lines: string[];
  /** Lebar baris terlebar (mm). */
  widthMm: number;
  /** Semua baris <= maxW dan jumlah baris <= maxLines. */
  fits: boolean;
}

/** Token kata: pecah di spasi; kata majemuk boleh dipecah setelah "-" atau "/" (tetap di baris atas). */
function words(s: string): string[] {
  const out: string[] = [];
  for (const w of s.trim().split(/\s+/)) {
    if (!w) continue;
    out.push(...w.split(/(?<=[-/])(?=.)/));
  }
  return out;
}

function joinLine(ws: readonly string[]): string {
  let s = "";
  for (const w of ws) s += s === "" || /[-/]$/.test(s) ? w : ` ${w}`;
  return s;
}

/**
 * Bungkus `s` ke paling banyak `maxLines` baris selebar <= `maxW` mm. Pilih jumlah baris
 * terkecil yang muat; di antara pemecahan dengan jumlah itu, pilih baris terlebar minimum
 * (seri: pemecahan paling awal). Bila tidak ada yang muat, kembalikan pemecahan dengan baris
 * terlebar minimum (<= `maxLines` baris) dan `fits = false`. Deterministik.
 */
export function wrap(s: string, maxW: number, maxLines: number, font: FitFont): WrapResult {
  const ws = words(s);
  if (ws.length === 0) return { lines: [""], widthMm: 0, fits: true };
  const one = joinLine(ws);
  const w1 = measureFont(one, font);
  const limit = Math.max(1, Math.floor(maxLines));
  if (w1 <= maxW + 1e-9 || limit === 1 || ws.length === 1) return { lines: [one], widthMm: w1, fits: w1 <= maxW + 1e-9 };
  const n = ws.length;
  const seg = (i: number, j: number): number => measureFont(joinLine(ws.slice(i, j)), font);
  const memo = new Map<string, { cost: number; cuts: number[] }>();
  // best(i, k): pecah kata i..n-1 menjadi tepat k baris, minimalkan baris terlebar.
  const best = (i: number, k: number): { cost: number; cuts: number[] } => {
    const key = `${i}:${k}`;
    const hit = memo.get(key);
    if (hit) return hit;
    let res: { cost: number; cuts: number[] };
    if (k === 1) res = { cost: seg(i, n), cuts: [] };
    else {
      res = { cost: Infinity, cuts: [] };
      for (let j = i + 1; j <= n - (k - 1); j++) {
        const head = seg(i, j);
        if (head >= res.cost) break; // baris pertama makin lebar seiring j
        const rest = best(j, k - 1);
        const c = Math.max(head, rest.cost);
        if (c < res.cost - 1e-9) res = { cost: c, cuts: [j, ...rest.cuts] };
      }
    }
    memo.set(key, res);
    return res;
  };
  const toResult = (cuts: readonly number[], fits: boolean): WrapResult => {
    const lines: string[] = [];
    let a = 0;
    for (const c of [...cuts, n]) {
      lines.push(joinLine(ws.slice(a, c)));
      a = c;
    }
    return { lines, widthMm: Math.max(0, ...lines.map((l) => measureFont(l, font))), fits };
  };
  const kMax = Math.min(limit, n);
  let fallback = { cost: w1, cuts: [] as number[] };
  for (let k = 2; k <= kMax; k++) {
    const b = best(0, k);
    if (b.cost <= maxW + 1e-9) return toResult(b.cuts, true);
    if (b.cost < fallback.cost - 1e-9) fallback = b;
  }
  return toResult(fallback.cuts, false);
}

/**
 * Potong `s` agar <= `maxW` mm, diakhiri "…" (jalan terakhir). Teks yang sudah muat
 * dikembalikan apa adanya (`truncated = false`).
 */
export function ellipsize(s: string, maxW: number, font: FitFont): { text: string; truncated: boolean } {
  if (measureFont(s, font) <= maxW + 1e-9) return { text: s, truncated: false };
  const glyphs = [...s];
  let lo = 0;
  let hi = glyphs.length;
  // prefiks terpanjang yang muat bersama elipsis (lebar monoton terhadap panjang prefiks)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const t = glyphs.slice(0, mid).join("").trimEnd() + ELLIPSIS;
    if (measureFont(t, font) <= maxW + 1e-9) lo = mid;
    else hi = mid - 1;
  }
  const text = lo === 0 ? ELLIPSIS : glyphs.slice(0, lo).join("").trimEnd() + ELLIPSIS;
  return { text, truncated: true };
}

/**
 * Bungkus; bila tetap tidak muat, isi rakus sampai `maxLines` baris lalu potong baris yang
 * masih terlalu lebar dengan elipsis. `truncated` = ada teks yang hilang dari tampilan.
 */
export function wrapEllipsize(s: string, maxW: number, maxLines: number, font: FitFont): WrapResult & { truncated: boolean } {
  const w = wrap(s, maxW, maxLines, font);
  if (w.fits) return { ...w, truncated: false };
  const ws = words(s);
  const lines: string[] = [];
  let cur: string[] = [];
  let i = 0;
  for (; i < ws.length && lines.length < Math.max(1, maxLines) - 1; i++) {
    const trial = [...cur, ws[i]];
    if (cur.length && measureFont(joinLine(trial), font) > maxW + 1e-9) {
      lines.push(joinLine(cur));
      cur = [ws[i]];
    } else cur = trial;
  }
  lines.push(joinLine([...cur, ...ws.slice(i)]));
  let truncated = false;
  const out = lines.map((l) => {
    const e = ellipsize(l, maxW, font);
    if (e.truncated) truncated = true;
    return e.text;
  });
  return { lines: out, widthMm: Math.max(0, ...out.map((l) => measureFont(l, font))), fits: true, truncated };
}

export interface SpanFit {
  x: number;
  anchor: "start" | "middle" | "end";
  lines: string[];
  /** Teks lengkap bila ada yang dipotong. */
  title?: string;
}

/**
 * Jaga satu label horizontal di dalam rentang [lo, hi] (mis. tepi kanvas). `null` bila sudah
 * muat. Label tengah digeser (anchor dijepit) bila muat lebar rentang; label rata kiri/kanan
 * dibungkus ke ruang dari anchornya sampai tepi (<= `maxLines`, lalu elipsis); ruang < 3 mm
 * -> digeser ke dalam. Deterministik.
 *
 * `edge` (ENG-FIX #1): batas "keluar" yang sebenarnya (mis. tepi kanvas nyata [0, W]),
 * terpisah dari rentang penempatan [lo, hi] yang bermargin. Teks yang masih di dalam
 * `edge` tidak diubah; margin [lo, hi] hanya dipakai saat menempatkan ulang teks yang memang
 * keluar. Tanpa `edge`: batas keluar = [lo, hi] (perilaku lama).
 */
export function fitWithinSpan(
  s: string,
  x: number,
  anchor: "start" | "middle" | "end",
  lo: number,
  hi: number,
  font: FitFont,
  maxLines = 2,
  edge?: { lo: number; hi: number },
): SpanFit | null {
  const w = measureFont(s, font);
  const x0 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  const outLo = edge?.lo ?? lo;
  const outHi = edge?.hi ?? hi;
  if (x0 >= outLo - 1e-9 && x0 + w <= outHi + 1e-9) return null;
  const span = hi - lo;
  const shifted = (): SpanFit => {
    if (w <= span) {
      const nx0 = Math.min(Math.max(x0, lo), hi - w);
      return { x: nx0 + w / 2, anchor: "middle", lines: [s] };
    }
    const r = wrapEllipsize(s, span, maxLines, font);
    return { x: (lo + hi) / 2, anchor: "middle", lines: r.lines, title: r.truncated ? s : undefined };
  };
  if (anchor === "middle") {
    // Tetap berpusat bila bungkus <= maxLines muat di ruang simetris sampai tepi terdekat.
    const sym = 2 * Math.min(x - lo, hi - x);
    if (sym >= 8) {
      const r = wrap(s, sym, maxLines, font);
      if (r.fits) return { x, anchor, lines: r.lines };
    }
    // Label sangat panjang (> separuh rentang): digeser akan menimpa label lain; potong di tempat.
    if (w > span / 2) {
      const e = ellipsize(s, Math.max(sym, 8), font);
      return { x: Math.min(Math.max(x, lo + 4), hi - 4), anchor, lines: [e.text], title: s };
    }
    return shifted();
  }
  const avail = anchor === "start" ? hi - x : x - lo;
  if (avail < 3 || avail > span) return shifted();
  const r = wrapEllipsize(s, avail, maxLines, font);
  return { x, anchor, lines: r.lines, title: r.truncated ? s : undefined };
}

/** Garis dasar baris pertama blok `nLines` agar blok rata atas/tengah/bawah terhadap `y`. */
export function firstBaseline(y: number, nLines: number, lineMm: number, align: "top" | "middle" | "bottom" = "top"): number {
  if (align === "middle") return y - ((nLines - 1) * lineMm) / 2;
  if (align === "bottom") return y - (nLines - 1) * lineMm;
  return y;
}

/** Karakter tak sah XML 1.0 (sama dengan svg.ts `stripXmlInvalid`, versi tanpa surrogate tunggal). */
const XML_INVALID = new RegExp(`[\u0000-\u0008\u000B\u000C\u000E-\u001F${String.fromCharCode(0xfffe, 0xffff)}]`, "g");

/** Escape teks XML (&, <, >) dan buang karakter tak sah XML 1.0. */
function escXml(s: string): string {
  return s
    .replace(XML_INVALID, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function numStr(v: number): string {
  const r = Number(v.toFixed(4));
  return Object.is(r, -0) || r === 0 ? "0" : String(r);
}

/**
 * Isi `<text>` multi-baris: `<tspan x="X" dy="0">baris 1</tspan><tspan x="X" dy="L">…`.
 * Satu baris -> teks polos (tanpa tspan), sama dengan isi teks biasa.
 */
export function tspanLines(lines: readonly string[], x: number, lineMm: number): string {
  if (lines.length <= 1) return escXml(lines[0] ?? "");
  return lines.map((l, i) => `<tspan x="${numStr(x)}" dy="${i === 0 ? "0" : numStr(lineMm)}">${escXml(l)}</tspan>`).join("");
}

/** Elemen `<title>` (teks lengkap untuk label yang dipotong). */
export function titleSvg(full: string): string {
  return `<title>${escXml(full)}</title>`;
}
