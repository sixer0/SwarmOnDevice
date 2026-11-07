/**
 * Primitif SVG diagram Garis A (port `_esc`, `_svg_text`, `_shape_svg`, defs
 * arsiran/kepala panah, jalur konektor, lompatan silang, pita knockout label;
 * `datum_diagram.py:1040-1112, 1214-1231, 1271-1322, 1410-1421`).
 *
 * Teks tetap teks nyata berfon IBM Plex (tidak dikonturkan). Angka ditulis
 * seperti `"%s" % round(x, n)` Python (lihat `pyfmt.ts`). Urutan atribut =
 * urutan Python; atribut peran tanda (`data-mark`, 01_specs.md §3.5 N2)
 * ditambahkan SETELAH atribut Python pada elemen tanda: bentuk simpul
 * `data-mark="node"`, jalur konektor `data-mark="link"` + `data-series=<jenis>`.
 * Opsi `dataMarks: false` menghasilkan keluaran Python murni.
 */
import type { DiagramEdgeKind, FaceRole, ProvenanceMark } from "../../../contract";
import { symbolBody } from "../../symbols";
import { measure, tspanLines } from "../../chart/core/textfit";
import { diagramFitActive } from "../fit/state";
import { nodeTextLayout, type TextBlockLayout } from "../fit/text";
import { type PyNumber, pyLen, pyNum, pyStr, pyStrNum } from "./pyfmt";
import type { SheetNode } from "./sheet";
import { nodeStrokeToken, nodeSymbolId } from "./sheet";
import { DiagramDefect } from "./defect";
import { xmlCommentText, xmlEscapeText } from "./xml";
import {
  DASH_PATTERNS,
  DIAGRAM_TOKENS,
  EDGE_KINDS,
  EDGE_KIND_NAMES_SORTED,
  FACES,
  INK_TEXT,
  LATTICE_Y,
  LIMITS,
  MARKS,
  PAPER,
  STROKE_HAIR,
  STROKE_PRIMARY,
  colourOf,
  estTextMm,
  faceOf,
  pt2mm,
  role,
  snap,
} from "./tokens";

/**
 * Escape isi teks seperti `_esc` Python (&, <, >), ditambah pembuangan
 * karakter yang tidak sah di XML 1.0 (IP-39b, S84 #4; Python meneruskannya
 * sehingga SVG rusak — deviasi yang disengaja, keluaran sama untuk teks sah).
 */
export function escText(s: unknown): string {
  return xmlEscapeText(pyStr(s), false);
}

/**
 * Escape nilai atribut: `_esc` Python ditambah `"` (Python tidak meng-escape
 * kutip sehingga id berkutip menghasilkan XML rusak; selain kasus itu identik).
 */
export function escAttr(s: unknown): string {
  return escText(s).replace(/"/g, "&quot;");
}

export interface SvgMarkOptions {
  /** Tambah atribut peran tanda (default true). */
  dataMarks?: boolean;
  /** Indeks tanda dalam gambar (`data-index`). */
  index?: number;
}

export interface SvgTextOptions {
  /** Peran tipografi token (`type.scale_pt`), default `caption`. */
  role?: string;
  /** Nama token warna interior (menimpa warna peran). */
  colourToken?: string;
  /** Warna heks langsung (menimpa token; di luar Garis A). */
  fill?: string;
  /** Default `middle` (Python). */
  anchor?: "start" | "middle" | "end";
  upper?: boolean;
  /** Tracking em; `null`/tidak ada = tracking peran. */
  track?: number | null;
  weight?: number;
  /** Ukuran pt (menimpa ukuran peran; di luar Garis A). */
  sizePt?: number;
  /** Wajah (menimpa wajah peran; di luar Garis A). */
  faceRole?: FaceRole;
}

const FACE_ROLE_KEY: Readonly<Record<FaceRole, string>> = {
  serif: "serif",
  condensed: "condensed",
  mono: "mono",
  workbookUi: "workbook_ui",
  symbolGlyph: "mono",
};

/** Teks SVG nyata berfon Plex (`_svg_text`). */
export function svgText(x: PyNumber, y: PyNumber, text: unknown, opts: SvgTextOptions = {}): string {
  const roleName = opts.role ?? "caption";
  const r = role(roleName);
  const sizePt = opts.sizePt ?? r.size;
  const size = pt2mm(sizePt);
  const face = opts.faceRole ? FACES[FACE_ROLE_KEY[opts.faceRole]] : faceOf(roleName);
  const col = opts.fill ?? colourOf(opts.colourToken || r.colour || INK_TEXT);
  let txt = pyStr(text);
  if (opts.upper || r.upper) txt = txt.toUpperCase();
  let ls = "";
  const tr = opts.track !== undefined && opts.track !== null ? opts.track : r.track_em;
  if (tr) ls = ` letter-spacing="${pyNum(pt2mm(sizePt) * tr, 3)}"`;
  const w = opts.weight || r.weight || 400;
  return (
    `<text x="${pyNum(x, 2)}" y="${pyNum(y, 2)}" font-family="${escAttr(face)}" font-size="${pyNum(size, 3)}" ` +
    `font-weight="${w}" fill="${col}" text-anchor="${opts.anchor ?? "middle"}"${ls}>${escText(txt)}</text>`
  );
}

/**
 * Teks berbaris (FIG-02b): SATU `<text>` dengan `<tspan x dy>` per baris (multiset teks tetap
 * satu entri per label, D-482/D-491). Satu baris = keluaran `svgText` biasa.
 */
export function svgTextLines(b: TextBlockLayout, opts: SvgTextOptions = {}): string {
  if (b.lines.length <= 1) return svgText(b.x, b.y, b.lines[0] ?? "", opts);
  const shell = svgText(b.x, b.y, "", opts);
  const x = Number(pyNum(b.x, 2));
  const lines = opts.upper || role(opts.role ?? "caption").upper ? b.lines.map((l) => l.toUpperCase()) : b.lines;
  return `${shell.slice(0, -"</text>".length)}${tspanLines(lines, x, Number(b.lineMm.toFixed(3)))}</text>`;
}

function markAttrs(kind: "node" | "link", opts: SvgMarkOptions, series?: string): string {
  if (opts.dataMarks === false) return "";
  let a = ` data-mark="${kind}"`;
  if (series !== undefined) a += ` data-series="${escAttr(series)}"`;
  if (opts.index !== undefined) a += ` data-index="${opts.index}"`;
  return a;
}

const r2 = (v: number): string => pyNum(v, 2);

/** Isian simpul: arsiran 45 (aksen), 135 (sekunder), atau none. */
export function nodeFill(nd: Pick<SheetNode, "spec">): string {
  const c = nd.spec.class ?? {};
  if (c.accent) return "url(#datum-hatch45)";
  if (c.secondary) return "url(#datum-hatch135)";
  return "none";
}

/**
 * Bentuk simpul (`_shape_svg`): 10 bentuk P3; bentuk tak dikenal jatuh ke box.
 * Hanya `stadium` beradius.
 */
export function shapeSvg(
  nd: SheetNode,
  strokeToken: string,
  fill: string,
  opts: SvgMarkOptions & { strokeW?: number } = {},
): string {
  const shape = nd.spec.shape ?? "box";
  const { x, y, w, h } = nd;
  const sw = opts.strokeW ?? STROKE_PRIMARY;
  const col = colourOf(strokeToken);
  const common = `data-node="${escAttr(nd.id)}" fill="${fill}" stroke="${col}" stroke-width="${pyStrNum(sw)}"${markAttrs("node", opts)}`;
  switch (shape) {
    case "stadium": {
      const rr = h / 2.0;
      return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" rx="${r2(rr)}" ry="${r2(rr)}" ${common}/>`;
    }
    case "diamond": {
      const pts = `${r2(x + w / 2)},${r2(y)} ${r2(x + w)},${r2(y + h / 2)} ${r2(x + w / 2)},${r2(y + h)} ${r2(x)},${r2(y + h / 2)}`;
      return `<polygon points="${pts}" ${common}/>`;
    }
    case "parallelogram": {
      const k = w * 0.18;
      const pts = `${r2(x + k)},${r2(y)} ${r2(x + w)},${r2(y)} ${r2(x + w - k)},${r2(y + h)} ${r2(x)},${r2(y + h)}`;
      return `<polygon points="${pts}" ${common}/>`;
    }
    case "hexagon": {
      const k = w * 0.22;
      const pts =
        `${r2(x + k)},${r2(y)} ${r2(x + w - k)},${r2(y)} ${r2(x + w)},${r2(y + h / 2)} ` +
        `${r2(x + w - k)},${r2(y + h)} ${r2(x + k)},${r2(y + h)} ${r2(x)},${r2(y + h / 2)}`;
      return `<polygon points="${pts}" ${common}/>`;
    }
    case "cylinder": {
      const ry = h * 0.16;
      return (
        `<path d="M${r2(x)} ${r2(y + ry)} a${r2(w / 2)} ${r2(ry)} 0 0 0 ${r2(w)} 0 ` +
        `L${r2(x + w)} ${r2(y + h - ry)} a${r2(w / 2)} ${r2(ry)} 0 0 1 -${r2(w)} 0 Z" ${common}/>`
      );
    }
    case "circle":
      return `<circle cx="${r2(x + w / 2)}" cy="${r2(y + h / 2)}" r="${r2(Math.min(w, h) / 2)}" ${common}/>`;
    case "bus":
      // P3: rel berat, garis tebal penuh lebar (Python tidak memberi data-node).
      return `<line x1="${r2(x)}" y1="${r2(y + h / 2)}" x2="${r2(x + w)}" y2="${r2(y + h / 2)}" stroke="${col}" stroke-width="${r2(STROKE_PRIMARY * 3)}"${markAttrs("node", opts)}/>`;
    case "doubled":
      return (
        `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${common}/>` +
        `<rect x="${r2(x + 1.2)}" y="${r2(y + 1.2)}" width="${r2(w - 2.4)}" height="${r2(h - 2.4)}" fill="none" stroke="${col}" stroke-width="${r2(STROKE_HAIR)}"/>` +
        `<line x1="${r2(x + 1.2)}" y1="${r2(y + h / 2)}" x2="${r2(x + w - 1.2)}" y2="${r2(y + h / 2)}" stroke="${col}" stroke-width="${r2(STROKE_HAIR)}"/>`
      );
    case "shadowed": {
      const off = snap(LATTICE_Y / 2, 0.1);
      return (
        `<rect x="${r2(x + off)}" y="${r2(y + off)}" width="${r2(w)}" height="${r2(h)}" fill="none" stroke="${colourOf("ink200")}" stroke-width="${r2(STROKE_HAIR)}"/>` +
        `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${common}/>`
      );
    }
    default:
      return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${common}/>`;
  }
}

/**
 * Swarm patch (row 124, CP-29): colour token of each provenance mark, manual Rev A Table 7.1
 * (ID p.38; tokens.json provenance.marks): TERUKUR ink900, DITURUNKAN signal, PEMASOK ink400,
 * ASUMSI alert. The original drew all four glyphs in signal.
 */
export const MARK_COLOUR_TOKENS: Readonly<Record<ProvenanceMark, string>> = {
  TERUKUR: "ink900",
  DITURUNKAN: "signal",
  PEMASOK: "ink400",
  ASUMSI: "alert",
};

/** Glif asal (mono; pitfall warisan: jangan tukar wajah). Row 124: warna per tanda (Tabel 7.1). */
export function markGlyphSvg(nd: SheetNode): string {
  const mk = nd.spec.mark;
  const glyph = mk ? MARKS[mk] : "";
  const fill = colourOf(mk ? (MARK_COLOUR_TOKENS[mk] ?? "signal") : "signal");
  return (
    `<text x="${r2(nd.x + nd.w - pt2mm(1.5))}" y="${r2(nd.y + pt2mm(role("caption").size))}" ` +
    `font-family="${escAttr(FACES.mono)}" font-size="${pyNum(pt2mm(role("register_block").size), 3)}" ` +
    `fill="${fill}" text-anchor="end">${escText(glyph)}</text>`
  );
}

/** Row 124 (CP-45): largest and smallest badge (mm) of a node symbol, and its inset from the box. */
const SYMBOL_BADGE_MAX_MM = 10;
const SYMBOL_BADGE_MIN_MM = 7;
const SYMBOL_INSET_X_MM = 0.6;
const SYMBOL_INSET_Y_MM = 0.4;

/**
 * Swarm patch (row 124, CP-45; manual Rev A Table 10.1 nodes[], SM-01, ID p.63, 66): draw the
 * library symbol a node specifies (e.g. `iec:battery` on the UPS) as a badge inside the box:
 * top-left, or bottom-left when the top-left corner holds the requirement tag. The 24 mm library
 * cell is scaled into the badge; stroke widths are divided by the scale so every printed line
 * keeps its library width (>= 0.18 mm photocopy floor, DT-11a), and a symbol whose own text would
 * print below 5.5 pt at that scale is refused (DATUM-28). `data-symbol` names the symbol,
 * `data-symbol-of` the node (not `data-node`: the badge is not a second node shape).
 * Empty string when the node names no symbol.
 */
export function nodeSymbolSvg(nd: SheetNode): string {
  const sid = nodeSymbolId(nd.spec);
  if (!sid) return "";
  const body = symbolBody(sid);
  const avail = Math.min(nd.h - 2 * SYMBOL_INSET_Y_MM, nd.w * 0.4);
  const want = Math.min(SYMBOL_BADGE_MAX_MM, Math.max(SYMBOL_BADGE_MIN_MM, nd.h * 0.5));
  let size = Math.min(want, avail);
  const fonts = [...body.markup.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
  const minFont = fonts.length ? Math.min(...fonts) : Infinity;
  const floorMm = pt2mm(LIMITS.diagram_type_min_pt);
  if (Number.isFinite(minFont)) size = Math.max(size, (floorMm / minFont) * body.cellMm);
  if (size > avail + 1e-9 || size <= 0) {
    throw new DiagramDefect(
      `CP-45: simbol ${body.id} pada simpul '${nd.id}' tidak muat terbaca (perlu ${pyNum(size, 2)} mm, tersedia ${pyNum(avail, 2)} mm); perbesar simpul atau pakai kotak bernama (SM-01)`,
      { checkId: "CP-45" },
    );
  }
  const sc = size / body.cellMm;
  const markup = body.markup.replace(/stroke-width="([\d.]+)"/g, (_, w: string) => `stroke-width="${pyNum(Number(w) / sc, 4)}"`);
  const x = nd.x + SYMBOL_INSET_X_MM;
  const y = nd.spec.tag ? nd.y + nd.h - size - SYMBOL_INSET_Y_MM : nd.y + SYMBOL_INSET_Y_MM;
  return (
    `<g data-symbol="${escAttr(body.id)}" data-symbol-of="${escAttr(nd.id)}" ` +
    `transform="translate(${r2(x)} ${r2(y)}) scale(${pyNum(sc, 4)})">${markup}</g>`
  );
}

/**
 * Semua elemen satu simpul, urutan `build_svg`: bentuk, label (caption ink900),
 * sub (source_line), glif asal, tag (table_header ink400 rata kiri).
 */
// ---------------------------------------------------------------- row 165C
/** Row 165C (F113-10): spacing and weight of the hatch lines, as the original `<pattern>` declared them. */
export const HATCH_PITCH_MM = 1.6;
export const HATCH_STROKE_MM = 0.3;

/** Row 165C (F113-10): hatch angle of a node (45 accent, 135 secondary, as `nodeFill`), null = no hatch. */
export function nodeHatchAngle(nd: Pick<SheetNode, "spec">): 45 | 135 | null {
  const c = nd.spec.class ?? {};
  if (c.accent) return 45;
  if (c.secondary) return 135;
  return null;
}

/**
 * Swarm patch (row 165C, F113-10, CP-47): hatch as plain vector `<line>`s instead of an SVG `<pattern>` fill.
 * Chromium prints a pattern fill into the PDF as a raster image (measured: a 363 x 554 px image block under the
 * whole figure, PyMuPDF get_image_info), so the figure was not fully vector. The lines lie where the pattern put
 * them (pattern space x = 0 mod 1.6 mm, rotated by `angle` about the origin: x cos a + y sin a = 1.6 k) and are
 * cut to the box `x, y, w, h` here (Liang-Barsky on the box); a non-rectangular node also gets a `clipPath`
 * (`clipSvg`). Weight 0.3 mm = the declared pattern line (the pattern tile showed only half of it, 0.15 mm,
 * below the 0.18 mm photocopy floor of tokens.json).
 */
export function hatchLinesSvg(x: number, y: number, w: number, h: number, angle: 45 | 135, clip?: { id: string; shape: string }): string {
  if (!(w > 0) || !(h > 0)) return "";
  const a = (angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const us = [x * cos + y * sin, (x + w) * cos + y * sin, x * cos + (y + h) * sin, (x + w) * cos + (y + h) * sin];
  const kMin = Math.ceil(Math.min(...us) / HATCH_PITCH_MM - 1e-9);
  const kMax = Math.floor(Math.max(...us) / HATCH_PITCH_MM + 1e-9);
  const dx = -sin;
  const dy = cos;
  const lines: string[] = [];
  for (let k = kMin; k <= kMax; k++) {
    const c = k * HATCH_PITCH_MM;
    const px = c * cos;
    const py = c * sin;
    // t-range where (px + t dx, py + t dy) lies in the box.
    const tx = [(x - px) / dx, (x + w - px) / dx].sort((p, q) => p - q);
    const ty = [(y - py) / dy, (y + h - py) / dy].sort((p, q) => p - q);
    const t0 = Math.max(tx[0], ty[0]);
    const t1 = Math.min(tx[1], ty[1]);
    if (t1 - t0 < 0.05) continue; // shorter than 0.05 mm: a corner touch, nothing to print
    lines.push(`<line x1="${r2(px + t0 * dx)}" y1="${r2(py + t0 * dy)}" x2="${r2(px + t1 * dx)}" y2="${r2(py + t1 * dy)}"/>`);
  }
  if (!lines.length) return "";
  const g = `stroke="${colourOf("ink400")}" stroke-width="${pyStrNum(HATCH_STROKE_MM)}" data-hatch="${angle}"`;
  if (!clip) return `<g ${g}>${lines.join("")}</g>`;
  return `<clipPath id="${escAttr(clip.id)}">${clip.shape}</clipPath><g ${g} clip-path="url(#${escAttr(clip.id)})">${lines.join("")}</g>`;
}

/** Row 165C: shapes whose outline is the box itself (hatch cut to the box exactly, no clipPath). */
const BOX_SHAPES: ReadonlySet<string> = new Set(["box", "shadowed", "doubled"]);

/** Row 165C: outline of a non-box node as a bare clip element (same geometry as `shapeSvg`), null = box/unknown/bus. */
function clipShapeSvg(shape: string, x: number, y: number, w: number, h: number): string | null {
  switch (shape) {
    case "stadium":
      return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" rx="${r2(h / 2)}" ry="${r2(h / 2)}"/>`;
    case "diamond":
      return `<polygon points="${r2(x + w / 2)},${r2(y)} ${r2(x + w)},${r2(y + h / 2)} ${r2(x + w / 2)},${r2(y + h)} ${r2(x)},${r2(y + h / 2)}"/>`;
    case "parallelogram": {
      const k = w * 0.18;
      return `<polygon points="${r2(x + k)},${r2(y)} ${r2(x + w)},${r2(y)} ${r2(x + w - k)},${r2(y + h)} ${r2(x)},${r2(y + h)}"/>`;
    }
    case "hexagon": {
      const k = w * 0.22;
      return `<polygon points="${r2(x + k)},${r2(y)} ${r2(x + w - k)},${r2(y)} ${r2(x + w)},${r2(y + h / 2)} ${r2(x + w - k)},${r2(y + h)} ${r2(x + k)},${r2(y + h)} ${r2(x)},${r2(y + h / 2)}"/>`;
    }
    case "cylinder": {
      const ry = h * 0.16;
      return `<path d="M${r2(x)} ${r2(y + ry)} a${r2(w / 2)} ${r2(ry)} 0 0 0 ${r2(w)} 0 L${r2(x + w)} ${r2(y + h - ry)} a${r2(w / 2)} ${r2(ry)} 0 0 1 -${r2(w)} 0 Z"/>`;
    }
    case "circle":
      return `<circle cx="${r2(x + w / 2)}" cy="${r2(y + h / 2)}" r="${r2(Math.min(w, h) / 2)}"/>`;
    default:
      return null;
  }
}

/**
 * Swarm patch (row 165C, F113-9, CP-37): a node outline that lies on the sheet edge (x = 0 or x + w = W, the same
 * for y) had half of its stroke outside the canvas, so the PNG/SVG cut it. The DRAWN outline is moved inside by
 * half a stroke on the sides that would cross the edge; layout, routes and texts keep the placed geometry.
 */
export function insetForStroke<T extends Pick<SheetNode, "x" | "y" | "w" | "h">>(nd: T, canvas: { widthMm: number; heightMm: number } | undefined, sw: number): T {
  if (!canvas) return nd;
  // Limits on the 0.01 mm grid the SVG numbers are written on (r2), rounded inward, so rounding never puts the
  // stroke back across the edge.
  const lo = Math.ceil((sw / 2) * 100 - 1e-9) / 100;
  const hiX = Math.floor((canvas.widthMm - sw / 2) * 100 + 1e-9) / 100;
  const hiY = Math.floor((canvas.heightMm - sw / 2) * 100 + 1e-9) / 100;
  const x0 = Math.max(nd.x, lo);
  const y0 = Math.max(nd.y, lo);
  const x1 = Math.min(nd.x + nd.w, hiX);
  const y1 = Math.min(nd.y + nd.h, hiY);
  if (x0 === nd.x && y0 === nd.y && x1 === nd.x + nd.w && y1 === nd.y + nd.h) return nd;
  if (x1 <= x0 || y1 <= y0) return nd;
  return { ...nd, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------- row 165J
/** Row 165J (F165H-2): paper margin around a text line on a hatched node (mm): beside the glyphs and above/below. */
export const TEXT_GROUND_PAD_X_MM = 0.5;
export const TEXT_GROUND_PAD_Y_MM = 0.3;
/** Row 165J: cap height and descender of IBM Plex (em) the ground covers; the line box (1.025/0.275 em) is not needed. */
const GROUND_ASCENT_EM = 0.78;
const GROUND_DESCENT_EM = 0.24;

interface GroundLine {
  x: number;
  y: number;
  s: string;
  role: string;
  anchor: "start" | "middle" | "end";
  face?: "struct" | "data";
  sizePt?: number;
}

/**
 * Swarm patch (row 165J, F165H-2; C191 ruling 1, verification/25 §5.3): on a hatched node the hatch (ink400, 0.3 mm)
 * ran through the node texts, and the sub-label and the requirement tag ARE ink400, so they were hard to read at print
 * size. Every text line of a hatched node (label, sub-label, tag, mark glyph) gets a `<rect>` in the paper colour
 * behind it: the glyph width (`measure`, the fit metric of the condensed face; mono for the mark glyph) plus
 * `TEXT_GROUND_PAD_X_MM`, from the cap height to the descender plus `TEXT_GROUND_PAD_Y_MM`. Each rect is cut to the
 * inside of the drawn outline (half a stroke in), and a non-box node clips the rects with its own outline clip, so no
 * ground reaches outside the node. Colours: paper only (already the figure ground), so CP-43 / DATUM-25 count no new
 * colour. Rects, not a paint-order stroke halo: Word's SVG renderer does not honour paint-order, and a paper stroke
 * painted over the glyphs would erode them. Returns "" when the node has no text.
 */
export function nodeTextGroundSvg(
  nd: SheetNode,
  g: Pick<SheetNode, "x" | "y" | "w" | "h">,
  fit: ReturnType<typeof nodeTextLayout>,
  clipId: string | null,
): string {
  const n = nd.spec;
  const cx = nd.x + nd.w / 2.0;
  const cy = nd.y + nd.h / 2.0;
  const capMm = pt2mm(role("caption").size);
  const lines: GroundLine[] = [];
  const block = (b: TextBlockLayout, roleName: string) => b.lines.forEach((s, i) => lines.push({ x: b.x, y: b.y + i * b.lineMm, s, role: roleName, anchor: "middle" }));
  if (fit) {
    block(fit.label, "caption");
    if (fit.sub) block(fit.sub, "source_line");
    else if (n.sub) lines.push({ x: cx, y: cy + capMm, s: pyStr(n.sub), role: "source_line", anchor: "middle" });
  } else {
    lines.push({ x: cx, y: cy, s: pyStr(n.label), role: "caption", anchor: "middle" });
    if (n.sub) lines.push({ x: cx, y: cy + capMm, s: pyStr(n.sub), role: "source_line", anchor: "middle" });
  }
  if (n.mark) {
    const glyph = MARKS[n.mark] ?? "";
    lines.push({ x: nd.x + nd.w - pt2mm(1.5), y: nd.y + capMm, s: glyph, role: "register_block", anchor: "end", face: "data" });
  }
  if (n.tag) lines.push({ x: nd.x + pt2mm(1.5), y: nd.y + capMm, s: pyStr(n.tag), role: "table_header", anchor: "start" });
  const half = STROKE_PRIMARY / 2;
  const bx0 = g.x + half;
  const by0 = g.y + half;
  const bx1 = g.x + g.w - half;
  const by1 = g.y + g.h - half;
  const rects: string[] = [];
  for (const ln of lines) {
    if (!ln.s.trim()) continue;
    const r = role(ln.role);
    const pt = ln.sizePt ?? r.size;
    const sizeMm = pt2mm(pt);
    const upper = !!r.upper;
    const trackMm = r.track_em ? sizeMm * r.track_em : 0;
    const w = measure(ln.s, pt, ln.face ?? "struct", { bold: (r.weight ?? 400) >= 600, trackMm, caps: upper });
    const lx = ln.anchor === "middle" ? ln.x - w / 2 : ln.anchor === "end" ? ln.x - w : ln.x;
    const x0 = Math.max(bx0, lx - TEXT_GROUND_PAD_X_MM);
    const x1 = Math.min(bx1, lx + w + TEXT_GROUND_PAD_X_MM);
    const y0 = Math.max(by0, ln.y - GROUND_ASCENT_EM * sizeMm - TEXT_GROUND_PAD_Y_MM);
    const y1 = Math.min(by1, ln.y + GROUND_DESCENT_EM * sizeMm + TEXT_GROUND_PAD_Y_MM);
    if (x1 - x0 < 0.05 || y1 - y0 < 0.05) continue;
    rects.push(`<rect x="${r2(x0)}" y="${r2(y0)}" width="${r2(x1 - x0)}" height="${r2(y1 - y0)}" fill="${PAPER}"/>`);
  }
  if (!rects.length) return "";
  const clip = clipId !== null ? ` clip-path="url(#${escAttr(clipId)})"` : "";
  return `<g data-text-ground="1"${clip}>${rects.join("")}</g>`;
}

/** Row 165C: options of `nodeSvg` (sheet size for the half-stroke inset of F113-9). */
export interface NodeSvgOptions extends SvgMarkOptions {
  canvas?: { widthMm: number; heightMm: number };
}

export function nodeSvg(nd: SheetNode, opts: NodeSvgOptions = {}): string[] {
  const n = nd.spec;
  // Row 165C (F113-9/F113-10): outline inset at the sheet edge; hatch drawn as vector lines under the outline.
  const { canvas, ...markOpts } = opts;
  const g = insetForStroke(nd, canvas, STROKE_PRIMARY);
  const angle = (n.shape ?? "box") === "bus" ? null : nodeHatchAngle(nd);
  const out: string[] = [];
  const cx = nd.x + nd.w / 2.0;
  const cy = nd.y + nd.h / 2.0;
  const capMm = pt2mm(role("caption").size);
  // FIG-02b: hanya saat fit dan hanya bila label tidak muat satu baris (atau rel bus).
  const fit = diagramFitActive() ? nodeTextLayout(nd) : null;
  if (angle !== null) {
    const shape = n.shape ?? "box";
    const clipShape = BOX_SHAPES.has(shape) ? null : clipShapeSvg(shape, g.x, g.y, g.w, g.h);
    const clipId = `datum-hatch-clip-${opts.index ?? escAttr(nd.id).replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const hatch = hatchLinesSvg(g.x, g.y, g.w, g.h, angle, clipShape !== null ? { id: clipId, shape: clipShape } : undefined);
    if (hatch) {
      out.push(hatch);
      // Row 165J (F165H-2): a paper ground behind every text line of a hatched node, so no hatch line runs through
      // a glyph (the sub-label and the ID were the hatch colour, ink400). Drawn after the hatch and before the outline.
      const ground = nodeTextGroundSvg(nd, g, fit, clipShape !== null ? clipId : null);
      if (ground) out.push(ground);
    }
  }
  out.push(shapeSvg(g, nodeStrokeToken(nd), "none", { ...markOpts, strokeW: STROKE_PRIMARY }));
  const sym = nodeSymbolSvg(nd); // row 124 (CP-45): specified symbol, drawn before the texts
  if (sym) out.push(sym);
  if (fit) {
    out.push(svgTextLines(fit.label, { role: "caption", colourToken: "ink900" }));
    if (fit.sub) out.push(svgTextLines(fit.sub, { role: "source_line" }));
    else if (n.sub) out.push(svgText(cx, cy + capMm, n.sub, { role: "source_line" }));
  } else {
    out.push(svgText(cx, cy, n.label, { role: "caption", colourToken: "ink900" }));
    if (n.sub) out.push(svgText(cx, cy + capMm, n.sub, { role: "source_line" }));
  }
  if (n.mark) out.push(markGlyphSvg(nd));
  if (n.tag) {
    out.push(svgText(nd.x + pt2mm(1.5), nd.y + capMm, n.tag, { role: "table_header", colourToken: "ink400", anchor: "start" }));
  }
  return out;
}

/** Pola garis per jenis konektor (`stroke-dasharray` atau null untuk solid). */
export function edgeDash(kind: DiagramEdgeKind): string | null {
  return DASH_PATTERNS[EDGE_KINDS[kind].pattern];
}

/** Tebal garis konektor: aksen 1,6x primer. */
export function edgeStrokeWidth(kind: DiagramEdgeKind): number {
  return kind === "accent" ? STROKE_PRIMARY * 1.6 : STROKE_PRIMARY;
}

/** Atribut `d` polilinear "M x y L x y ..." (dibulatkan 2 desimal). */
export function polylineD(pts: ReadonlyArray<readonly [number, number]>): string {
  return `M ${pts.map(([px, py]) => `${r2(px)} ${r2(py)}`).join(" L ")}`;
}

/** Jalur konektor (6 jenis, pola garis ISO 128-2, kepala panah per jenis). */
export function edgePathSvg(
  pts: ReadonlyArray<readonly [number, number]>,
  kind: DiagramEdgeKind,
  opts: SvgMarkOptions = {},
): string {
  const meta = EDGE_KINDS[kind];
  const dash = DASH_PATTERNS[meta.pattern];
  let attrs = `fill="none" stroke="${colourOf(meta.colour)}" stroke-width="${r2(edgeStrokeWidth(kind))}"`;
  if (dash) attrs += ` stroke-dasharray="${dash}"`;
  return `<path d="${polylineD(pts)}" ${attrs} marker-end="url(#head-${kind})"${markAttrs("link", opts, kind)}/>`;
}

/** Kepala panah satu jenis (P4: solid terisi, open bergaris). */
export function edgeMarkerSvg(kind: DiagramEdgeKind): string {
  const meta = EDGE_KINDS[kind];
  const col = colourOf(meta.colour);
  if (meta.head === "solid") {
    return `<marker id="head-${kind}" markerWidth="4" markerHeight="4" refX="3.4" refY="1.6" orient="auto"><path d="M0,0 L3.6,1.6 L0,3.2 Z" fill="${col}"/></marker>`;
  }
  return `<marker id="head-${kind}" markerWidth="4" markerHeight="4" refX="3.4" refY="1.6" orient="auto"><path d="M0,0 L3.6,1.6 L0,3.2" fill="none" stroke="${col}" stroke-width="0.35"/></marker>`;
}

/** Pola arsiran 45/135 derajat (isian diagram tahan fotokopi). */
export function hatchPatternSvg(angle: 45 | 135): string {
  return (
    `<pattern id="datum-hatch${angle}" width="1.6" height="1.6" patternUnits="userSpaceOnUse" ` +
    `patternTransform="rotate(${angle})"><line x1="0" y1="0" x2="0" y2="1.6" stroke="${colourOf("ink400")}" stroke-width="0.3"/></pattern>`
  );
}

/** Row 124: what a figure actually draws from `<defs>`. */
export interface DiagramDefsUse {
  kinds: Iterable<DiagramEdgeKind>;
  hatch45: boolean;
  hatch135: boolean;
}

/**
 * Blok `<defs>` sebagai baris-baris terpisah (urutan Python: arsiran, kepala panah terurut).
 * Swarm patch (row 124, CP-43 / C23 check 25; DT-06 ID p.48): with `use`, only the hatch patterns
 * and arrow heads the figure references are defined, so no unused colour (the alert and verd
 * heads of the original) is printed into the file. Without `use` = the original full block.
 */
export function diagramDefs(use?: DiagramDefsUse): string[] {
  if (!use) return ["<defs>", hatchPatternSvg(45), hatchPatternSvg(135), ...EDGE_KIND_NAMES_SORTED.map(edgeMarkerSvg), "</defs>"];
  const kinds = new Set(use.kinds);
  const out: string[] = [];
  if (use.hatch45) out.push(hatchPatternSvg(45));
  if (use.hatch135) out.push(hatchPatternSvg(135));
  out.push(...EDGE_KIND_NAMES_SORTED.filter((k) => kinds.has(k)).map(edgeMarkerSvg));
  return out.length ? ["<defs>", ...out, "</defs>"] : [];
}

/**
 * Swarm patch (row 124, CP-28/CP-48; DT-15 ID p.41, 9.5 p.57): figure caption line. When the line
 * starts with the label (`GAMBAR 4.1`), the label is set in a SemiBold `<tspan>` and the sentence
 * follows at the caption weight, in the same `<text>` (one caption element, as before).
 */
export function captionSvg(x: PyNumber, y: PyNumber, line: string, label: string, opts: SvgTextOptions = {}): string {
  const shell = svgText(x, y, "", opts);
  if (!label || !line.startsWith(label)) return svgText(x, y, line, opts);
  const head = shell.slice(0, -"</text>".length);
  return `${head}<tspan font-weight="600">${escText(label)}</tspan>${escText(line.slice(label.length))}</text>`;
}

/**
 * Komentar generator (padanan baris komentar Python; bukan elemen). Nilai yang
 * disisipkan lewat `xmlCommentText`: tidak pernah memuat "--" (S84 #3), walau
 * `family` di jalur build sudah tervalidasi ke enum keluarga.
 */
export function generatorComment(family: string): string {
  const fam = xmlCommentText(escText(family));
  const tok = xmlCommentText(escText(DIAGRAM_TOKENS.sourceName));
  return `<!-- generator studio engine/diagram (port datum_diagram.py v2.0.0 Garis A, rebuild DHS-RB-04) | family=${fam} | token=${tok} -->`;
}

/** Komentar kewajiban apparatus page (P6, dilaporkan lint cek 36). */
export const APPARATUS_REQUIRED_COMMENT =
  "<!-- DATUM-APPARATUS-REQUIRED: caption, source dan baris kunci dicetak oleh halaman, bukan oleh SVG ini (P6, lint cek 36) -->";

/** Latar kertas penuh lembar. */
export function paperRectSvg(widthMm: number, heightMm: number): string {
  return `<rect x="0" y="0" width="${pyNum(widthMm, 3)}" height="${pyNum(heightMm, 3)}" fill="${PAPER}"/>`;
}

/** Garis lurus bertoken (pemisah lajur, parit, garis kehidupan). */
export function lineSvg(
  x1: PyNumber,
  y1: PyNumber,
  x2: PyNumber,
  y2: PyNumber,
  colourToken: string,
  strokeW: number,
  dash?: string | null,
): string {
  const d = dash ? ` stroke-dasharray="${dash}"` : "";
  return `<line x1="${pyNum(x1, 2)}" y1="${pyNum(y1, 2)}" x2="${pyNum(x2, 2)}" y2="${pyNum(y2, 2)}" stroke="${colourOf(colourToken)}" stroke-width="${r2(strokeW)}"${d}/>`;
}

/** Lompatan silang pada lintasan horizontal (r = 0,9 mm). */
export function hopSvg(hx: number, hy: number, kind: DiagramEdgeKind): string {
  const r = LIMITS.hop_radius_mm;
  return (
    `<path d="M ${r2(hx - r)} ${r2(hy)} A ${r2(r)} ${r2(r)} 0 0 1 ${r2(hx + r)} ${r2(hy)}" ` +
    `fill="none" stroke="${colourOf(EDGE_KINDS[kind].colour)}" stroke-width="${r2(STROKE_PRIMARY)}"/>`
  );
}

/** Pita kertas pemutus garis di belakang label tepi (`_label_knockout`; my = garis dasar). */
export function labelKnockoutSvg(mx: number, my: number, text: unknown, sheetW: number, kwMm?: number): string {
  const r = role("evidence_rail");
  const size = pt2mm(r.size);
  const tr = r.track_em;
  // Python memakai pt2mm(size) atas size yang sudah mm (dipertahankan untuk paritas).
  const lw = estTextMm(text, "evidence_rail") + (tr ? pt2mm(size) * tr * pyLen(pyStr(text)) : 0.0);
  // FIG-02b: saat fit, lebar pita = lebar mono terukur 0,6 em + 1,6 (`fit/labels.ts knockWidthMm`).
  const kw = kwMm ?? lw + 1.6;
  const kh = size * 1.7;
  const kx = Math.min(Math.max(mx - kw / 2.0, 0.0), Math.max(0.0, sheetW - kw));
  const ky = my - size * 1.15;
  return `<rect x="${r2(kx)}" y="${r2(ky)}" width="${r2(kw)}" height="${r2(kh)}" fill="${PAPER}"/>`;
}

/** Label konektor: pita knockout lalu teks evidence_rail berwarna jenis. */
export function edgeLabelSvg(mx: number, my: number, label: unknown, kind: DiagramEdgeKind, sheetW: number, kwMm?: number): string[] {
  return [
    labelKnockoutSvg(mx, my, label, sheetW, kwMm),
    svgText(mx, my, label, { role: "evidence_rail", colourToken: EDGE_KINDS[kind].colour, anchor: "middle" }),
  ];
}
