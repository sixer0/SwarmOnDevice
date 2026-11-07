/**
 * Modul engine/docx/tables (I06, 01_specs.md §8.2), diisi S17.
 *
 * Keluarga tabel DOCX (11 jenis: table, specTable, registerTable 8 preset,
 * financialTable 3 preset, checklist, glossary, sourceRegister, ruleIndex,
 * referenceScale, ruleTable, exampleWrongRight) dengan satu tata bahasa Tabel
 * 5.1: garis mendatar saja (border per sel, tanpa border tingkat tabel), kepala
 * berulang, pita kelompok, baris total, kolom satuan, SUMBER + PROVENANS, sel
 * bergabung, tabel bersarang satu tingkat, cantSplit; `solveWidths` dan guard
 * G1-G4 adalah port datumcheck.py.
 */
import type { DocxBlockRenderer, LintIssue, TableBlock } from "../../../contract";
import { renderRuleIndexMarker } from "../blocks";
import { tableGuards as runTableGuards, type TableGuardOptions } from "./guards";
import { renderTableBlock } from "./render";
import { solveWidthsImpl } from "./widths";

/**
 * RQ-7: `ruleIndex` v2 (compose SR-08, `content.mode === "auto"`) = penanda unit indeks
 * aturan, bukan tabel; tabel v1 `ruleIndex` tetap lewat `renderTableBlock`.
 */
const renderRuleIndex: DocxBlockRenderer = (block, ctx) => {
  const c = block.content as { mode?: unknown } | null;
  return c && typeof c === "object" && c.mode === "auto" ? renderRuleIndexMarker(block, ctx) : renderTableBlock(block, ctx);
};

export const docxTables: Partial<Record<TableBlock["type"], DocxBlockRenderer>> = {
  table: renderTableBlock,
  specTable: renderTableBlock,
  registerTable: renderTableBlock,
  exampleWrongRight: renderTableBlock,
  ruleTable: renderTableBlock,
  checklist: renderTableBlock,
  glossary: renderTableBlock,
  sourceRegister: renderTableBlock,
  ruleIndex: renderRuleIndex,
  referenceScale: renderTableBlock,
  financialTable: renderTableBlock,
};

/** Port persis `datumcheck.solve_widths(rows, total_mm)` (lebar mm, 0,1 mm). */
export function solveWidths(rows: readonly string[][], totalMm: number): number[] {
  return solveWidthsImpl(rows, totalMm);
}

/** Guard G1-G3 (G4 sebagai sub-cek G3, detail "G4"). `opts` opsional (lebar total, ukuran numeral). */
export function tableGuards(b: TableBlock, opts?: TableGuardOptions): LintIssue[] {
  return runTableGuards(b, opts);
}

export type { TableGuardOptions } from "./guards";
export type { TableRenderOptions } from "./render";
export { renderTableXml } from "./render";
export { FINANCIAL_TABLE_PRESETS, REGISTER_TABLE_PRESETS } from "./presets";
export { numFloorMm, okWidthsMm } from "./widths";
