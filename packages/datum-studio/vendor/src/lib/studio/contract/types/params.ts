/**
 * Tipe registri parameter dan registri lain (01_specs.md §5.1-5.5).
 * Isi registri: src/lib/studio/params/*.ts dan src/lib/studio/registry/*.ts.
 */
import type { ChartCode, LintGroup, LintHqMode, ParamSurface, StudioErrorCode, StudioTier } from "../enums";
import type { ChartDataShape } from "./chart";
import type { ParamValue } from "./common";

export type ParamType =
  | "bool"
  | "int"
  | "number"
  | "mm"
  | "pt"
  | "em"
  | "deg"
  | "percent"
  | "cm"
  | "rp"
  | "ratio"
  | "hex"
  | "char"
  | "string"
  | "enum"
  | "list"
  | "map"
  | "object"
  | "tokenRef"
  | "range"
  | "pair";

export type ParamGroup =
  | "P1"
  | "P3"
  | "P4C"
  | "P4T"
  | "P4G"
  | "P4R"
  | "P4S"
  | "P4V"
  | "P4K"
  | "P4A"
  | "P5"
  | "P6"
  | "P7"
  | "P7X"
  | "P8"
  | "P9"
  | "P10"
  | "P11"
  | "P12"
  | "P13"
  | "P14"
  | "P15"
  | "P16"
  | "PA"
  | "PB"
  | "PC"
  | "PD"
  | "R";

export type DeriveFnId =
  | "fullSpan"
  | "latticeX"
  | "latticeY"
  | "allowedFigureWidths"
  | "pageWidthCheck"
  | "railMode"
  | "rederiveNonA4"
  | "tierSuggested"
  | "pdfEnabledByTier"
  | "reconciliationByTier"
  | "lintByTier"
  | "fileName"
  | "figureFileFromCaption"
  | "docNumberFileForm"
  | "monthRoman"
  | "coverLeftMargin"
  | "coverRuleWidth"
  | "ruleWeightFromHair"
  | "ticksFromSubcolumns"
  | "runningHeadRule"
  | "totalRowRule"
  | "captionIdentifierStyle"
  | "registerMaxDecimals"
  | "auditByTier"
  | "admiraltyOnce"
  | "serahByTier"
  | "vatEffective"
  | "issueNumber"
  | "chartEngine"
  | "eyeCheckList"
  | "wordLadder"
  | "railColsTw"
  // FIX-6 (F-S71-2, kontrak §5.1 "derive wajib untuk kelas T"): tiga kunci diagram
  // yang sebelumnya dihitung KEYED_DERIVERS tanpa DeriveFnId.
  | "diagramClassification"
  | "diagramLatticeSnap"
  | "diagramLineSpacing"
  // Delta SR-04 (register §13.3 DV-01..DV-04): turunan kenop esensial / ukuran kertas.
  | "pageSizeFromPaper"
  | "textColumnFromPage"
  | "marginsFromDensity"
  | "typeScaleFromBase"
  // Delta SR-04 (research/09 §6.2, D-165): turunan bernama SR-59/SR-60. Nama research/09
  // untuk DV-01 dicabut (D-172, D-211, IP-48); nama kanonik tunggal `pageSizeFromPaper`.
  | "textBlockFromPage"
  | "baselineFromBodyLeading"
  | "figureWidthFromClass"
  | "figureMaxHeightFromBlock"
  | "sectionSetupFromGrid"
  | "headerFooterTabsFromSpan"
  | "colorLiterals";

export interface ParamDef {
  /** "P4G-03", "P4T-S01-size", chart "P7X-P-01-sort", renderer "R-01". */
  id: string;
  /** "grid.textColumnMm"; parameter khusus chart: `chart.kind.<KODE>.<nama>`. */
  key: string;
  /** Label UI berbahasa Indonesia. */
  label: string;
  type: ParamType;
  /** null bila [TAK TERBACA]. */
  default: ParamValue;
  range?: { min?: number; max?: number; step?: number };
  enum?: readonly string[];
  pattern?: string;
  class: "B" | "K" | "T";
  /** Mis. "B (>= 0,18: K)". */
  classNote?: string;
  /** Wajib untuk kelas T. */
  derive?: DeriveFnId;
  /** "DT-10" atau "-". */
  ruleRef: string;
  /** "L721, TK82" | "research/04 T033" | "S01 §5.7". */
  source: string;
  origin: "catalog" | "contract";
  group: ParamGroup;
  /** Pengelompokan UI per bab manual: "Bab 1-2" | "Bab 3" | ... | "Lampiran" | "Renderer". */
  chapter: string;
  /** Segmen pertama key. */
  namespace: string;
  tiers?: Array<StudioTier>;
  /** Nilai [REK] sudah diganti research/04 (D-09). */
  rek?: boolean;
  /** [TAK TERBACA]. */
  unreadable?: boolean;
  /** Konflik katalog "K-11" (research/01 §7.1). */
  conflictRef?: string;
  /** "G-03". */
  gapRef?: string;
  /** P15 workbook/brief (A5, D-05). */
  inactive?: boolean;
  /**
   * Delta SR-04 (register §13.5, E31): lapis permukaan (essential | advanced |
   * derived | internal). Diisi agregasi `params/index.ts` dari `PARAM_SURFACE`
   * (`L/registry/essentials.ts`); satu sumber. Lapis terpisah dari kelas B/K/T.
   */
  surface?: ParamSurface;
  /**
   * Delta SR-04 (register §13.5, E32): cakupan `document` | `section:<kunci>` |
   * `shared:<kelompok>` | `slot`. Diisi agregasi dari `PARAM_SCOPE` (`L/registry/slots.ts`).
   */
  scope?: string;
}

/** Temuan resolusi/izin parameter (I01). */
export interface ParamIssue {
  key: string;
  code: Extract<StudioErrorCode, "PARAM_UNKNOWN_KEY" | "PARAM_CLASS_K_FORBIDDEN" | "PARAM_CLASS_T_READONLY" | "SCHEMA_INVALID">;
  message: string;
  pointer?: string;
}

// ── Registri section (§5.2) ──────────────────────────────────────────────

export interface SectionTypeDef {
  key: string;
  catalogId: string;
  group: "DOCUMENT" | "PAGE_DEVICE" | "CHANNEL";
  register: "WRAPPER" | "INTERIOR" | "NONE";
  name: string;
  elements: readonly string[];
  paramRefs: readonly string[];
  ruleRefs: readonly string[];
  activeTiers: readonly ("NOTA" | "TERBIT" | "SERAH")[];
  renderable: boolean;
  sourceRef: string;
}

/** Rencana section per tier (§5.5); kunci = tier. */
export interface SectionPlan {
  [tier: string]: {
    required: readonly string[];
    optional: readonly string[];
    forbidden: readonly string[];
    requiredPresets?: Record<string, readonly string[]>;
    /**
     * Delta S03-d2 (aditif; IP-23, D-76): urutan tampil section lintas status
     * (kunci registri, unik, masing-masing ada di salah satu daftar tier ini).
     * Absen = urutan registri. Kunci daftar yang tidak disebut menyusul di
     * belakang dalam urutan registri. Tidak mengubah makna wajib/opsional/terlarang.
     */
    order?: readonly string[];
  };
}

// ── Registri chart (§5.3, S09) ───────────────────────────────────────────

export type ChartModule =
  | "core"
  | "family-p1"
  | "family-p2"
  | "family-h1"
  | "family-h2"
  | "family-k1"
  | "family-k2"
  | "family-w1"
  | "family-w2"
  | "family-s1"
  | "family-s2"
  | "family-g";

export interface ChartDef {
  code: ChartCode;
  name: string;
  group: "P" | "H" | "K" | "W" | "S" | "G";
  purpose: "perbandingan" | "hubungan" | "komposisi" | "waktu" | "sebaran" | "geospasial" | "aliranProses";
  fn: string;
  useWhen: string;
  avoidWhen: string;
  manualTable: "8.1" | "8.2" | "8.3" | "8.4" | "8.5";
  drawn: boolean;
  /** Wajib bila drawn. */
  dataShape?: ChartDataShape;
  /** Kunci di CHART_PARAMS. */
  paramKeys: readonly string[];
  pyRef: { kind: "datumchart" | "pustakachart" | "none"; ref?: string; form?: "PENUH" | "PARSIAL"; dataOrigin?: string };
  /** research/06:253-256. */
  parityClass?: "CA" | "CB1" | "CB2" | "CC";
  module?: ChartModule;
  /** WAJIB tidak kosong bila drawn=false (research/06:172-189). */
  alternatives?: readonly ChartCode[];
  /** WAJIB bila drawn=false. */
  renderErrorCode?: "CHART_KIND_NOT_DRAWN";
  benchmarkFigure?: "8.1" | "8.2" | "8.3" | "8.4" | "8.5";
}

// ── Registri lint (§5.4, S10) ────────────────────────────────────────────

export interface LintDef {
  /** "DATUM-01".."DATUM-39" | "G1","G2","G3","N1" | "C-14".. | "D01".."D21" | "H01".."H16". */
  id: string;
  group: LintGroup;
  title: string;
  limit: string;
  stage: "file" | "build" | "eye" | "guard" | "human";
  hqMode: readonly LintHqMode[];
  partial: boolean;
  ruleRef: string;
  tiers: readonly ("NOTA" | "TERBIT" | "SERAH")[];
  /** true -> 422 saat ingest (grup S by-construction + guard B, A10). */
  blocksIngest: boolean;
  module: "scan" | "render" | "structure" | "language" | "human";
  /** Mis. "lint.emDash.maxPer1000Words" (KT-06). */
  paramRef?: string;
  /** Alat tidak tersedia (KT-13). */
  notRunReason?: string;
}
