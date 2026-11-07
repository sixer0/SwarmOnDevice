/**
 * JSON Schema 2020-12 bersama kontrak v2 KONTEN MURNI (`common/v2`, C32;
 * register 03_structural_sections_specs.md §4.1-§4.4). Memuat `$defs` blok,
 * bab, section, dan payload slot yang dirujuk `studio.doc/v2`,
 * `studio.chapter/v2`, dan `studio.slot/v2`.
 *
 * Aturan:
 * - Nama `$defs` = nama tipe TS register (T2-xx) agar galat ajv dapat dipetakan
 *   ke lokasi DISPLAY_FIELD/V1_FIELD (`classifySchemaV2Errors`, forbidden.ts).
 * - `additionalProperties: false` di semua objek: setiap medan tampilan
 *   (DF-01..DF-69) dan medan v1 berganti nama (VF-01..VF-14) gagal di sini.
 * - Tidak ada properti bernama parameter, `params`, `overrides`, `essentials`,
 *   `advanced`, `roleFormats` (PT-06).
 * - Kompatibel `STUDIO_AJV_OPTIONS` (strict, discriminator, allowUnionTypes);
 *   setiap `required` di subskema mendeklarasikan propertinya (strictRequired).
 */
import {
  AGENT_WORK_REPORT_STATUSES,
  CHART_CODES,
  CHART_CUSTOM_MARKS,
  CHART_CUSTOM_ORIENTATIONS,
  CHART_INTENT_LIMITS,
  CHART_INTENT_ORIENTATIONS,
  CHART_INTENT_SORTS,
  CONTRACT_EVIDENCE_KINDS,
  CONTRACT_ITEM_STATUSES,
  CONTRACT_REF_RELS,
  CONTRACT_VERDICTS,
  PARAGRAPH_ROLES_V2,
  PROVENANCE_MARKS,
  RENDER_SCOPE_NAMES,
  SYMBOL_DIALECTS,
  TABLE_BLOCK_TYPES,
} from "../../enums";
import {
  ASSET_KEY_PATTERN,
  ASSET_REF_PATTERN,
  CARD_ID_PATTERN,
  CONTRACT_ACTOR_PATTERN,
  CONTRACT_KEY_PATTERN,
  CONTRACT_LIMITS,
  CONTRACT_REPORTED_AT_PATTERN,
  CONTRACT_SHA_PREFIX_PATTERN,
  DOC_KEY_PATTERN,
  PID_PATTERN,
} from "../../env";
import { atMostOne, JSON_SCHEMA_DIALECT, STUDIO_SCHEMA_URL_BASE, xorRequired } from "../common.schema";
import { diagramSchema } from "../diagram.schema";
import { FIGURE_BOUNDS as B } from "../figure-bounds";
import { DOC_SCHEMA_ID, docSchema } from "../doc.schema";

export const COMMON_V2_SCHEMA_ID = `${STUDIO_SCHEMA_URL_BASE}/common/v2.json`;

/** `$ref` ke `$defs` skema bersama v2. */
export function commonV2Ref(def: string): { $ref: string } {
  return { $ref: `${COMMON_V2_SCHEMA_ID}#/$defs/${def}` };
}

/** `$ref` ke `$defs` `studio.doc/v1` yang dipakai ulang apa adanya (TemplateRef, MissionRef, RegisterEntry). */
export function docV1Ref(def: "TemplateRef" | "MissionRef" | "RegisterEntry"): { $ref: string } {
  return { $ref: `${DOC_SCHEMA_ID}#/$defs/${def}` };
}

const ref = commonV2Ref;
const inline = ref("InlineV2");
const bool = { type: "boolean" } as const;
const num = { type: "number" } as const;
const str = { type: "string", minLength: 1, maxLength: 200 } as const;
const pid = { type: "string", pattern: PID_PATTERN } as const;
const longText = { type: "string", minLength: 1, maxLength: 2000 } as const;
const isoDate = { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$" } as const;
const dec = { enum: [0, 1, 2, 3] } as const;
const inlineList = (min = 1) => ({ type: "array", minItems: min, items: inline }) as const;

/** Properti `InlineV2` (text XOR runs) untuk disebar ke objek lain. */
const INLINE_V2_PROPERTIES = {
  text: { type: "string", maxLength: 20000 },
  runs: { type: "array", items: ref("RunV2") },
} as const;
const INLINE_XOR = xorRequired("text", "runs");

/** Medan bersama setiap blok v2: `type` + `id?` (pid). */
const BLOCK_ID = { id: pid } as const;

/**
 * SEC-FIX2 (D-506): `$ref` + saudara (2020-12) mempersempit `runs` HANYA pada figur; `InlineV2`/`CaptionV2`/`SourceV2`
 * bersama paragraf/tabel tidak berubah, dan nama `$defs` untuk klasifikasi galat (forbidden.ts) tetap.
 */
const figureText = (def: "InlineV2" | "CaptionV2" | "SourceV2") =>
  ({ ...ref(def), type: "object", properties: { runs: { type: "array", maxItems: B.figureRuns } } }) as const;

/** Medan figur v2 (tanpa ukuran/format): caption, source, keyRow. */
const FIGURE_V2 = { caption: figureText("CaptionV2"), source: figureText("SourceV2"), keyRow: figureText("InlineV2") } as const;

function obj(properties: Record<string, unknown>, required: readonly string[] = [], extra: Record<string, unknown> = {}) {
  return { type: "object", properties, required: [...required], additionalProperties: false, ...extra } as const;
}

function shapeVariant(shape: string, properties: Record<string, unknown>, required: readonly string[]) {
  return obj({ shape: { const: shape }, ...properties }, ["shape", ...required]);
}

/** Union berdiskriminator `type` dari `$defs` v2. */
function unionOf(defs: readonly string[]) {
  return {
    type: "object",
    properties: { type: { type: "string" } },
    required: ["type"],
    discriminator: { propertyName: "type" },
    oneOf: defs.map((d) => ref(d)),
  } as const;
}

/** 11 `$defs` blok isi (T2-30), urutan register. */
export const BLOCK_V2_DEFS = [
  "ParagraphV2",
  "ListV2",
  "AsideV2",
  "MonoBlockV2",
  "AssumptionInlineV2",
  "TableV2",
  "DerivationV2",
  "ChartV2",
  "DiagramV2",
  "ImageV2",
  "SymbolSheetV2",
] as const;

/** 7 `$defs` payload slot tak-berulang (T2-44 + T2-61 `contractRecord`, AM-02 DC-05). */
export const SLOT_PAYLOAD_V2_DEFS = [
  "CoverPayloadV2",
  "ControlSheetPayloadV2",
  "SignaturePayloadV2",
  "TocPayloadV2",
  "SourceRegisterPayloadV2",
  "RuleIndexPayloadV2",
  "ContractRecordPayloadV2",
] as const;

// ── Document contract (register 05 §5.3, T2-61..T2-66; DC-05) ────────────
// Enum skema `status` = gabungan set jenis aktif (KD-32; tahap 1 = E45). Pola = konstanta C34-C38.
const contractKey = { type: "string", pattern: CONTRACT_KEY_PATTERN } as const;
const contractActor = { type: "string", pattern: CONTRACT_ACTOR_PATTERN } as const;
const contractPhaseName = { type: "string", minLength: 1, maxLength: 64 } as const;

// ── Tabel (T2-18..T2-21) ─────────────────────────────────────────────────

function cellSchema(nested: boolean) {
  return obj(
    {
      text: { type: "string", maxLength: 20000 },
      runs: { type: "array", items: ref("RunV2") },
      paragraphs: { type: "array", items: inline },
      gridSpan: { type: "integer", minimum: 1, maximum: 20 },
      vMerge: { enum: ["restart", "continue"] },
      ...(nested ? { nested: ref("TableLeafV2"), nestedIndex: { type: "integer", minimum: 0 } } : {}),
    },
    [],
    atMostOne("text", "runs", "paragraphs"),
  );
}

function rowSchema(cellDef: "CellV2" | "CellLeafV2") {
  return obj(
    {
      kind: { enum: ["header", "body", "group", "total"] },
      cells: { type: "array", minItems: 1, maxItems: 20, items: ref(cellDef) },
    },
    ["cells"],
  );
}

function tableSchema(rowDef: "RowV2" | "RowLeafV2") {
  return obj(
    {
      type: { enum: [...TABLE_BLOCK_TYPES] },
      ...BLOCK_ID,
      caption: ref("CaptionV2"),
      columns: { type: "array", minItems: 1, maxItems: 20, items: ref("ColumnV2") },
      rows: { type: "array", minItems: 1, items: ref(rowDef) },
      source: ref("SourceV2"),
      /** Jenis tabel semantik; profil lebar kolom dari templat (R-52, KC-6). */
      preset: { type: "string", minLength: 1, maxLength: 64 },
    },
    ["type", "columns", "rows"],
  );
}

// ── Diagram (T2-27) ──────────────────────────────────────────────────────

const DIAGRAM_V1_PROPS = diagramSchema.properties;
/** T2-27: StudioDiagramV1 tanpa `$schema`, `id`, `title`, `width_mm`, `apparatus`, `source` (dan `sld`). */
const DIAGRAM_SPEC_V2 = obj(
  {
    family: DIAGRAM_V1_PROPS.family,
    classification: DIAGRAM_V1_PROPS.classification,
    labels_verified: DIAGRAM_V1_PROPS.labels_verified,
    sources: DIAGRAM_V1_PROPS.sources,
    // SEC-FIX M-1 / SEC-FIX2 (D-501, D-506): semua larik berbatas di skema v1 (`FIGURE_BOUNDS`), dipakai ulang di sini.
    nodes: DIAGRAM_V1_PROPS.nodes,
    edges: DIAGRAM_V1_PROPS.edges,
    zones: DIAGRAM_V1_PROPS.zones,
    legend: DIAGRAM_V1_PROPS.legend,
    notes: DIAGRAM_V1_PROPS.notes,
    per_row: DIAGRAM_V1_PROPS.per_row,
  },
  ["family", "nodes"],
);

// ── Chart (T2-23..T2-25) ─────────────────────────────────────────────────

const highlight = {
  type: "array",
  minItems: 1,
  maxItems: 64,
  items: { anyOf: [{ type: "string", minLength: 1, maxLength: 200 }, { type: "integer", minimum: 0 }] },
} as const;

/**
 * FIG-03a (D-482 butir 2; E58, E59, C61): medan maksud analitis blok chart. Kecocokan
 * `labelShort[].label` dengan kategori data diperiksa mesin (SCHEMA_INVALID ber-pointer).
 */
const CHART_INTENT_V2 = {
  orientation: { enum: [...CHART_INTENT_ORIENTATIONS] },
  sort: { enum: [...CHART_INTENT_SORTS] },
  topN: { type: "integer", minimum: CHART_INTENT_LIMITS.topNMin, maximum: CHART_INTENT_LIMITS.topNMax },
  otherLabel: { type: "string", minLength: 1, maxLength: CHART_INTENT_LIMITS.otherLabelMax },
  labelShort: { type: "array", minItems: 1, maxItems: CHART_INTENT_LIMITS.labelShortItemsMax, items: ref("ChartLabelShortV2") },
} as const;

/**
 * T2-24: shape ChartData v1 tanpa `accent` (VF-12). SEC-FIX M-1 (D-501): `maxItems` = `FIGURE_LIMITS` route pratinjau
 * (`documents/[id]/figures/preview/_lib/limits.ts`, dikunci uji secfix-chart-maxitems): kapasitas mesin terukur.
 */
const CHART_DATA_V2 = {
  type: "object",
  properties: { shape: { type: "string", maxLength: 32 } },
  required: ["shape"],
  discriminator: { propertyName: "shape" },
  oneOf: [
    shapeVariant(
      "categorical",
      { points: { type: "array", minItems: 1, maxItems: 200, items: obj({ label: str, value: num, sub: { type: "string", maxLength: 200 }, target: num }, ["label", "value"]) } },
      ["points"],
    ),
    shapeVariant(
      "series",
      {
        categories: { type: "array", minItems: 1, maxItems: 200, items: str },
        series: {
          type: "array",
          minItems: 1,
          maxItems: 24,
          items: obj({ name: str, values: { type: "array", maxItems: 200, items: { type: ["number", "null"] } } }, ["name", "values"]),
        },
      },
      ["categories", "series"],
    ),
    shapeVariant(
      "xy",
      {
        points: {
          type: "array",
          minItems: 1,
          maxItems: 2000,
          items: obj({ x: num, y: num, size: num, label: { type: "string", maxLength: 200 }, group: str }, ["x", "y"]),
        },
        divider: obj({ x: num, y: num }, [], { minProperties: 1 }),
      },
      ["points"],
    ),
    shapeVariant(
      "matrix",
      {
        rows: { type: "array", minItems: 1, maxItems: 200, items: str },
        cols: { type: "array", minItems: 1, maxItems: 200, items: str },
        values: { type: "array", maxItems: 200, items: { type: "array", maxItems: 200, items: num } },
      },
      ["rows", "cols", "values"],
    ),
    shapeVariant(
      "intervals",
      {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: obj(
            { label: str, start: { type: ["number", "string"], maxLength: 200 }, end: { type: ["number", "string"], maxLength: 200 }, group: str, milestone: bool },
            ["label", "start", "end"],
          ),
        },
      },
      ["items"],
    ),
    shapeVariant(
      "graph",
      {
        nodes: { type: "array", minItems: 1, maxItems: 200, items: obj({ id: str, label: str, value: num, group: str }, ["id", "label"]) },
        links: { type: "array", maxItems: 400, items: obj({ from: str, to: str, value: num }, ["from", "to"]) },
      },
      ["nodes", "links"],
    ),
    shapeVariant(
      "distribution",
      {
        groups: { type: "array", minItems: 1, maxItems: 50, items: obj({ name: str, values: { type: "array", maxItems: 5000, items: num } }, ["name", "values"]) },
        binEdges: { type: "array", minItems: 2, maxItems: 201, items: num },
        sectors: { type: "integer", minimum: 4, maximum: 72 },
      },
      ["groups"],
    ),
    shapeVariant(
      "tiles",
      {
        tiles: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: obj({ code: str, row: { type: "integer" }, col: { type: "integer" }, value: num, label: str }, ["code", "row", "col"]),
        },
        flows: { type: "array", maxItems: 400, items: obj({ from: str, to: str, value: num }, ["from", "to", "value"]) },
        dots: { type: "array", maxItems: 1000, items: obj({ tile: str, dx: num, dy: num, label: str }, ["tile"]) },
      },
      ["tiles"],
    ),
    shapeVariant(
      "ohlc",
      { points: { type: "array", minItems: 1, maxItems: 200, items: obj({ t: str, o: num, h: num, l: num, c: num }, ["t", "o", "h", "l", "c"]) } },
      ["points"],
    ),
    shapeVariant(
      "sets",
      {
        sets: { type: "array", minItems: 1, maxItems: 16, items: obj({ name: str, size: num }, ["name", "size"]) },
        overlaps: { type: "array", maxItems: 256, items: obj({ sets: { type: "array", minItems: 2, maxItems: B.sets, items: str }, size: num }, ["sets", "size"]) },
      },
      ["sets", "overlaps"],
    ),
    shapeVariant("steps", { spec: ref("DiagramSpecV2") }, ["spec"]),
  ],
} as const;

// ── Halaman depan dan slot (T2-33..T2-45) ────────────────────────────────

/** Daftar bertipe ATAU `TableV2` konten-saja (KD-19). */
function listOrTable(entryDef: string) {
  return { oneOf: [{ type: "array", minItems: 1, maxItems: 200, items: ref(entryDef) }, ref("TableV2")] } as const;
}

const DOC_META_V1_PROPS = docSchema.$defs.DocMeta.properties;

export const commonV2Schema = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: COMMON_V2_SCHEMA_ID,
  title: "Studio common/v2 (konten murni)",
  $defs: {
    // ── Bentuk bersama (T2-01..T2-12) ──
    RunV2: {
      type: "object",
      properties: {
        t: { type: "string", maxLength: 20000 },
        strong: bool,
        em: bool,
        code: bool,
        sup: bool,
        sub: bool,
        tab: { const: true },
        br: { const: "line" },
      },
      additionalProperties: false,
      oneOf: [
        { properties: { t: true }, required: ["t"] },
        { properties: { tab: true }, required: ["tab"] },
        { properties: { br: true }, required: ["br"] },
      ],
      // Penanda makna hanya pada run teks; `sup` dan `sub` tidak keduanya true.
      if: { not: { properties: { t: true }, required: ["t"] } },
      then: { properties: { strong: false, em: false, code: false, sup: false, sub: false } },
      not: { properties: { sup: { const: true }, sub: { const: true } }, required: ["sup", "sub"] },
    },
    InlineV2: { type: "object", properties: { ...INLINE_V2_PROPERTIES }, additionalProperties: false, ...INLINE_XOR },
    CaptionV2: { type: "object", properties: { ...INLINE_V2_PROPERTIES }, additionalProperties: false, ...INLINE_XOR },
    SourceV2: {
      type: "object",
      properties: {
        ...INLINE_V2_PROPERTIES,
        provenance: { type: "array", minItems: 1, maxItems: PROVENANCE_MARKS.length, uniqueItems: true, items: { enum: [...PROVENANCE_MARKS] } },
      },
      additionalProperties: false,
      ...INLINE_XOR,
    },
    RailLineV2: {
      type: "object",
      properties: { kind: { enum: ["mark", "source", "note"] }, mark: { enum: [...PROVENANCE_MARKS] }, ...INLINE_V2_PROPERTIES },
      required: ["kind"],
      additionalProperties: false,
      ...atMostOne("text", "runs"),
    },
    AssetInputV2: {
      oneOf: [
        obj({ assetRef: { type: "string", pattern: ASSET_REF_PATTERN } }, ["assetRef"]),
        obj({ mime: { enum: ["image/png", "image/jpeg"] }, dataBase64: { type: "string", minLength: 1 } }, ["mime", "dataBase64"]),
      ],
    },
    DocMetaV2: obj({ ...DOC_META_V1_PROPS }),
    DocTargetV2: obj(
      {
        documentId: { type: "string", minLength: 1, maxLength: 64 },
        docNumber: DOC_META_V1_PROPS.docNumber,
        mission: docV1Ref("MissionRef"),
        docKey: { type: "string", pattern: DOC_KEY_PATTERN, maxLength: 64 },
      },
      [],
      { minProperties: 1 },
    ),
    ChangeV2: obj({ what: longText, why: longText, impact: longText }, ["what", "why", "impact"]),
    RenderRequestV2: obj({
      scope: { enum: [...RENDER_SCOPE_NAMES] },
      key: { type: "string", minLength: 1, maxLength: 64 },
      formats: { type: "array", uniqueItems: true, items: { enum: ["docx", "pdf", "html"] } },
      figures: { type: "array", uniqueItems: true, items: { enum: ["svg", "png"] } },
      revisionNo: { type: "integer", minimum: 1 },
    }),
    // IMPL-W4: `label` = penomoran sumber (judul dicetak apa adanya, label Tabel/Gambar = label.n).
    OutlineEntryV2: obj({ key: { type: "string", minLength: 1, maxLength: 16 }, title: inline, label: { type: "string", pattern: "^[A-Za-z0-9]{1,8}$" } }, ["key"]),
    PartV2: obj({ id: { type: "string", pattern: "^P[1-9][0-9]?$" }, title: inline, lede: inline }, ["id", "title"]),

    // ── Blok (T2-13..T2-30) ──
    ParagraphV2: {
      type: "object",
      properties: {
        type: { const: "paragraph" },
        ...BLOCK_ID,
        ...INLINE_V2_PROPERTIES,
        role: { enum: [...PARAGRAPH_ROLES_V2] },
        rail: { type: "array", items: ref("RailLineV2") },
      },
      required: ["type"],
      additionalProperties: false,
      ...INLINE_XOR,
    },
    ListItemV2: {
      type: "object",
      properties: { ...INLINE_V2_PROPERTIES, rail: { type: "array", items: ref("RailLineV2") } },
      additionalProperties: false,
      ...INLINE_XOR,
    },
    ListV2: obj(
      { type: { const: "list" }, ...BLOCK_ID, ordered: bool, items: { type: "array", minItems: 1, items: ref("ListItemV2") } },
      ["type", "items"],
    ),
    AsideV2: obj(
      {
        type: { const: "aside" },
        ...BLOCK_ID,
        variant: { enum: ["generic", "doctrine", "story", "quickCheck", "ifInDoubt"] },
        label: inline,
        body: inlineList(),
      },
      ["type", "variant", "body"],
    ),
    MonoBlockV2: obj({ type: { const: "monoBlock" }, ...BLOCK_ID, label: inline, lines: inlineList() }, ["type", "label", "lines"]),
    AssumptionInlineV2: {
      type: "object",
      properties: {
        type: { const: "assumptionInline" },
        ...BLOCK_ID,
        ...INLINE_V2_PROPERTIES,
        asmId: { type: "string", pattern: "^ASM-[A-Za-z0-9]+-[0-9]{2,}$" },
        impact: longText,
      },
      required: ["type", "asmId", "impact"],
      additionalProperties: false,
      ...INLINE_XOR,
    },
    ColumnV2: obj({ role: { enum: ["text", "numeral", "id", "unit", "glyph"] }, unit: { type: "string", minLength: 1, maxLength: 40 } }),
    CellV2: cellSchema(true),
    CellLeafV2: cellSchema(false),
    RowV2: rowSchema("CellV2"),
    RowLeafV2: rowSchema("CellLeafV2"),
    TableV2: tableSchema("RowV2"),
    TableLeafV2: tableSchema("RowLeafV2"),
    DerivationV2: obj(
      {
        type: { const: "derivation" },
        ...BLOCK_ID,
        title: inline,
        intro: inline,
        lines: {
          type: "array",
          minItems: 1,
          items: obj(
            {
              label: inline,
              value: { oneOf: [inline, obj({ registerKey: { type: "string", minLength: 1 }, dec }, ["registerKey"])] },
              mark: { enum: [...PROVENANCE_MARKS] },
            },
            ["label"],
          ),
        },
        result: obj(
          { label: inline, expr: longText, registerKey: { type: "string", minLength: 1 }, tol: { type: "number", minimum: 0 } },
          ["label", "expr", "registerKey"],
        ),
        verdict: obj(
          { label: inline, registerKey: { type: "string", minLength: 1 }, limit: num, direction: { enum: ["lessOrEqual", "greaterOrEqual"] } },
          ["label", "registerKey", "limit"],
        ),
        closing: inline,
      },
      ["type", "title", "lines", "closing"],
    ),
    DiagramSpecV2: DIAGRAM_SPEC_V2,
    ChartDataV2: CHART_DATA_V2,
    ChartPanelV2: obj(
      {
        name: str,
        code: { enum: [...CHART_CODES] },
        data: ref("ChartDataV2"),
        highlight,
        unit: { type: "string", maxLength: 40 },
        dec,
        limit: obj({ value: num, label: { type: "string", maxLength: 200 } }, ["value"]),
        caption: { type: "string", maxLength: 300 },
        axisNote: { type: "string", maxLength: 200 },
      },
      ["name", "code", "data"],
    ),
    ChartV2: obj(
      {
        type: { const: "chart" },
        ...BLOCK_ID,
        // AM-03 (DC-05): `custom` + `form` berbatas (T2-66); aturan pasangan di `allOf` (CH-05).
        code: { enum: [...CHART_CODES, "composite", "custom"] },
        form: ref("ChartCustomFormV2"),
        data: ref("ChartDataV2"),
        panels: { type: "array", minItems: 1, maxItems: 24, items: ref("ChartPanelV2") },
        artifactId: { type: "string", minLength: 1, maxLength: 64 },
        highlight,
        unit: { type: "string", maxLength: 40 },
        dec,
        limit: obj({ value: num, label: { type: "string", maxLength: 200 } }, ["value"]),
        note: { type: "string", maxLength: 2000 },
        // FIG-03a (D-482 butir 2): maksud analitis opsional (konten, bukan tampilan).
        ...CHART_INTENT_V2,
        ...FIGURE_V2,
      },
      ["type", "code", "caption", "source"],
      {
        // FIG-03a: `otherLabel` hanya bermakna bersama `topN`.
        dependentRequired: { otherLabel: ["topN"] },
        oneOf: [
          { properties: { data: true }, required: ["data"] },
          { properties: { panels: true }, required: ["panels"] },
          { properties: { artifactId: true }, required: ["artifactId"] },
        ],
        if: { properties: { code: { const: "composite" } }, required: ["code"] },
        then: { properties: { panels: true }, required: ["panels"] },
        // CH-05: `custom` wajib `form` + `data` (oneOf di atas lalu melarang panels/artifactId);
        // `form` terlarang pada kode lain.
        allOf: [
          {
            if: { properties: { code: { const: "custom" } }, required: ["code"] },
            then: { properties: { form: true, data: true }, required: ["form", "data"] },
            else: { not: { properties: { form: true }, required: ["form"] } },
          },
        ],
      },
    ),
    ChartLabelShortV2: obj(
      { label: str, short: { type: "string", minLength: 1, maxLength: CHART_INTENT_LIMITS.labelShortMax } },
      ["label", "short"],
    ),
    ChartCustomFormV2: obj(
      {
        mark: { enum: [...CHART_CUSTOM_MARKS] },
        orientation: { enum: [...CHART_CUSTOM_ORIENTATIONS] },
        stacked: bool,
      },
      ["mark"],
    ),
    DiagramV2: obj(
      {
        type: { const: "diagram" },
        ...BLOCK_ID,
        spec: ref("DiagramSpecV2"),
        artifactId: { type: "string", minLength: 1, maxLength: 64 },
        ...FIGURE_V2,
      },
      ["type", "caption", "source"],
      xorRequired("spec", "artifactId"),
    ),
    ImageV2: obj(
      {
        type: { const: "image" },
        ...BLOCK_ID,
        asset: { type: "string", maxLength: 71, anyOf: [{ pattern: ASSET_KEY_PATTERN }, { pattern: ASSET_REF_PATTERN }] },
        ...FIGURE_V2,
      },
      ["type", "asset", "caption", "source"],
    ),
    SymbolSheetV2: obj(
      { type: { const: "symbolSheet" }, ...BLOCK_ID, dialect: { enum: [...SYMBOL_DIALECTS] }, ...FIGURE_V2 },
      ["type", "dialect", "caption", "source"],
    ),
    BlockV2: unionOf(BLOCK_V2_DEFS),

    // ── Bab dan section (T2-31, T2-32) ──
    SectionV2: obj({ id: pid, title: inline, blocks: { type: "array", items: ref("BlockV2") } }, ["title", "blocks"]),
    ChapterV2: obj(
      {
        // Pola C33a/C33b per jenis slot ditegakkan layanan (422 CHAPTER_KEY_INVALID).
        key: { type: "string", minLength: 1, maxLength: 16 },
        id: pid,
        title: inline,
        shortTitle: { type: "string", minLength: 1, maxLength: 80 },
        partId: { type: "string", pattern: "^P[1-9][0-9]?$" },
        intro: { type: "array", items: ref("BlockV2") },
        sections: { type: "array", items: ref("SectionV2") },
      },
      ["key", "title", "sections"],
    ),

    // ── Payload slot (T2-33..T2-44) ──
    CoverPayloadV2: obj(
      {
        type: { const: "cover" },
        tagline: inline,
        titleLines: { type: "array", minItems: 1, maxItems: 4, items: inline },
        standfirst: inline,
        scopeLine: inline,
        addressLine: inline,
        control: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "array", prefixItems: [inline, inline, inline, inline], items: false, minItems: 4 },
        },
        colophon: obj({ left: inline, right: inline }, ["left", "right"]),
        identityString: inline,
      },
      ["type"],
    ),
    RevisionEntryV2: obj(
      { rev: { type: "string", minLength: 1, maxLength: 16 }, date: isoDate, what: longText, by: str },
      ["rev", "date", "what", "by"],
    ),
    VerificationEntryV2: obj({ layer: { type: "string", minLength: 1, maxLength: 16 }, role: str, name: str, date: isoDate }, [
      "layer",
      "role",
      "name",
    ]),
    DistributionEntryV2: obj({ copy: { type: "string", minLength: 1, maxLength: 16 }, holder: str }, ["copy", "holder"]),
    ControlSheetPayloadV2: obj(
      {
        type: { const: "controlSheet" },
        title: inline,
        revisionHistory: listOrTable("RevisionEntryV2"),
        verificationChain: listOrTable("VerificationEntryV2"),
        methodStatement: inline,
        distribution: listOrTable("DistributionEntryV2"),
      },
      ["type"],
    ),
    SignaturePayloadV2: obj(
      {
        type: { const: "signatureBlock" },
        roles: { type: "array", minItems: 1, maxItems: 8, items: obj({ role: inline, holder: inline, date: inline }, ["role", "holder"]) },
      },
      ["type", "roles"],
    ),
    ContentSlotPayloadV2: obj(
      {
        type: { const: "chapter" },
        outline: { type: "array", maxItems: 999, items: ref("OutlineEntryV2") },
        parts: { type: "array", maxItems: 99, items: ref("PartV2") },
        chapters: { type: "array", items: ref("ChapterV2") },
      },
      ["type"],
    ),
    AppendixSlotPayloadV2: obj(
      {
        type: { const: "appendix" },
        outline: { type: "array", maxItems: 26, items: ref("OutlineEntryV2") },
        chapters: { type: "array", maxItems: 26, items: ref("ChapterV2") },
      },
      ["type"],
    ),
    TocPayloadV2: obj(
      {
        type: { const: "toc" },
        entries: {
          type: "array",
          items: obj(
            { level: { enum: ["part", "chapter", "appendix"] }, label: inline, title: inline, page: { type: "string", maxLength: 16 } },
            ["level", "title", "page"],
          ),
        },
      },
      ["type"],
    ),
    SourceRegisterPayloadV2: obj(
      {
        type: { const: "sourceRegister" },
        entries: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: obj(
            {
              id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,31}$" },
              citation: inline,
              kind: { type: "string", minLength: 1, maxLength: 40 },
              url: { type: "string", maxLength: 2000, pattern: "^[A-Za-z][A-Za-z0-9+.-]*:\\S+$" },
              accessed: isoDate,
            },
            ["id", "citation"],
          ),
        },
      },
      ["type", "entries"],
    ),
    RuleIndexPayloadV2: obj({ type: { const: "ruleIndex" } }, ["type"]),
    // ── Payload contractRecord (T2-61..T2-65, register 05 §5.3; tanpa medan `kind`, KD-30) ──
    ContractRecordPayloadV2: obj(
      {
        type: { const: "contractRecord" },
        status: { enum: [...AGENT_WORK_REPORT_STATUSES] },
        verdict: { enum: [...CONTRACT_VERDICTS] },
        owner: contractActor,
        initiator: contractActor,
        taskRef: contractKey,
        reportedAt: { type: "string", pattern: CONTRACT_REPORTED_AT_PATTERN },
        due: isoDate,
        phase: ref("ContractPhaseV2"),
        cardIds: {
          type: "array",
          maxItems: CONTRACT_LIMITS.cardIds,
          uniqueItems: true,
          items: { type: "string", pattern: CARD_ID_PATTERN },
        },
        refs: { type: "array", maxItems: CONTRACT_LIMITS.refs, items: ref("ContractRefV2") },
        evidence: { type: "array", maxItems: CONTRACT_LIMITS.evidence, items: ref("ContractEvidenceV2") },
        items: { type: "array", maxItems: CONTRACT_LIMITS.items, items: ref("ContractItemV2") },
      },
      ["type", "status", "reportedAt"],
    ),
    ContractPhaseV2: obj({ from: contractPhaseName, to: contractPhaseName }, ["to"]),
    ContractRefV2: obj(
      {
        documentId: { type: "string", pattern: "^[a-z0-9]{20,40}$" },
        docNumber: { type: "string", minLength: 1, maxLength: 80 },
        pid,
        revisionNo: { type: "integer", minimum: 1 },
        rel: { enum: [...CONTRACT_REF_RELS] },
      },
      ["rel"],
      xorRequired("documentId", "docNumber"),
    ),
    ContractEvidenceV2: obj(
      {
        kind: { enum: [...CONTRACT_EVIDENCE_KINDS] },
        ref: { type: "string", minLength: 1, maxLength: CONTRACT_LIMITS.refText },
        sha256: { type: "string", pattern: CONTRACT_SHA_PREFIX_PATTERN },
        bytes: { type: "integer", minimum: 0 },
        line: { type: "integer", minimum: 1 },
        exitCode: { type: "integer", minimum: -2147483648, maximum: 2147483647 },
        item: contractKey,
        note: inline,
      },
      ["kind", "ref"],
      {
        allOf: [
          {
            if: { properties: { kind: { not: { const: "file" } } } },
            then: { not: { properties: { line: true }, required: ["line"] } },
          },
          {
            if: { properties: { kind: { not: { const: "command" } } } },
            then: { not: { properties: { exitCode: true }, required: ["exitCode"] } },
          },
        ],
      },
    ),
    ContractItemV2: obj(
      {
        key: contractKey,
        title: inline,
        status: { enum: [...CONTRACT_ITEM_STATUSES] },
        owner: contractActor,
        phase: contractPhaseName,
        due: isoDate,
        dependsOn: { type: "array", maxItems: CONTRACT_LIMITS.dependsOn, uniqueItems: true, items: contractKey },
      },
      ["key", "title", "status"],
    ),
    SlotPayloadV2: unionOf(SLOT_PAYLOAD_V2_DEFS),
    /** Nilai `sections.<slotKey>` dokumen v2: slot tak-berulang atau berulang. */
    DocSectionPayloadV2: unionOf([...SLOT_PAYLOAD_V2_DEFS, "ContentSlotPayloadV2", "AppendixSlotPayloadV2"]),

    // ── Peta bersama kiriman ──
    AssetMapV2: {
      type: "object",
      maxProperties: 200,
      propertyNames: { pattern: ASSET_KEY_PATTERN },
      additionalProperties: ref("AssetInputV2"),
    },
    RegisterMapV2: { type: "object", additionalProperties: docV1Ref("RegisterEntry") },
  },
} as const;
