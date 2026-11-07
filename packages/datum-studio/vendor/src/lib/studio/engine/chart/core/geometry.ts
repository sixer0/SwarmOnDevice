/**
 * engine/chart/core — lint geometri teks keluaran chart (FIG-02a, audit research/18 §6 P0-1).
 *
 * Port tanpa browser dari metrik harness FIG-01 (`measure.mjs`, §2.3): kotak teks ditaksir
 * dari `textfit` (tabel lebar glif IBM Plex terkalibrasi, mono 0,6 em) + anchor + rotasi +
 * baris `<tspan>`; tinggi kotak = em box IBM Plex (ascent 1,025 / descent 0,275) disusutkan
 * 12 % atas/bawah ke tinggi tinta, seperti harness. Empat jenis cacat:
 *
 * - `textOverlap`: luas irisan dua kotak teks > 0,2 mm² dan > 8 % kotak terkecil (per pasangan);
 * - `textOutside`: sudut kotak teks di luar viewBox > 0,3 mm;
 * - `textStraddleMark`: 21 titik sampel kotak teks; sebagian (bukan semua) jatuh di isian
 *   tanda `data-mark` berisi (rect/circle/path). Label yang seluruhnya di dalam tanda = sengaja;
 * - `lineThroughText`: titik sampel kena goresan tanda garis (`line`, path tanpa isian,
 *   `data-mark` line/link).
 *
 * Pengecualian halo (FIG-02c, opt-in lewat `LintOptions.haloExempt`; renderChart memakai
 * `CHART_LINT_OPTIONS`): teks berhalo kertas (`stroke` + `paint-order="stroke"`) tidak
 * dihitung `lineThroughText` (halo memutus garis di bawah huruf, padanan pita knockout) dan
 * tidak dihitung `textStraddleMark` terhadap isian tanda `area` (pita kontur/area muda).
 * Tanda isian lain (batang, baji, titik) tetap dihitung. Tanpa opsi perilaku = FIG-02a.
 *
 * Hasil lint hanya REPORT (tidak pernah FAIL; uji asap tetap hijau) dengan `suggest` yang
 * bisa langsung dipakai agen (audit §7.2). Deterministik: masukan SVG sama -> hasil sama.
 * Parser hanya memahami keluaran `SvgDoc` (atribut ber-kutip ganda, angka mm, transform
 * translate/scale/rotate) — bukan parser SVG umum.
 */
import type { LintIssue } from "../../../contract";
import { intentSupport, orientationTarget } from "./intent";
import { FONT_ASCENT_EM, FONT_DESCENT_EM, measure } from "./textfit";
import {
  attrsOf,
  bboxOf,
  inkSamples,
  INK_SHRINK,
  MM_PER_PT,
  OUTSIDE_MIN_MM,
  OVERLAP_MIN_FRAC,
  OVERLAP_MIN_MM2,
  pathPolylines,
  type Pt,
  segDist,
  unescXml,
} from "./svgscan";

export { pathPolylines } from "./svgscan";

type Mat = readonly [number, number, number, number, number, number]; // a b c d e f

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Mat, x: number, y: number): Pt {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Atribut transform -> matriks (translate, scale, rotate(a [cx cy]), matrix). */
function parseTransform(t: string | undefined): Mat {
  if (!t) return IDENTITY;
  let m: Mat = IDENTITY;
  const re = /(translate|scale|rotate|matrix)\s*\(([^)]*)\)/g;
  for (let k = re.exec(t); k; k = re.exec(t)) {
    const v = k[2].trim().split(/[\s,]+/).map(Number);
    let n: Mat = IDENTITY;
    if (k[1] === "translate") n = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    else if (k[1] === "scale") n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    else if (k[1] === "matrix" && v.length === 6) n = [v[0], v[1], v[2], v[3], v[4], v[5]];
    else if (k[1] === "rotate") {
      const a = ((v[0] ?? 0) * Math.PI) / 180;
      const cx = v[1] ?? 0;
      const cy = v[2] ?? 0;
      const c = Math.cos(a);
      const s = Math.sin(a);
      n = mul(mul([1, 0, 0, 1, cx, cy], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    }
    m = mul(m, n);
  }
  return m;
}

/** Kotak teks (poligon 4 titik, searah jarum jam dalam koordinat SVG) satu baris. */
export interface TextBox {
  /** Indeks elemen `<text>` (baris tspan berbagi indeks). */
  el: number;
  text: string;
  quad: Pt[];
  area: number;
  /** Teks berhalo kertas (`stroke` + `paint-order="stroke"`), FIG-02c. */
  halo?: boolean;
}

interface Mark {
  kind: string;
  lineLike: boolean;
  filled: boolean;
  /** Poligon isian (rect/path; lingkaran memakai `circle`). */
  polys: Pt[][];
  circle?: { cx: number; cy: number; r: number };
  /** Polilinear goresan untuk tanda garis. */
  strokes: Pt[][];
  halfStroke: number;
  bbox: [number, number, number, number];
}

export interface GeometryDefect {
  kind: "textOverlap" | "textOutside" | "textStraddleMark" | "lineThroughText";
  text: string;
  /** Teks pasangan (textOverlap) atau jenis tanda. */
  other?: string;
  /** mm² (overlap) atau mm (outside). */
  amount?: number;
  side?: "left" | "right" | "top" | "bottom";
}

export interface GeometryLint {
  widthMm: number;
  heightMm: number;
  nText: number;
  counts: Record<GeometryDefect["kind"], number>;
  defects: GeometryDefect[];
  /** Jumlah semua cacat (skor; 0 = bersih). */
  score: number;
}

// ── Geometri dasar ──────────────────────────────────────────────────────────

function polyArea(p: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Sutherland-Hodgman: irisan dua poligon cembung berorientasi positif. */
function clipConvex(subj: readonly Pt[], clip: readonly Pt[]): Pt[] {
  let out: Pt[] = [...subj];
  for (let i = 0; i < clip.length && out.length; i++) {
    const A = clip[i];
    const B = clip[(i + 1) % clip.length];
    const inp = out;
    out = [];
    const side = (p: Pt): number => (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]);
    for (let j = 0; j < inp.length; j++) {
      const P = inp[j];
      const Q = inp[(j + 1) % inp.length];
      const sp = side(P);
      const sq = side(Q);
      if (sp >= 0) out.push(P);
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq);
        out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
      }
    }
  }
  return out;
}

/** Bilangan lilitan (aturan isian nonzero, bawaan SVG) untuk kumpulan subpath. */
function insidePolys(polys: readonly (readonly Pt[])[], x: number, y: number): boolean {
  let wn = 0;
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      if (a[1] <= y) {
        if (b[1] > y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) > 0) wn++;
      } else if (b[1] <= y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) < 0) wn--;
    }
  }
  return wn !== 0;
}

// ── Pemindai SVG ────────────────────────────────────────────────────────────

interface Scan {
  W: number;
  H: number;
  texts: TextBox[];
  nText: number;
  marks: Mark[];
}

/** Kotak teks satu baris pada matriks `m` (x, y = titik anchor, garis dasar). */
function lineBox(m: Mat, x: number, y: number, w: number, sizeMm: number, anchor: string): Pt[] {
  const x0 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  const em = sizeMm;
  const shrink = (FONT_ASCENT_EM + FONT_DESCENT_EM) * em * INK_SHRINK;
  const top = y - FONT_ASCENT_EM * em + shrink;
  const bot = y + FONT_DESCENT_EM * em - shrink;
  const q = [apply(m, x0, top), apply(m, x0 + w, top), apply(m, x0 + w, bot), apply(m, x0, bot)];
  return polyArea(q) < 0 ? q.reverse() : q;
}

function scanSvgGeometry(svg: string): Scan {
  const root = /<svg\b[^>]*viewBox="([^"]+)"/.exec(svg);
  const vb = root ? root[1].trim().split(/[\s,]+/).map(Number) : [0, 0, 0, 0];
  const W = vb[2] ?? 0;
  const H = vb[3] ?? 0;
  const texts: TextBox[] = [];
  const marks: Mark[] = [];
  const stack: Mat[] = [IDENTITY];
  let inDefs = 0;
  let el = 0;
  // Token: tag pembuka/penutup, atau elemen <text>...</text> utuh.
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>|<(\/?)([a-zA-Z]+)\b([^>]*?)(\/?)>/g;
  for (let k = re.exec(svg); k; k = re.exec(svg)) {
    const top = stack[stack.length - 1];
    if (k[1] !== undefined) {
      if (inDefs) continue;
      const a = attrsOf(k[1]);
      const m = mul(top, parseTransform(a.transform));
      const sizeMm = Number(a["font-size"] ?? 0);
      if (!(sizeMm > 0)) continue;
      const face = /mono/i.test(a["font-family"] ?? "") ? "data" : "struct";
      const bold = Number(a["font-weight"] ?? 400) >= 600;
      const track = Number(a["letter-spacing"] ?? 0) || 0;
      const anchor = a["text-anchor"] ?? "start";
      const pt = sizeMm / MM_PER_PT;
      const halo = /stroke/.test(a["paint-order"] ?? "") && (a.stroke ?? "none") !== "none" && Number(a["stroke-width"] ?? 0) > 0;
      const body = k[2].replace(/<title>[\s\S]*?<\/title>/g, "");
      const x0 = Number(a.x ?? 0);
      const y0 = Number(a.y ?? 0);
      const spans = [...body.matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/g)];
      const lines: { x: number; y: number; s: string }[] = [];
      if (spans.length) {
        let cy = y0;
        for (const sp of spans) {
          const sa = attrsOf(sp[1]);
          cy += Number(sa.dy ?? 0) || 0;
          lines.push({ x: sa.x !== undefined ? Number(sa.x) : x0, y: sa.y !== undefined ? Number(sa.y) : cy, s: unescXml(sp[2]) });
        }
      } else lines.push({ x: x0, y: y0, s: unescXml(body.replace(/<[^>]+>/g, "")) });
      let any = false;
      for (const ln of lines) {
        if (!ln.s.trim()) continue;
        any = true;
        const w = measure(ln.s, pt, face, { bold, trackMm: track });
        const quad = lineBox(m, ln.x, ln.y, w, sizeMm, anchor);
        texts.push({ el, text: ln.s, quad, area: Math.max(1e-9, Math.abs(polyArea(quad))), ...(halo ? { halo } : {}) });
      }
      if (any) el++;
      continue;
    }
    const closing = k[3] === "/";
    const tag = k[4];
    const selfClose = k[6] === "/";
    if (closing) {
      if (tag === "g" || tag === "svg") stack.pop();
      if (tag === "defs") inDefs = Math.max(0, inDefs - 1);
      continue;
    }
    if (tag === "defs" && !selfClose) {
      inDefs++;
      continue;
    }
    const a = attrsOf(k[5]);
    if (tag === "g" || tag === "svg") {
      if (!selfClose) stack.push(tag === "g" ? mul(top, parseTransform(a.transform)) : top);
      continue;
    }
    if (inDefs) continue;
    const kind = a["data-mark"] ?? (a["data-node"] !== undefined ? "node" : undefined);
    if (!kind) continue;
    const m = mul(top, parseTransform(a.transform));
    const fill = (a.fill ?? "").toLowerCase();
    const filled = fill !== "" && fill !== "none" && !fill.startsWith("url(");
    const lineLike = tag === "line" || tag === "polyline" || (tag === "path" && fill === "none") || kind === "line" || kind === "link";
    const sw = Number(a["stroke-width"] ?? 0) || 0;
    const scale = Math.hypot(m[0], m[1]);
    let polys: Pt[][] = [];
    let circle: Mark["circle"];
    if (tag === "rect") {
      const x = Number(a.x ?? 0);
      const y = Number(a.y ?? 0);
      const w = Number(a.width ?? 0);
      const h = Number(a.height ?? 0);
      if (!(w > 0 && h > 0)) continue;
      polys = [[apply(m, x, y), apply(m, x + w, y), apply(m, x + w, y + h), apply(m, x, y + h)]];
    } else if (tag === "circle") {
      const c = apply(m, Number(a.cx ?? 0), Number(a.cy ?? 0));
      circle = { cx: c[0], cy: c[1], r: Number(a.r ?? 0) * scale };
    } else if (tag === "line") {
      polys = [[apply(m, Number(a.x1 ?? 0), Number(a.y1 ?? 0)), apply(m, Number(a.x2 ?? 0), Number(a.y2 ?? 0))]];
    } else if (tag === "path") {
      polys = pathPolylines(a.d ?? "").map((p) => p.map(([x, y]) => apply(m, x, y)));
    } else continue;
    const pts = circle ? [[circle.cx - circle.r, circle.cy - circle.r] as Pt, [circle.cx + circle.r, circle.cy + circle.r] as Pt] : polys.flat();
    if (!pts.length) continue;
    const hs = (sw * scale) / 2;
    const bb = bboxOf(pts);
    marks.push({
      kind,
      lineLike,
      filled: filled && !lineLike,
      polys: lineLike ? [] : polys,
      circle,
      strokes: lineLike ? polys : [],
      halfStroke: hs,
      bbox: [bb[0] - hs, bb[1] - hs, bb[2] + hs, bb[3] + hs],
    });
  }
  return { W, H, texts, nText: el, marks };
}

/** Opsi lint (semua opt-in; bawaan = perilaku FIG-02a). */
export interface LintOptions {
  /**
   * FIG-02c: teks berhalo kertas dikecualikan dari `lineThroughText` dan dari
   * `textStraddleMark` terhadap tanda `area` (positif palsu label kontur H-06, audit §2.3).
   */
  haloExempt?: boolean;
}

/** Opsi lint yang dipakai mesin chart (renderChart + autoFitChart). Diagram tidak memakainya. */
export const CHART_LINT_OPTIONS: Readonly<LintOptions> = Object.freeze({ haloExempt: true });

/**
 * Lint geometri SVG chart. Tanpa browser; hasil deterministik. `score` = jumlah cacat
 * (pasangan tumpuk + teks keluar + teks memotong tanda + garis menembus teks).
 */
export function lintChartGeometry(svg: string, opts: Readonly<LintOptions> = {}): GeometryLint {
  const { W, H, texts, nText, marks } = scanSvgGeometry(svg);
  const defects: GeometryDefect[] = [];
  const boxes = texts.map((t) => bboxOf(t.quad));
  // teks-teks (per pasangan elemen berbeda; baris satu elemen tidak dibandingkan)
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const A = texts[i];
      const B = texts[j];
      if (A.el === B.el) continue;
      const a = boxes[i];
      const b = boxes[j];
      if (a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]) continue;
      const inter = Math.abs(polyArea(clipConvex(A.quad, B.quad)));
      if (inter > OVERLAP_MIN_MM2 && inter > OVERLAP_MIN_FRAC * Math.min(A.area, B.area)) {
        defects.push({ kind: "textOverlap", text: A.text, other: B.text, amount: Number(inter.toFixed(2)) });
      }
    }
  }
  // luar viewBox
  texts.forEach((t, i) => {
    const [x0, y0, x1, y1] = boxes[i];
    const over = Math.max(0, -x0, x1 - W, -y0, y1 - H);
    if (over > OUTSIDE_MIN_MM) {
      defects.push({ kind: "textOutside", text: t.text, amount: Number(over.toFixed(2)), side: x0 < 0 ? "left" : x1 > W ? "right" : y0 < 0 ? "top" : "bottom" });
    }
  });
  // tanda
  texts.forEach((t, i) => {
    const tb = boxes[i];
    const S = inkSamples(t.quad);
    const haloOk = opts.haloExempt === true && t.halo === true;
    let straddle: string | null = null;
    let through: string | null = null;
    for (const m of marks) {
      if (m.bbox[2] < tb[0] || m.bbox[0] > tb[2] || m.bbox[3] < tb[1] || m.bbox[1] > tb[3]) continue;
      if (m.kind === "node") continue;
      if (haloOk && (m.lineLike || m.kind === "area")) continue;
      if (m.lineLike) {
        if (through) continue;
        const hit = S.some((p) => m.strokes.some((pl) => pl.some((a, k) => k + 1 < pl.length && segDist(p, a, pl[k + 1]) <= m.halfStroke + 1e-9)));
        if (hit) through = m.kind;
      } else if (m.filled && !straddle) {
        let inF = 0;
        for (const [x, y] of S) {
          if (m.circle ? Math.hypot(x - m.circle.cx, y - m.circle.cy) <= m.circle.r : insidePolys(m.polys, x, y)) inF++;
        }
        if (inF > 0 && inF < S.length) straddle = m.kind;
      }
      if (straddle && through) break;
    }
    if (straddle) defects.push({ kind: "textStraddleMark", text: t.text, other: straddle });
    if (through) defects.push({ kind: "lineThroughText", text: t.text, other: through });
  });
  const counts = { textOverlap: 0, textOutside: 0, textStraddleMark: 0, lineThroughText: 0 };
  for (const d of defects) counts[d.kind]++;
  return { widthMm: W, heightMm: H, nText, counts, defects, score: defects.length };
}

// ── REPORT + saran ──────────────────────────────────────────────────────────

/** Isu lint dengan saran yang bisa langsung dipakai agen (audit §7.2). */
export type GeometryIssue = LintIssue & { suggest: string };

export const GEOMETRY_CHECKS = {
  textOverlap: "GEOM_TEXT_OVERLAP",
  textOutside: "GEOM_TEXT_OUTSIDE",
  textStraddleMark: "GEOM_TEXT_MARK",
  lineThroughText: "GEOM_LINE_TEXT",
} as const;

/** Konteks saran: kode, jumlah kategori, panjang label/seri terpanjang. */
export interface GeometryHintCtx {
  code: string;
  nCategories: number;
  maxLabelChars: number;
  maxSeriesChars: number;
  /** FIG-02c (opsional): lebar kanvas spec (mm). */
  widthMm?: number;
  /** FIG-02c (opsional): satuan spec (ditempel pada label nilai). */
  unit?: string;
  /** FIG-02c (opsional, data matrix): jumlah baris/kolom dan panjang angka terpanjang. */
  nRows?: number;
  nCols?: number;
  maxValueChars?: number;
}

/** Satuan lebih panjang dari ini membuat label nilai "angka + satuan" melebar (saran FIG-02c). */
const UNIT_SHORT_MAX = 12;
/** Huruf angka sel tabel P-15 (pt) untuk taksiran kapasitas kolom pada saran. */
const TABLE_CELL_PT = 6.8;

/** Kapasitas kolom tabel pada lebar spec: (lebar - kolom label ~30 %) / (lebar angka + 1,5 mm). */
function tableColumnCapacity(c: GeometryHintCtx): number | null {
  if (!c.widthMm || !c.maxValueChars) return null;
  const cell = measure("0".repeat(c.maxValueChars), TABLE_CELL_PT, "data") + 1.5;
  return Math.max(1, Math.floor((c.widthMm * 0.7) / cell));
}

const COLUMN_LIKE = new Set(["P-02", "P-03", "P-05", "P-07", "P-10", "W-02", "S-02", "S-04", "S-06", "S-07", "K-12"]);

function suggestFor(kind: GeometryDefect["kind"], c: GeometryHintCtx, texts: readonly string[] = []): string {
  const parts: string[] = [];
  // FIG-02c: tabel P-15 melebihi kapasitas lebar -> saran konkret (bukan masalah tata letak).
  if (c.code === "P-15" && (kind === "textOverlap" || kind === "textStraddleMark") && c.nCols) {
    const cap = tableColumnCapacity(c);
    const w = c.widthMm ? ` pada ${c.widthMm} mm` : "";
    parts.push(
      `tabel ${c.nRows ?? "?"} x ${c.nCols} melebihi kapasitas${w}${cap ? ` (muat ~${cap} kolom angka)` : ""}: pisah menjadi ${cap ? Math.ceil(c.nCols / cap) : 2} tabel/gambar, atau kirim sebagai blok tabel dokumen (\`topN\` tidak berlaku untuk tabel matriks P-15)`,
    );
  }
  // FIG-02c: satuan panjang menempel pada setiap label nilai.
  const unit = (c.unit ?? "").trim();
  if (unit.length > UNIT_SHORT_MAX && (kind === "textOverlap" || kind === "textOutside") && texts.some((t) => t.includes(unit.slice(0, 8)))) {
    parts.push(`persingkat \`unit\` (${unit.length} karakter, ditempel pada setiap label nilai) menjadi <= ${UNIT_SHORT_MAX} karakter, mis. singkatan; keterangan panjang ke judul/catatan`);
  }
  if (parts.length) return parts.join("; ");
  // FIG-03a: saran medan maksud hanya untuk kode yang benar-benar menerapkannya (`intentSupport`).
  const sup = intentSupport(c.code);
  const many = sup.topN ? "pakai `topN: 8` atau pisah menjadi dua gambar" : "pisah menjadi dua gambar (kurangi kategori)";
  if (kind === "textOverlap" || kind === "textOutside") {
    if (c.maxLabelChars > 24) {
      const to = orientationTarget(c.code, "horizontal");
      if (to) parts.push(`pakai \`orientation: "horizontal"\` (${c.code} -> ${to})`);
      else if (COLUMN_LIKE.has(c.code)) parts.push("ganti ke bar horizontal P-01 bila datanya kategoris");
      parts.push(
        sup.labelShort
          ? 'kirim `labelShort: [{ "label": "<label lengkap>", "short": "<maks ~24 karakter>" }]` untuk label kategori'
          : "persingkat label kategori/grup (maks ~24 karakter)",
      );
    }
    if (c.nCategories > 12) parts.push(many);
    if (c.maxSeriesChars > 40) parts.push("persingkat nama seri (maks ~40 karakter)");
  }
  if (kind === "textStraddleMark" || kind === "lineThroughText") {
    if (c.nCategories > 12) parts.push(many);
    parts.push("persingkat label titik/nilai atau kurangi jumlah label");
  }
  if (!parts.length) parts.push("persingkat teks yang dilaporkan atau pisah menjadi dua gambar");
  return parts.join("; ");
}

const KIND_TEXT: Record<GeometryDefect["kind"], string> = {
  textOverlap: "pasangan teks bertumpuk",
  textOutside: "teks keluar kanvas",
  textStraddleMark: "teks memotong tanda data",
  lineThroughText: "garis menembus teks",
};

/** Lint -> isu REPORT (satu per jenis cacat; tidak pernah FAIL). */
export function geometryIssues(lint: GeometryLint, c: GeometryHintCtx): GeometryIssue[] {
  const out: GeometryIssue[] = [];
  for (const kind of Object.keys(GEOMETRY_CHECKS) as GeometryDefect["kind"][]) {
    const ds = lint.defects.filter((d) => d.kind === kind);
    if (!ds.length) continue;
    const sample = ds
      .slice(0, 3)
      .map((d) => `"${d.text.slice(0, 40)}"${d.other && kind === "textOverlap" ? ` x "${d.other.slice(0, 40)}"` : d.side ? ` (${d.side})` : ""}`)
      .join(", ");
    const suggest = suggestFor(kind, c, ds.flatMap((d) => [d.text, d.other ?? ""]));
    out.push({ checkId: GEOMETRY_CHECKS[kind], status: "REPORT", detail: `${ds.length} ${KIND_TEXT[kind]}: ${sample}; saran: ${suggest}`, suggest });
  }
  return out;
}

/** Konteks saran dari data spec (kategori/titik/grup/simpul; nama seri). */
export function hintCtxFromSpec(spec: { kind: string; data?: unknown }): GeometryHintCtx {
  const d = (spec.data ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  let labels: string[] = [];
  let series: string[] = [];
  let matrix: { nRows: number; nCols: number; maxValueChars: number } | null = null;
  switch (d.shape) {
    case "categorical":
      labels = arr(d.points).map((p) => str((p as { label?: unknown }).label));
      break;
    case "series":
      labels = arr(d.categories).map(str);
      series = arr(d.series).map((s) => str((s as { name?: unknown }).name));
      break;
    case "distribution":
      labels = arr(d.groups).map((g) => str((g as { name?: unknown }).name));
      break;
    case "intervals":
      labels = arr(d.items).map((p) => str((p as { label?: unknown }).label));
      break;
    case "graph":
      labels = arr(d.nodes).map((p) => str((p as { label?: unknown }).label));
      break;
    case "matrix": {
      labels = [...arr(d.rows).map(str), ...arr(d.cols).map(str)];
      const vals = arr(d.values).flatMap((r) => arr(r)).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      const dec = typeof (spec as { dec?: unknown }).dec === "number" ? ((spec as { dec?: number }).dec as number) : 1;
      matrix = {
        nRows: arr(d.rows).length,
        nCols: arr(d.cols).length,
        maxValueChars: Math.max(1, ...vals.map((v) => v.toFixed(Math.max(0, Math.min(6, dec))).length + Math.floor(Math.log10(Math.max(1, Math.abs(v))) / 3))),
      };
      break;
    }
    case "xy":
      labels = arr(d.points).map((p) => str((p as { label?: unknown }).label));
      series = arr(d.points).map((p) => str((p as { group?: unknown }).group));
      break;
    default:
      break;
  }
  const sp = spec as { widthMm?: unknown; unit?: unknown };
  return {
    code: spec.kind,
    nCategories: labels.length,
    maxLabelChars: Math.max(0, ...labels.map((s) => s.length)),
    maxSeriesChars: Math.max(0, ...series.map((s) => s.length)),
    ...(typeof sp.widthMm === "number" ? { widthMm: sp.widthMm } : {}),
    ...(typeof sp.unit === "string" && sp.unit ? { unit: sp.unit } : {}),
    ...(matrix ?? {}),
  };
}

