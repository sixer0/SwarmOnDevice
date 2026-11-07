/**
 * Hitungan nilai warna untuk DATUM-14 (per halaman) dan DATUM-25 (per gambar).
 *
 * Acuan perilaku: HS datum_lint.py `chromatic()` — hanya warna kromatik yang
 * dihitung ((maks - min) / maks >= 0,15); abu-abu netral, hitam, putih dan
 * kertas tidak dihitung. Tambahan K-32 (usulan E-16, research/01 §7.1): ramp
 * tinta (ink900..ink100 interior, ramp pembungkus) dihitung SATU keluarga,
 * karena ink900/ink700/ink400 berhue dingin dan lolos ambang kromatik HS
 * sehingga tanpa aturan ini setiap halaman sudah memakai 3 dari 5 nilai.
 */

/** Satu ramp tinta: anggota tetap (hex) plus pita hue/saturasi untuk nilai turunan. */
export interface InkRamp {
  name: string;
  /** Hex RRGGBB huruf besar tanpa '#'. */
  members: readonly string[];
  /** Hue pusat (derajat) dan toleransinya; saturasi HSV maksimum. */
  hueDeg: number;
  hueTolDeg: number;
  maxSat: number;
}

/**
 * Ramp bawaan dari katalog P4C (`src/lib/studio/params/color-type.ts` c(2..5), c(9..13)).
 * Hue terukur: ramp interior 205..210 derajat (s <= 0,33), ramp pembungkus 24..38 derajat (s <= 0,25).
 */
export const DEFAULT_INK_RAMPS: readonly InkRamp[] = [
  {
    name: "ink",
    members: ["101418", "2B3640", "6B7783", "C3CBD1", "EFF2F4", "D9D9D9"],
    hueDeg: 208,
    hueTolDeg: 25,
    maxSat: 0.4,
  },
  {
    name: "wrapper-ink",
    members: ["14110F", "33302C", "7A756E", "C4BEB4"],
    hueDeg: 30,
    hueTolDeg: 18,
    maxSat: 0.3,
  },
];

/** Ambang kromatik HS `chromatic()`. */
export const CHROMATIC_MIN = 0.15;

const NAMED: Readonly<Record<string, string>> = {
  black: "000000",
  white: "FFFFFF",
  gray: "808080",
  grey: "808080",
  silver: "C0C0C0",
  red: "FF0000",
  maroon: "800000",
  green: "008000",
  lime: "00FF00",
  blue: "0000FF",
  navy: "000080",
  yellow: "FFFF00",
  orange: "FFA500",
  purple: "800080",
  fuchsia: "FF00FF",
  magenta: "FF00FF",
  aqua: "00FFFF",
  cyan: "00FFFF",
  teal: "008080",
  olive: "808000",
};

function hex2(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n)));
  return v.toString(16).toUpperCase().padStart(2, "0");
}

/**
 * Normalisasi nilai warna CSS/SVG ke RRGGBB. Null untuk none, transparent,
 * currentColor, url(...), alfa nol, atau nilai tak terbaca.
 */
export function normaliseColour(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.trim().replace(/\s*!important$/i, "").toLowerCase();
  if (!v || v === "none" || v === "transparent" || v === "currentcolor" || v === "inherit" || v.startsWith("url(")) return null;
  // Hex tanpa '#' (bentuk keluaran analyseSvg dan registri P4C) diterima hanya 6 digit.
  if (/^[0-9a-f]{6}$/.test(v)) return v.toUpperCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      if (h.length === 4 && h[3] === "0") return null;
      return (h[0] + h[0] + h[1] + h[1] + h[2] + h[2]).toUpperCase();
    }
    if (h.length === 6) return h.toUpperCase();
    if (h.length === 8) return h.slice(6) === "00" ? null : h.slice(0, 6).toUpperCase();
    return null;
  }
  m = /^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)(%?)(?:[\s,/]+([\d.]+)(%?))?\s*\)$/.exec(v);
  if (m) {
    if (m[7] !== undefined) {
      const a = m[8] === "%" ? parseFloat(m[7]) / 100 : parseFloat(m[7]);
      if (a === 0) return null;
    }
    const ch = (n: string, pct: string) => (pct === "%" ? (parseFloat(n) * 255) / 100 : parseFloat(n));
    return hex2(ch(m[1], m[2])) + hex2(ch(m[3], m[4])) + hex2(ch(m[5], m[6]));
  }
  return NAMED[v] ?? null;
}

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

/** HS `chromatic()`: maks > 0 dan (maks - min) / maks >= 0,15. */
export function isChromatic(hex: string): boolean {
  const [r, g, b] = rgb(hex);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx > 0 && (mx - mn) / mx >= CHROMATIC_MIN;
}

/** Hue (derajat) dan saturasi HSV. */
function hueSat(hex: string): { hue: number; sat: number } {
  const [r, g, b] = rgb(hex);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  const sat = mx === 0 ? 0 : d / mx;
  if (d === 0) return { hue: 0, sat };
  let h: number;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { hue: h, sat };
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Nama ramp bila warna termasuk satu ramp tinta, selain itu null. */
export function rampOf(hex: string, ramps: readonly InkRamp[]): string | null {
  for (const r of ramps) if (r.members.includes(hex)) return r.name;
  const { hue, sat } = hueSat(hex);
  for (const r of ramps) if (sat <= r.maxSat && hueDistance(hue, r.hueDeg) <= r.hueTolDeg) return r.name;
  return null;
}

export interface ColourCount {
  /** Jumlah nilai warna menurut aturan (keluarga ramp = 1). */
  count: number;
  /** Nilai yang dihitung: hex kromatik di luar ramp, plus nama ramp `ramp:<nama>`. */
  values: string[];
  /** Hex kromatik mentah (sebelum ramp dilipat). */
  chromatic: string[];
}

/** Hitung nilai warna dari daftar warna mentah (hex atau CSS). Deterministik, urut. */
export function countColourValues(colours: Iterable<string>, ramps: readonly InkRamp[]): ColourCount {
  const chrom = new Set<string>();
  for (const c of colours) {
    const h = normaliseColour(c);
    if (h && isChromatic(h)) chrom.add(h);
  }
  const values = new Set<string>();
  for (const h of chrom) {
    const ramp = rampOf(h, ramps);
    values.add(ramp ? `ramp:${ramp}` : `#${h}`);
  }
  const list = [...values].sort();
  return { count: list.length, values: list, chromatic: [...chrom].sort().map((h) => `#${h}`) };
}

/**
 * Swarm patch (row 124; decisions C23 check 25 and C29 K-32; manual Rev A DT-06 ID p.48, Table 9.4
 * p.57): colour values of ONE figure. Rev A allows at most 5 hex values besides the white ground
 * and counts every printed value, so the ink ramp is NOT folded into one family (Studio's K-32 is
 * in neither manual edition) and neutral greys are not dropped. Grounds: paper #FCFCFB, wrapper
 * paper #FBFAF7 and white #FFFFFF (as datum_lint.py check 25).
 */
export const FIGURE_GROUNDS: readonly string[] = ["FCFCFB", "FBFAF7", "FFFFFF"];

export function countFigureColourValues(colours: Iterable<string>): ColourCount {
  const all = new Set<string>();
  for (const c of colours) {
    const h = normaliseColour(c);
    if (h && !FIGURE_GROUNDS.includes(h)) all.add(h);
  }
  const list = [...all].sort().map((h) => `#${h}`);
  return { count: list.length, values: list, chromatic: list.filter((h) => isChromatic(h.slice(1))) };
}
