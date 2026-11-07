/**
 * JSON Schema 2020-12 `studio.doc/v1` (01_specs.md §3.3-3.4, §3.10).
 * Union blok = `oneOf` berdiskriminator `type` (opsi ajv `discriminator: true`).
 * Aturan isi (pola nomor dokumen P3-18, daftar typeCode P3-20, jumlah sel =
 * kolom, rujukan register) ditegakkan layanan/lint, bukan skema, karena
 * bergantung pada parameter templat kelas K.
 */
import { PROVENANCE_MARKS, STUDIO_TIERS, SYMBOL_DIALECTS } from "../enums";
import { CHART_SCHEMA_ID } from "./chart.schema";
import {
  commonRef,
  INLINE_PROPERTIES,
  JSON_SCHEMA_DIALECT,
  STUDIO_SCHEMA_URL_BASE,
  tableBlockProperties,
  xorRequired,
} from "./common.schema";
import { DIAGRAM_SCHEMA_ID } from "./diagram.schema";
import { FIGURE_BOUNDS as B } from "./figure-bounds";

export const DOC_SCHEMA_ID = `${STUDIO_SCHEMA_URL_BASE}/studio.doc/v1.json`;

function docRef(def: string): { $ref: string } {
  return { $ref: `${DOC_SCHEMA_ID}#/$defs/${def}` };
}

const inline = commonRef("Inline");
const paraFormat = commonRef("ParaFormat");

/** Medan bersama setiap blok isi (§3.4). */
const BLOCK_COMMON = {
  blockId: { type: "string", minLength: 1, maxLength: 120 },
  format: paraFormat,
  runDefaults: commonRef("RunProps"),
  /** Delta S03-d1 (G-06). */
  fieldFormats: commonRef("FieldFormats"),
  x: { type: "object" },
} as const;

/** Medan FigureCommon (§3.4). */
const FIGURE_COMMON = {
  caption: commonRef("Caption"),
  keyRow: inline,
  source: commonRef("SourceLine"),
  widthMm: { type: "number", exclusiveMinimum: 0, maximum: 400 },
  heightMm: { type: "number", exclusiveMinimum: 0, maximum: 400 },
  paragraphFormat: paraFormat,
} as const;
const FIGURE_REQUIRED = ["caption", "source", "widthMm"] as const;

/**
 * SEC-FIX2 (D-506): blok chart/diagram v1 = `BLOCK_COMMON` + `FIGURE_COMMON` dengan larik teks berbatas. `$ref` +
 * saudara (2020-12) mempersempit `runs`/`tabs`/`provenance` HANYA pada blok figur; definisi bersama tidak berubah.
 */
const figPara = { ...paraFormat, type: "object", properties: { tabs: { type: "array", maxItems: B.figureTabs } } } as const;
const figInline = { ...inline, type: "object", properties: { runs: { type: "array", maxItems: B.figureRuns } } } as const;
const FIGURE_BOUNDED = {
  format: figPara,
  paragraphFormat: figPara,
  fieldFormats: { ...commonRef("FieldFormats"), type: "object", additionalProperties: figPara },
  keyRow: figInline,
  caption: { ...commonRef("Caption"), type: "object", properties: { inline: figInline, format: figPara } },
  source: {
    ...commonRef("SourceLine"),
    type: "object",
    properties: { inline: figInline, format: figPara, provenance: { type: "array", maxItems: PROVENANCE_MARKS.length } },
  },
} as const;

const PARAGRAPH_ROLES = [
  "body",
  "identity",
  "anchor",
  "pivot",
  "closingAction",
  "lede",
  "subheading",
  "note",
  "kicker",
  "pageTitle",
  "blockHeading",
  "addressLine",
  "title",
  "standfirst",
  "scopeLine",
  "methodStatement",
] as const;

const artifactRef = {
  type: "object",
  properties: { artifactId: { type: "string", minLength: 1, maxLength: 64 } },
  required: ["artifactId"],
  additionalProperties: false,
} as const;

/** Daftar `$defs` blok untuk union berdiskriminator. */
const CONTENT_BLOCK_DEFS = [
  "ParagraphBlock",
  "ListBlock",
  "AsideBlock",
  "MonoBlock",
  "AssumptionInlineBlock",
  "TableFamilyBlock",
  "DerivationBlock",
  "ChartBlock",
  "DiagramBlock",
  "ImageBlock",
  "SymbolSheetBlock",
] as const;

function unionOf(defs: readonly string[]) {
  return {
    type: "object",
    properties: { type: { type: "string" } },
    required: ["type"],
    discriminator: { propertyName: "type" },
    oneOf: defs.map((d) => docRef(d)),
  } as const;
}

const setup = commonRef("SectionSetup");
const colsTw = { type: "array", maxItems: 20, items: { type: "integer", minimum: 0 } } as const;
const cellFormat = commonRef("CellFormat");
const fieldFormats = commonRef("FieldFormats");

export const docSchema = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: DOC_SCHEMA_ID,
  title: "studio.doc/v1",
  type: "object",
  properties: {
    $schema: { const: "studio.doc/v1" },
    template: docRef("TemplateRef"),
    mission: docRef("MissionRef"),
    meta: docRef("DocMeta"),
    register: { type: "object", additionalProperties: docRef("RegisterEntry") },
    overrides: { type: "object", additionalProperties: commonRef("ParamValue") },
    front: {
      type: "object",
      properties: {
        cover: docRef("FrontPage"),
        controlSheet: docRef("FrontPage"),
        toc: docRef("TocSpec"),
        signature: docRef("SignatureBlock"),
      },
      additionalProperties: false,
    },
    parts: { type: "array", items: docRef("PartSpec") },
    chapters: { type: "array", minItems: 1, items: docRef("Chapter") },
    appendices: { type: "array", items: docRef("Chapter") },
    assets: { type: "object", maxProperties: 200, additionalProperties: docRef("AssetRef") },
    outputs: { type: "array", uniqueItems: true, items: { enum: ["docx", "pdf", "html"] } },
    x: { type: "object" },
  },
  required: ["$schema", "template", "meta", "chapters"],
  additionalProperties: false,
  $defs: {
    StudioIngestRequest: {
      type: "object",
      properties: {
        agentId: { type: "string", maxLength: 80 },
        document: { $ref: DOC_SCHEMA_ID },
        render: {
          type: "object",
          properties: {
            formats: { type: "array", uniqueItems: true, items: { enum: ["docx", "pdf", "html"] } },
            figures: { type: "array", uniqueItems: true, items: { enum: ["svg", "png"] } },
          },
          additionalProperties: false,
        },
      },
      required: ["document"],
      additionalProperties: false,
    },
    TemplateRef: {
      type: "object",
      properties: {
        slug: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 },
        version: { type: "integer", minimum: 1 },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    MissionRef: {
      type: "object",
      properties: {
        folder: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}[_-][a-z0-9][a-z0-9_-]{0,80}$" },
        agentRequestId: { type: "string", minLength: 1, maxLength: 64 },
        hermesTaskId: { type: "string", minLength: 1, maxLength: 64 },
      },
      additionalProperties: false,
    },
    DocMeta: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 300 },
        docNumber: { type: "string", minLength: 1, maxLength: 64, pattern: "^[0-9A-Za-z][0-9A-Za-z/._-]*$" },
        rev: { type: "string", pattern: "^[A-Z]{1,2}$" },
        typeCode: { type: "string", pattern: "^[A-Z]{2,4}$" },
        tier: { enum: [...STUDIO_TIERS] },
        classification: { type: "string", minLength: 1, maxLength: 64 },
        language: { enum: ["ID", "EN"] },
        author: { type: "string", minLength: 1, maxLength: 200 },
        issueDate: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$" },
        custodian: { type: "string", maxLength: 200 },
        audience: { type: "string", maxLength: 300 },
        basis: { type: "string", maxLength: 300 },
        subject: { type: "string", maxLength: 300 },
        urgency: { enum: ["kilat", "sangat segera", "segera", "biasa"] },
        issueNumber: { type: "integer", minimum: 1 },
        copyControl: { type: "string", maxLength: 200 },
      },
      required: ["title", "rev", "typeCode", "tier", "classification", "language", "author", "issueDate"],
      additionalProperties: false,
    },
    RegisterEntry: {
      type: "object",
      properties: {
        v: { type: "number" },
        dec: { enum: [0, 1, 2, 3] },
        unit: { type: "string", minLength: 1, maxLength: 40 },
        mark: { enum: [...PROVENANCE_MARKS] },
        src: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["v", "dec", "unit", "mark", "src"],
      additionalProperties: false,
    },
    AssetRef: {
      type: "object",
      properties: {
        kind: { const: "raster" },
        mime: { enum: ["image/png", "image/jpeg"] },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        path: { type: "string", minLength: 1, maxLength: 260 },
        dataBase64: { type: "string" },
        widthPx: { type: "integer", minimum: 1 },
        heightPx: { type: "integer", minimum: 1 },
      },
      required: ["kind", "mime", "sha256"],
      additionalProperties: false,
    },
    FrontPage: {
      type: "object",
      properties: {
        mode: { enum: ["auto", "explicit"] },
        data: { oneOf: [docRef("CoverData"), docRef("ControlSheetData")] },
        body: { type: "array", items: docRef("FrontItem") },
        setup,
      },
      required: ["mode"],
      additionalProperties: false,
    },
    FrontItem: unionOf([...CONTENT_BLOCK_DEFS, "SpacerBlock", "DeviceBlock", "SignatureBlock", "ControlBlock", "Colophon"]),
    FlowItem: unionOf([...CONTENT_BLOCK_DEFS, "SpacerBlock", "DeviceBlock"]),
    CoverData: {
      type: "object",
      properties: {
        kicker: inline,
        titleLines: { type: "array", minItems: 1, items: inline },
        standfirst: inline,
        scopeLine: inline,
        addressLine: inline,
        control: docRef("ControlBlock"),
        colophon: docRef("Colophon"),
        identityString: inline,
      },
      required: ["titleLines"],
      additionalProperties: false,
    },
    ControlSheetData: {
      type: "object",
      properties: {
        kicker: inline,
        title: inline,
        revisionHistory: commonRef("TableBlock"),
        verificationChain: commonRef("TableBlock"),
        methodStatement: inline,
        distribution: commonRef("TableBlock"),
      },
      required: ["title"],
      additionalProperties: false,
    },
    ControlBlock: {
      type: "object",
      properties: {
        type: { const: "controlBlock" },
        rows: {
          type: "array",
          items: { type: "array", prefixItems: [inline, inline, inline, inline], items: false, minItems: 4 },
        },
        colsTw: { type: "array", items: { type: "integer", minimum: 0 } },
        // Delta S03-d1 (S95-C02).
        firstRowCell: cellFormat,
        rowCell: cellFormat,
      },
      required: ["type", "rows"],
      additionalProperties: false,
    },
    Colophon: {
      type: "object",
      properties: {
        type: { const: "colophon" },
        left: inline,
        right: inline,
        // Delta S03-d1 (S95-C07).
        colsTw,
        cellFormats: { type: "array", maxItems: 2, items: cellFormat },
      },
      required: ["type", "left", "right"],
      additionalProperties: false,
    },
    SignatureBlock: {
      type: "object",
      properties: {
        type: { const: "signatureBlock" },
        roles: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { role: inline, holder: inline, date: inline },
            required: ["role", "holder"],
            additionalProperties: false,
          },
        },
        signRowFormat: paraFormat,
        colsTw: { type: "array", items: { type: "integer", minimum: 0 } },
        // Delta S03-d1 (G-03, S95-C03).
        rowOrder: {
          type: "array",
          uniqueItems: true,
          minItems: 1,
          maxItems: 4,
          items: { enum: ["role", "sign", "holder", "date"] },
        },
        cellFormats: {
          type: "object",
          properties: { role: cellFormat, sign: cellFormat, holder: cellFormat, date: cellFormat },
          additionalProperties: false,
        },
      },
      required: ["type", "roles"],
      additionalProperties: false,
    },
    TocEntry: {
      type: "object",
      properties: {
        level: { enum: ["part", "chapter", "appendix"] },
        label: inline,
        title: inline,
        page: { type: "string", maxLength: 16 },
      },
      required: ["level", "label", "title", "page"],
      additionalProperties: false,
    },
    TocSpec: {
      type: "object",
      properties: {
        mode: { enum: ["field", "static"] },
        kicker: inline,
        title: inline,
        note: inline,
        entries: { type: "array", items: docRef("TocEntry") },
        sealBand: docRef("DeviceBlock"),
        setup,
        // Delta S03-d1 (S95-C06, G-06).
        colsTw,
        fieldFormats,
      },
      required: ["mode"],
      additionalProperties: false,
    },
    PartSpec: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^P[1-9][0-9]*$" },
        label: inline,
        title: inline,
        lede: inline,
        chapterKeys: { type: "array", items: { type: "string", pattern: "^([1-9][0-9]*|[A-Z])$" } },
        showChapterList: { type: "boolean" },
        body: { type: "array", items: docRef("FrontItem") },
        setup,
        // Delta S03-d1 (G-02, G-06).
        order: {
          type: "array",
          uniqueItems: true,
          minItems: 1,
          maxItems: 5,
          items: { enum: ["body", "label", "title", "lede", "chapterList"] },
        },
        fieldFormats,
      },
      required: ["id", "label", "title", "chapterKeys"],
      additionalProperties: false,
    },
    Chapter: {
      type: "object",
      properties: {
        key: { type: "string", pattern: "^([1-9][0-9]*|[A-Z])$" },
        blockId: { type: "string", minLength: 1, maxLength: 120 },
        kicker: inline,
        title: inline,
        partId: { type: "string", pattern: "^P[1-9][0-9]*$" },
        runningHeadTitle: { type: "string", maxLength: 200 },
        setup,
        intro: { type: "array", items: docRef("FlowItem") },
        sections: { type: "array", items: docRef("Section") },
        /** Delta S03-d1 (G-06). */
        fieldFormats,
      },
      required: ["title", "sections"],
      additionalProperties: false,
    },
    Section: {
      type: "object",
      properties: {
        blockId: { type: "string", minLength: 1, maxLength: 120 },
        number: { type: "string", maxLength: 16 },
        /** Delta S03-d1 (G-01, S95-C14). */
        numberSeparator: { type: "string", maxLength: 8 },
        title: inline,
        headingFormat: paraFormat,
        blocks: { type: "array", items: docRef("FlowItem") },
      },
      required: ["title", "blocks"],
      additionalProperties: false,
    },
    SpacerBlock: {
      type: "object",
      properties: { type: { const: "spacer" }, format: paraFormat },
      required: ["type", "format"],
      additionalProperties: false,
    },
    DeviceBlock: {
      type: "object",
      properties: {
        type: { const: "device" },
        device: { enum: ["sealBand", "logo", "hairline", "datumRule", "spineString", "issueStamp"] },
        left: inline,
        right: inline,
        text: inline,
        asset: { type: "string", minLength: 1, maxLength: 120 },
        widthMm: { type: "number", exclusiveMinimum: 0, maximum: 400 },
        heightMm: { type: "number", exclusiveMinimum: 0, maximum: 400 },
        format: paraFormat,
        // Delta S03-d1 (S95-C01, S95-C07).
        colsTw,
        cellFormats: { type: "array", maxItems: 2, items: cellFormat },
      },
      required: ["type", "device"],
      additionalProperties: false,
    },
    ParagraphBlock: {
      type: "object",
      properties: {
        type: { const: "paragraph" },
        ...BLOCK_COMMON,
        ...INLINE_PROPERTIES,
        role: { enum: [...PARAGRAPH_ROLES] },
        rail: { type: "array", items: commonRef("RailLine") },
      },
      required: ["type"],
      additionalProperties: false,
      ...xorRequired("text", "runs"),
    },
    ListItem: {
      type: "object",
      properties: {
        ...INLINE_PROPERTIES,
        marker: commonRef("Run"),
        format: paraFormat,
        rail: { type: "array", items: commonRef("RailLine") },
      },
      additionalProperties: false,
      ...xorRequired("text", "runs"),
    },
    ListBlock: {
      type: "object",
      properties: {
        type: { const: "list" },
        ...BLOCK_COMMON,
        style: { enum: ["bullet", "number"] },
        items: { type: "array", minItems: 1, items: docRef("ListItem") },
      },
      required: ["type", "style", "items"],
      additionalProperties: false,
    },
    AsideBlock: {
      type: "object",
      properties: {
        type: { const: "aside" },
        ...BLOCK_COMMON,
        variant: { enum: ["generic", "doctrine", "story", "quickCheck", "ifInDoubt"] },
        label: inline,
        body: { type: "array", minItems: 1, items: commonRef("CellParagraph") },
      },
      required: ["type", "variant", "label", "body"],
      additionalProperties: false,
    },
    MonoBlock: {
      type: "object",
      properties: {
        type: { const: "monoBlock" },
        ...BLOCK_COMMON,
        label: inline,
        lines: { type: "array", minItems: 1, items: commonRef("CellParagraph") },
      },
      required: ["type", "label", "lines"],
      additionalProperties: false,
    },
    AssumptionInlineBlock: {
      type: "object",
      properties: {
        type: { const: "assumptionInline" },
        ...BLOCK_COMMON,
        ...INLINE_PROPERTIES,
        asmId: { type: "string", pattern: "^ASM-[A-Za-z0-9]+-[0-9]{2,}$" },
        impact: { type: "string", minLength: 1, maxLength: 2000 },
      },
      required: ["type", "asmId", "impact"],
      additionalProperties: false,
      ...xorRequired("text", "runs"),
    },
    TableFamilyBlock: {
      type: "object",
      properties: { ...tableBlockProperties("Row"), runDefaults: commonRef("RunProps") },
      required: ["type", "columns", "rows"],
      additionalProperties: false,
    },
    DerivationBlock: {
      type: "object",
      properties: {
        type: { const: "derivation" },
        ...BLOCK_COMMON,
        id: { type: "string", maxLength: 32 },
        title: inline,
        intro: inline,
        lines: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              label: inline,
              value: {
                oneOf: [
                  inline,
                  {
                    type: "object",
                    properties: {
                      registerKey: { type: "string", minLength: 1 },
                      dec: { type: "integer", minimum: 0, maximum: 3 },
                    },
                    required: ["registerKey"],
                    additionalProperties: false,
                  },
                ],
              },
              mark: { enum: [...PROVENANCE_MARKS] },
            },
            required: ["label"],
            additionalProperties: false,
          },
        },
        result: {
          type: "object",
          properties: {
            label: inline,
            expr: { type: "string", minLength: 1, maxLength: 2000 },
            registerKey: { type: "string", minLength: 1 },
            tol: { type: "number", minimum: 0 },
          },
          required: ["label", "expr", "registerKey"],
          additionalProperties: false,
        },
        verdict: {
          type: "object",
          properties: {
            label: inline,
            registerKey: { type: "string", minLength: 1 },
            limit: { type: "number" },
            direction: { enum: ["lessOrEqual", "greaterOrEqual"] },
          },
          required: ["label", "registerKey", "limit"],
          additionalProperties: false,
        },
        closing: inline,
      },
      required: ["type", "title", "lines", "closing"],
      additionalProperties: false,
    },
    ChartBlock: {
      type: "object",
      properties: {
        type: { const: "chart" },
        ...BLOCK_COMMON,
        ...FIGURE_COMMON,
        ...FIGURE_BOUNDED,
        spec: { oneOf: [{ $ref: CHART_SCHEMA_ID }, artifactRef] },
      },
      required: ["type", "spec", ...FIGURE_REQUIRED],
      additionalProperties: false,
    },
    DiagramBlock: {
      type: "object",
      properties: {
        type: { const: "diagram" },
        ...BLOCK_COMMON,
        ...FIGURE_COMMON,
        ...FIGURE_BOUNDED,
        spec: { oneOf: [{ $ref: DIAGRAM_SCHEMA_ID }, artifactRef] },
      },
      required: ["type", "spec", ...FIGURE_REQUIRED],
      additionalProperties: false,
    },
    ImageBlock: {
      type: "object",
      properties: {
        type: { const: "image" },
        ...BLOCK_COMMON,
        ...FIGURE_COMMON,
        asset: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["type", "asset", ...FIGURE_REQUIRED],
      additionalProperties: false,
    },
    SymbolSheetBlock: {
      type: "object",
      properties: {
        type: { const: "symbolSheet" },
        ...BLOCK_COMMON,
        ...FIGURE_COMMON,
        dialect: { enum: [...SYMBOL_DIALECTS] },
        cols: { type: "integer", minimum: 1, maximum: 12 },
      },
      required: ["type", "dialect", ...FIGURE_REQUIRED],
      additionalProperties: false,
    },
  },
} as const;

