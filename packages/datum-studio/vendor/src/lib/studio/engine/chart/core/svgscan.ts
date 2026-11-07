/**
 * engine/chart/core — primitif pemindai SVG bersama untuk lint geometri chart (`geometry.ts`)
 * dan diagram (`diagram/fit/lint.ts`) (ENG-FIX #5, review ronde 4 temuan #5).
 *
 * Keduanya port dari metrik harness FIG-01 (`measure.mjs`); konstanta, pembaca atribut,
 * unescape teks, kotak batas, jarak titik-segmen, sampel 7 x 3, dan path -> polilinear
 * kini satu sumber sehingga ambang dan cara baca teks chart/diagram tidak lagi bisa
 * menyimpang. Tanpa dependensi; murni dan deterministik. Hanya memahami keluaran mesin
 * (`SvgDoc`, `Sheet`): atribut ber-kutip ganda, angka mm — bukan parser SVG umum.
 */

/** mm per pt (1 pt = 1/72 in). */
export const MM_PER_PT = 25.4 / 72;
/** Susut vertikal em box ke tinggi tinta (harness FIG-01). */
export const INK_SHRINK = 0.12;
/** Ambang tumpuk teks: luas irisan > 0,2 mm² dan > 8 % kotak terkecil. */
export const OVERLAP_MIN_MM2 = 0.2;
export const OVERLAP_MIN_FRAC = 0.08;
/** Teks dianggap keluar kanvas bila kotaknya melewati viewBox > 0,3 mm. */
export const OUTSIDE_MIN_MM = 0.3;

export type Pt = readonly [number, number];
/** [x0, y0, x1, y1] */
export type Box = readonly [number, number, number, number];

/** Atribut ber-kutip ganda satu tag. */
export function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g;
  for (let k = re.exec(tag); k; k = re.exec(tag)) out[k[1]] = k[2];
  return out;
}

const NAMED: Readonly<Record<string, string>> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

/**
 * Teks yang ditampilkan peramban untuk isi `<text>`/`<tspan>`: entitas XML di-unescape
 * (bernama + numerik, satu lintasan sehingga `&amp;lt;` tetap `&lt;`), lalu tata spasi bawaan
 * SVG (tanpa `xml:space`, seperti Chromium): tab/CR/LF = spasi, spasi beruntun = satu, tepi
 * dibuang. Mesin tidak pernah memancarkan `xml:space="preserve"`.
 */
export function unescXml(s: string): string {
  return s
    .replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (m, e: string) => {
      if (e[0] !== "#") return NAMED[e] ?? m;
      const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/[\t\r\n]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function bboxOf(pts: readonly Pt[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** Jarak titik ke segmen [a, b]. */
export function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Grid sampel 7 x 3 di dalam kotak teks (inset seperti harness FIG-01). `q` = poligon 4 titik
 * [kiri-atas, kanan-atas, kanan-bawah, kiri-bawah] (boleh diputar).
 */
export function inkSamples(q: readonly Pt[]): Pt[] {
  const [p0, p1, p2, p3] = q;
  const S: Pt[] = [];
  for (let u = 0; u < 7; u++) {
    for (let v = 0; v < 3; v++) {
      const fu = 0.12 + 0.76 * (u / 6);
      const fv = 0.2 + 0.6 * (v / 2);
      const top: Pt = [p0[0] + (p1[0] - p0[0]) * fu, p0[1] + (p1[1] - p0[1]) * fu];
      const bot: Pt = [p3[0] + (p2[0] - p3[0]) * fu, p3[1] + (p2[1] - p3[1]) * fu];
      S.push([top[0] + (bot[0] - top[0]) * fv, top[1] + (bot[1] - top[1]) * fv]);
    }
  }
  return S;
}

/** Kotak sejajar sumbu -> poligon 4 titik untuk `inkSamples`. */
export function boxQuad(b: Box): Pt[] {
  return [
    [b[0], b[1]],
    [b[2], b[1]],
    [b[2], b[3]],
    [b[0], b[3]],
  ];
}

// ── Path -> polilinear ──────────────────────────────────────────────────────

function arcPoints(x1: number, y1: number, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): Pt[] {
  // SVG 1.1 F.6.5: parameter ujung -> pusat
  if (rx === 0 || ry === 0) return [[x2, y2]];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy;
  const y1p = -sp * dx + cp * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / (den || 1)));
  if (large === sweep) co = -co;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2;
  const cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 16)));
  const out: Pt[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = t1 + (dt * i) / steps;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push([cp * ex - sp * ey + cx, sp * ex + cp * ey + cy]);
  }
  return out;
}

/** `d` -> daftar subpath polilinear (kurva dirata 8-16 segmen). */
export function pathPolylines(d: string): Pt[][] {
  const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cmd = "";
  let lastC: Pt | null = null;
  let i = 0;
  const nums = (k: number): number[] | null => {
    const v: number[] = [];
    for (let j = 0; j < k; j++) {
      const t = toks[i + j];
      if (t === undefined || /[a-zA-Z]/.test(t)) return null;
      v.push(Number(t));
    }
    i += k;
    return v;
  };
  const bez = (pts: Pt[], n: number): void => {
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      const u = 1 - t;
      if (pts.length === 4) {
        cur.push([
          u * u * u * pts[0][0] + 3 * u * u * t * pts[1][0] + 3 * u * t * t * pts[2][0] + t * t * t * pts[3][0],
          u * u * u * pts[0][1] + 3 * u * u * t * pts[1][1] + 3 * u * t * t * pts[2][1] + t * t * t * pts[3][1],
        ]);
      } else {
        cur.push([u * u * pts[0][0] + 2 * u * t * pts[1][0] + t * t * pts[2][0], u * u * pts[0][1] + 2 * u * t * pts[1][1] + t * t * pts[2][1]]);
      }
    }
  };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    if (C === "Z") {
      if (cur.length) cur.push([sx, sy]);
      x = sx;
      y = sy;
      if (cur.length) out.push(cur);
      cur = [];
      lastC = null;
      if (i < toks.length && !/[a-zA-Z]/.test(toks[i])) i++;
      continue;
    }
    let v: number[] | null;
    if (C === "M") {
      if (!(v = nums(2))) break;
      if (cur.length) out.push(cur);
      x = ox + v[0];
      y = oy + v[1];
      sx = x;
      sy = y;
      cur = [[x, y]];
      cmd = rel ? "l" : "L";
      lastC = null;
    } else if (C === "L") {
      if (!(v = nums(2))) break;
      x = ox + v[0];
      y = oy + v[1];
      cur.push([x, y]);
      lastC = null;
    } else if (C === "H") {
      if (!(v = nums(1))) break;
      x = ox + v[0];
      cur.push([x, y]);
      lastC = null;
    } else if (C === "V") {
      if (!(v = nums(1))) break;
      y = oy + v[0];
      cur.push([x, y]);
      lastC = null;
    } else if (C === "C" || C === "S") {
      const k = C === "C" ? 6 : 4;
      if (!(v = nums(k))) break;
      const p0: Pt = [x, y];
      const c1: Pt = C === "C" ? [ox + v[0], oy + v[1]] : lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
      const c2: Pt = C === "C" ? [ox + v[2], oy + v[3]] : [ox + v[0], oy + v[1]];
      const p3: Pt = C === "C" ? [ox + v[4], oy + v[5]] : [ox + v[2], oy + v[3]];
      bez([p0, c1, c2, p3], 12);
      lastC = c2;
      x = p3[0];
      y = p3[1];
    } else if (C === "Q" || C === "T") {
      const k = C === "Q" ? 4 : 2;
      if (!(v = nums(k))) break;
      const p0: Pt = [x, y];
      const c1: Pt = C === "Q" ? [ox + v[0], oy + v[1]] : lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
      const p2: Pt = C === "Q" ? [ox + v[2], oy + v[3]] : [ox + v[0], oy + v[1]];
      bez([p0, c1, p2], 8);
      lastC = c1;
      x = p2[0];
      y = p2[1];
    } else if (C === "A") {
      if (!(v = nums(7))) break;
      const nx = ox + v[5];
      const ny = oy + v[6];
      cur.push(...arcPoints(x, y, v[0], v[1], v[2], v[3] !== 0, v[4] !== 0, nx, ny));
      x = nx;
      y = ny;
      lastC = null;
    } else {
      break; // perintah tak dikenal: berhenti (konservatif)
    }
  }
  if (cur.length) out.push(cur);
  return out;
}
