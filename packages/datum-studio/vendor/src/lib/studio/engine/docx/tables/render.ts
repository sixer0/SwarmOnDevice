/**
 * Penyaji DOCX keluarga tabel (S17; I06, 01_specs.md §8.2).
 *
 * Satu blok tabel menjadi: paragraf caption (opsional, di atas, keepNext) ->
 * `w:tbl` -> paragraf SUMBER (hanya `sourcePlacement:"paragraphBelow"`).
 * Tata bahasa Tabel 5.1 (research/04 T038): hanya garis mendatar per sel (tanpa
 * border tingkat tabel, TP-01), kepala tanpa isian, pita kelompok, baris total
 * bergaris atas, kolom satuan, SUMBER + PROVENANS di baris terakhir bergabung
 * (KT-26) atau di bawah tabel. Setiap baris `cantSplit` (P5-13), baris kepala
 * terdepan `tblHeader` (P5-12). Sel bergabung (`gridSpan`, `vMerge`), border/
 * margin/shading per sel, dan tabel bersarang satu tingkat (N01/N02) didukung.
 *
 * Modul murni: tanpa I/O. Peringatan dikirim lewat `ctx.log` (dipersistenkan
 * layanan render S51); bentuk konten yang rusak dilempar `StudioEngineError`
 * `BY_CONSTRUCTION_FAILED` (G1 adalah 422 by-construction saat ingest).
 */
import type {
  Cell,
  ColumnSpec,
  DocxFragment,
  Inline,
  NormBlock,
  NormUnitKind,
  ParaFormat,
  ParamMap,
  ProvenanceMark,
  RenderContext,
  ResolvedTemplate,
  RoleKey,
  Row,
  Run,
  RunProps,
  Shading,
  SourceLine,
  TableBlock,
} from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import type { TableFamilyBlock } from "../../../contract/types/doc";
import { borderXml, facesInXml, paragraphXml, runsXml, shadingXml, sideBordersXml } from "./ooxml";
import { inlinePlain, rowSpan, shapeProblem } from "./model";
import { type ColumnRole, presetTokens, resolvePresetDefaults } from "./presets";
import {
  cellStyle,
  effectiveTemplate,
  isGlyphText,
  markGlyph,
  markGlyphRun,
  mdLite,
  pBool,
  pList,
  pNum,
  pObj,
  pStr,
  ruleBorder,
  roleFormat,
  type RowKind,
  totalRunTweak,
  unitRunTweak,
} from "./style";
import { gridMatrix } from "./guards";
import { hasPlainText, symbolGlyphProps } from "../blocks/semantic";
import { resolveTokenColor } from "../../tokens";
import { APPARATUS_TEXT, apparatusLabelRunText, apparatusLabelWords, artifactLabelText, provenanceMarkLabelText, type WrapperLang, wrapperLangOf } from "../../front/texts";
import { mmToTw, mmWidthsToTw, solveWidthsImpl, twToMm } from "./widths";
import { type ParaAdjust, apparatusParaAdjust } from "../blocks/apparatus";
import { baselineSnapTw, rowWrappedTw, snapUpTw } from "../blocks/rhythm";
import { assertTableFits, tableBreakRuns } from "../../table-fit";

/** Python `_NUM_RE` datum_docx.py: kolom angka bila >= 70 % sel badan cocok. */
const NUM_RE = /^[\d.,%±\s-]+\s*(%|x|mm|m|kVA|kW|Hz)?$/;

export interface TableRenderOptions {
  /** Alamat blok untuk log. */
  address?: string | null;
  /** Label hasil penomoran ("Tabel 3.1"). */
  artifactLabel?: string;
  /** Lebar total paksa (twip), dipakai tabel bersarang. */
  totalTw?: number;
  /** Kedalaman sarang (0 = tingkat atas). */
  depth?: number;
}

interface Env {
  tpl: ResolvedTemplate;
  ctx: RenderContext;
  address: string | null;
  depth: number;
  /** Jenis unit pemilik blok (opt-in ronde cakupan C20); absen untuk tabel tanpa NormBlock. */
  unitKind?: NormUnitKind;
}

/** C19 (R-74): garis dasar (twip) untuk tabel tingkat atas bila opt-in aktif; tabel bersarang tidak diubah. */
function rhythmBaseTw(env: Env): number | undefined {
  return env.depth === 0 ? baselineSnapTw((k) => env.tpl.params[k]) : undefined;
}

/**
 * Apparatus tabel tingkat atas (opt-in ronde cakupan; mati = undefined, byte sekarang):
 * C20 (R-75) caption dan SUMBER-bawah tabel selebar kolom teks atau lebih sempit ikut badan
 * 128 mm bila kolom rel dicadangkan, tabel bentang penuh membawa apparatusnya selebar tabel;
 * C19 (R-74) jarak apparatus dikunci ke garis dasar; leading caption/SUMBER tetap (GF-21 (a), `snapApparatusPara`).
 */
function apparatusAdjust(env: Env, totalTw: number): ParaAdjust | undefined {
  return env.depth === 0 ? apparatusParaAdjust((k) => env.tpl.params[k], env.unitKind, totalTw) : undefined;
}

interface ColumnInfo {
  spec: ColumnSpec;
  role: ColumnRole;
  align: NonNullable<ColumnSpec["align"]>;
}

function warn(env: Env, message: string): void {
  env.ctx.log({ level: "warn", message: `[docx/tables] ${message}`, ...(env.address ? { address: env.address } : {}) });
}

// ── Kolom ────────────────────────────────────────────────────────────────

function inferNumeric(b: TableBlock, ci: number): boolean {
  const vals: string[] = [];
  for (const row of b.rows) {
    if (row.kind && row.kind !== "body") continue;
    let c = 0;
    for (const cell of row.cells) {
      const span = Math.max(1, cell.gridSpan ?? 1);
      if (c === ci && span === 1) {
        vals.push(cell.text ?? (cell.runs ? cell.runs.map((r) => ("t" in r ? r.t : "")).join("") : cell.paragraphs ? cell.paragraphs.map((p) => inlinePlain(p)).join(" ") : ""));
      }
      c += span;
    }
  }
  if (vals.length === 0) return false;
  const num = vals.filter((v) => NUM_RE.test(v)).length;
  return num >= Math.max(1, Math.floor(0.7 * vals.length));
}

function resolveColumns(b: TableBlock, env: Env, presetRoles: readonly (ColumnRole | undefined)[] | undefined): ColumnInfo[] {
  const numeralAlign = pStr(env.tpl.params, "table.numeral.align") === "right" ? "right" : "decimal";
  return b.columns.map((spec, ci) => {
    let role = spec.role ?? presetRoles?.[ci];
    let inferred = false;
    if (!role) {
      if (inferNumeric(b, ci)) {
        role = "numeral";
        inferred = true;
      } else {
        role = "text";
      }
    }
    // Python: kolom angka hasil inferensi = mono rata kanan.
    const align = spec.align ?? (role === "numeral" ? (inferred ? "right" : numeralAlign) : "left");
    return { spec, role, align };
  });
}

/** `render.table.layout.widthTw` templat (lebar tabel bawaan, twip) atau undefined. */
function templateWidthTw(p: ParamMap): number | undefined {
  const w = pObj(p, "render.table.layout")?.widthTw;
  return typeof w === "number" && Number.isFinite(w) && w > 0 ? Math.round(w) : undefined;
}

/**
 * Lebar kolom twip + lebar total (twip).
 *
 * Lebar total: paksa (sarang) > `layout.widthTw` blok > `render.table.layout.widthTw`
 * templat (hanya tingkat atas) > jumlah lebar eksplisit / `table.columnWidthSumMm`.
 * Bila semua kolom eksplisit, lebar templat hanya dipakai kalau jumlah kolom
 * berada di bawahnya sebesar sisa pembulatan per kolom (<= jumlah kolom twip;
 * BM: tblW 9412, jumlah kolom 9409..9412); tabel yang sengaja lebih sempit atau
 * lebih lebar memakai jumlah kolomnya.
 */
/** P5-14 `table.columnWidthSumMm` turunan (A4 128 mm); absen = BY_CONSTRUCTION_FAILED (D-245 H1, tanpa cadangan literal). */
function columnWidthSumMm(p: ParamMap): number {
  const v = p["table.columnWidthSumMm"];
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "Lebar tabel tidak terbaca: table.columnWidthSumMm wajib ada di parameter templat", {
    key: "table.columnWidthSumMm",
  });
}

function resolveWidths(b: TableBlock, env: Env, forcedTotalTw?: number): { grid: number[]; totalTw: number } {
  const p = env.tpl.params;
  const given = b.columns.map((c) => (c.widthTw !== undefined ? Math.round(c.widthTw) : c.widthMm !== undefined ? mmToTw(c.widthMm) : undefined));
  const explicitSum = given.reduce<number>((s, g) => s + (g ?? 0), 0);
  const allGiven = given.every((g) => g !== undefined);
  let totalTw = forcedTotalTw ?? (b.layout?.widthTw !== undefined ? Math.round(b.layout.widthTw) : undefined);
  if (totalTw === undefined) {
    const tplTw = env.depth === 0 ? templateWidthTw(p) : undefined;
    if (allGiven) totalTw = tplTw !== undefined && explicitSum <= tplTw && tplTw - explicitSum <= given.length ? tplTw : explicitSum;
    else totalTw = tplTw ?? mmToTw(columnWidthSumMm(p));
  }
  if (allGiven) {
    if (forcedTotalTw !== undefined && explicitSum !== forcedTotalTw && explicitSum > 0) {
      // Tabel bersarang: skala proporsional ke lebar sel induk.
      const mm = (given as number[]).map((g) => twToMm((g * forcedTotalTw) / explicitSum));
      return { grid: mmWidthsToTw(mm, forcedTotalTw), totalTw: forcedTotalTw };
    }
    return { grid: given as number[], totalTw };
  }
  const missing = given.map((g, i) => (g === undefined ? i : -1)).filter((i) => i >= 0);
  const rem = totalTw - explicitSum;
  const grid = given.map((g) => g ?? 0);
  if (rem <= missing.length) {
    warn(env, `lebar eksplisit (${explicitSum} tw) menghabiskan lebar tabel (${totalTw} tw); kolom tanpa lebar dibagi rata minimum`);
    for (const i of missing) grid[i] = Math.max(1, Math.floor(Math.max(rem, missing.length) / missing.length));
    return { grid, totalTw: grid.reduce((s, w) => s + w, 0) };
  }
  const matrix = gridMatrix(b).map((r) => missing.map((i) => r[i]));
  const numeralsPt = pNum(p, "type.scale.tableNumerals.size", 7.8);
  const solvedMm = solveWidthsImpl(matrix, twToMm(rem), numeralsPt);
  const solvedTw = mmWidthsToTw(solvedMm, rem);
  missing.forEach((ci, k) => (grid[ci] = solvedTw[k]));
  return { grid, totalTw };
}

// ── Tingkat tabel ────────────────────────────────────────────────────────

const NONE_SIDES = ["top", "left", "bottom", "right", "insideH", "insideV"] as const;

function tblPrXml(b: TableBlock, env: Env, totalTw: number): string {
  const lay = pObj(env.tpl.params, "render.table.layout") ?? {};
  const fixed = b.layout?.fixed ?? (typeof lay.fixed === "boolean" ? lay.fixed : true);
  const indent = b.layout?.indentTw ?? (typeof lay.indentTw === "number" ? lay.indentTw : 0);
  const layMar = lay.cellMarginTw && typeof lay.cellMarginTw === "object" && !Array.isArray(lay.cellMarginTw) ? (lay.cellMarginTw as Record<string, unknown>) : {};
  const marL = b.layout?.cellMarginTw?.left ?? (typeof layMar.left === "number" ? layMar.left : 0);
  const marR = b.layout?.cellMarginTw?.right ?? (typeof layMar.right === "number" ? layMar.right : 0);
  let borders = "";
  if (b.layout?.borders) {
    const bb = b.layout.borders;
    // Sisi yang tidak dinyatakan = none (tanpa border tingkat tabel, TP-01).
    borders = NONE_SIDES.map((s) => borderXml(s, bb[s] ?? { val: "none", sz: 0, color: "auto" })).join("");
  } else {
    borders = NONE_SIDES.map((s) => borderXml(s, { val: "none", sz: 0, color: "auto" })).join("");
  }
  return (
    `<w:tblPr><w:tblW w:w="${Math.round(totalTw)}" w:type="dxa"/>` +
    `<w:tblInd w:w="${Math.round(indent)}" w:type="dxa"/>` +
    `<w:tblBorders>${borders}</w:tblBorders>` +
    (fixed ? `<w:tblLayout w:type="fixed"/>` : `<w:tblLayout w:type="autofit"/>`) +
    `<w:tblCellMar><w:left w:w="${Math.round(marL)}" w:type="dxa"/><w:right w:w="${Math.round(marR)}" w:type="dxa"/></w:tblCellMar>` +
    `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>`
  );
}

// ── Sel ──────────────────────────────────────────────────────────────────

function rowKindOf(r: Row): Exclude<RowKind, "source"> {
  return r.kind ?? "body";
}

function cellRole(kind: RowKind, col: ColumnInfo, cell: Cell, plain: string): RoleKey {
  if (kind === "header") return col.align === "right" || col.align === "decimal" ? "table.headerRight" : "table.headerLeft";
  if (kind === "group") return "table.groupBand";
  if (kind === "source") return "table.source";
  if (col.role === "glyph" || (cell.runs === undefined && isGlyphText(plain))) return "table.cellGlyph";
  if (col.role === "numeral" || col.role === "id") {
    return col.align === "left" ? "table.cellMono" : "table.cellNumeralRight";
  }
  return "table.cellText";
}

function jcFor(kind: RowKind, col: ColumnInfo): ParaFormat["jc"] | undefined {
  if (kind === "group" || kind === "source") return undefined;
  if (col.align === "right" || col.align === "decimal") return "right";
  if (col.align === "center") return "center";
  // Rata kiri = bawaan; jc=left eksplisit (KT-23) datang dari format paragraf sel bila ada (KT-07 tanpa jc).
  return undefined;
}

function inlineRuns(i: Inline): Run[] {
  return "text" in i ? mdLite(i.text) : i.runs;
}

/**
 * R-37 asli: glif simbol sebaris (`faceRole: "symbolGlyph"` tanpa `face`) di
 * paragraf yang juga memuat teks lain mendapat `render.run.symbolGlyphByRole[role]`
 * templat; properti run sendiri menang, `face` hasil gabungan menggantikan
 * `faceRole` (face XOR faceRole). Run ber-`face` eksplisit tidak disentuh.
 */
function symbolRuns(runs: Run[], params: ParamMap, role: RoleKey): Run[] {
  const symbol = symbolGlyphProps(params, role);
  if (!symbol || !hasPlainText(runs)) return runs;
  return runs.map((r) => {
    if (!("t" in r) || r.face || r.faceRole !== "symbolGlyph") return r;
    const q = { ...symbol, ...r } as Run & { faceRole?: string };
    if (!q.face) return q;
    const { faceRole: _f, ...rest } = q;
    void _f;
    return rest as Run;
  });
}

/** Teks label sumber yang dibawa run konten ("SUMBER  ", "   PROVENANS "); kata dari tabel teks aparatus (L4). */
const SOURCE_LABEL_RE = new RegExp(`^\\s*(${apparatusLabelWords(["source", "provenance"]).join("|")})\\s*$`);

/**
 * Run label sumber dari dokumen (Inline.runs, C1) mendapat `labelRun` peran
 * (mis. spacingTw 12) di bawah properti run itu sendiri; run ber-`face`
 * eksplisit (dokumen verbatim) tidak disentuh.
 */
function labelRuns(runs: Run[], label: RunProps | undefined, lang: WrapperLang): Run[] {
  if (!label && lang === "ID") return runs;
  return runs.map((r) => {
    if (!("t" in r) || r.face || !SOURCE_LABEL_RE.test(r.t)) return r;
    // S13/F-2: penanda label ID ("SUMBER  ") tampil berbahasa dokumen; dokumen ID byte-sama.
    const shown = lang === "ID" ? r : ({ ...r, t: apparatusLabelRunText(r.t, lang) } as Run);
    return label ? ({ ...label, ...shown } as Run) : shown;
  });
}

/** Bahasa label aparatus tabel = bahasa dokumen (S13/F-2). */
function langOf(env: Env): WrapperLang {
  return wrapperLangOf(env.ctx?.snapshot?.doc?.meta);
}

interface CellParts {
  paragraphs: Array<{ runs: Run[] | null; format?: ParaFormat }>;
}

/** Paragraf isi sel; `runs: null` = `<w:p/>` tanpa pPr (KT-19). */
function cellParts(cell: Cell): CellParts {
  if (cell.paragraphs !== undefined) {
    if (cell.paragraphs.length === 0) return { paragraphs: [{ runs: null }] };
    return { paragraphs: cell.paragraphs.map((p) => ({ runs: inlineRuns(p), format: p.format })) };
  }
  if (cell.runs !== undefined) return { paragraphs: [{ runs: cell.runs }] };
  if (cell.text !== undefined) return { paragraphs: [{ runs: mdLite(cell.text) }] };
  return { paragraphs: [{ runs: null }] };
}

interface RowCtx {
  kind: RowKind;
  zebra?: Shading;
  catalogHeaderVAlign?: Cell["vAlign"];
}

function tcXml(env: Env, b: TableFamilyBlock, cell: Cell, cols: ColumnInfo[], grid: number[], startCol: number, rc: RowCtx): string {
  const span = Math.max(1, cell.gridSpan ?? 1);
  const col = cols[Math.min(startCol, cols.length - 1)];
  let width = 0;
  for (let j = startCol; j < Math.min(grid.length, startCol + span); j++) width += grid[j];
  if (cell.widthTw !== undefined) width = Math.round(cell.widthTw);

  const parts = cellParts(cell);
  const plain = parts.paragraphs.map((p) => (p.runs ? p.runs.map((r) => ("t" in r ? r.t : "")).join("") : "")).join(" ");
  const role = cellRole(rc.kind, col, cell, plain);
  const st = cellStyle(env.tpl, role, rc.kind);

  // Run dasar.
  let base: RunProps = { ...st.run };
  const numeric = col.role === "numeral" || col.role === "id";
  if (rc.kind === "body" || rc.kind === "total") {
    if (col.role === "unit" && !st.measured) base = { ...base, ...unitRunTweak(env.tpl) };
    if (b.runDefaults) base = { ...base, ...b.runDefaults };
    if (rc.kind === "total") base = { ...base, ...totalRunTweak(env.tpl, numeric) };
  }
  if (base.face && base.faceRole) delete base.faceRole;

  // Paragraf.
  const jc = jcFor(rc.kind, col);
  const paraBase: ParaFormat = { ...st.para, ...(jc ? { jc } : {}) };
  let inner = "";
  const breakable = !(span === 1 && (col.role === "numeral" || col.role === "unit" || col.role === "id"));
  for (const p of parts.paragraphs) {
    if (p.runs === null) {
      inner += "<w:p/>";
      continue;
    }
    // Swarm 1.2.7 row 40 (N-11, C12 O-6): U+200B (Word's no-width optional break) after each separator of a long ID
    // list joined without spaces, the breaks DT-10a counts (table-fit.ts); never in numeral / unit / id columns.
    const runs = symbolRuns(p.runs, env.tpl.params, role);
    const broken = breakable ? tableBreakRuns(runs, "\u200B") : null;
    inner += paragraphXml({ ...paraBase, ...(p.format ?? {}) }, runsXml(broken ?? runs, base, env.tpl.params));
  }
  if (cell.nested) {
    if (env.depth >= 1) {
      warn(env, "tabel bersarang lebih dari satu tingkat diabaikan (kedalaman maks 1)");
    } else {
      const margins = cell.marginsTw ?? st.margins;
      const nestedTw = Math.max(1, width - (margins.left ?? 0) - (margins.right ?? 0));
      const nb = cell.nested as TableFamilyBlock;
      const nestedWidth = nb.layout?.widthTw ?? (nb.columns.every((c) => c.widthTw !== undefined || c.widthMm !== undefined) ? undefined : nestedTw);
      inner += tableXmlParts(nb, { ...env, depth: env.depth + 1 }, { totalTw: nestedWidth }).join("");
      // OOXML: sel wajib diakhiri paragraf; paragraf penutup setelah tabel bersarang (KT-19).
      inner += "<w:p/>";
    }
  }
  if (!inner) inner = "<w:p/>";

  // tcPr (urutan CT_TcPr).
  let pr = `<w:tcW w:w="${Math.round(width)}" w:type="dxa"/>`;
  if (span > 1) pr += `<w:gridSpan w:val="${span}"/>`;
  if (cell.vMerge === "restart") pr += `<w:vMerge w:val="restart"/>`;
  else if (cell.vMerge === "continue") pr += `<w:vMerge/>`;
  const borders = cell.borders ?? st.borders;
  const bx = sideBordersXml(borders);
  if (bx) pr += `<w:tcBorders>${bx}</w:tcBorders>`;
  const shd = cell.shading ?? st.shading ?? (rc.kind === "body" ? rc.zebra : undefined);
  pr += shadingXml(shd);
  const m = cell.marginsTw ?? st.margins;
  const mx = (["top", "left", "bottom", "right"] as const)
    .filter((k) => m[k] !== undefined)
    .map((k) => `<w:${k} w:w="${Math.round(m[k] as number)}" w:type="dxa"/>`)
    .join("");
  if (mx) pr += `<w:tcMar>${mx}</w:tcMar>`;
  const vAlign = cell.vAlign ?? (rc.kind === "header" && !st.measured ? rc.catalogHeaderVAlign : undefined);
  if (vAlign) pr += `<w:vAlign w:val="${vAlign}"/>`;
  return `<w:tc><w:tcPr>${pr}</w:tcPr>${inner}</w:tc>`;
}

// ── SUMBER + PROVENANS ───────────────────────────────────────────────────

function sourceRuns(env: Env, src: SourceLine, label: RunProps | undefined, main: RunProps, glyphRun: ReturnType<typeof roleFormat>["glyphRun"]): Run[] {
  // C1 (D-44): Inline.runs lengkap tanpa label/prefiks tambahan; hanya peran label
  // (labelRun) dan glif simbol (R-37) yang diikat ke templat.
  const lang = langOf(env);
  if ("runs" in src.inline) return symbolRuns(labelRuns(src.inline.runs, label, lang), env.tpl.params, "table.source");
  const plain = inlinePlain(src.inline).trimStart();
  const out: Run[] = [];
  const word = (k: "source" | "provenance", l: WrapperLang) => APPARATUS_TEXT[k][l].toUpperCase();
  const known = (k: "source" | "provenance") => (lang === "ID" ? word(k, "ID") : `(?:${word(k, "ID")}|${word(k, lang)})`);
  if (!new RegExp(`^${known("source")}\\b`).test(plain)) {
    out.push({ t: word("source", lang), ...(label ?? {}) });
    out.push({ t: " " });
  }
  out.push(...inlineRuns(src.inline));
  const marks = src.provenance ?? [];
  if (marks.length > 0 && !new RegExp(`\\b${known("provenance")}\\b`).test(plain)) {
    const pv = word("provenance", lang);
    out.push({ t: plain.length > 0 && !/[.\s]$/.test(plain) ? `. ${pv} ` : ` ${pv} ` });
    marks.forEach((mk: ProvenanceMark, i) => {
      if (i > 0) out.push({ t: ", " });
      const g = markGlyphRun(env.tpl, mk, glyphRun);
      out.push({ t: markGlyph(env.tpl, mk), ...(main.szHalfPt !== undefined && g.szHalfPt === undefined ? { szHalfPt: main.szHalfPt } : {}), ...g });
      out.push({ t: ` ${provenanceMarkLabelText(mk, lang)}` });
    });
  }
  return out;
}

function sourceRowXml(env: Env, src: SourceLine, totalTw: number, ncols: number, rowHeight: (tcs: string) => string = () => ""): string {
  const st = cellStyle(env.tpl, "table.source", "source");
  const runs = sourceRuns(env, src, st.labelRun, st.run, st.glyphRun);
  const p = paragraphXml({ ...st.para, ...(src.format ?? {}) }, runsXml(runs, st.run, env.tpl.params));
  let pr = `<w:tcW w:w="${Math.round(totalTw)}" w:type="dxa"/>`;
  if (ncols > 1) pr += `<w:gridSpan w:val="${ncols}"/>`;
  const bx = sideBordersXml(st.borders);
  if (bx) pr += `<w:tcBorders>${bx}</w:tcBorders>`;
  pr += shadingXml(st.shading);
  const m = st.margins;
  const mx = (["top", "left", "bottom", "right"] as const)
    .filter((k) => m[k] !== undefined)
    .map((k) => `<w:${k} w:w="${Math.round(m[k] as number)}" w:type="dxa"/>`)
    .join("");
  if (mx) pr += `<w:tcMar>${mx}</w:tcMar>`;
  const cant = !pBool(env.tpl.params, "table.row.splitAcrossPages", false);
  const tc = `<w:tc><w:tcPr>${pr}</w:tcPr>${p}</w:tc>`;
  const trPr = (cant ? "<w:cantSplit/>" : "") + rowHeight(tc);
  return `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ""}${tc}</w:tr>`;
}

/** SUMBER sebagai paragraf di bawah tabel, garis rambut di atas (pola K-34). */
function sourceParagraphXml(env: Env, src: SourceLine, adjust?: ParaAdjust): string {
  const st = cellStyle(env.tpl, "table.source", "source");
  const runs = sourceRuns(env, src, st.labelRun, st.run, st.glyphRun);
  const fmt: ParaFormat = { ...st.para, borders: { top: ruleBorder(env.tpl, "hair", 1) }, ...(src.format ?? {}) };
  return paragraphXml(adjust ? adjust(fmt) : fmt, runsXml(runs, st.run, env.tpl.params));
}

// ── Caption ──────────────────────────────────────────────────────────────

function captionXml(env: Env, b: TableFamilyBlock, artifactLabel: string | undefined, adjust?: ParaAdjust): string {
  const cap = b.caption;
  if (!cap) return "";
  const rf = roleFormat(env.tpl, "caption");
  const measured = env.tpl.roleFormats.caption !== undefined;
  const main: RunProps = { ...(rf.run ?? {}) };
  // K-29: label caption Cond kapital tebal; katalog hanya memberi condensedCaps.
  // Row 122 (C40 FIX CP-28, DT-15 ID p.41 "Label caption selalu kapital tebal dengan nomor"): bold capitals always,
  // whatever the template role or the content's labelProps say (before: a measured role without labelRun printed the
  // label in the sentence weight).
  const label: RunProps = { ...(rf.labelRun ?? rf.run ?? {}), ...(measured ? {} : { b: true }), ...(cap.labelProps ?? {}), b: true, caps: true };
  if (cap.label && artifactLabel && cap.label !== artifactLabel) {
    warn(env, `caption.label "${cap.label}" berbeda dari hasil penomoran "${artifactLabel}"; penomoran dipakai`);
  }
  // D-3: tampilan label berbahasa dokumen; alamat/penomoran tetap ("Tabel n.m").
  const lang = langOf(env);
  const text = artifactLabelText(artifactLabel ?? cap.label ?? APPARATUS_TEXT.table.ID, lang);
  const sep = cap.separator ?? pStr(env.tpl.params, "render.caption.separator") ?? " ";
  // K-29 pola run "RS19 RS20": pemisah ikut run label (berprops label); tab = w:tab berprops label.
  const runs: Run[] = [];
  for (const [i, chunk] of sep.split("\t").entries()) {
    if (i > 0) runs.push({ tab: true, ...label });
    const t = i === 0 ? text + chunk : chunk;
    if (t) runs.push({ t, ...label });
  }
  runs.push(...symbolRuns(inlineRuns(cap.inline), env.tpl.params, "caption"));
  // K-29: sp[b120 a48 l220x] keepNext.
  const fmt: ParaFormat = {
    spacingBeforeTw: 120,
    spacingAfterTw: 48,
    keepNext: true,
    ...(rf.para ?? {}),
    ...(b.format ?? {}),
    ...(cap.format ?? {}),
  };
  return paragraphXml(adjust ? adjust(fmt) : fmt, runsXml(runs, main, env.tpl.params));
}

// ── Tabel ────────────────────────────────────────────────────────────────

function headerFromParam(env: Env, key: string | undefined, ncols: number): Row | undefined {
  if (!key) return undefined;
  const list = pList(env.tpl.params, key);
  if (!list || list.length !== ncols || !list.every((x) => typeof x === "string")) return undefined;
  return { kind: "header", cells: (list as string[]).map((t) => ({ runs: [{ t }] })) };
}

function zebraShading(env: Env, tokens: string[], zebraParam: string | undefined, bodyRows: number): Shading | undefined {
  if (!tokens.includes("zebra")) return undefined;
  const p = env.tpl.params;
  if (zebraParam && !pBool(p, zebraParam, false)) {
    warn(env, "zebra diabaikan: BoQ cetak tidak pernah ber-zebra (P5-09)");
    return undefined;
  }
  const minRows = pNum(p, "table.zebra.minRows", 12);
  if (bodyRows <= minRows) {
    warn(env, `zebra diabaikan: ${bodyRows} baris badan, zebra hanya di atas ${minRows} baris (P5-07)`);
    return undefined;
  }
  const ref = pStr(p, "table.zebra.colour") ?? "zebra15";
  const fill = resolveTokenColor(env.tpl, ref) ?? resolveTokenColor(env.tpl, "zebra15");
  if (!fill) {
    warn(env, `zebra diabaikan: tokenRef "${ref}" tidak terselesaikan`);
    return undefined;
  }
  return { fill, val: "clear" };
}

/** `render.table.columnProfiles` templat (R-52, D-166 KC-6): presetName -> { colsTw }. */
function columnProfilesOf(env: Env): Record<string, unknown> {
  return pObj(env.tpl.params, "render.table.columnProfiles") ?? {};
}

/** Nama preset yang punya profil lebar kolom; preset utuh berprofil = semua tokennya sah (compose mencocokkan string utuh). */
function profileNamesFor(profiles: Record<string, unknown>, preset: string | undefined): Set<string> {
  const names = new Set(Object.keys(profiles));
  if (preset !== undefined && Object.hasOwn(profiles, preset)) for (const t of presetTokens(preset)) names.add(t);
  return names;
}

/**
 * FIX-T: profil lebar diterapkan compose (`columnProfile`) hanya bila jumlah kolom
 * sama; bila profil ada tetapi tabel tiba tanpa lebar lengkap karena jumlah kolom
 * beda, laporkan (lebar jatuh ke solver otomatis) agar templat dapat dibetulkan.
 */
function checkProfileApplied(env: Env, b: TableFamilyBlock, profiles: Record<string, unknown>): void {
  if (b.preset === undefined || !Object.hasOwn(profiles, b.preset)) return;
  if (b.columns.every((c) => c.widthTw !== undefined || c.widthMm !== undefined)) return;
  const prof = profiles[b.preset];
  const cols = prof && typeof prof === "object" && !Array.isArray(prof) ? (prof as { colsTw?: unknown }).colsTw : undefined;
  const n = Array.isArray(cols) ? cols.length : 0;
  warn(env, `profil lebar kolom preset "${b.preset}" (${n} kolom) tidak cocok dengan tabel ${b.columns.length} kolom; lebar otomatis`);
}

/**
 * Potongan XML tabel: [caption?, tbl, sumberBawah?]. Dipakai juga untuk tabel
 * bersarang (`depth` 1) dan oleh modul lain yang memakai tata bahasa tabel.
 */
export function tableXmlParts(b: TableFamilyBlock, env: Env, opts: { totalTw?: number; artifactLabel?: string } = {}): string[] {
  const problem = shapeProblem(b);
  if (problem) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Tabel tidak sah: ${problem}`, { address: env.address });
  }
  const ncols = b.columns.length;
  b.rows.forEach((row, ri) => {
    const span = rowSpan(row);
    if (span !== ncols) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `GUARD-G1: baris ${ri + 1} memuat ${span} sel, kolom ${ncols}`, {
        address: env.address,
        pointer: `/rows/${ri}/cells`,
      });
    }
  });

  const profiles = columnProfilesOf(env);
  const { defaults, tokens, unknown } = resolvePresetDefaults(b.type, b.preset, profileNamesFor(profiles, b.preset));
  if (unknown.length > 0) warn(env, `preset tidak dikenal untuk ${b.type}: ${unknown.join(", ")}`);
  checkProfileApplied(env, b, profiles);

  let rows: Row[] = b.rows;
  if (!rows.some((r) => r.kind === "header")) {
    const hdr = headerFromParam(env, defaults.headerParam, ncols);
    if (hdr) rows = [hdr, ...rows];
  }
  // AHS: baris berformula (D, F di `ahs.rows`, P6-19) bergaya total bila kind tidak dinyatakan.
  if (tokens.includes("ahs")) {
    const formulaRows = new Set(
      (pList(env.tpl.params, "ahs.rows") ?? [])
        .filter((x): x is Record<string, string> => !!x && typeof x === "object" && !Array.isArray(x) && "formula" in x)
        .map((x) => String(x.row)),
    );
    rows = rows.map((r) => {
      if (r.kind) return r;
      const first = r.cells[0];
      const t = first ? (first.text ?? (first.runs ? first.runs.map((x) => ("t" in x ? x.t : "")).join("") : "")).trim() : "";
      return formulaRows.has(t) ? { ...r, kind: "total" as const } : r;
    });
  }
  const effBlock: TableFamilyBlock = { ...b, rows };
  const cols = resolveColumns(effBlock, env, defaults.roles);
  const { grid, totalTw } = resolveWidths(effBlock, env, opts.totalTw);

  const p = env.tpl.params;
  const cantDefault = !pBool(p, "table.row.splitAcrossPages", false);
  const repeatDefault = pBool(p, "table.header.repeatEachPage", true);
  const headerVAlignParam = pStr(p, "table.header.verticalAlign");
  const catalogHeaderVAlign = headerVAlignParam === "top" || headerVAlignParam === "center" || headerVAlignParam === "bottom" ? headerVAlignParam : undefined;
  const bodyCount = rows.filter((r) => rowKindOf(r) === "body").length;
  const zebra = zebraShading(env, tokens, defaults.zebraParam, bodyCount);

  const rhythmBase = rhythmBaseTw(env);
  /** C19 / GF-21 (b): `w:trHeight atLeast` kelipatan garis dasar dari perkiraan baris teks terbungkus (opt-in). */
  const rowHeight = (tcs: string): string =>
    rhythmBase === undefined ? "" : `<w:trHeight w:val="${snapUpTw(rowWrappedTw(tcs, rhythmBase), rhythmBase)}" w:hRule="atLeast"/>`;
  let trs = "";
  let leadingHeader = true;
  let bodyIdx = 0;
  // Row 122 (C40 FIX CP-51, Manual Rev A ID p.80 Tabel 13.1 cek 33, p.52): the caption (keepNext), the leading
  // header rows and the first body row stay on one page, so a heading or caption is never stranded at a page foot
  // above a table that starts on the next page. Rows after the first body row may break (cantSplit per row as before).
  let keepRows = env.depth === 0;
  for (const row of rows) {
    const kind = rowKindOf(row);
    if (kind !== "header") leadingHeader = false;
    const cant = row.cantSplit ?? cantDefault;
    // tblHeader hanya sah untuk baris kepala terdepan yang berurutan.
    const repeat = leadingHeader && kind === "header" && (row.repeatHeader ?? repeatDefault);
    if (row.repeatHeader && !leadingHeader) warn(env, "repeatHeader diabaikan pada baris yang bukan kepala terdepan");
    let trPr = "";
    if (cant) trPr += "<w:cantSplit/>";
    const rowZebra = kind === "body" && zebra && bodyIdx++ % 2 === 1 ? zebra : undefined;
    let tcs = "";
    let ci = 0;
    for (const cell of row.cells) {
      tcs += tcXml(env, effBlock, cell, cols, grid, ci, { kind, zebra: rowZebra, catalogHeaderVAlign });
      ci += Math.max(1, cell.gridSpan ?? 1);
    }
    // CT_TrPrBase (urutan Word): cantSplit, trHeight, tblHeader.
    trPr += rowHeight(tcs);
    if (repeat) trPr += "<w:tblHeader/>";
    if (keepRows) {
      tcs = keepNextParagraphs(tcs);
      if (kind !== "header") keepRows = false;
    }
    trs += `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ""}${tcs}</w:tr>`;
  }

  const placement = b.sourcePlacement ?? (pStr(p, "render.table.sourcePlacement") === "paragraphBelow" ? "paragraphBelow" : "lastRowMerged");
  if (b.source && placement === "lastRowMerged") trs += sourceRowXml(env, b.source, totalTw, ncols, rowHeight);
  if (!b.source && b.caption && env.depth === 0) warn(env, "tabel bercaption tanpa baris SUMBER (lint 10)");

  const tblGrid = `<w:tblGrid>${grid.map((w) => `<w:gridCol w:w="${Math.round(w)}"/>`).join("")}</w:tblGrid>`;
  const tbl = `<w:tbl>${tblPrXml(effBlock, env, totalTw)}${tblGrid}${trs}</w:tbl>`;

  const out: string[] = [];
  const adjust = apparatusAdjust(env, totalTw);
  const cap = captionXml(env, b, opts.artifactLabel, adjust);
  if (cap) out.push(cap);
  out.push(tbl);
  if (b.source && placement === "paragraphBelow") out.push(sourceParagraphXml(env, b.source, adjust));
  return out;
}

/**
 * Row 122 (CP-51): `w:keepNext` on every paragraph of one row's cells (CT_PPrBase order: after `w:pStyle`).
 * Paragraphs that already keep with next are unchanged.
 */
export function keepNextParagraphs(tcs: string): string {
  return tcs.replace(/<w:pPr>([\s\S]*?)<\/w:pPr>/g, (m: string, inner: string) => {
    if (/<w:keepNext\/>/.test(inner)) return m;
    const style = /^<w:pStyle\b[^>]*\/>/.exec(inner);
    return style ? `<w:pPr>${style[0]}<w:keepNext/>${inner.slice(style[0].length)}</w:pPr>` : `<w:pPr><w:keepNext/>${inner}</w:pPr>`;
  }).replace(/(<w:p(?:\s[^>]*[^/])?>)(?!<w:pPr>)/g, "$1<w:pPr><w:keepNext/></w:pPr>");
}

/** Penyaji `DocxBlockRenderer` untuk ke-11 jenis keluarga tabel. */
export function renderTableBlock(block: NormBlock, ctx: RenderContext): DocxFragment {
  const tpl = effectiveTemplate(ctx.tpl);
  const unitKind = ctx.snapshot?.units?.find((u) => u.key === block.unitKey)?.kind;
  const env: Env = { tpl, ctx, address: block.address, depth: 0, ...(unitKind ? { unitKind } : {}) };
  const content = block.content as TableFamilyBlock;
  const label = block.artifactLabel ?? ctx.snapshot?.numbering?.[block.blockId];
  // Swarm row 143a (C177 F143-1 (b), DT-10a): same full-span refusal as the HTML renderer.
  if (content && Array.isArray(content.columns) && Array.isArray(content.rows)) assertTableFits(content, tpl.params, { label, address: block.address });
  const xml = tableXmlParts(content, env, { artifactLabel: label }).join("");
  return { xml, facesUsed: facesInXml(xml) };
}

/** Untuk modul lain (perangkat/derivation): tabel tanpa NormBlock. */
export function renderTableXml(b: TableBlock, ctx: RenderContext, opts: TableRenderOptions = {}): DocxFragment {
  const tpl = effectiveTemplate(ctx.tpl);
  const env: Env = { tpl, ctx, address: opts.address ?? null, depth: opts.depth ?? 0 };
  const xml = tableXmlParts(b as TableFamilyBlock, env, { totalTw: opts.totalTw, artifactLabel: opts.artifactLabel }).join("");
  return { xml, facesUsed: facesInXml(xml) };
}

