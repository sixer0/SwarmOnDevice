/**
 * Swarm addition (row 163, decision U24 C; security binding: verification/18_row160 §4 C2, C4, C5, C8, C9).
 *
 * Typed agent input of the Vega chart family (`studio.chart-vega/v1`). Agents send DATA and a few
 * whitelisted OPTIONS only; Studio builds every Vega-Lite / Vega spec itself (`./specs`). Nothing an agent
 * sends is ever a Vega expression, a field name, a URL, a colour or a font.
 *
 * Validation order (all before Vega is touched):
 *   1. size: serialized JSON <= 256 KiB (C8)                         -> PAYLOAD_TOO_LARGE
 *   2. structure walk: depth <= 64, keys `__proto__`/`constructor`/`prototype` refused at any depth (C9),
 *      every key of the §4 reject list refused at any depth with its own message (C2, C4, C5), strings
 *      <= 1 000 chars, numbers finite, at most 5 000 array items                -> SCHEMA_INVALID
 *   3. ajv (the package's ajv 8.20.0, Ajv2020, Studio's options): one closed schema per chart type
 *      (`additionalProperties: false` everywhere)                                -> SCHEMA_INVALID
 *   4. semantic checks (lengths agree, ids unique, one root, no cycle, valid dates) -> SCHEMA_INVALID
 * Capacity (how much the figure can show cleanly) is checked later by the builders and refused with
 * FIGURE_OVER_CAPACITY (row 158), never squeezed.
 */
import Ajv2020 from "ajv/dist/2020";
import type { ErrorObject, ValidateFunction } from "ajv";
import { StudioEngineError } from "../../../contract/errors";

export const VEGA_CHART_SCHEMA = "studio.chart-vega/v1" as const;

/** Codes of the family (registry/charts.ts `VEGA_CHART_REGISTRY` carries name, purpose, replaced DF code). */
export const VEGA_CHART_CODES = ["V-01", "V-02", "V-03", "V-04", "V-05", "V-06", "V-07", "V-08"] as const;
export type VegaChartCode = (typeof VEGA_CHART_CODES)[number];

// ── Limits (C8) ──────────────────────────────────────────────────────────
export const VEGA_INPUT_MAX_BYTES = 256 * 1024;
/** Same value as STUDIO_MAX_JSON_DEPTH (vendor/src/lib/studio/http/body.ts:75). */
export const VEGA_INPUT_MAX_DEPTH = 64;
/** Same value as STUDIO_MAX_TABLE_CELLS (contract/env.ts:48): rows and cells. */
export const VEGA_INPUT_MAX_ITEMS = 5000;
export const VEGA_INPUT_MAX_STRING = 1000;

/** Keys refused at any depth (C2, C4, C5, C9 and the §4 list). The message names the rule. */
const FORBIDDEN_KEYS: Readonly<Record<string, string>> = {
  ["__proto__"]: "kunci prototipe ditolak (C9)",
  constructor: "kunci prototipe ditolak (C9)",
  prototype: "kunci prototipe ditolak (C9)",
  expr: "ekspresi Vega tidak boleh dari agen (C2)",
  signal: "ekspresi Vega tidak boleh dari agen (C2)",
  signals: "sinyal Vega tidak boleh dari agen (C2)",
  calculate: "ekspresi Vega tidak boleh dari agen (C2)",
  filter: "ekspresi Vega tidak boleh dari agen (C2)",
  test: "ekspresi Vega tidak boleh dari agen (C2)",
  params: "parameter/seleksi Vega tidak boleh dari agen (C2)",
  selection: "parameter/seleksi Vega tidak boleh dari agen (C2)",
  bind: "parameter/seleksi Vega tidak boleh dari agen (C2)",
  on: "handler Vega tidak boleh dari agen (C2)",
  update: "ekspresi Vega tidak boleh dari agen (C2)",
  formula: "ekspresi Vega tidak boleh dari agen (C2)",
  expression: "ekspresi Vega tidak boleh dari agen (C2)",
  encode: "blok encode Vega tidak boleh dari agen (C2)",
  encoding: "encoding Vega-Lite dibangun Studio, bukan agen (C2)",
  transform: "transform Vega dibangun Studio, bukan agen (C2, C7)",
  mark: "mark Vega dibangun Studio, bukan agen (C5)",
  marks: "mark Vega dibangun Studio, bukan agen (C5)",
  url: "data eksternal ditolak: hanya data JSON sebaris (C4)",
  href: "tautan ditolak (C5)",
  image: "gambar ditolak (C5)",
  tooltip: "tooltip ditolak (C5)",
  format: "format data ditolak: hanya data JSON sebaris (C4)",
  usermeta: "usermeta ditolak (§4)",
  config: "konfigurasi Vega dibangun Studio dari token DATUM (C6)",
  customFormatTypes: "customFormatTypes ditolak (§4)",
  projection: "proyeksi/geoshape ditolak (§4)",
  geoshape: "proyeksi/geoshape ditolak (§4)",
  color: "warna hanya dari token DATUM (C6)",
  fill: "warna hanya dari token DATUM (C6)",
  stroke: "warna hanya dari token DATUM (C6)",
  font: "huruf hanya dari Studio (C6)",
};

/**
 * Markup in agent text is refused (defence in depth; text is XML-escaped anyway). URLs inside plain text (a
 * SUMBER line naming a web page) stay allowed: they are text nodes, and the C6 output gate checks markup only.
 */
const SUSPECT_STRING = /<\s*\/?\s*(?:script|svg|a|image|img|foreignObject|style|iframe)\b/i;

export type VegaChartLang = "id" | "en";

interface Common {
  $schema?: typeof VEGA_CHART_SCHEMA;
  id?: string;
  title: string;
  source: string;
  widthMm: number;
  heightMm?: number;
  apparatus?: "figure" | "page";
  unit?: string;
  dec?: 0 | 1 | 2 | 3;
  lang?: VegaChartLang;
  note?: string;
}

export interface CalendarInput extends Common {
  kind: "V-01";
  data: { shape: "days"; days: Array<{ date: string; value: number }> };
  accent?: { point?: string };
  options?: { weekStart?: "monday" | "sunday" };
}
export interface SeriesData {
  shape: "series";
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
}
export interface StreamInput extends Common {
  kind: "V-02";
  data: SeriesData;
  accent?: { series?: string };
  options?: { offset?: "center" | "zero" | "normalize" };
}
export interface ParallelInput extends Common {
  kind: "V-03";
  data: { shape: "matrix"; rows: string[]; cols: string[]; values: number[][] };
  accent?: { point?: string };
}
export interface EcdfInput extends Common {
  kind: "V-04";
  data: { shape: "distribution"; groups: Array<{ name: string; values: number[] }> };
  accent?: { group?: string };
}
export interface PolarAreaInput extends Common {
  kind: "V-05";
  data: { shape: "categorical"; points: Array<{ label: string; value: number; accent?: boolean }> };
  accent?: { point?: string };
}
export interface RadarInput extends Common {
  kind: "V-06";
  data: SeriesData;
  accent?: { series?: string };
  options?: { max?: number };
}
export interface HierarchyData {
  shape: "hierarchy";
  nodes: Array<{ id: string; parent?: string; label: string; value?: number }>;
}
export interface PartitionInput extends Common {
  kind: "V-07";
  data: HierarchyData;
  accent?: { point?: string };
  options?: { form?: "sunburst" | "icicle" };
}
export interface TreeInput extends Common {
  kind: "V-08";
  data: HierarchyData;
  accent?: { point?: string };
  options?: { form?: "tidy" | "dendrogram" };
}

export type VegaChartInput = CalendarInput | StreamInput | ParallelInput | EcdfInput | PolarAreaInput | RadarInput | PartitionInput | TreeInput;

// ── JSON Schemas (closed) ────────────────────────────────────────────────

const str = (max = 200, min = 1) => ({ type: "string", minLength: min, maxLength: max });
const finite = { type: "number" };
const N = VEGA_INPUT_MAX_ITEMS;

function chartSchema(kind: VegaChartCode, data: object, accent: object | null, options: object | null): object {
  const properties: Record<string, object> = {
    $schema: { const: VEGA_CHART_SCHEMA },
    kind: { const: kind },
    id: str(40),
    title: str(300),
    source: str(300),
    widthMm: { type: "number", exclusiveMinimum: 0, maximum: 400 },
    heightMm: { type: "number", exclusiveMinimum: 0, maximum: 400 },
    apparatus: { enum: ["figure", "page"] },
    unit: str(40),
    dec: { enum: [0, 1, 2, 3] },
    lang: { enum: ["id", "en"] },
    note: str(300),
    data,
  };
  if (accent) properties.accent = accent;
  if (options) properties.options = options;
  return { type: "object", additionalProperties: false, required: ["kind", "title", "source", "widthMm", "data"], properties };
}

const seriesData = {
  type: "object",
  additionalProperties: false,
  required: ["shape", "categories", "series"],
  properties: {
    shape: { const: "series" },
    categories: { type: "array", minItems: 1, maxItems: N, items: str(120) },
    series: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "values"],
        properties: { name: str(120), values: { type: "array", minItems: 1, maxItems: N, items: finite } },
      },
    },
  },
};
const hierarchyData = {
  type: "object",
  additionalProperties: false,
  required: ["shape", "nodes"],
  properties: {
    shape: { const: "hierarchy" },
    nodes: {
      type: "array",
      minItems: 2,
      maxItems: N,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label"],
        properties: { id: str(80), parent: str(80), label: str(120), value: { type: "number", minimum: 0 } },
      },
    },
  },
};
const accentOf = (...keys: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(keys.map((k) => [k, str(200)])),
});

const SCHEMAS: Record<VegaChartCode, object> = {
  "V-01": chartSchema(
    "V-01",
    {
      type: "object",
      additionalProperties: false,
      required: ["shape", "days"],
      properties: {
        shape: { const: "days" },
        days: {
          type: "array",
          minItems: 1,
          maxItems: N,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["date", "value"],
            properties: { date: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }, value: finite },
          },
        },
      },
    },
    accentOf("point"),
    { type: "object", additionalProperties: false, properties: { weekStart: { enum: ["monday", "sunday"] } } },
  ),
  "V-02": chartSchema(
    "V-02",
    seriesData,
    accentOf("series"),
    { type: "object", additionalProperties: false, properties: { offset: { enum: ["center", "zero", "normalize"] } } },
  ),
  "V-03": chartSchema(
    "V-03",
    {
      type: "object",
      additionalProperties: false,
      required: ["shape", "rows", "cols", "values"],
      properties: {
        shape: { const: "matrix" },
        rows: { type: "array", minItems: 1, maxItems: N, items: str(120) },
        cols: { type: "array", minItems: 1, maxItems: 64, items: str(80) },
        values: { type: "array", minItems: 1, maxItems: N, items: { type: "array", minItems: 1, maxItems: 64, items: finite } },
      },
    },
    accentOf("point"),
    null,
  ),
  "V-04": chartSchema(
    "V-04",
    {
      type: "object",
      additionalProperties: false,
      required: ["shape", "groups"],
      properties: {
        shape: { const: "distribution" },
        groups: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "values"],
            properties: { name: str(120), values: { type: "array", minItems: 1, maxItems: N, items: finite } },
          },
        },
      },
    },
    accentOf("group"),
    null,
  ),
  "V-05": chartSchema(
    "V-05",
    {
      type: "object",
      additionalProperties: false,
      required: ["shape", "points"],
      properties: {
        shape: { const: "categorical" },
        points: {
          type: "array",
          minItems: 1,
          maxItems: N,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "value"],
            properties: { label: str(120), value: { type: "number", minimum: 0 }, accent: { type: "boolean" } },
          },
        },
      },
    },
    accentOf("point"),
    null,
  ),
  "V-06": chartSchema(
    "V-06",
    seriesData,
    accentOf("series"),
    { type: "object", additionalProperties: false, properties: { max: { type: "number", exclusiveMinimum: 0 } } },
  ),
  "V-07": chartSchema(
    "V-07",
    hierarchyData,
    accentOf("point"),
    { type: "object", additionalProperties: false, properties: { form: { enum: ["sunburst", "icicle"] } } },
  ),
  "V-08": chartSchema(
    "V-08",
    hierarchyData,
    accentOf("point"),
    { type: "object", additionalProperties: false, properties: { form: { enum: ["tidy", "dendrogram"] } } },
  ),
};

/**
 * Swarm addition (row 163b, C155): the closed JSON Schema the validator compiles for one type (a copy), so the agent
 * catalog (studio_registry kind=charts, `meta.vega`) shows exactly what is enforced.
 */
export function vegaChartInputSchema(kind: VegaChartCode): Record<string, unknown> {
  return structuredClone(SCHEMAS[kind]) as Record<string, unknown>;
}

let validators: Map<VegaChartCode, ValidateFunction> | null = null;

function validatorFor(kind: VegaChartCode): ValidateFunction {
  if (!validators) {
    // Studio's options (contract/index.ts:96 STUDIO_AJV_OPTIONS) without discriminator (no oneOf here).
    const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
    validators = new Map(VEGA_CHART_CODES.map((k) => [k, ajv.compile(SCHEMAS[k])]));
  }
  return validators.get(kind)!;
}

function invalid(message: string, details: Record<string, unknown>): StudioEngineError {
  return new StudioEngineError("SCHEMA_INVALID", `chart Vega: ${message}`, details);
}

/** Walk the raw input once: depth, forbidden keys, strings, numbers, array sizes (C2, C4, C5, C8, C9). */
function walk(v: unknown, pointer: string, depth: number): void {
  if (depth > VEGA_INPUT_MAX_DEPTH) {
    throw new StudioEngineError("PAYLOAD_TOO_LARGE", `chart Vega: kedalaman masukan > ${VEGA_INPUT_MAX_DEPTH}`, { pointer, limit: VEGA_INPUT_MAX_DEPTH });
  }
  if (typeof v === "string") {
    if (v.length > VEGA_INPUT_MAX_STRING) throw invalid(`teks lebih dari ${VEGA_INPUT_MAX_STRING} karakter di ${pointer}`, { pointer });
    if (SUSPECT_STRING.test(v)) throw invalid(`teks di ${pointer} memuat markup; hanya teks biasa yang diterima (C5, C6)`, { pointer });
    return;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw invalid(`angka tidak hingga di ${pointer}`, { pointer });
    return;
  }
  // `undefined` is dropped by JSON (the validator works on the JSON form).
  if (v === null || v === undefined || typeof v === "boolean") return;
  if (Array.isArray(v)) {
    if (v.length > VEGA_INPUT_MAX_ITEMS) {
      throw new StudioEngineError("PAYLOAD_TOO_LARGE", `chart Vega: ${v.length} butir di ${pointer} (maks ${VEGA_INPUT_MAX_ITEMS})`, { pointer, limit: VEGA_INPUT_MAX_ITEMS, measured: v.length });
    }
    v.forEach((x, i) => walk(x, `${pointer}/${i}`, depth + 1));
    return;
  }
  if (typeof v === "object") {
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw invalid(`objek bukan JSON biasa di ${pointer}`, { pointer });
    const keys = Object.keys(v as object);
    if (keys.length > 32) throw invalid(`terlalu banyak medan di ${pointer} (maks 32)`, { pointer });
    for (const k of keys) {
      const why = Object.prototype.hasOwnProperty.call(FORBIDDEN_KEYS, k) ? FORBIDDEN_KEYS[k] : undefined;
      // `$schema` is allowed only at the top as the family's own constant (checked by ajv).
      if (why !== undefined || (k === "$schema" && pointer !== "")) throw invalid(`medan "${k}" di ${pointer || "/"}: ${why ?? "skema eksternal ditolak"}`, { pointer: `${pointer}/${k}`, key: k });
      walk((v as Record<string, unknown>)[k], `${pointer}/${k}`, depth + 1);
    }
    return;
  }
  throw invalid(`nilai tak didukung di ${pointer}`, { pointer });
}

function ajvMessage(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 8)
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "tidak sah"}${e.keyword === "additionalProperties" ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})` : ""}`)
    .join("; ");
}

function semantic(input: VegaChartInput): void {
  const d = input.data as unknown as Record<string, unknown>;
  switch (input.kind) {
    case "V-01": {
      const seen = new Set<string>();
      for (const [i, day] of input.data.days.entries()) {
        const t = Date.parse(`${day.date}T00:00:00Z`);
        if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== day.date) throw invalid(`tanggal tidak sah di /data/days/${i}/date`, { pointer: `/data/days/${i}/date` });
        if (seen.has(day.date)) throw invalid(`tanggal ganda ${day.date}`, { pointer: `/data/days/${i}/date` });
        seen.add(day.date);
      }
      return;
    }
    case "V-02":
    case "V-06": {
      const n = input.data.categories.length;
      input.data.series.forEach((s, i) => {
        if (s.values.length !== n) throw invalid(`seri ${i} punya ${s.values.length} nilai, kategori ${n}`, { pointer: `/data/series/${i}/values` });
      });
      uniq(input.data.series.map((s) => s.name), "/data/series", "nama seri");
      uniq(input.data.categories, "/data/categories", "kategori");
      if (input.kind === "V-02" && input.data.series.some((s) => s.values.some((x) => x < 0))) throw invalid("streamgraph butuh nilai >= 0", { pointer: "/data/series" });
      return;
    }
    case "V-03": {
      const { rows, cols, values } = input.data;
      if (values.length !== rows.length) throw invalid(`values punya ${values.length} baris, rows ${rows.length}`, { pointer: "/data/values" });
      values.forEach((r, i) => {
        if (r.length !== cols.length) throw invalid(`baris ${i} punya ${r.length} nilai, cols ${cols.length}`, { pointer: `/data/values/${i}` });
      });
      uniq(rows, "/data/rows", "baris");
      uniq(cols, "/data/cols", "dimensi");
      return;
    }
    case "V-04":
      uniq(input.data.groups.map((g) => g.name), "/data/groups", "nama grup");
      return;
    case "V-05":
      uniq(input.data.points.map((p) => p.label), "/data/points", "label");
      return;
    case "V-07":
    case "V-08": {
      hierarchyCheck(input.data);
      return;
    }
    default:
      throw invalid(`bentuk data ${String(d.shape)} tidak dikenal`, {});
  }
}

function uniq(list: readonly string[], pointer: string, what: string): void {
  const seen = new Set<string>();
  for (const x of list) {
    if (seen.has(x)) throw invalid(`${what} ganda "${x.slice(0, 60)}"`, { pointer });
    seen.add(x);
  }
}

/** One root, every parent exists, no cycle; returns depth per id. */
export function hierarchyCheck(d: HierarchyData): Map<string, number> {
  const byId = new Map<string, HierarchyData["nodes"][number]>();
  for (const [i, n] of d.nodes.entries()) {
    if (byId.has(n.id)) throw invalid(`id simpul ganda "${n.id.slice(0, 60)}"`, { pointer: `/data/nodes/${i}/id` });
    byId.set(n.id, n);
  }
  const roots = d.nodes.filter((n) => n.parent === undefined);
  if (roots.length !== 1) throw invalid(`hierarki butuh tepat satu akar (tanpa parent), ada ${roots.length}`, { pointer: "/data/nodes" });
  const depth = new Map<string, number>();
  const depthOf = (id: string, guard: number): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (guard > d.nodes.length) throw invalid("hierarki berputar (siklus parent)", { pointer: "/data/nodes", id });
    const n = byId.get(id)!;
    if (n.parent === undefined) return 0;
    if (!byId.has(n.parent)) throw invalid(`parent "${n.parent.slice(0, 60)}" tidak ada`, { pointer: "/data/nodes", id });
    const v = depthOf(n.parent, guard + 1) + 1;
    depth.set(id, v);
    return v;
  };
  for (const n of d.nodes) depth.set(n.id, depthOf(n.id, 0));
  return depth;
}

/**
 * Validate untrusted agent input into a typed `VegaChartInput` (or throw SCHEMA_INVALID / PAYLOAD_TOO_LARGE).
 * The returned object is a structured clone: later code never sees the caller's object.
 */
export function validateVegaChartInput(raw: unknown): VegaChartInput {
  let text: string;
  try {
    text = JSON.stringify(raw) ?? "";
  } catch {
    throw invalid("masukan bukan JSON", {});
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > VEGA_INPUT_MAX_BYTES) {
    throw new StudioEngineError("PAYLOAD_TOO_LARGE", `chart Vega: masukan ${bytes} byte > ${VEGA_INPUT_MAX_BYTES}`, { limit: VEGA_INPUT_MAX_BYTES, measured: bytes });
  }
  walk(raw, "", 0);
  // Re-parse: drops anything non-JSON and gives a private copy (a JSON key "__proto__" was refused above).
  const input = JSON.parse(text) as Record<string, unknown>;
  const kind = input?.kind;
  if (typeof kind !== "string" || !(VEGA_CHART_CODES as readonly string[]).includes(kind)) {
    throw invalid(`kind ${JSON.stringify(kind)} bukan ${VEGA_CHART_CODES.join("/")}`, { pointer: "/kind", supported: [...VEGA_CHART_CODES] });
  }
  const validate = validatorFor(kind as VegaChartCode);
  if (!validate(input)) throw invalid(ajvMessage(validate.errors), { errors: (validate.errors ?? []).slice(0, 20).map((e) => ({ pointer: e.instancePath, keyword: e.keyword, message: e.message })) });
  const typed = input as unknown as VegaChartInput;
  semantic(typed);
  return typed;
}
