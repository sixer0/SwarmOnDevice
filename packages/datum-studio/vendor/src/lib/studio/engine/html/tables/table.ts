/**
 * Keluarga tabel HTML (11 jenis TableBlock; padanan DOCX S17).
 *
 * Tata bahasa DATUM (RL 03 §1, P5-01..P5-16):
 * - Hanya garis mendatar: garis utama di atas kepala, garis bawah-kepala, garis
 *   rambut antarbaris, garis utama di atas total. Garis tegak dibuang kecuali
 *   `table.verticalRules.allowed`; kepala tanpa isian kecuali
 *   `table.headerFill.allowed`; total tanpa isian (P5-11).
 * - Kepala berulang di cetak: baris kepala di `<thead>` (`table-header-group`)
 *   bila `table.header.repeatEachPage` atau baris `repeatHeader`.
 * - Baris tidak dipecah antarhalaman (P5-13, `cantSplit`).
 * - Pita kelompok (`kind: "group"`) tanpa isian; kolom satuan sendiri (peran
 *   kolom `unit`, skala `type.scale.unitColumn.*`); numeral Mono rata kanan,
 *   tidak pernah di tengah (P5-04).
 * - Zebra hanya bila baris badan > `table.zebra.minRows`, warna
 *   `table.zebra.colour` (token turunan `zebra15`, D-31), tidak pada BoQ cetak.
 * - Sel gabung: `gridSpan` -> colspan, `vMerge` restart/continue -> rowspan.
 * - Tabel bersarang kedalaman 1 (§3.4).
 * - SUMBER/PROVENANS: baris terakhir tergabung (`lastRowMerged`) atau paragraf
 *   di bawah (`paragraphBelow`), default `render.table.sourcePlacement`.
 */
import type {
  BorderSpec,
  Cell,
  CellParagraph,
  ColumnSpec,
  NormBlock,
  ParaFormat,
  ParamMap,
  RenderContext,
  RoleKey,
  Row,
  RunProps,
  TableBlock,
} from "../../../contract";
import { apparatusReserveTw } from "../../docx/blocks/rail";
import { baselineSnapTw } from "../../docx/blocks/rhythm";
import { mmToTw } from "../../tokens";
import { assertTableFits, tableBreakRuns } from "../../table-fit";
import { scaleRun } from "../../tokens/roles";
import { artifactLabel, captionHtml, sourceInner, sourceParagraphCss, sourceParagraphHtml } from "./apparatus";
import { attr, escText } from "./escape";
import { symbolBoundRuns } from "../blocks/semantic";
import { inlineHtml, paraHtml, parseMdLite, runsHtml } from "./inline";
import {
  borderCss,
  color,
  css,
  hexCss,
  n,
  pBool,
  pNum,
  pObj,
  pStr,
  role,
  ruleCss,
  runCss,
  twToMm,
} from "./style";

/** Kedalaman maksimum tabel bersarang (§3.4). */
export const MAX_NESTED_DEPTH = 1;

/** Cadangan rona zebra15 palet kanonik (15 % ink900 di atas paper). */
const ZEBRA_FALLBACK = "D9D9D9";

type RowKind = NonNullable<Row["kind"]>;

interface Rules {
  primary: string;
  belowHeader: string;
  hair: string;
}

interface TableEnv {
  ctx: RenderContext;
  t: TableBlock;
  cols: readonly ColumnSpec[];
  rules: Rules;
  verticalAllowed: boolean;
  headerFillAllowed: boolean;
  splitRows: boolean;
  zebraColor: string | undefined;
  marginLR: { left: number; right: number };
  hasHead: boolean;
  depth: number;
}

function rowKind(r: Row): RowKind {
  return r.kind ?? "body";
}

function isNumericCol(c: ColumnSpec | undefined): boolean {
  return !!c && (c.role === "numeral" || c.align === "right" || c.align === "decimal");
}

/** Rata teks kolom; numeral tidak pernah di tengah (P5-04). */
function colAlign(c: ColumnSpec | undefined): string | undefined {
  if (!c) return undefined;
  if (c.role === "glyph") return "center";
  if (c.role === "numeral") return "right";
  if (c.align === "decimal" || c.align === "right") return "right";
  if (c.align === "center") return "center";
  if (c.align === "left") return "left";
  return undefined;
}

function cellRoleKey(kind: RowKind, c: ColumnSpec | undefined): RoleKey | "unit" {
  if (kind === "header") return isNumericCol(c) ? "table.headerRight" : "table.headerLeft";
  if (kind === "group") return "table.groupBand";
  switch (c?.role) {
    case "numeral":
      return "table.cellNumeralRight";
    case "id":
      return "table.cellMono";
    case "glyph":
      return "table.cellGlyph";
    case "unit":
      return "unit";
    default:
      return "table.cellText";
  }
}

/** Rencana sel gabung vertikal per seksi (thead/tbody tidak boleh dilintasi rowspan). */
function mergePlan(rows: readonly Row[]): { span: Map<Cell, number>; skip: Set<Cell> } {
  const span = new Map<Cell, number>();
  const skip = new Set<Cell>();
  let open = new Map<number, Cell>();
  for (const r of rows) {
    let col = 0;
    const next = new Map<number, Cell>();
    for (const cell of r.cells) {
      const gs = Math.max(1, Math.floor(cell.gridSpan ?? 1));
      if (cell.vMerge === "continue") {
        const o = open.get(col);
        if (o) {
          span.set(o, (span.get(o) ?? 1) + 1);
          skip.add(cell);
          next.set(col, o);
        }
      } else if (cell.vMerge === "restart") {
        span.set(cell, 1);
        next.set(col, cell);
      }
      col += gs;
    }
    open = next;
  }
  return { span, skip };
}

function cellParagraphs(cell: Cell): CellParagraph[] | null {
  if (Array.isArray(cell.paragraphs)) return cell.paragraphs;
  if (typeof cell.text === "string") return [{ text: cell.text }];
  if (Array.isArray(cell.runs)) return [{ runs: cell.runs }];
  return null;
}

interface CellPos {
  kind: RowKind;
  first: boolean;
  last: boolean;
  /** Baris badan ke-n (0-based) sejak pita kelompok terakhir, untuk zebra. */
  zebraIndex: number;
}

/**
 * Swarm 1.2.7 row 40 (N-11): the cell paragraph with `<wbr>` after each separator of a long ID list joined without
 * spaces (table-fit.ts `breakableSegments`, the same breaks DT-10a counts). Null when no break applies (the caller's
 * output stays byte-identical) or when the text already holds U+200B (the marker used here).
 */
function brokenParaHtml(para: CellParagraph, p: ParamMap, rk: RoleKey | "unit"): string | null {
  const runs =
    "runs" in para && Array.isArray(para.runs)
      ? symbolBoundRuns(para.runs, p, rk === "unit" ? undefined : rk)
      : "text" in para && typeof para.text === "string"
        ? parseMdLite(para.text)
        : null;
  if (!runs || runs.some((r) => "t" in r && r.t.includes(ZWSP))) return null;
  const broken = tableBreakRuns(runs, ZWSP);
  return broken ? runsHtml(broken, {}, p).split(ZWSP).join("<wbr>") : null;
}
const ZWSP = "\u200B";

function cellHtml(env: TableEnv, cell: Cell, colIdx: number, pos: CellPos, rowspan: number, tag: "td" | "th"): string {
  const { ctx, cols, rules } = env;
  const p = ctx.tpl.params;
  const col = cols[colIdx];
  const gs = Math.max(1, Math.floor(cell.gridSpan ?? 1));
  const rk = cellRoleKey(pos.kind, col);
  const rf = rk === "unit" ? { run: scaleRun(p, "unitColumn") as RunProps, para: undefined } : role(ctx, rk);
  let run: RunProps = { ...(rf.run ?? {}) };
  if (pos.kind === "total") {
    const ink = color(ctx.tpl, "ink900", "ink900");
    run = { ...run, b: true, color: run.color ?? (ink.startsWith("#") ? ink.slice(1) : undefined) };
    if (col?.role !== "numeral" && col?.role !== "id" && col?.role !== "unit") run.faceRole = "condensed";
  }
  const align = gs === 1 ? colAlign(col) : pos.kind === "group" ? "left" : colAlign(col);
  // Swarm row 143a (C177 F143-1 (b)): only a single-column numeral / unit / id cell stays on one line. A cell that
  // spans columns (a total or band label such as "Jumlah titik sensor, empat ruang, ...") wraps like text; kept on one
  // line it pushed case 01 Table 3.1 to 176.9 mm, past the 166 mm span, and the page clipped the last column.
  const nowrap = gs === 1 && (col?.role === "numeral" || col?.role === "unit" || col?.role === "id");

  // Isi sel.
  let paras = cellParagraphs(cell);
  if ((paras === null || paras.length === 0) && pos.kind !== "header" && col?.role === "unit" && col.unit) paras = [{ text: col.unit }];
  let inner = "";
  const pStyle = css(runCss(run, p), align && `text-align:${align}`, nowrap && "white-space:pre");
  if (paras === null || paras.length === 0) {
    inner = paraHtml("", rf.para, pStyle);
  } else {
    for (const para of paras) {
      const fmt: ParaFormat | undefined = para.format ? { ...(rf.para ?? {}), ...para.format } : rf.para;
      const body =
        "runs" in para && Array.isArray(para.runs)
          ? runsHtml(symbolBoundRuns(para.runs, p, rk === "unit" ? undefined : rk), {}, p)
          : inlineHtml(para, {}, p);
      inner += paraHtml((!nowrap && brokenParaHtml(para, p, rk)) || body, fmt, pStyle);
    }
  }
  // Satuan tunggal di kepala (P5-06 pengecualian): kolom numeral dengan `unit`.
  if (pos.kind === "header" && col?.role === "numeral" && col.unit && pBool(p, "table.unitInHeader.singleUnitException", false)) {
    inner += paraHtml(escText(`(${col.unit})`), rf.para, pStyle);
  }
  if (cell.nested) {
    if (env.depth < MAX_NESTED_DEPTH) {
      inner += tableHtml(cell.nested, ctx, { depth: env.depth + 1 });
    } else {
      ctx.log({ level: "warn", message: "engine/html/tables: tabel bersarang melebihi kedalaman 1 dilewati", code: "SCHEMA_INVALID" });
    }
  }

  // Margin sel: sel > layout tabel > peran > default (RL `.tbl`: 1,5 mm vertikal).
  const roleMargins = rk === "unit" ? undefined : role(ctx, rk).cell?.marginsTw;
  const m = { ...(roleMargins ?? {}), ...(cell.marginsTw ?? {}) };
  const padTop = m.top !== undefined ? twToMm(m.top) : pos.kind === "group" ? 3.2 : pos.kind === "header" ? 1.6 : 1.5;
  const padBottom = m.bottom !== undefined ? twToMm(m.bottom) : pos.kind === "group" ? 1 : pos.kind === "header" ? 1.6 : 1.5;
  const padLeft = m.left !== undefined ? twToMm(m.left) : env.marginLR.left;
  let padRight = m.right !== undefined ? twToMm(m.right) : env.marginLR.right;
  // Tanpa margin horizontal sama sekali kolom saling menempel; jarak RL 2,5 mm (deviasi HTML-only).
  if (m.left === undefined && m.right === undefined && env.marginLR.left === 0 && env.marginLR.right === 0 && colIdx + gs < cols.length) padRight = 2.5;
  // specTable: kolom kondisi uji menjorok, tidak bergaris (P5-27).
  const specIndent = env.t.type === "specTable" && colIdx === 1 && pos.kind === "body" ? 3 : 0;

  // Garis: default tata bahasa < layout.borders blok < peran sel < sel.
  const b: Partial<Record<"top" | "bottom" | "left" | "right", string>> = {};
  const lb = env.t.layout?.borders;
  if (pos.kind === "header") {
    if (pos.first) b.top = rules.primary;
    if (pos.last) b.bottom = rules.belowHeader;
  } else if (pos.kind === "total") {
    b.top = rules.primary;
  } else if (pos.first) {
    // Badan tanpa kepala di atasnya: garis utama membuka tabel.
    if (!env.hasHead) b.top = rules.primary;
  } else if (specIndent === 0) {
    b.top = rules.hair;
  }
  if (lb) {
    if (pos.first && (pos.kind === "header" || !env.hasHead) && lb.top) b.top = borderCss(lb.top);
    else if (!pos.first && lb.insideH && pos.kind !== "total") b.top = borderCss(lb.insideH);
    if (lb.bottom && pos.last && pos.kind !== "header") b.bottom = borderCss(lb.bottom);
    if (env.verticalAllowed) {
      if (lb.insideV && colIdx > 0) b.left = borderCss(lb.insideV);
      if (lb.left && colIdx === 0) b.left = borderCss(lb.left);
      if (lb.right && colIdx + gs >= cols.length) b.right = borderCss(lb.right);
    }
  }
  const sides = (src: Partial<Record<"top" | "bottom" | "left" | "right", BorderSpec>> | undefined): void => {
    if (!src) return;
    if (src.top) b.top = borderCss(src.top);
    if (src.bottom) b.bottom = borderCss(src.bottom);
    if (env.verticalAllowed) {
      if (src.left) b.left = borderCss(src.left);
      if (src.right) b.right = borderCss(src.right);
    }
  };
  if (rk !== "unit") sides(role(ctx, rk).cell?.borders);
  sides(cell.borders);

  // Isian: kepala tanpa isian (P5-02), total tanpa isian (P5-11); zebra untuk badan.
  let bg: string | undefined;
  const roleShading = rk !== "unit" ? role(ctx, rk).cell?.shading : undefined;
  const shading = cell.shading ?? roleShading;
  const fillAllowed = pos.kind === "header" ? env.headerFillAllowed : pos.kind !== "total";
  if (shading && fillAllowed) bg = hexCss(shading.fill);
  if (!bg && env.zebraColor && pos.kind === "body" && pos.zebraIndex % 2 === 1) bg = env.zebraColor;

  const valign = cell.vAlign ?? (pos.kind === "header" ? pStr(p, "table.header.verticalAlign", "bottom") : "top");
  const style = css(
    `padding:${n(padTop)}mm ${n(padRight)}mm ${n(padBottom)}mm ${n(padLeft + specIndent)}mm`,
    `vertical-align:${valign === "center" ? "middle" : valign}`,
    b.top && `border-top:${b.top}`,
    b.bottom && `border-bottom:${b.bottom}`,
    b.left && `border-left:${b.left}`,
    b.right && `border-right:${b.right}`,
    bg && `background:${bg}`,
    cell.widthTw !== undefined && `width:${n(twToMm(cell.widthTw))}mm`,
  );
  const scope = tag === "th" ? (gs > 1 ? ' scope="colgroup"' : ' scope="col"') : "";
  return `<${tag}${gs > 1 ? attr("colspan", gs) : ""}${rowspan > 1 ? attr("rowspan", rowspan) : ""}${scope} style="${escText(style)}">${inner}</${tag}>`;
}

function rowsHtml(env: TableEnv, rows: readonly Row[], section: "head" | "body"): string {
  const { span, skip } = mergePlan(rows);
  let html = "";
  let zebra = -1;
  rows.forEach((r, ri) => {
    const kind = section === "head" ? "header" : rowKind(r);
    if (kind === "group") zebra = -1;
    else if (kind === "body") zebra++;
    const pos: CellPos = {
      kind,
      first: ri === 0,
      last: ri === rows.length - 1,
      zebraIndex: Math.max(0, zebra),
    };
    let col = 0;
    let cells = "";
    for (const cell of r.cells) {
      const gs = Math.max(1, Math.floor(cell.gridSpan ?? 1));
      if (!skip.has(cell)) cells += cellHtml(env, cell, col, pos, span.get(cell) ?? 1, kind === "header" ? "th" : "td");
      col += gs;
    }
    const keep = env.splitRows && !r.cantSplit ? "" : "break-inside:avoid";
    html += `<tr class="st-row st-row-${kind}"${keep ? ` style="${keep}"` : ""}>${cells}</tr>`;
  });
  return html;
}

/** Lebar kolom mm (undefined bila tidak dinyatakan). */
function colWidthMm(c: ColumnSpec): number | undefined {
  if (typeof c.widthMm === "number" && c.widthMm > 0) return c.widthMm;
  if (typeof c.widthTw === "number" && c.widthTw > 0) return twToMm(c.widthTw);
  return undefined;
}

export interface TableHtmlOptions {
  depth: number;
  /** Blok ternormalisasi (hanya tabel tingkat atas; tabel bersarang tidak beralamat). */
  block?: NormBlock;
}

/** Render satu TableBlock (tingkat atas atau bersarang) ke HTML. */
export function tableHtml(t: TableBlock, ctx: RenderContext, opts: TableHtmlOptions): string {
  const p = ctx.tpl.params;
  const cols = Array.isArray(t.columns) ? t.columns : [];
  const rows = Array.isArray(t.rows) ? t.rows : [];
  const paramLayout = pObj(p, "render.table.layout") ?? {};
  const cm = (t.layout?.cellMarginTw ?? (paramLayout.cellMarginTw as { left?: number; right?: number } | undefined)) ?? {};
  const isBoq = t.type === "financialTable" && t.preset === "boq";

  // Pisah kepala (baris kepala di awal tabel) dari badan.
  let headCount = 0;
  while (headCount < rows.length && (rowKind(rows[headCount]) === "header" || rows[headCount].repeatHeader === true)) headCount++;
  const head = rows.slice(0, headCount);
  const body = rows.slice(headCount);
  const bodyRows = body.filter((r) => rowKind(r) === "body").length;
  const zebraOn = bodyRows > pNum(p, "table.zebra.minRows", 12) && !(isBoq && !pBool(p, "table.zebra.onPrintedBoq", false));

  const env: TableEnv = {
    ctx,
    t,
    cols,
    rules: {
      primary: ruleCss(pNum(p, "rules.primaryMm", 0.45), color(ctx.tpl, "rules.primary.colour", "ink900")),
      belowHeader: ruleCss(pNum(p, "rules.belowHeaderMm", 0.25), color(ctx.tpl, "rules.belowHeader.colour", "ink400")),
      hair: ruleCss(pNum(p, "rules.hairMm", 0.2), color(ctx.tpl, "rules.hair.colour", "ink200")),
    },
    verticalAllowed: pBool(p, "table.verticalRules.allowed", false),
    headerFillAllowed: pBool(p, "table.headerFill.allowed", false),
    splitRows: pBool(p, "table.row.splitAcrossPages", false),
    zebraColor: zebraOn ? color(ctx.tpl, "table.zebra.colour", ZEBRA_FALLBACK) : undefined,
    marginLR: { left: twToMm(Number(cm.left ?? 0) || 0), right: twToMm(Number(cm.right ?? 0) || 0) },
    hasHead: head.length > 0,
    depth: opts.depth,
  };

  // Lebar tabel dan kolom.
  const widths = cols.map(colWidthMm);
  const allWidths = widths.length > 0 && widths.every((w) => w !== undefined);
  const layoutWidthTw = t.layout?.widthTw;
  const widthMm = layoutWidthTw ? twToMm(layoutWidthTw) : allWidths ? widths.reduce<number>((a, w) => a + (w ?? 0), 0) : undefined;
  const fixed = (t.layout?.fixed ?? paramLayout.fixed === true) && allWidths;
  const indentTw = t.layout?.indentTw ?? (typeof paramLayout.indentTw === "number" ? paramLayout.indentTw : 0);
  const colgroup = widths.some((w) => w !== undefined)
    ? `<colgroup>${widths.map((w) => (w !== undefined ? `<col style="width:${n(w)}mm">` : "<col>")).join("")}</colgroup>`
    : "";

  const repeat = pBool(p, "table.header.repeatEachPage", true) || head.some((r) => r.repeatHeader === true);
  const theadHtml = head.length > 0 ? rowsHtml(env, head, "head") : "";
  let tbodyHtml = rowsHtml(env, body, "body");

  // C22b / GF-21 (R-74): apparatus tabel tingkat atas dikunci ke garis dasar (= DOCX `rhythmBaseTw`, depth 0).
  const rhythmBase = opts.depth === 0 ? baselineSnapTw((k) => p[k]) : undefined;

  // SUMBER.
  const placement = t.sourcePlacement ?? (pStr(p, "render.table.sourcePlacement", "lastRowMerged") as TableBlock["sourcePlacement"]);
  let below = "";
  if (t.source) {
    if (placement === "paragraphBelow" || cols.length === 0) {
      below = sourceParagraphHtml(t.source, ctx, "table.source", true, rhythmBase);
    } else {
      const rf = role(ctx, "table.source");
      const srcStyle = css(
        `padding:1.6mm 0 0 0`,
        `border-top:${env.rules.hair}`,
        "vertical-align:top",
      );
      tbodyHtml +=
        `<tr class="st-row st-row-source" style="break-inside:avoid;break-before:avoid">` +
        `<td${attr("colspan", cols.length)} style="${escText(srcStyle)}">` +
        // Row 123 (CP-26): the merged SUMBER row stays within the 166 mm text span.
        paraHtml(sourceInner(t.source, ctx, "table.source"), t.source.format ?? rf.para, sourceParagraphCss(ctx, "table.source"), "st-source") +
        `</td></tr>`;
    }
  }

  const tableStyle = css(
    "border-collapse:collapse",
    "border-spacing:0",
    widthMm !== undefined ? `width:${n(widthMm)}mm` : "width:100%",
    fixed && "table-layout:fixed",
    indentTw ? `margin-left:${n(twToMm(indentTw))}mm` : undefined,
  );
  const thead = theadHtml
    ? repeat
      ? `<thead style="display:table-header-group">${theadHtml}</thead>`
      : `<tbody class="st-head-once">${theadHtml}</tbody>`
    : "";
  const tableEl = `<table class="st-table-grid" style="${escText(tableStyle)}">${colgroup}${thead}<tbody>${tbodyHtml}</tbody></table>`;

  const block = opts.block;
  const label = block ? artifactLabel(block, ctx, t.caption) : t.caption?.label ?? "";
  const cap = captionHtml(t.caption, label, ctx, "margin-bottom:2.2mm", rhythmBase);
  const f = t.format;
  const wrapStyle = css(
    f?.spacingBeforeTw !== undefined ? `margin-top:${n(f.spacingBeforeTw / 20)}pt` : opts.depth > 0 ? "margin-top:1mm" : undefined,
    f?.spacingAfterTw !== undefined ? `margin-bottom:${n(f.spacingAfterTw / 20)}pt` : undefined,
    f?.pageBreakBefore ? "break-before:page" : undefined,
  );
  const attrs =
    (block?.address ? attr("data-address", block.address) : "") +
    (block?.blockId ? attr("data-block-id", block.blockId) : "") +
    attr("data-block-type", t.type) +
    (t.preset ? attr("data-preset", t.preset) : "") +
    (label && opts.depth === 0 ? attr("data-label", label) : "") +
    (railReserved(ctx, block, opts.depth, layoutWidthTw ?? (widthMm !== undefined ? mmToTw(widthMm) : undefined)) ? attr("data-rail-reserve", "true") : "");
  const cls = opts.depth > 0 ? "st-table st-table-nested" : "st-table";
  return `<div class="${cls}"${attrs}${wrapStyle ? ` style="${escText(wrapStyle)}"` : ""}>${cap}${tableEl}${below}</div>`;
}

/**
 * C22b / GF-24 (R-75, opt-in): tabel tingkat atas selebar kolom teks atau lebih sempit membawa caption/SUMBER-bawah
 * selebar badan 128 mm bila kolom rel dicadangkan (predikat DOCX `apparatusReserveTw`: K2 + R-75 + unit interior +
 * lebar <= `grid.textColumnMm`). Lebar HTML tak tertulis (`width:100%`, bentang penuh) = tidak ditandai.
 */
function railReserved(ctx: RenderContext, block: NormBlock | undefined, depth: number, widthTw: number | undefined): boolean {
  if (depth !== 0 || !block || widthTw === undefined) return false;
  const kind = ctx.snapshot?.units?.find((u) => u.key === block.unitKey)?.kind;
  return apparatusReserveTw((k) => ctx.tpl?.params?.[k], kind, widthTw) !== undefined;
}

/** Renderer HtmlBlockRenderer untuk satu jenis tabel. */
export function renderTableBlock(block: NormBlock, ctx: RenderContext): string {
  const t = block.content as TableBlock | null;
  if (!t || typeof t !== "object" || !Array.isArray((t as TableBlock).rows)) {
    ctx.log({
      level: "error",
      message: `engine/html/tables: isi blok ${block.type} tidak berbentuk TableBlock`,
      code: "SCHEMA_INVALID",
      address: block.address ?? undefined,
    });
    return `<div class="st-table st-invalid"${attr("data-address", block.address ?? undefined)}></div>`;
  }
  // Swarm row 143a (C177 F143-1 (b), DT-10a): refuse a table whose unbreakable content cannot fit the full span.
  assertTableFits(t, ctx.tpl.params, { label: block.artifactLabel ?? ctx.snapshot?.numbering?.[block.blockId], address: block.address });
  return tableHtml(t, ctx, { depth: 0, block });
}
