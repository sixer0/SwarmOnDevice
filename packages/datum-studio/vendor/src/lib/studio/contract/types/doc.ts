/**
 * `studio.doc/v1` (01_specs.md §3.3) dan blok isi (§3.4).
 * Skema JSON padanan: ../schema/doc.schema.ts dan ../schema/common.schema.ts.
 */
import type { ProvenanceMark, StudioTier, SymbolDialect, TableBlockType } from "../enums";
import type { StudioChartV1 } from "./chart";
import type { Borders, CellFormat, FieldFormats, Inline, ParaFormat, ParamValue, Run, RunProps, Shading, Tw } from "./common";
import type { StudioDiagramV1 } from "./diagram";

// ── Permintaan dan dokumen ───────────────────────────────────────────────

/** Badan POST /api/studio/documents dan /api/studio/validate. */
export interface StudioIngestRequest {
  /** Maks 80 karakter (A6). */
  agentId?: string;
  document: StudioDocV1;
  render?: { formats?: Array<"docx" | "pdf" | "html">; figures?: Array<"svg" | "png"> };
}

export interface StudioDocV1 {
  $schema: "studio.doc/v1";
  /** Tanpa `version` = latestVersionNo templat. */
  template: { slug: string; version?: number };
  mission?: StudioMissionRef;
  meta: DocMeta;
  register?: Record<string, RegisterEntry>;
  /** Hanya kelas B untuk non-admin (KT-16). */
  overrides?: Record<string, ParamValue>;
  front?: { cover?: FrontPage; controlSheet?: FrontPage; toc?: TocSpec; signature?: SignatureBlock };
  parts?: PartSpec[];
  /** minItems 1. */
  chapters: Chapter[];
  /** Kunci huruf A..Z. */
  appendices?: Chapter[];
  assets?: Record<string, AssetRef>;
  /** Default dari templat per tier. */
  outputs?: Array<"docx" | "pdf" | "html">;
  x?: Record<string, unknown>;
}

export interface StudioMissionRef {
  folder?: string;
  agentRequestId?: string;
  hermesTaskId?: string;
}

export interface DocMeta {
  title: string;
  /** Pola P3-18; absen -> sekuens HQ (KT-05 c). */
  docNumber?: string;
  /** `^[A-Z]{1,2}$` */
  rev: string;
  /** Daftar tertutup P3-20 (ditegakkan layanan dari parameter templat). */
  typeCode: string;
  tier: StudioTier;
  classification: string;
  language: "ID" | "EN";
  author: string;
  /** YYYY-MM-DD; juga cap waktu deterministik ZIP/PDF. */
  issueDate: string;
  custodian?: string;
  audience?: string;
  basis?: string;
  subject?: string;
  urgency?: "kilat" | "sangat segera" | "segera" | "biasa";
  issueNumber?: number;
  copyControl?: string;
}

export interface RegisterEntry {
  v: number;
  dec: 0 | 1 | 2 | 3;
  /** minLength 1. */
  unit: string;
  mark: ProvenanceMark;
  src: string;
}

export interface AssetRef {
  kind: "raster";
  mime: "image/png" | "image/jpeg";
  sha256: string;
  /** Relatif akar aset. */
  path?: string;
  dataBase64?: string;
  widthPx?: number;
  heightPx?: number;
}

/** Satu `w:sectPr`. */
export interface SectionSetup {
  /** BM: [11906, 16838]. */
  pageSizeTw?: [Tw, Tw];
  marginTw?: { top: Tw; bottom: Tw; left: Tw; right: Tw; header: Tw; footer: Tw; gutter: Tw };
  cols?: { num: number; spaceTw: Tw };
  docGridLinePitch?: number;
  titlePg?: boolean;
  header?: HeaderFooterSpec;
  footer?: HeaderFooterSpec;
}

/**
 * `styleId` (delta S03-d1, G-07): rujukan gaya paragraf `w:pStyle` (BM: "Header"/"Footer";
 * definisi gaya dari parameter `render.docx.headerFooterStyles`). Medan registerBlock
 * `colsTw`/`cellFormats`/`trailingFormat` (delta S03-d1, G-08/S95-C09): tata letak tabel
 * blok register dan paragraf sesudah tabel; absen -> `render.section.registerBlockLayout`.
 */
export type HeaderFooterSpec =
  | { mode: "inherit" } // dari render.section.* templat
  | { mode: "empty"; format?: ParaFormat; styleId?: string } // BM header1.xml: line 40 exact
  | { mode: "runningHead"; left?: Inline; right?: Inline; format?: ParaFormat; styleId?: string } // BM header5.xml
  | {
      mode: "registerBlock";
      cells?: Inline[];
      styleId?: string;
      colsTw?: Tw[];
      /** Per sel, urutan kolom. */
      cellFormats?: CellFormat[];
      /** Paragraf kosong sesudah tabel (BM: pStyle Footer, line 20 exact). */
      trailingFormat?: ParaFormat;
    } // BM footer5.xml, field PAGE/NUMPAGES
  | { mode: "custom"; paragraphs?: Array<{ runs: Run[]; format?: ParaFormat }>; table?: TableBlock; styleId?: string };

/** sec:S01 cover / sec:S02 controlSheet. */
export interface FrontPage {
  mode: "auto" | "explicit";
  /** Mode auto: disusun dari cover.elementOrder (P4V-03). */
  data?: CoverData | ControlSheetData;
  /** Mode explicit: urutan persis (benchmark). */
  body?: FrontItem[];
  setup?: SectionSetup;
}

/**
 * Isi halaman depan/pembatas mode explicit. Spesifikasi §3.3 menulis
 * `Block | ParagraphBlock | SignatureBlock | ControlBlock | Colophon`; §13
 * (K-01, K-04, K-10, K-16, K-20) menempatkan juga `device` dan `spacer` di
 * `front.*.body[]` dan `parts[].body[]`, sehingga keduanya ikut di union ini.
 */
export type FrontItem = Block | SpacerBlock | DeviceBlock | SignatureBlock | ControlBlock | Colophon;

export interface CoverData {
  kicker?: Inline;
  titleLines: Inline[];
  standfirst?: Inline;
  scopeLine?: Inline;
  addressLine?: Inline;
  control?: ControlBlock;
  colophon?: Colophon;
  identityString?: Inline;
}

export interface ControlSheetData {
  kicker?: Inline;
  title: Inline;
  revisionHistory?: TableBlock;
  verificationChain?: TableBlock;
  methodStatement?: Inline;
  distribution?: TableBlock;
}

/** KT-03/KT-04. */
export interface ControlBlock {
  type: "controlBlock";
  rows: Array<[Inline, Inline, Inline, Inline]>;
  colsTw?: Tw[];
  /** Sel baris pertama (BM TCP-03: garis atas 14110F sz10). Delta S03-d1, S95-C02. */
  firstRowCell?: CellFormat;
  /** Sel baris lain (BM TCP-04). Delta S03-d1. */
  rowCell?: CellFormat;
}

/** KT-05/KT-06. */
export interface Colophon {
  type: "colophon";
  left: Inline;
  right: Inline;
  /** BM [4706, 4706]. Delta S03-d1, S95-C07. */
  colsTw?: Tw[];
  /** [kiri, kanan]. Delta S03-d1. */
  cellFormats?: CellFormat[];
}

/** sec:S05. */
export interface SignatureBlock {
  type: "signatureBlock";
  roles: Array<{ role: Inline; holder: Inline; date?: Inline }>;
  signRowFormat?: ParaFormat;
  colsTw?: Tw[];
  /**
   * Urutan baris tabel (delta S03-d1, G-03). BM T008: ["role", "sign", "holder"];
   * absen = urutan bawaan renderer.
   */
  rowOrder?: Array<"role" | "sign" | "holder" | "date">;
  /** Format sel per jenis baris (BM TCP-08 peran, TCP-10 pemegang). Delta S03-d1, S95-C03. */
  cellFormats?: { role?: CellFormat; sign?: CellFormat; holder?: CellFormat; date?: CellFormat };
}

export interface TocEntry {
  level: "part" | "chapter" | "appendix";
  label: Inline;
  title: Inline;
  /** Mode static: halaman literal. */
  page: string;
}

export interface TocSpec {
  mode: "field" | "static";
  kicker?: Inline;
  title?: Inline;
  note?: Inline;
  entries?: TocEntry[];
  sealBand?: DeviceBlock;
  setup?: SectionSetup;
  /** Lebar kolom tabel daftar isi statis (BM T010 [1474, 7144, 793]). Delta S03-d1, S95-C06. */
  colsTw?: Tw[];
  /** Format paragraf `kicker`/`title`/`note` (delta S03-d1, G-06). */
  fieldFormats?: FieldFormats;
}

export interface PartSpec {
  /** "P1".. */
  id: string;
  /** "Bagian I". */
  label: Inline;
  title: Inline;
  lede?: Inline;
  chapterKeys: string[];
  showChapterList?: boolean;
  body?: FrontItem[];
  setup?: SectionSetup;
  /**
   * Urutan unsur halaman bagian (delta S03-d1, G-02). BM T011/T012:
   * ["body", "label", "title", "lede", "chapterList"]; absen = urutan bawaan renderer.
   */
  order?: Array<"body" | "label" | "title" | "lede" | "chapterList">;
  /** Format paragraf `label`/`title`/`lede` (delta S03-d1, G-06). */
  fieldFormats?: FieldFormats;
}

/** Unsur aliran blok: 21 blok isi + primitif spacer/device (KS-05). */
export type FlowItem = Block | SpacerBlock | DeviceBlock;

export interface Chapter {
  /** "1".."n" (bab) | "A".."Z" (lampiran); default posisi. */
  key?: string;
  blockId?: string;
  kicker?: Inline;
  title: Inline;
  partId?: string;
  runningHeadTitle?: string;
  setup?: SectionSetup;
  /** Alamat C.0.P. */
  intro?: FlowItem[];
  sections: Section[];
  /** Format paragraf `kicker`/`title` (delta S03-d1, G-06). */
  fieldFormats?: FieldFormats;
}

export interface Section {
  blockId?: string;
  /** Default C.S. */
  number?: string;
  /**
   * Pemisah nomor-judul, ditulis di run nomor (delta S03-d1, G-01/S95-C14;
   * BM "1.1" + 3 spasi). Absen -> `render.section.numberSeparator`.
   */
  numberSeparator?: string;
  title: Inline;
  headingFormat?: ParaFormat;
  blocks: FlowItem[];
}

export interface SpacerBlock {
  type: "spacer";
  format: ParaFormat;
}

export type DeviceKind = "sealBand" | "logo" | "hairline" | "datumRule" | "spineString" | "issueStamp";

export interface DeviceBlock {
  type: "device";
  device: DeviceKind;
  left?: Inline;
  right?: Inline;
  text?: Inline;
  asset?: string;
  widthMm?: number;
  heightMm?: number;
  format?: ParaFormat;
  /** Lebar kolom tabel perangkat (pita segel BM [4706, 4706]). Delta S03-d1, S95-C07. */
  colsTw?: Tw[];
  /** Format sel [kiri, kanan] (pita segel: sel kanan jc right, tcMar left 0). Delta S03-d1, S95-C01. */
  cellFormats?: CellFormat[];
}

// ── Blok isi (§3.4) ──────────────────────────────────────────────────────

export interface RailLine {
  kind: "mark" | "source" | "note";
  mark?: ProvenanceMark;
  label?: string;
  text?: string;
  runs?: Run[];
  format?: ParaFormat;
}

export interface Caption {
  /** Default "Tabel n.m"/"Gambar n.m"; bila diisi wajib sama dengan hasil penomoran, selain itu lint REPORT. */
  label?: string;
  separator?: string;
  inline: Inline;
  labelProps?: RunProps;
  format?: ParaFormat;
}

export interface SourceLine {
  inline: Inline;
  provenance?: ProvenanceMark[];
  format?: ParaFormat;
}

export interface FigureCommon {
  caption: Caption;
  keyRow?: Inline;
  source: SourceLine;
  /** 128 | 166; aset raster boleh selain 128/166. */
  widthMm: number;
  heightMm?: number;
  paragraphFormat?: ParaFormat;
}

export type CellParagraph = Inline & { format?: ParaFormat };

export interface Cell {
  /** Kosong [] = `<w:p/>` tanpa pPr (KT-19, KT-37). */
  paragraphs?: CellParagraph[];
  /** Singkatan satu paragraf (XOR paragraphs). */
  text?: string;
  runs?: Run[];
  gridSpan?: number;
  vMerge?: "restart" | "continue";
  widthTw?: Tw;
  borders?: Omit<Borders, "insideH" | "insideV">;
  marginsTw?: { top?: Tw; left?: Tw; bottom?: Tw; right?: Tw };
  shading?: Shading;
  vAlign?: "top" | "center" | "bottom";
  /** Kedalaman maks 1. */
  nested?: TableBlock;
  /**
   * Jumlah paragraf sel yang ditulis SEBELUM tabel bersarang (delta S03-d1, G-04);
   * absen = semua paragraf lebih dulu, lalu tabel bersarang.
   */
  nestedIndex?: number;
}

export interface Row {
  kind?: "header" | "body" | "group" | "total";
  cells: Cell[];
  cantSplit?: boolean;
  repeatHeader?: boolean;
}

export interface ColumnSpec {
  widthTw?: Tw;
  widthMm?: number;
  align?: "left" | "right" | "center" | "decimal";
  role?: "text" | "numeral" | "id" | "unit" | "glyph";
  unit?: string;
}

export interface TableBlock {
  type: TableBlockType;
  blockId?: string;
  caption?: Caption;
  /** 1..20. */
  columns: ColumnSpec[];
  /** Baris kepala = rows dengan kind "header". */
  rows: Row[];
  /** Wajib untuk tabel data (lint 10, by-construction 422) kecuali tabel tanpa caption. */
  source?: SourceLine;
  /** Default render.table.sourcePlacement. */
  sourcePlacement?: "lastRowMerged" | "paragraphBelow";
  layout?: { widthTw?: Tw; indentTw?: Tw; cellMarginTw?: { left: Tw; right: Tw }; fixed?: boolean; borders?: Borders };
  preset?: string;
  format?: ParaFormat;
  x?: Record<string, unknown>;
}

/** Medan bersama setiap blok isi. */
export interface BlockCommon {
  /** Stabil lintas revisi (§4.4). */
  blockId?: string;
  /** Override paragraf utama. */
  format?: ParaFormat;
  runDefaults?: RunProps;
  /** Format paragraf medan Inline-only (`label`, `keyRow`, `title`, ...). Delta S03-d1, G-06. */
  fieldFormats?: FieldFormats;
  x?: Record<string, unknown>;
}

export type ParagraphRole =
  | "body"
  | "identity"
  | "anchor"
  | "pivot"
  | "closingAction"
  | "lede"
  | "subheading"
  | "note"
  | "kicker"
  | "pageTitle"
  | "blockHeading"
  | "addressLine"
  | "title"
  | "standfirst"
  | "scopeLine"
  | "methodStatement";

export type ParagraphBlock = BlockCommon & Inline & { type: "paragraph"; role?: ParagraphRole; rail?: RailLine[] };

export type ListItem = Inline & { marker?: Run; format?: ParaFormat; rail?: RailLine[] };

export interface ListBlock extends BlockCommon {
  type: "list";
  style: "bullet" | "number";
  items: ListItem[];
}

export interface AsideBlock extends BlockCommon {
  type: "aside";
  variant: "generic" | "doctrine" | "story" | "quickCheck" | "ifInDoubt";
  label: Inline;
  body: CellParagraph[];
}

export interface MonoBlock extends BlockCommon {
  type: "monoBlock";
  label: Inline;
  lines: CellParagraph[];
}

/** asmId berpola P5-63 (`ASM-{domain}-{nn}`). */
export type AssumptionInlineBlock = BlockCommon & Inline & { type: "assumptionInline"; asmId: string; impact: string };

/** Keluarga tabel (11 jenis): bentuk TableBlock + preset (registerTable 8, financialTable `boq`/`ahs`/`recap`). */
export type TableFamilyBlock = TableBlock & { runDefaults?: RunProps };

export interface DerivationLine {
  label: Inline;
  value?: Inline | { registerKey: string; dec?: number };
  mark?: ProvenanceMark;
}

export interface DerivationBlock extends BlockCommon {
  type: "derivation";
  /** Default `D-C.n`. */
  id?: string;
  title: Inline;
  intro?: Inline;
  lines: DerivationLine[];
  result?: { label: Inline; expr: string; registerKey: string; tol?: number };
  verdict?: { label: Inline; registerKey: string; limit: number; direction?: "lessOrEqual" | "greaterOrEqual" };
  closing: Inline;
}

export interface ArtifactSpecRef {
  artifactId: string;
}

export interface ChartBlock extends BlockCommon, FigureCommon {
  type: "chart";
  spec: StudioChartV1 | ArtifactSpecRef;
}

export interface DiagramBlock extends BlockCommon, FigureCommon {
  type: "diagram";
  spec: StudioDiagramV1 | ArtifactSpecRef;
}

export interface ImageBlock extends BlockCommon, FigureCommon {
  type: "image";
  /** Kunci `assets`. */
  asset: string;
}

export interface SymbolSheetBlock extends BlockCommon, FigureCommon {
  type: "symbolSheet";
  dialect: SymbolDialect;
  cols?: number;
}

/** Union 21 jenis blok isi (§3.4). */
export type Block =
  | ParagraphBlock
  | ListBlock
  | AsideBlock
  | MonoBlock
  | AssumptionInlineBlock
  | TableFamilyBlock
  | DerivationBlock
  | ChartBlock
  | DiagramBlock
  | ImageBlock
  | SymbolSheetBlock;

