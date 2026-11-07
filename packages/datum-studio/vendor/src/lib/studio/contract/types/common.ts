/**
 * Bentuk bersama kontrak Studio (01_specs.md §3.2).
 * Satuan OOXML apa adanya: Tw = twip (1/20 pt), HalfPt = w:sz, Eighth = 1/8 pt.
 */

/** `^[0-9A-F]{6}$` (huruf besar) atau `"auto"`. */
export type Hex = string;
/** Integer twip. */
export type Tw = number;
/** Integer setengah poin. */
export type HalfPt = number;
/** Integer 1/8 pt (border `w:sz`). */
export type Eighth = number;

export interface BorderSpec {
  val: "single" | "dashed" | "dotted" | "double" | "none";
  sz: Eighth;
  color: Hex;
  space?: number;
}

export interface Borders {
  top?: BorderSpec;
  bottom?: BorderSpec;
  left?: BorderSpec;
  right?: BorderSpec;
  insideH?: BorderSpec;
  insideV?: BorderSpec;
}

export interface Shading {
  fill: Hex;
  val: "clear";
}

export interface TabStop {
  posTw: Tw;
  val: "left" | "right" | "center" | "decimal";
  leader?: "none" | "dot";
}

export interface ParaFormat {
  spacingBeforeTw?: Tw;
  spacingAfterTw?: Tw;
  lineTw?: Tw;
  lineRule?: "auto" | "exact" | "atLeast";
  jc?: "left" | "right" | "center" | "both";
  indLeftTw?: Tw;
  indRightTw?: Tw;
  indHangingTw?: Tw;
  indFirstLineTw?: Tw;
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  widowControl?: boolean;
  outlineLvl?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  tabs?: TabStop[];
  borders?: Omit<Borders, "insideH" | "insideV">;
  shading?: Shading;
}

export type FaceRole = "serif" | "condensed" | "mono" | "workbookUi" | "symbolGlyph";

export interface RunProps {
  /** Nama wajah apa adanya, mis. "IBM Plex Sans Cond" (research/05:13). XOR faceRole. */
  face?: string;
  /** XOR face. */
  faceRole?: FaceRole;
  szHalfPt?: HalfPt;
  color?: Hex;
  b?: boolean;
  i?: boolean;
  caps?: boolean;
  /** `w:smallCaps`; HTML `font-variant-caps: small-caps` (D-46). Delta S03-d1. */
  smallCaps?: boolean;
  /** `w:spacing w:val` (1/20 pt), boleh negatif. */
  spacingTw?: number;
  u?: "single" | "none";
  vertAlign?: "superscript" | "subscript";
}

export type Run =
  | ({ t: string } & RunProps) // teks apa adanya, termasuk spasi
  | ({ tab: true } & RunProps)
  | ({ br: "line" } & RunProps)
  | ({ field: "PAGE" | "NUMPAGES" } & RunProps);

/** oneOf: `text` (md-lite Garis A, KS-03) XOR `runs[]` (KS-02). */
export type Inline = { text: string } | { runs: Run[] };

/**
 * Format satu sel tabel beserta paragrafnya (delta S03-d1: S95-C01/C02/C03,
 * G-08/S95-C09). Semua medan opsional; yang tidak diisi jatuh ke roleFormats/default.
 */
export interface CellFormat {
  para?: ParaFormat;
  borders?: Omit<Borders, "insideH" | "insideV">;
  marginsTw?: { top?: Tw; left?: Tw; bottom?: Tw; right?: Tw };
  shading?: Shading;
  vAlign?: "top" | "center" | "bottom";
  widthTw?: Tw;
}

/**
 * Format paragraf per medan Inline-only sebuah wadah (delta S03-d1, G-06),
 * kunci = nama medan (mis. `kicker`, `title`, `lede`, `label`, `note`, `keyRow`).
 * Prioritas: fieldFormats > roleFormats templat > default katalog.
 */
export type FieldFormats = { [field: string]: ParaFormat };

export interface SpacerSpec {
  format: ParaFormat;
}

export type ParamValue = null | boolean | number | string | ParamValue[] | { [k: string]: ParamValue };
