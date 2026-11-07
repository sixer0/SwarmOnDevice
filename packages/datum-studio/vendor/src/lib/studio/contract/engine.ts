/**
 * Tipe konteks bersama mesin render (01_specs.md §8.1) plus tipe pendukung
 * yang dirujuk tanda tangan modul §8.2 (RegisterApi, LayoutResult, ChartCanvas,
 * dst.). Modul mesin mengimpor tipe dari sini, bukan dari modul lain.
 */
import type { ChartCode, DiagramEdgeKind, DiagramFamily, LintCheckStatus, ProvenanceMark, RoleKey, StudioErrorCode } from "./enums";
import type { StudioChartV1 } from "./types/chart";
import type { Borders, CellFormat, FaceRole, ParaFormat, ParamValue, RunProps, Shading } from "./types/common";
import type { StudioDiagramV1 } from "./types/diagram";
import type { Cell, DocMeta, RegisterEntry } from "./types/doc";
import type { NormBlock, NormDocSnapshot } from "./types/model";
import type { SectionPlan } from "./types/params";

export type ParamMap = Readonly<Record<string, ParamValue>>;

export interface RoleFormat {
  para?: ParaFormat;
  run?: RunProps;
  labelRun?: RunProps;
  numberRun?: RunProps;
  markerRun?: RunProps;
  glyphRun?: Partial<Record<ProvenanceMark, RunProps>>;
  cell?: { borders?: Borders; marginsTw?: Cell["marginsTw"]; shading?: Shading };
  // ── Delta S03-d1 (aditif, profil S95) ──
  /** Run label per tanda provenans (rel bukti: TERUKUR 101418, ASUMSI 9B1C1C, DITURUNKAN B45309). S95-C04. */
  labelRunByMark?: Partial<Record<ProvenanceMark, RunProps>>;
  /** Sel kanan tabel dua kolom (pita segel: jc right, tcMar left 0 = TCP-02). S95-C01. */
  rightCell?: CellFormat;
  /** Sel baris pertama tabel peran ini (ControlBlock TCP-03). S95-C02. */
  firstRowCell?: CellFormat;
  /** Sel bila peran dipakai di SignatureBlock (TCP-08 peran, TCP-10 pemegang). S95-C03. */
  signatureCell?: CellFormat;
}

export type RoleFormatMap = Readonly<Partial<Record<RoleKey, RoleFormat>>>;

export interface ResolvedTemplate {
  templateId: string;
  versionId: string;
  versionNo: number;
  params: ParamMap;
  roleFormats: RoleFormatMap;
  sectionPlan: SectionPlan;
  assets: Readonly<Record<string, { sha256: string; absPath: string; kind: "font" | "raster" | "base" }>>;
}

/** Akses baca register angka dokumen (port datumbind, I02). */
export interface RegisterApi {
  has(key: string): boolean;
  /** Melempar BindDefect bila kunci tidak ada. */
  get(key: string): RegisterEntry;
  /** Nilai terformat DATUM dengan `dec` entri atau override. */
  format(key: string, dec?: number): string;
  keys(): readonly string[];
}

export interface RenderLogEntry {
  level: "info" | "warn" | "error";
  message: string;
  code?: StudioErrorCode | string;
  address?: string;
  at?: string;
}

export interface FigureStore {
  get(label: string): { svg?: string; png?: Uint8Array; widthMm: number; heightMm: number } | undefined;
}

export interface RenderContext {
  snapshot: NormDocSnapshot;
  tpl: ResolvedTemplate;
  register: RegisterApi;
  /** meta.issueDate, determinisme. */
  fixedDate: string;
  figures: FigureStore;
  log: (e: RenderLogEntry) => void;
  /**
   * Byte aset raster dokumen (delta S03-d1, D-63/S48). Sinkron karena renderer
   * blok sinkron: pemanggil (S48/S51) memuat byte lebih dulu, lalu mencari per
   * sha256 (`AssetRef.sha256`), dengan kunci `doc.assets` sebagai petunjuk.
   * Absen atau `undefined` = aset tidak tersedia (renderer memakai cadangan/log).
   */
  assetBytes?: (sha256: string, key?: string) => Uint8Array | undefined;
  /**
   * Delta SR-04 (register §15.1): nilai efektif per slot (preset, esensial,
   * lanjutan, turunan, T) untuk perakit sadar slot (SR-16/SR-17). Absen = jalur v1.
   */
  slots?: ReadonlyMap<string, ResolvedSlot>;
  /** Delta SR-04: lingkup render (bawaan DOCUMENT). */
  scope?: RenderScope;
  /** Delta SR-04: render draf (bawaan `scope.kind !== "DOCUMENT"`); penanda `render.draft.marker`. */
  draft?: boolean;
}

/** Lingkup render (register §15.1; nama API E40 dipetakan ke E27). */
export type RenderScope = { kind: "DOCUMENT" } | { kind: "CHAPTER"; key: string } | { kind: "SLOT"; key: string };

/** Hasil resolusi nilai efektif satu slot kerangka (register §15.1, I44 `resolveSlotParams`). */
export interface ResolvedSlot {
  slotKey: string;
  sectionType: string;
  label: string;
  params: ParamMap;
  roleFormats: RoleFormatMap;
  /** `slot.placeholderText` dengan `{label}` sudah diganti. */
  placeholderText: string;
}

export interface DocxFragment {
  xml: string;
  media?: Array<{ name: string; data: Uint8Array; contentType: string }>;
  facesUsed?: string[];
}

export type DocxBlockRenderer = (block: NormBlock, ctx: RenderContext) => DocxFragment;
export type HtmlBlockRenderer = (block: NormBlock, ctx: RenderContext) => string;

export interface LintIssue {
  checkId: string;
  status: LintCheckStatus;
  detail?: string;
  address?: string;
  pointer?: string;
}

export interface SvgResult {
  svg: string;
  widthMm: number;
  heightMm: number;
  report: { checksRun: string[]; issues: LintIssue[] };
}

export interface LintReport {
  tier: "NOTA" | "TERBIT" | "SERAH";
  checks: LintIssue[];
  releaseStatus: "PASS" | "FAIL" | "NOT_RUN";
  banner: string;
}

// ── Tipe pendukung tanda tangan §8.2 ─────────────────────────────────────

/** Temuan audit teks terhadap register (I02 auditText/auditRetired). */
export interface AuditFinding {
  kind: "unregistered" | "mismatch" | "retired";
  /** Potongan teks yang memicu temuan. */
  text: string;
  /** Indeks karakter awal di teks masukan. */
  index: number;
  key?: string;
  detail?: string;
}

/** Masukan perakitan paket DOCX (I03). */
export interface DocxPackageInput {
  tpl: ResolvedTemplate;
  meta: DocMeta;
  /** Cap waktu deterministik ZIP (= meta.issueDate). */
  fixedDate: string;
  /** Isi `word/document.xml` lengkap. */
  documentXml: string;
  /** Bagian tambahan (header/footer/media/fonts), path relatif akar paket. */
  parts: Array<{ path: string; data: Uint8Array | string; contentType?: string }>;
  /** Relasi tambahan `word/_rels/document.xml.rels`. */
  relationships: Array<{ id: string; type: string; target: string; targetMode?: "External" }>;
  fonts?: EmbeddedFontPlan;
}

/** Rencana penanaman fon odttf (I04). */
export interface EmbeddedFontPlan {
  fonts: Array<{
    face: string;
    slot: "regular" | "bold" | "italic" | "boldItalic";
    absPath: string;
    /** GUID kunci obfuscation `{XXXXXXXX-...}`. */
    guid: string;
    /** Nama bagian di paket, mis. `word/fonts/font1.odttf`. */
    partName: string;
    relId: string;
  }>;
}

/** Pegangan instans browser tunggal (I14). Detail playwright tersembunyi di modul. */
export interface BrowserHandle {
  readonly engine: "chromium";
  readonly version: string;
  readonly executablePath: string;
}

/** Metrik tata letak hasil pengukuran browser untuk lint R (I14, I35). */
export interface LayoutMetrics {
  pageCount: number;
  elements: Array<{
    kind: string;
    address?: string;
    page?: number;
    xMm: number;
    yMm: number;
    widthMm: number;
    heightMm: number;
    fontSizePt?: number;
    overflow?: boolean;
  }>;
}

export interface DiagramBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Kanvas diagram (I16 `class Sheet` mengimplementasikan ini). */
export interface DiagramSheet {
  readonly widthMm: number;
  readonly heightMm: number;
  /** Kisi Garis A: 10,6667 x 4,7625 mm. */
  readonly colMm: number;
  readonly rowMm: number;
  add(svgElement: string): void;
  toSvg(): string;
}

export interface LayoutResult {
  nodes: Record<string, DiagramBox>;
  zones?: Record<string, DiagramBox>;
  lanes?: Record<string, DiagramBox>;
  widthMm: number;
  heightMm: number;
  // ── Delta S03-d1 (S28): state lembar Python yang dibaca build_svg ──
  family?: DiagramFamily;
  /** Urutan lajur swimlane. */
  laneOrder?: string[];
  gutterMm?: number;
  /** Garis hidup sequence. */
  lifelines?: Array<{ id: string; x: number; top: number }>;
  msgY?: number;
  msgStep?: number;
  msgEnd?: number;
}

export type LayoutFn = (s: StudioDiagramV1, sheet: DiagramSheet) => LayoutResult;

export interface RoutedEdge {
  from: string;
  to: string;
  kind: DiagramEdgeKind;
  label: string;
  points: ReadonlyArray<readonly [number, number]>;
  /** Atribut `d` path SVG setelah add_crossing_hops. */
  d?: string;
}

/** Kanvas chart mm 128/166 (I22). */
export interface ChartCanvas {
  /** 128 | 166 untuk figur dokumen; dilebarkan ke `number` di delta S03-d1 (D-63, S32: panel komposit/galeri). */
  widthMm: number;
  heightMm: number;
  plot: DiagramBox;
  /** Konversi pt fisik ke mm (font min 5,5 pt, F-007). */
  ptToMm(pt: number): number;
}

/**
 * Bentuk satu entri R-08 `render.docx.embedFonts` (delta S03-d1; dibaca
 * engine/docx/fonts S15, D-43). `forceEmbed` (S95-C15): tanam walau tidak ada
 * run yang memakai keluarga ini (BM menanam IBM Plex Sans 4 slot).
 */
export interface EmbedFontFamilyEntry {
  /** Nama keluarga persis `w:rFonts`; wajib bila `role` absen. */
  family?: string;
  slots: Array<"regular" | "bold" | "italic" | "boldItalic">;
  /** Keluarga dari parameter `type.face.<role>`. */
  role?: FaceRole;
  /** `canonical` = Bold bila ada; `semibold` = reproduksi BM. */
  boldFace?: "canonical" | "semibold";
  files?: Partial<Record<"regular" | "bold" | "italic" | "boldItalic", string>>;
  forceEmbed?: boolean;
}

export type ChartRenderer = (spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate) => SvgResult;
export type ChartRendererMap = Partial<Record<ChartCode, ChartRenderer>>;
