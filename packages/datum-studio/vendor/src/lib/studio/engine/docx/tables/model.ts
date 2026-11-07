/**
 * Utilitas model TableBlock (S17): teks polos sel, cacah sel per baris, dan
 * validasi bentuk minimal konten NormBlock.
 */
import type { Cell, Inline, Row, Run, TableBlock } from "../../../contract";
import { TABLE_BLOCK_TYPES } from "../../../contract/enums";
import type { TableFamilyBlock } from "../../../contract/types/doc";

/** Hapus penanda md-lite (`**`, `` ` ``, `*` pembungkus) untuk teks polos. */
export function stripMdLite(text: string): string {
  return text.replace(/\*\*|`/g, "").replace(/(^|[\s(])\*(\S[^*]*?)\*(?=$|[\s).,;:])/g, "$1$2");
}

export function runsPlain(runs: readonly Run[]): string {
  return runs.map((r) => ("t" in r ? r.t : "tab" in r ? " " : "br" in r ? " " : "")).join("");
}

export function inlinePlain(i: Inline | undefined): string {
  if (!i) return "";
  if ("text" in i) return stripMdLite(i.text);
  return runsPlain(i.runs);
}

/** Teks polos sel (paragraf digabung spasi; tabel bersarang tidak dihitung). */
export function cellPlain(c: Cell): string {
  if (c.paragraphs) return c.paragraphs.map((p) => inlinePlain(p)).join(" ");
  if (c.runs) return runsPlain(c.runs);
  if (c.text !== undefined) return stripMdLite(c.text);
  return "";
}

/** Cacah kolom grid yang dibentang baris (memperhitungkan gridSpan). */
export function rowSpan(row: Row): number {
  return row.cells.reduce((s, c) => s + Math.max(1, c.gridSpan ?? 1), 0);
}

const TYPES: ReadonlySet<string> = new Set(TABLE_BLOCK_TYPES);

/** Validasi bentuk minimal; `null` bila sah, selain itu alasan. */
export function shapeProblem(x: unknown): string | null {
  if (x === null || typeof x !== "object") return "konten blok bukan objek";
  const b = x as Partial<TableBlock>;
  if (typeof b.type !== "string" || !TYPES.has(b.type)) return `jenis tabel tidak dikenal: ${String(b.type)}`;
  if (!Array.isArray(b.columns) || b.columns.length === 0) return "columns kosong";
  if (!Array.isArray(b.rows)) return "rows bukan larik";
  for (const [i, r] of b.rows.entries()) {
    if (!r || !Array.isArray(r.cells)) return `rows[${i}].cells bukan larik`;
  }
  return null;
}

export function asTableBlock(x: unknown): TableFamilyBlock {
  return x as TableFamilyBlock;
}
