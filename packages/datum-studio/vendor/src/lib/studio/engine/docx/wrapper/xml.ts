/**
 * Primitif WordprocessingML untuk halaman pembungkus (S18).
 *
 * Sejak IP-38 (INT-T, D-101; INT-W, D-110) seluruh serialisasi tingkat rendah
 * (escape, atribut, `w:rPr`, `w:pPr`, garis, arsir, run, `w:t`, paragraf,
 * sel, tabel) berasal dari satu sumber `../package/xml` ragam bawaan
 * `PACKAGE_FLAVOR`. Modul ini hanya mengikat opsi khas pembungkus: TAB
 * literal dipertahankan (`WRAPPER_TEXT`), paragraf tanpa bentuk ringkas
 * `<w:p/>`, `w:tblW` = jumlah kolom bulat, plus md-lite via `parseMdLite` S16
 * (IP-13).
 */
import type { Inline, ParaFormat, ParamMap, Run, RunProps } from "../../../contract";
import { parseMdLite } from "../blocks/runs";
import {
  hfRunXml,
  paragraphFromInnerXml,
  pPrInner,
  rPrXml,
  runOwnProps,
  simpleTableRowsXml,
  textXml,
  WRAPPER_TEXT,
  type SimpleCell,
  type SimpleRow,
} from "../package/xml";

export { escapeXml, facesInXml, tcXml } from "../package/xml";

export const DRAWING_NS = {
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
} as const;

/** Paragraf; `runsXml` sudah berupa `<w:r>...`. Selalu `<w:p>...</w:p>` (bukan `<w:p/>`). */
export function paragraphXml(f: ParaFormat | undefined, runsXml = ""): string {
  return paragraphFromInnerXml(pPrInner(f), runsXml, { compactEmpty: false });
}

/**
 * Satu run; properti run menimpa `base` per atribut. Run teks: `w:t` ragam
 * pembungkus (`WRAPPER_TEXT`); tab/br/field (PAGE/NUMPAGES `w:fldSimple`
 * cache "1", pola BM footer) = `hfRunXml` paket.
 */
export function runXml(r: Run, base: RunProps, params?: ParamMap): string {
  if ("t" in r) {
    const own = runOwnProps(r);
    const merged: RunProps = { ...base, ...own };
    // face XOR faceRole (§3.2): peran wajah run sendiri menggantikan wajah dasar (RT-01, run konten-saja).
    if (own.faceRole !== undefined && own.face === undefined) delete merged.face;
    return `<w:r>${rPrXml(merged, params)}${textXml(r.t, WRAPPER_TEXT)}</w:r>`;
  }
  return hfRunXml(r, base, params);
}

export function runsXml(runs: readonly Run[], base: RunProps, params?: ParamMap): string {
  return runs.map((r) => runXml(r, base, params)).join("");
}

// ── md-lite (KS-03) ───────────────────────────────────────────────────

/*
 * md-lite pembungkus memakai pengurai tunggal S16 `parseMdLite` (IP-13, F-027):
 * `**tebal**`, `` `mono` ``, `*miring*`, URL/DOI. Peran mono pembungkus tidak
 * mengecilkan ukuran (nilai klaster BM per peran sudah final).
 */
const MD_ROLES = { mono: { faceRole: "mono" as const }, bold: { b: true }, italic: { i: true } };

/** Inline -> daftar run (text md-lite XOR runs). */
export function inlineRuns(i: Inline | undefined): Run[] {
  if (!i) return [];
  if ("runs" in i) return i.runs;
  return parseMdLite(i.text, MD_ROLES);
}

export function inlinePlain(i: Inline | undefined): string {
  if (!i) return "";
  if ("runs" in i) return i.runs.map((r) => ("t" in r ? r.t : "tab" in r ? "\t" : "")).join("");
  return i.text.replace(/\*\*|\*|`/g, "");
}

export function isInlineEmpty(i: Inline | undefined): boolean {
  return inlinePlain(i).trim() === "";
}

export function textInline(text: string): Inline {
  return { runs: [{ t: text }] };
}

// ── Tabel ────────────────────────────────────────────────────────────────

/** Sel pembungkus = `SimpleCell` paket (tcW, gridSpan, vMerge, tcBorders, shd, tcMar, vAlign). */
export type WCell = SimpleCell;

/** Baris pembungkus = `SimpleRow` paket (`cantSplit` bawaan true, `repeatHeader` = `w:tblHeader`). */
export type WRow = SimpleRow;

/**
 * Tabel TP-01 (research/07 §5.2): lebar tetap, tanpa garis tepi tabel,
 * tblCellMar kiri/kanan 0, tblInd 0, tblLook 04A0; semua baris cantSplit
 * kecuali `cantSplit: false`. `w:tblW` = jumlah lebar kolom bulat.
 */
export function tableXml(gridTw: readonly number[], rows: readonly WRow[], opts: { indentTw?: number } = {}): string {
  return simpleTableRowsXml(gridTw, rows, { indentTw: opts.indentTw, widthFromRoundedCols: true });
}

/**
 * Skala pola lebar kolom ke total twip (sisa pembulatan ke kolom terakhir).
 * Selisih <= 3 twip dianggap pembulatan mm->twip dan pola dipakai apa adanya
 * (BM: tabel 9410-9412 twip pada lebar teks 9411).
 */
export function scaleCols(pattern: readonly number[], total: number): number[] {
  const sum = pattern.reduce((a, b) => a + b, 0);
  if (sum <= 0 || pattern.length === 0) return [Math.round(total)];
  if (Math.abs(Math.round(sum) - Math.round(total)) <= 3) return pattern.map((w) => Math.round(w));
  const out = pattern.map((w) => Math.round((w * total) / sum));
  const diff = Math.round(total) - out.reduce((a, b) => a + b, 0);
  out[out.length - 1] += diff;
  return out;
}

export function mmToTw(mm: number): number {
  return Math.round((mm * 1440) / 25.4);
}

export function mmToEmu(mm: number): number {
  return Math.round(mm * 36000);
}
