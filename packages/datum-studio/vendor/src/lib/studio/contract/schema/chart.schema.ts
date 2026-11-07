/**
 * JSON Schema 2020-12 `studio.chart/v1` (01_specs.md §3.5, §3.10).
 * `data` wajib bila kind != "composite"; `composite` wajib bila kind = "composite".
 * Kode drawn=false lolos skema dan ditolak renderer (422 CHART_KIND_NOT_DRAWN).
 */
import { CHART_CODES, CHART_INTENT_LIMITS, CHART_INTENT_ORIENTATIONS, CHART_INTENT_SORTS } from "../enums";
import { JSON_SCHEMA_DIALECT, STUDIO_SCHEMA_URL_BASE } from "./common.schema";
import { DIAGRAM_SCHEMA_ID } from "./diagram.schema";
import { FIGURE_BOUNDS as B } from "./figure-bounds";

export const CHART_SCHEMA_ID = `${STUDIO_SCHEMA_URL_BASE}/studio.chart/v1.json`;

function chartRef(def: string): { $ref: string } {
  return { $ref: `${CHART_SCHEMA_ID}#/$defs/${def}` };
}

const str = { type: "string", minLength: 1, maxLength: 200 } as const;
const num = { type: "number" } as const;
const bool = { type: "boolean" } as const;
/** SEC-FIX2 (D-506): larik figur berbatas `FIGURE_BOUNDS` (uji secfix2-schema-walk); biaya mesin super-linear. */
const arr = (max: number, items: unknown, min?: number) => ({ type: "array", ...(min ? { minItems: min } : {}), maxItems: max, items }) as const;

function obj(properties: Record<string, unknown>, required: readonly string[]) {
  return { type: "object", properties, required: [...required], additionalProperties: false } as const;
}

function shapeVariant(shape: string, properties: Record<string, unknown>, required: readonly string[]) {
  return obj({ shape: { const: shape }, ...properties }, ["shape", ...required]);
}

/** Properti yang dipakai bersama spec penuh dan panel komposit. */
const CHART_COMMON_PROPERTIES = {
  id: { type: "string", maxLength: 64 },
  // D-271: batas atas = blok teks turunan kertas (`grid.textBlockHeightMm`), ditegakkan gerbang by-construction (DATUM-33).
  heightMm: { type: "number", exclusiveMinimum: 0 },
  unit: { type: "string", maxLength: 40 },
  dec: { enum: [0, 1, 2, 3] },
  apparatus: { enum: ["page", "figure"] },
  inDocument: bool,
  note: { type: "string", maxLength: 2000 },
  data: chartRef("ChartData"),
  // SEC-FIX2: nilai params bebas bentuk tetapi berbatas (`ChartParamValue`); bukan `ParamValue` bersama templat.
  params: { type: "object", maxProperties: B.paramProperties, additionalProperties: chartRef("ChartParamValue") },
  style: { enum: ["datum", "gallery"] },
  limit: num,
  limitLabel: { type: "string", maxLength: 200 },
  /** Delta S03-d1 (D-58); alias `params.accentPoint`/`accentGroup`/`accentSeries`. */
  accent: {
    type: "object",
    properties: { point: { type: ["string", "number"], maxLength: 200 }, group: str, series: str },
    minProperties: 1,
    additionalProperties: false,
  },
  /** Delta IP-41d (D-113): metadata tak-tergambar (asal transkripsi, catatan, seriesNames: ASUMSI); renderer mengabaikan. */
  x: { type: "object", additionalProperties: true },
} as const;

export const chartSchema = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: CHART_SCHEMA_ID,
  title: "studio.chart/v1",
  type: "object",
  properties: {
    $schema: { const: "studio.chart/v1" },
    kind: { enum: [...CHART_CODES, "composite"] },
    title: { type: "string", minLength: 1, maxLength: 300 },
    source: { type: "string", minLength: 1, maxLength: 1000 },
    // D-245 H1: lebar sah = turunan kertas (A4 128/166); keanggotaan ditegakkan mesin chart (G2).
    widthMm: { type: "number", exclusiveMinimum: 0 },
    ...CHART_COMMON_PROPERTIES,
    composite: chartRef("ChartComposite"),
    /** Delta FIG-03a (D-482 butir 2): maksud analitis dari blok chart v2; hanya spec tingkat atas. */
    intent: {
      type: "object",
      properties: {
        orientation: { enum: [...CHART_INTENT_ORIENTATIONS] },
        sort: { enum: [...CHART_INTENT_SORTS] },
        topN: { type: "integer", minimum: CHART_INTENT_LIMITS.topNMin, maximum: CHART_INTENT_LIMITS.topNMax },
        otherLabel: { type: "string", minLength: 1, maxLength: CHART_INTENT_LIMITS.otherLabelMax },
        labelShort: {
          type: "array",
          minItems: 1,
          maxItems: CHART_INTENT_LIMITS.labelShortItemsMax,
          items: obj({ label: str, short: { type: "string", minLength: 1, maxLength: CHART_INTENT_LIMITS.labelShortMax } }, ["label", "short"]),
        },
      },
      dependentRequired: { otherLabel: ["topN"] },
      additionalProperties: false,
    },
  },
  required: ["$schema", "kind", "title", "source", "widthMm"],
  additionalProperties: false,
  if: { properties: { kind: { const: "composite" } }, required: ["kind"] },
  then: { properties: { composite: true }, required: ["composite"] },
  else: { properties: { data: true }, required: ["data"] },
  $defs: {
    ChartData: {
      type: "object",
      properties: { shape: { type: "string", maxLength: 32 } },
      required: ["shape"],
      discriminator: { propertyName: "shape" },
      oneOf: [
        shapeVariant(
          "categorical",
          {
            points: {
              type: "array",
              minItems: 1,
              maxItems: B.items,
              items: obj({ label: str, value: num, accent: bool, sub: { type: "string", maxLength: 200 } }, ["label", "value"]),
            },
          },
          ["points"],
        ),
        shapeVariant(
          "series",
          {
            categories: arr(B.items, str, 1),
            series: {
              type: "array",
              minItems: 1,
              maxItems: B.series,
              items: obj(
                { name: str, values: arr(B.items, { type: ["number", "null"] }), accent: bool },
                ["name", "values"],
              ),
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
              maxItems: B.xyPoints,
              items: obj(
                { x: num, y: num, size: num, label: { type: "string", maxLength: 200 }, group: str, accent: bool },
                ["x", "y"],
              ),
            },
          },
          ["points"],
        ),
        shapeVariant(
          "matrix",
          {
            rows: arr(B.items, str, 1),
            cols: arr(B.items, str, 1),
            values: arr(B.items, arr(B.items, num)),
          },
          ["rows", "cols", "values"],
        ),
        shapeVariant(
          "intervals",
          {
            items: {
              type: "array",
              minItems: 1,
              maxItems: B.items,
              items: obj(
                {
                  label: str,
                  start: { type: ["number", "string"], maxLength: 200 },
                  end: { type: ["number", "string"], maxLength: 200 },
                  group: str,
                  milestone: bool,
                },
                ["label", "start", "end"],
              ),
            },
          },
          ["items"],
        ),
        shapeVariant(
          "graph",
          {
            nodes: {
              type: "array",
              minItems: 1,
              maxItems: B.graphNodes,
              items: obj({ id: str, label: str, value: num, group: str }, ["id", "label"]),
            },
            links: { type: "array", maxItems: B.graphLinks, items: obj({ from: str, to: str, value: num }, ["from", "to"]) },
          },
          ["nodes", "links"],
        ),
        shapeVariant(
          "distribution",
          {
            groups: {
              type: "array",
              minItems: 1,
              maxItems: B.distributionGroups,
              items: obj({ name: str, values: arr(B.distributionValues, num) }, ["name", "values"]),
            },
          },
          ["groups"],
        ),
        shapeVariant(
          "tiles",
          {
            tiles: {
              type: "array",
              minItems: 1,
              maxItems: B.items,
              items: obj(
                { code: str, row: { type: "integer" }, col: { type: "integer" }, value: num, label: str },
                ["code", "row", "col"],
              ),
            },
            flows: { type: "array", maxItems: B.tileFlows, items: obj({ from: str, to: str, value: num }, ["from", "to", "value"]) },
            dots: { type: "array", maxItems: B.tileDots, items: obj({ tile: str, dx: num, dy: num, label: str }, ["tile"]) },
          },
          ["tiles"],
        ),
        shapeVariant(
          "ohlc",
          {
            points: {
              type: "array",
              minItems: 1,
              maxItems: B.items,
              items: obj({ t: str, o: num, h: num, l: num, c: num }, ["t", "o", "h", "l", "c"]),
            },
          },
          ["points"],
        ),
        shapeVariant(
          "sets",
          {
            sets: { type: "array", minItems: 1, maxItems: B.sets, items: obj({ name: str, size: num }, ["name", "size"]) },
            overlaps: {
              type: "array",
              maxItems: B.setOverlaps,
              items: obj({ sets: arr(B.sets, str, 2), size: num }, ["sets", "size"]),
            },
          },
          ["sets", "overlaps"],
        ),
        shapeVariant("steps", { spec: { $ref: DIAGRAM_SCHEMA_ID } }, ["spec"]),
      ],
    },
    /** SEC-FIX2 (D-506): nilai `params` chart v1 berbatas (rekursif); bentuk sama dengan `ParamValue` common/v1. */
    ChartParamValue: {
      type: ["null", "boolean", "number", "string", "array", "object"],
      maxLength: B.stringChars,
      maxItems: B.paramItems,
      items: chartRef("ChartParamValue"),
      maxProperties: B.paramProperties,
      additionalProperties: chartRef("ChartParamValue"),
    },
    ChartPanelSpec: {
      type: "object",
      properties: { kind: { enum: [...CHART_CODES] }, ...CHART_COMMON_PROPERTIES },
      required: ["kind"],
      additionalProperties: false,
    },
    ChartComposite: {
      type: "object",
      properties: {
        columns: { enum: [1, 2, 3] },
        gapMm: { type: "number", minimum: 0, maximum: 50 },
        panels: {
          type: "array",
          minItems: 1,
          maxItems: B.panels,
          items: {
            type: "object",
            properties: {
              name: str,
              code: { enum: [...CHART_CODES] },
              caption: { type: "string", maxLength: 300 },
              axisNote: { type: "string", maxLength: 200 },
              spec: chartRef("ChartPanelSpec"),
            },
            required: ["name", "code", "spec"],
            additionalProperties: false,
          },
        },
      },
      required: ["columns", "panels"],
      additionalProperties: false,
    },
  },
} as const;
