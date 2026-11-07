/**
 * Tabel satu baris untuk perangkat blok teks (S16): kotak rel 1x3 moda A
 * (`render.rail.renderer = "table3col"`, KT-18..KT-22), aside 1x1 (TCP-18),
 * monoBlock 1x1 (TCP-21), pita segel 1x2 (TCP-01/02).
 *
 * Properti tabel dari R-17 `render.table.layout` (tata letak tetap, indentasi
 * 0, margin sel kiri/kanan 0, tanpa garis tepi; TP-01..03). Tabel data milik
 * S17; modul ini hanya menulis bingkai perangkat.
 */
import type { Borders, Cell, Shading } from "../../../contract";
import type { BlockEnv } from "./env";
import { bordersInner, shadingEl } from "./props";
import { el } from "./xml";

export interface FrameCell {
  widthTw: number;
  /** Isi sel (paragraf/tabel); kosong -> `<w:p/>`. */
  content: string;
  borders?: Omit<Borders, "insideH" | "insideV">;
  marginsTw?: Cell["marginsTw"];
  shading?: Shading;
}

const NONE_BORDER = { "w:val": "none", "w:sz": 0, "w:space": 0, "w:color": "auto" } as const;

function layoutParam(env: BlockEnv): { fixed: boolean; indentTw: number; cellMarginTw: { left: number; right: number }; borders?: Borders } {
  const v = env.param("render.table.layout");
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const cm = o.cellMarginTw && typeof o.cellMarginTw === "object" ? (o.cellMarginTw as Record<string, unknown>) : {};
  const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);
  const borders = o.borders && typeof o.borders === "object" && !Array.isArray(o.borders) ? (o.borders as Borders) : undefined;
  return {
    fixed: o.fixed !== false,
    indentTw: num(o.indentTw, 0),
    cellMarginTw: { left: num(cm.left, 0), right: num(cm.right, 0) },
    borders,
  };
}

function tableBorders(b: Borders | undefined): string {
  if (b) return `<w:tblBorders>${bordersInner(b)}</w:tblBorders>`;
  const sides = ["top", "left", "bottom", "right", "insideH", "insideV"];
  return `<w:tblBorders>${sides.map((s) => el(`w:${s}`, NONE_BORDER)).join("")}</w:tblBorders>`;
}

function cellXml(c: FrameCell): string {
  const tcPr: string[] = [el("w:tcW", { "w:w": c.widthTw, "w:type": "dxa" })];
  if (c.borders && Object.keys(c.borders).length > 0) tcPr.push(`<w:tcBorders>${bordersInner(c.borders)}</w:tcBorders>`);
  if (c.shading) tcPr.push(shadingEl(c.shading));
  const m = c.marginsTw;
  if (m && (m.top !== undefined || m.left !== undefined || m.bottom !== undefined || m.right !== undefined)) {
    const side = (tag: string, v: number | undefined) => (v === undefined ? "" : el(`w:${tag}`, { "w:w": v, "w:type": "dxa" }));
    tcPr.push(`<w:tcMar>${side("top", m.top)}${side("left", m.left)}${side("bottom", m.bottom)}${side("right", m.right)}</w:tcMar>`);
  }
  // Sel wajib diakhiri paragraf (ECMA-376 §17.4.66).
  let content = c.content || "<w:p/>";
  if (!/<\/w:p>$|<w:p\/>$/.test(content)) content += "<w:p/>";
  return `<w:tc><w:tcPr>${tcPr.join("")}</w:tcPr>${content}</w:tc>`;
}

/** Tabel satu baris, `cantSplit` (P5-13), lebar total = jumlah sel. */
export function singleRowTable(env: BlockEnv, cells: readonly FrameCell[]): string {
  const lay = layoutParam(env);
  const total = cells.reduce((a, c) => a + Math.round(c.widthTw), 0);
  const tblPr =
    el("w:tblW", { "w:w": total, "w:type": "dxa" }) +
    el("w:tblInd", { "w:w": lay.indentTw, "w:type": "dxa" }) +
    tableBorders(lay.borders) +
    (lay.fixed ? el("w:tblLayout", { "w:type": "fixed" }) : "") +
    `<w:tblCellMar>${el("w:left", { "w:w": lay.cellMarginTw.left, "w:type": "dxa" })}${el("w:right", { "w:w": lay.cellMarginTw.right, "w:type": "dxa" })}</w:tblCellMar>` +
    el("w:tblLook", {
      "w:val": "04A0",
      "w:firstRow": "1",
      "w:lastRow": "0",
      "w:firstColumn": "1",
      "w:lastColumn": "0",
      "w:noHBand": "0",
      "w:noVBand": "1",
    });
  const grid = cells.map((c) => el("w:gridCol", { "w:w": c.widthTw })).join("");
  const row = `<w:tr><w:trPr>${el("w:cantSplit")}</w:trPr>${cells.map(cellXml).join("")}</w:tr>`;
  return `<w:tbl><w:tblPr>${tblPr}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${row}</w:tbl>`;
}
