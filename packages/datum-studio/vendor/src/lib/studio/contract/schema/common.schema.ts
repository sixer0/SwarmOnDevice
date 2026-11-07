/**
 * JSON Schema 2020-12 bersama (01_specs.md §3.10): `$defs` dipakai skema doc,
 * chart, diagram, image, html lewat `$ref` absolut ke `COMMON_SCHEMA_ID`.
 *
 * Aturan (KS-09): `additionalProperties: false` di semua objek; ekstensi hanya
 * lewat medan `x`. Kompatibel opsi ajv `{ strict: true, allErrors: true,
 * discriminator: true, allowUnionTypes: true }` (setiap `required` di subskema
 * oneOf/not mendeklarasikan propertinya, sesuai strictRequired).
 */
import { PROVENANCE_MARKS, TABLE_BLOCK_TYPES } from "../enums";

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
export const STUDIO_SCHEMA_URL_BASE = "https://hq.gsp.local/studio/schema";
export const COMMON_SCHEMA_ID = `${STUDIO_SCHEMA_URL_BASE}/common/v1.json`;

/** `$ref` ke `$defs` skema bersama. */
export function commonRef(def: string): { $ref: string } {
  return { $ref: `${COMMON_SCHEMA_ID}#/$defs/${def}` };
}

/** Tepat satu dari dua properti (strictRequired-aman). */
export function xorRequired(a: string, b: string) {
  return {
    oneOf: [
      { properties: { [a]: true }, required: [a] },
      { properties: { [b]: true }, required: [b] },
    ],
  };
}

/** Tidak boleh ada dua properti dari daftar sekaligus. */
export function atMostOne(...keys: string[]) {
  const pairs: Array<{ properties: Record<string, true>; required: string[] }> = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      pairs.push({ properties: { [keys[i]]: true, [keys[j]]: true }, required: [keys[i], keys[j]] });
    }
  }
  return { not: { anyOf: pairs } };
}

const tw = { type: "integer" } as const;
const twNonNeg = { type: "integer", minimum: 0 } as const;

/** Properti `Inline` (text XOR runs) untuk disebar ke objek lain. */
export const INLINE_PROPERTIES = {
  text: { type: "string", maxLength: 20000 },
  runs: { type: "array", items: commonRef("Run") },
} as const;

/** Properti RunProps untuk disebar ke Run. */
const RUN_PROPS_PROPERTIES = {
  face: { type: "string", minLength: 1, maxLength: 120 },
  faceRole: { enum: ["serif", "condensed", "mono", "workbookUi", "symbolGlyph"] },
  szHalfPt: { type: "integer", minimum: 8, maximum: 144 },
  color: commonRef("Hex"),
  b: { type: "boolean" },
  i: { type: "boolean" },
  caps: { type: "boolean" },
  /** Delta S03-d1 (S22). */
  smallCaps: { type: "boolean" },
  spacingTw: { type: "integer", minimum: -200, maximum: 400 },
  u: { enum: ["single", "none"] },
  vertAlign: { enum: ["superscript", "subscript"] },
} as const;

const FACE_XOR_ROLE = atMostOne("face", "faceRole");

/** Rujukan gaya paragraf `w:pStyle` header/footer (delta S03-d1, G-07). */
const STYLE_ID = { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]*$" } as const;

const BORDER_SIDES = {
  top: commonRef("BorderSpec"),
  bottom: commonRef("BorderSpec"),
  left: commonRef("BorderSpec"),
  right: commonRef("BorderSpec"),
} as const;

const CELL_PROPERTIES = {
  paragraphs: { type: "array", items: commonRef("CellParagraph") },
  text: { type: "string", maxLength: 20000 },
  runs: { type: "array", items: commonRef("Run") },
  gridSpan: { type: "integer", minimum: 1, maximum: 20 },
  vMerge: { enum: ["restart", "continue"] },
  widthTw: twNonNeg,
  borders: commonRef("BorderSides"),
  marginsTw: {
    type: "object",
    properties: { top: tw, left: tw, bottom: tw, right: tw },
    additionalProperties: false,
  },
  shading: commonRef("Shading"),
  vAlign: { enum: ["top", "center", "bottom"] },
} as const;

/** Properti TableBlock (§3.4); `rowDef` memilih Row bersarang atau daun. */
export function tableBlockProperties(rowDef: "Row" | "RowLeaf") {
  return {
    type: { enum: [...TABLE_BLOCK_TYPES] },
    blockId: { type: "string", minLength: 1, maxLength: 120 },
    caption: commonRef("Caption"),
    columns: { type: "array", minItems: 1, maxItems: 20, items: commonRef("ColumnSpec") },
    rows: { type: "array", minItems: 1, items: commonRef(rowDef) },
    source: commonRef("SourceLine"),
    sourcePlacement: { enum: ["lastRowMerged", "paragraphBelow"] },
    layout: {
      type: "object",
      properties: {
        widthTw: twNonNeg,
        indentTw: tw,
        cellMarginTw: {
          type: "object",
          properties: { left: tw, right: tw },
          required: ["left", "right"],
          additionalProperties: false,
        },
        fixed: { type: "boolean" },
        borders: commonRef("Borders"),
      },
      additionalProperties: false,
    },
    preset: { type: "string", minLength: 1, maxLength: 64 },
    format: commonRef("ParaFormat"),
    x: { type: "object" },
  } as const;
}

function rowSchema(cellDef: "Cell" | "CellLeaf") {
  return {
    type: "object",
    properties: {
      kind: { enum: ["header", "body", "group", "total"] },
      cells: { type: "array", minItems: 1, maxItems: 20, items: commonRef(cellDef) },
      cantSplit: { type: "boolean" },
      repeatHeader: { type: "boolean" },
    },
    required: ["cells"],
    additionalProperties: false,
  } as const;
}

const HEADER_FOOTER_VARIANTS = [
  {
    type: "object",
    properties: { mode: { const: "inherit" } },
    required: ["mode"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: { mode: { const: "empty" }, format: commonRef("ParaFormat"), styleId: STYLE_ID },
    required: ["mode"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      mode: { const: "runningHead" },
      left: commonRef("Inline"),
      right: commonRef("Inline"),
      format: commonRef("ParaFormat"),
      styleId: STYLE_ID,
    },
    required: ["mode"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      mode: { const: "registerBlock" },
      cells: { type: "array", items: commonRef("Inline") },
      // Delta S03-d1 (G-07, G-08/S95-C09).
      styleId: STYLE_ID,
      colsTw: { type: "array", maxItems: 20, items: twNonNeg },
      cellFormats: { type: "array", maxItems: 20, items: commonRef("CellFormat") },
      trailingFormat: commonRef("ParaFormat"),
    },
    required: ["mode"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      mode: { const: "custom" },
      paragraphs: {
        type: "array",
        items: {
          type: "object",
          properties: { runs: { type: "array", items: commonRef("Run") }, format: commonRef("ParaFormat") },
          required: ["runs"],
          additionalProperties: false,
        },
      },
      table: commonRef("TableBlock"),
      styleId: STYLE_ID,
    },
    required: ["mode"],
    additionalProperties: false,
  },
] as const;

export const commonSchema = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: COMMON_SCHEMA_ID,
  title: "Studio common/v1",
  $defs: {
    Hex: { type: "string", pattern: "^([0-9A-F]{6}|auto)$" },
    Tw: tw,
    HalfPt: { type: "integer", minimum: 8, maximum: 144 },
    Eighth: { type: "integer", minimum: 0 },
    ProvenanceMark: { enum: [...PROVENANCE_MARKS] },
    ParamValue: { type: ["null", "boolean", "number", "string", "array", "object"] },
    BorderSpec: {
      type: "object",
      properties: {
        val: { enum: ["single", "dashed", "dotted", "double", "none"] },
        sz: { type: "integer", minimum: 0 },
        color: commonRef("Hex"),
        space: { type: "integer", minimum: 0 },
      },
      required: ["val", "sz", "color"],
      additionalProperties: false,
    },
    BorderSides: { type: "object", properties: BORDER_SIDES, additionalProperties: false },
    Borders: {
      type: "object",
      properties: { ...BORDER_SIDES, insideH: commonRef("BorderSpec"), insideV: commonRef("BorderSpec") },
      additionalProperties: false,
    },
    Shading: {
      type: "object",
      properties: { fill: commonRef("Hex"), val: { const: "clear" } },
      required: ["fill", "val"],
      additionalProperties: false,
    },
    TabStop: {
      type: "object",
      properties: {
        posTw: twNonNeg,
        val: { enum: ["left", "right", "center", "decimal"] },
        leader: { enum: ["none", "dot"] },
      },
      required: ["posTw", "val"],
      additionalProperties: false,
    },
    ParaFormat: {
      type: "object",
      properties: {
        spacingBeforeTw: twNonNeg,
        spacingAfterTw: twNonNeg,
        lineTw: { type: "integer", minimum: 20, maximum: 1440 },
        lineRule: { enum: ["auto", "exact", "atLeast"] },
        jc: { enum: ["left", "right", "center", "both"] },
        indLeftTw: tw,
        indRightTw: tw,
        indHangingTw: tw,
        indFirstLineTw: tw,
        keepNext: { type: "boolean" },
        keepLines: { type: "boolean" },
        pageBreakBefore: { type: "boolean" },
        widowControl: { type: "boolean" },
        outlineLvl: { type: "integer", minimum: 0, maximum: 8 },
        tabs: { type: "array", items: commonRef("TabStop") },
        borders: commonRef("BorderSides"),
        shading: commonRef("Shading"),
      },
      additionalProperties: false,
    },
    RunProps: {
      type: "object",
      properties: RUN_PROPS_PROPERTIES,
      additionalProperties: false,
      ...FACE_XOR_ROLE,
    },
    Run: {
      type: "object",
      properties: {
        ...RUN_PROPS_PROPERTIES,
        t: { type: "string", maxLength: 20000 },
        tab: { const: true },
        br: { const: "line" },
        field: { enum: ["PAGE", "NUMPAGES"] },
      },
      additionalProperties: false,
      oneOf: [
        { properties: { t: true }, required: ["t"] },
        { properties: { tab: true }, required: ["tab"] },
        { properties: { br: true }, required: ["br"] },
        { properties: { field: true }, required: ["field"] },
      ],
      ...FACE_XOR_ROLE,
    },
    Inline: {
      type: "object",
      properties: INLINE_PROPERTIES,
      additionalProperties: false,
      ...xorRequired("text", "runs"),
    },
    CellParagraph: {
      type: "object",
      properties: { ...INLINE_PROPERTIES, format: commonRef("ParaFormat") },
      additionalProperties: false,
      ...xorRequired("text", "runs"),
    },
    Caption: {
      type: "object",
      properties: {
        label: { type: "string", minLength: 1, maxLength: 64 },
        separator: { type: "string", maxLength: 8 },
        inline: commonRef("Inline"),
        labelProps: commonRef("RunProps"),
        format: commonRef("ParaFormat"),
      },
      required: ["inline"],
      additionalProperties: false,
    },
    SourceLine: {
      type: "object",
      properties: {
        inline: commonRef("Inline"),
        provenance: { type: "array", items: commonRef("ProvenanceMark") },
        format: commonRef("ParaFormat"),
      },
      required: ["inline"],
      additionalProperties: false,
    },
    RailLine: {
      type: "object",
      properties: {
        kind: { enum: ["mark", "source", "note"] },
        mark: commonRef("ProvenanceMark"),
        label: { type: "string", maxLength: 200 },
        text: { type: "string", maxLength: 20000 },
        runs: { type: "array", items: commonRef("Run") },
        format: commonRef("ParaFormat"),
      },
      required: ["kind"],
      additionalProperties: false,
    },
    ColumnSpec: {
      type: "object",
      properties: {
        widthTw: twNonNeg,
        widthMm: { type: "number", exclusiveMinimum: 0 },
        align: { enum: ["left", "right", "center", "decimal"] },
        role: { enum: ["text", "numeral", "id", "unit", "glyph"] },
        unit: { type: "string", maxLength: 40 },
      },
      additionalProperties: false,
    },
    /** Sel yang boleh memuat tabel bersarang (kedalaman maks 1). */
    Cell: {
      type: "object",
      properties: {
        ...CELL_PROPERTIES,
        nested: commonRef("TableBlockLeaf"),
        /** Delta S03-d1 (G-04): jumlah paragraf sebelum tabel bersarang. */
        nestedIndex: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
      ...atMostOne("paragraphs", "text", "runs"),
    },
    /** Sel di dalam tabel bersarang: tanpa `nested`. */
    CellLeaf: {
      type: "object",
      properties: CELL_PROPERTIES,
      additionalProperties: false,
      ...atMostOne("paragraphs", "text", "runs"),
    },
    Row: rowSchema("Cell"),
    RowLeaf: rowSchema("CellLeaf"),
    TableBlock: {
      type: "object",
      properties: tableBlockProperties("Row"),
      required: ["type", "columns", "rows"],
      additionalProperties: false,
    },
    TableBlockLeaf: {
      type: "object",
      properties: tableBlockProperties("RowLeaf"),
      required: ["type", "columns", "rows"],
      additionalProperties: false,
    },
    /** Format sel + paragrafnya (delta S03-d1: S95-C01/C02/C03/C07, G-08). */
    CellFormat: {
      type: "object",
      properties: {
        para: commonRef("ParaFormat"),
        borders: commonRef("BorderSides"),
        marginsTw: {
          type: "object",
          properties: { top: tw, left: tw, bottom: tw, right: tw },
          additionalProperties: false,
        },
        shading: commonRef("Shading"),
        vAlign: { enum: ["top", "center", "bottom"] },
        widthTw: twNonNeg,
      },
      additionalProperties: false,
    },
    /** Format paragraf per medan Inline-only (delta S03-d1, G-06). */
    FieldFormats: {
      type: "object",
      propertyNames: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]*$", maxLength: 40 },
      maxProperties: 20,
      additionalProperties: commonRef("ParaFormat"),
    },
    HeaderFooterSpec: {
      type: "object",
      properties: { mode: { type: "string" } },
      required: ["mode"],
      discriminator: { propertyName: "mode" },
      oneOf: HEADER_FOOTER_VARIANTS,
    },
    SectionSetup: {
      type: "object",
      properties: {
        pageSizeTw: {
          type: "array",
          prefixItems: [twNonNeg, twNonNeg],
          items: false,
          minItems: 2,
        },
        marginTw: {
          type: "object",
          properties: { top: tw, bottom: tw, left: tw, right: tw, header: tw, footer: tw, gutter: tw },
          required: ["top", "bottom", "left", "right", "header", "footer", "gutter"],
          additionalProperties: false,
        },
        cols: {
          type: "object",
          properties: { num: { type: "integer", minimum: 1, maximum: 6 }, spaceTw: twNonNeg },
          required: ["num", "spaceTw"],
          additionalProperties: false,
        },
        docGridLinePitch: { type: "integer", minimum: 0 },
        titlePg: { type: "boolean" },
        header: commonRef("HeaderFooterSpec"),
        footer: commonRef("HeaderFooterSpec"),
      },
      additionalProperties: false,
    },
  },
} as const;
