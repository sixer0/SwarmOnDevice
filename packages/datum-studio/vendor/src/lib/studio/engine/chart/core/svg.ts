/**
 * engine/chart/core — satuan dan pembangun SVG chart (S32, I22).
 *
 * Konvensi SVG chart Studio (berlaku untuk inti dan keluarga S33-S43):
 * - akar `width="<W>mm" height="<H>mm" viewBox="0 0 W H"`: SATU satuan pengguna = 1 mm;
 * - ukuran huruf ditulis dalam satuan pengguna = pt FISIK x 25,4/72 (F-007), sehingga
 *   6,8 pt tercetak 6,8 pt pada lebar nominal; tidak pernah px 96 dpi (research/06 §6.4-N1);
 * - setiap tanda data membawa `data-mark`, `data-series`, `data-index` (spesifikasi §3.5 N2);
 *   dekorasi tidak; garis sumbu dibungkus `<g data-axis="x|y">`;
 * - latar kertas memakai `data-bg="paper"` agar komposit dapat membuangnya;
 * - hanya teks dan vektor nyata; tanpa `<image>`, tanpa href eksternal (D-38).
 *
 * Angka ditulis deterministik: dibulatkan 4 desimal (huruf 5 desimal), tanpa nol buntut,
 * tanpa "-0". Tanpa acak, tanpa waktu.
 */
import { StudioEngineError } from "../../../contract/errors";
import type { ChartDataMark } from "../../../contract";
import { fitActive } from "./fit";
import { fitWithinSpan, lineHeightMm, titleSvg, tspanLines } from "./textfit";

/** 1 pt = 25,4/72 mm. */
export const MM_PER_PT = 25.4 / 72;
/** Konstanta `MM` datumchart.py (DC:53): 1 mm pada 96 dpi, dalam px. */
export const DC_PX_PER_MM = 3.7795275591;

export const FACE_STRUCT = "IBM Plex Sans Condensed";
export const FACE_DATA = "IBM Plex Mono";

/** Rerata lebar glif per em untuk taksiran lebar teks (tanpa pengukuran fon). */
const EM_STRUCT = 0.5;
const EM_DATA = 0.6;

export function ptToMm(pt: number): number {
  return pt * MM_PER_PT;
}

/** Garis dasar teks yang tegak-tengah di `yc` (satu definisi inti dan keluarga, S84 #8). */
export function midBaseline(yc: number, sizePt: number): number {
  return yc + ptToMm(sizePt) * 0.35;
}

/** px datumchart (96 dpi) -> mm. */
export function dcPx(px: number): number {
  return px / DC_PX_PER_MM;
}

/** Angka SVG deterministik. */
export function num(v: number, digits = 4): string {
  if (!Number.isFinite(v)) {
    throw new StudioEngineError("SCHEMA_INVALID", `engine/chart/core: angka geometri tidak hingga (${v})`);
  }
  const r = Number(v.toFixed(digits));
  return Object.is(r, -0) || r === 0 ? "0" : String(r);
}

/**
 * Karakter yang tidak sah di XML 1.0 (§2.2 Char): C0 selain TAB/LF/CR, U+FFFE/U+FFFF, dan
 * surrogate tunggal. Dibuang dari teks, atribut, dan komentar chart (S84 #4) agar parser
 * XML ketat (impor SVG DOCX/LibreOffice) tidak menolak berkas.
 */
const XML_INVALID_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Buang karakter tak sah XML 1.0. */
export function stripXmlInvalid(s: string): string {
  return s.replace(XML_INVALID_RE, "");
}

/** Escape teks seperti `esc` DC:68-69 (&, <, >) + buang karakter tak sah XML 1.0. */
export function escText(s: string): string {
  return stripXmlInvalid(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape nilai atribut. */
export function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}

/** Taksiran lebar teks dalam mm (rerata glif; cukup untuk talang label). */
export function textWidthMm(s: string, sizePt: number, face: "struct" | "data" = "struct", trackMm = 0): number {
  const em = face === "data" ? EM_DATA : EM_STRUCT;
  return s.length * (em * ptToMm(sizePt) + trackMm);
}

/** Warna: hex 6 digit dengan atau tanpa "#" -> "#RRGGBB". */
export function hexColor(hex: string): string {
  const m = /^#?([0-9A-Fa-f]{6})$/.exec(hex.trim());
  if (!m) throw new StudioEngineError("SCHEMA_INVALID", `engine/chart/core: warna "${hex}" bukan hex 6 digit`);
  return `#${m[1].toUpperCase()}`;
}

export interface MarkAttrs {
  mark: ChartDataMark;
  series?: string;
  index?: number;
}

function markAttr(m?: MarkAttrs): string {
  if (!m) return "";
  const series = m.series !== undefined ? ` data-series="${escAttr(m.series)}"` : "";
  const index = m.index !== undefined ? ` data-index="${m.index}"` : "";
  return ` data-mark="${m.mark}"${series}${index}`;
}

export interface TextOpts {
  sizePt: number;
  fill: string;
  face?: "struct" | "data";
  anchor?: "start" | "middle" | "end";
  bold?: boolean;
  caps?: boolean;
  /** letter-spacing dalam mm. */
  trackMm?: number;
  mark?: MarkAttrs;
  /** Atribut tambahan siap pakai (mis. ` data-label="value"`). */
  attrs?: string;
}

export interface ShapeOpts {
  mark?: MarkAttrs;
  stroke?: string;
  strokeWidthMm?: number;
  dashMm?: readonly number[];
  attrs?: string;
}

/**
 * Pembangun SVG chart bersatuan mm. Urutan elemen = urutan panggilan (deterministik).
 * `minFontPt` = lantai huruf templat P7-36 `chart.minFontPt` (S84 #5): setiap teks
 * ditulis minimal sebesar lantai ini, sehingga keluaran memenuhi parameter sahnya sendiri
 * (DATUM-28) di semua keluarga. 0 = tanpa lantai (pemanggil lama).
 */
export class SvgDoc {
  private readonly parts: string[] = [];

  constructor(
    readonly widthMm: number,
    readonly heightMm: number,
    private readonly rootAttrs = "",
    readonly minFontPt = 0,
  ) {}

  /** Ukuran huruf efektif (pt): tidak pernah di bawah lantai `minFontPt`. */
  fontPt(sizePt: number): number {
    return Math.max(sizePt, this.minFontPt);
  }

  raw(s: string): this {
    this.parts.push(s);
    return this;
  }

  /**
   * Komentar XML sah (XML 1.0 §2.5, S84 #3): setiap tanda hubung yang diikuti tanda hubung
   * diberi spasi (`---` -> `- - -`, tidak tersisa `--`), karakter tak sah dibuang; isi
   * selalu ditutup spasi sebelum `-->` sehingga tidak berakhir `-`.
   */
  comment(s: string): this {
    this.parts.push(`<!-- ${stripXmlInvalid(s).replace(/-(?=-)/g, "- ")} -->`);
    return this;
  }

  open(attrs: string): this {
    this.parts.push(`<g${attrs ? ` ${attrs}` : ""}>`);
    return this;
  }

  close(): this {
    this.parts.push("</g>");
    return this;
  }

  /** Latar kertas penuh kanvas (dekorasi, dibuang komposit). */
  paper(fill: string): this {
    this.parts.push(
      `<rect data-bg="paper" width="${num(this.widthMm)}" height="${num(this.heightMm)}" fill="${hexColor(fill)}"/>`,
    );
    return this;
  }

  rect(x: number, y: number, w: number, h: number, fill: string, o: ShapeOpts = {}): this {
    const stroke = o.stroke ? ` stroke="${hexColor(o.stroke)}" stroke-width="${num(o.strokeWidthMm ?? 0.2)}"` : "";
    this.parts.push(
      `<rect${markAttr(o.mark)} x="${num(x)}" y="${num(y)}" width="${num(Math.max(0, w))}" height="${num(Math.max(0, h))}" fill="${hexColor(fill)}"${stroke}${o.attrs ?? ""}/>`,
    );
    return this;
  }

  line(x1: number, y1: number, x2: number, y2: number, stroke: string, widthMm: number, o: ShapeOpts = {}): this {
    const dash = o.dashMm && o.dashMm.length ? ` stroke-dasharray="${o.dashMm.map((d) => num(d)).join(" ")}"` : "";
    this.parts.push(
      `<line${markAttr(o.mark)} x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${hexColor(stroke)}" stroke-width="${num(widthMm, 5)}"${dash}${o.attrs ?? ""}/>`,
    );
    return this;
  }

  circle(cx: number, cy: number, r: number, fill: string, o: ShapeOpts = {}): this {
    const stroke = o.stroke ? ` stroke="${hexColor(o.stroke)}" stroke-width="${num(o.strokeWidthMm ?? 0.2)}"` : "";
    this.parts.push(
      `<circle${markAttr(o.mark)} cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="${hexColor(fill)}"${stroke}${o.attrs ?? ""}/>`,
    );
    return this;
  }

  /** `d` dibangun pemanggil dengan `num()`; `fill` "none" diperbolehkan. */
  path(d: string, fill: string | "none", o: ShapeOpts = {}): this {
    const f = fill === "none" ? "none" : hexColor(fill);
    const stroke = o.stroke ? ` stroke="${hexColor(o.stroke)}" stroke-width="${num(o.strokeWidthMm ?? 0.2, 5)}"` : "";
    const dash = o.dashMm && o.dashMm.length ? ` stroke-dasharray="${o.dashMm.map((v) => num(v)).join(" ")}"` : "";
    this.parts.push(`<path${markAttr(o.mark)} d="${d}" fill="${f}"${stroke}${dash}${o.attrs ?? ""}/>`);
    return this;
  }

  /**
   * Teks nyata; ukuran dalam pt fisik (ditulis sebagai mm satuan pengguna).
   *
   * FIG-02a (P1-5/P1-6): hanya saat fit aktif (render ulang setelah lint geometri menemukan
   * cacat), teks horizontal yang keluar tepi kiri/kanan kanvas dijaga di dalam: label tengah
   * digeser, label rata kiri/kanan dibungkus ke ruang sampai tepi (maks 2 baris, lalu elipsis
   * dengan teks lengkap di `<title>`). Di luar fit perilaku tidak berubah.
   */
  text(x: number, y: number, s: string, o: TextOpts): this {
    if (fitActive() && !(o.attrs ?? "").includes("transform")) {
      const pt = this.fontPt(o.sizePt);
      const font = { pt, face: o.face ?? "struct", bold: o.bold, trackMm: o.trackMm, caps: o.caps } as const;
      // ENG-FIX #1: "keluar" diukur terhadap tepi kanvas nyata [0, W]; margin 0,4 mm hanya untuk
      // menempatkan ulang teks yang memang keluar. Toleransi lint 0,3 mm sengaja TIDAK dipakai:
      // Chromium mengukur angka tabel P-15 sampai 0,38 mm di luar tepi bila teks dibiarkan.
      const edge = { lo: 0, hi: this.widthMm };
      const f = fitWithinSpan(o.caps ? s.toUpperCase() : s, x, o.anchor ?? "start", 0.4, this.widthMm - 0.4, font, 2, edge);
      if (f) {
        const lh = lineHeightMm({ pt });
        const size = ptToMm(pt);
        // Blok berpusat pada garis dasar lama, lalu dijaga di dalam tinggi kanvas.
        let y0 = y - ((f.lines.length - 1) * lh) / 2;
        y0 = Math.max(y0, 0.3 + 0.87 * size);
        y0 = Math.min(y0, this.heightMm - 0.3 - 0.12 * size - (f.lines.length - 1) * lh);
        return this.textLines(f.x, y0, f.lines, { ...o, anchor: f.anchor, caps: false }, lh, f.title);
      }
    }
    const face = o.face === "data" ? FACE_DATA : FACE_STRUCT;
    const anchor = o.anchor ?? "start";
    const w = o.bold ? ' font-weight="600"' : "";
    const t = o.trackMm ? ` letter-spacing="${num(o.trackMm)}"` : "";
    const body = escText(o.caps ? s.toUpperCase() : s);
    this.parts.push(
      `<text${markAttr(o.mark)} x="${num(x)}" y="${num(y)}" font-family="${face}" font-size="${num(ptToMm(this.fontPt(o.sizePt)), 5)}" fill="${hexColor(o.fill)}" text-anchor="${anchor}"${w}${t}${o.attrs ?? ""}>${body}</text>`,
    );
    return this;
  }

  /**
   * Teks multi-baris (FIG-02a): SATU `<text>` dengan `<tspan x dy>` per baris; `y` = garis
   * dasar baris pertama, `lineMm` = jarak antarbaris. Satu baris -> identik dengan `text()`.
   * `title` (teks lengkap label yang dipotong) membungkus elemen dalam `<g data-fit="ellipsis">`.
   */
  textLines(x: number, y: number, lines: readonly string[], o: TextOpts, lineMm: number, title?: string): this {
    const face = o.face === "data" ? FACE_DATA : FACE_STRUCT;
    const anchor = o.anchor ?? "start";
    const w = o.bold ? ' font-weight="600"' : "";
    const t = o.trackMm ? ` letter-spacing="${num(o.trackMm)}"` : "";
    const body = tspanLines(o.caps ? lines.map((l) => l.toUpperCase()) : lines, x, lineMm);
    const el = `<text${markAttr(o.mark)} x="${num(x)}" y="${num(y)}" font-family="${face}" font-size="${num(ptToMm(this.fontPt(o.sizePt)), 5)}" fill="${hexColor(o.fill)}" text-anchor="${anchor}"${w}${t}${o.attrs ?? ""}>${body}</text>`;
    this.parts.push(title !== undefined ? `<g data-fit="ellipsis">${titleSvg(title)}${el}</g>` : el);
    return this;
  }

  toString(): string {
    const W = num(this.widthMm);
    const H = num(this.heightMm);
    const extra = this.rootAttrs ? ` ${this.rootAttrs}` : "";
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}"${extra}>`,
      ...this.parts,
      "</svg>",
    ].join("\n");
  }
}
