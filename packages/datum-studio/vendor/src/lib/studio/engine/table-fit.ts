/**
 * Swarm patch (row 143a, decision C177 F143-1 (b); Manual Rev A ID p.51-52 DT-10a "Tidak ada unsur lebih lebar dari
 * 166 mm"): a table must fit the full span. The renderers wrap cell text (HTML: only single-column numeral / unit /
 * id cells stay on one line, html/tables/table.ts; DOCX: fixed column grid, docx/tables/render.ts), so a table can
 * only overflow when its UNBREAKABLE content alone is wider than the span. This module measures that lower bound and
 * refuses such a table with FIGURE_OVER_CAPACITY (figure "table", check DT-10a) and a concrete suggestion, instead of
 * letting the page clip it (row 143's case 01 Table 3.1 lost its last column at the right edge).
 *
 * The estimate is a LOWER bound, so a table that fits is never refused:
 * - single-column numeral / id cells (IBM Plex Mono, advance exactly 0.6 em) at `type.scale.tableNumerals.size`;
 * - single-column unit cells and header cells of those columns (Plex Sans Condensed) at 0.42 em, the narrowest
 *   plausible average advance, plus the header letter spacing;
 * - every other cell: its longest word at 0.42 em (it wraps between words);
 * - 2.5 mm between columns (the HTML gap, html/tables/table.ts cellHtml); spanning cells are not counted.
 */
import type { Cell, ColumnSpec, ParamMap, Row, TableBlock } from "../contract";
import { okWidthsMm } from "./docx/tables/widths";
import { TableOverCapacity } from "./figure-capacity";

/** Manual Rev A check id of the full-span rule (ID p.51, DT-10a). */
export const TABLE_FIT_CHECK_ID = "DT-10a";
const MM_PER_PT = 25.4 / 72;
const MONO_EM = 0.6;
const PROP_EM_MIN = 0.42;
const HEADER_PT = 7;
const HEADER_SPACING_PT = 0.6;
const UNIT_PT = 7;
const TEXT_PT = 7.5;
const COLUMN_GAP_MM = 2.5;
const FALLBACK_SPAN_MM = 166;

function num(p: ParamMap, key: string, dflt: number): number {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt;
}

/** Visible text of a cell: `text`, `runs[].t`, or its paragraphs (one string per paragraph). */
export function cellTexts(c: Cell): string[] {
  const runText = (runs: readonly unknown[]): string =>
    runs.map((r) => (r && typeof r === "object" && typeof (r as { t?: unknown }).t === "string" ? (r as { t: string }).t : " ")).join("");
  if (Array.isArray(c.paragraphs)) {
    return c.paragraphs.map((p) => {
      const o = p as { text?: unknown; runs?: unknown };
      return typeof o.text === "string" ? o.text : Array.isArray(o.runs) ? runText(o.runs) : "";
    });
  }
  if (typeof c.text === "string") return [c.text];
  if (Array.isArray(c.runs)) return [runText(c.runs)];
  return [];
}

const cps = (s: string): number => Array.from(s).length;

/**
 * Swarm 1.2.7 row 40 (N-11, C12 O-6): an ID list joined without spaces (`R-01/R-02/.../R-12`) is not one unbreakable
 * word. A whitespace-free run longer than `TABLE_BREAK_MIN_CHARS` may break after each of `TABLE_BREAK_AFTER`; both
 * renderers make that break (HTML `<wbr>`, DOCX U+200B, Word's own no-width optional break), never inside an ID.
 */
export const TABLE_BREAK_AFTER: readonly string[] = [",", ";", "/"];
export const TABLE_BREAK_MIN_CHARS = 16;

/** Segments of a whitespace-free run: split after each separator (kept on the left) when the run is long, else whole. */
export function breakableSegments(word: string): string[] {
  const chars = Array.from(word);
  if (chars.length <= TABLE_BREAK_MIN_CHARS) return [word];
  const out: string[] = [];
  let cur = "";
  for (const ch of chars) {
    cur += ch;
    if (TABLE_BREAK_AFTER.includes(ch)) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The paragraph's runs with `mark` inserted at every break `breakableSegments` allows, words read across run
 * boundaries (a run without `t` is whitespace, as in `cellTexts`). Null when no break applies, so callers keep their
 * output byte-identical.
 */
export function tableBreakRuns<R extends object>(runs: readonly R[], mark: string): R[] | null {
  const texts = runs.map((r) => ("t" in r && typeof (r as { t?: unknown }).t === "string" ? (r as unknown as { t: string }).t : null));
  const joined = texts.map((t) => t ?? " ").join("");
  const at: number[] = [];
  for (const m of joined.matchAll(/\S+/g)) {
    const segs = breakableSegments(m[0]);
    let off = m.index ?? 0;
    for (let i = 0; i < segs.length - 1; i++) {
      off += segs[i].length;
      at.push(off);
    }
  }
  if (at.length === 0) return null;
  let start = 0;
  return runs.map((r, i) => {
    const t = texts[i];
    const len = t === null ? 1 : t.length;
    const end = start + len;
    let out = r;
    if (t !== null) {
      const cuts = at.filter((x) => x >= start && x < end).map((x) => x - start);
      if (cuts.length) {
        let s = "";
        let prev = 0;
        for (const c of cuts) {
          s += t.slice(prev, c) + mark;
          prev = c;
        }
        out = { ...r, t: s + t.slice(prev) };
      }
    }
    start = end;
    return out;
  });
}

const longestWord = (s: string): string =>
  s
    .split(/\s+/)
    .flatMap((w) => breakableSegments(w))
    .reduce((a, w) => (cps(w) > cps(a) ? w : a), "");

export interface TableMinWidth {
  /** Lower bound of the table width (mm). */
  minMm: number;
  /** Lower bound per grid column (mm), without the gaps. */
  columnsMm: number[];
  /** The cell that sets the widest column. */
  widest: { column: number; row: number; text: string; mm: number } | null;
}

/** Lower bound of the width the table needs (mm), from its unbreakable content. */
export function tableMinWidthMm(t: Pick<TableBlock, "columns" | "rows">, params: ParamMap): TableMinWidth {
  const cols: readonly ColumnSpec[] = Array.isArray(t.columns) ? t.columns : [];
  const rows: readonly Row[] = Array.isArray(t.rows) ? t.rows : [];
  const monoPt = num(params, "type.scale.tableNumerals.size", 7.8);
  const columnsMm = cols.map(() => 0);
  const at: Array<{ row: number; text: string } | null> = cols.map(() => null);
  rows.forEach((r, ri) => {
    let ci = 0;
    for (const cell of r.cells ?? []) {
      const gs = Math.max(1, Math.floor(cell.gridSpan ?? 1));
      if (gs === 1 && ci < cols.length && cell.vMerge !== "continue") {
        const role = cols[ci]?.role;
        const nowrap = role === "numeral" || role === "unit" || role === "id";
        for (const text of cellTexts(cell)) {
          let mm: number;
          let shown = text;
          if (nowrap && r.kind === "header") mm = cps(text) * (PROP_EM_MIN * HEADER_PT + HEADER_SPACING_PT) * MM_PER_PT;
          else if (nowrap && role === "unit") mm = cps(text) * PROP_EM_MIN * UNIT_PT * MM_PER_PT;
          else if (nowrap) mm = cps(text) * MONO_EM * monoPt * MM_PER_PT;
          else {
            shown = longestWord(text);
            mm = cps(shown) * PROP_EM_MIN * TEXT_PT * MM_PER_PT;
          }
          if (mm > columnsMm[ci]) {
            columnsMm[ci] = mm;
            at[ci] = { row: ri, text: shown };
          }
        }
      }
      ci += gs;
    }
  });
  const minMm = columnsMm.reduce((a, b) => a + b, 0) + COLUMN_GAP_MM * Math.max(0, cols.length - 1);
  let widest: TableMinWidth["widest"] = null;
  columnsMm.forEach((mm, ci) => {
    const a = at[ci];
    if (a && (!widest || mm > widest.mm)) widest = { column: ci, row: a.row, text: a.text, mm };
  });
  return { minMm, columnsMm, widest };
}

/** Widest span a table may take (mm): the largest allowed figure width, 166 mm on A4 (DT-10a). */
export function tableSpanLimitMm(params: ParamMap): number {
  const ok = okWidthsMm(params["grid.allowedFigureWidthsMm"]);
  return ok ? Math.max(...ok) : num(params, "grid.fullSpanMm", FALLBACK_SPAN_MM);
}

/**
 * Refuse (FIGURE_OVER_CAPACITY, figure "table") a top-level table whose unbreakable content cannot fit the span.
 * `label` / `address` only name the table in the message.
 */
export function assertTableFits(
  t: Pick<TableBlock, "columns" | "rows" | "type">,
  params: ParamMap,
  where: { label?: string | null; address?: string | null } = {},
): void {
  const limit = tableSpanLimitMm(params);
  const m = tableMinWidthMm(t, params);
  if (m.minMm <= limit + 1e-6) return;
  const name = where.label || (where.address ? `tabel @ ${where.address}` : "tabel");
  const w = m.widest;
  const cell = w ? `kolom ${w.column + 1}, baris ${w.row + 1}: "${w.text.length > 40 ? `${w.text.slice(0, 40)}…` : w.text}" ${w.mm.toFixed(1)} mm` : "";
  const base = `${name} tidak muat dalam bentang ${limit} mm (DT-10a): isi yang tidak dapat dipatah (angka, ID, satuan) saja sudah ${m.minMm.toFixed(1)} mm${cell ? `; sel terlebar ${cell}` : ""}`;
  throw new TableOverCapacity(base, {
    checkId: TABLE_FIT_CHECK_ID,
    family: String(t.type ?? "table"),
    quantity: "lebar minimum tabel",
    unit: "mm",
    limit,
    measured: Math.round(m.minMm * 10) / 10,
    suggestion:
      "pecah tabel menjadi dua (kolom kunci diulang), kurangi jumlah kolom angka, atau pindahkan teks panjang dari kolom ID/angka/satuan ke kolom teks agar dapat dibungkus; daftar ID tanpa spasi dipatah setelah , ; / bila lebih dari 16 karakter",
    ...(where.address ? { pointer: where.address } : {}),
  });
}
