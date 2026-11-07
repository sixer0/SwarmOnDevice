/**
 * Swarm addition (row 163b, decision C155): the Vega chart family (row 163, `engine/chart/family-v`) on the render path.
 *
 * A document chart block whose code is V-01..V-08, or an undrawn Rev A code that `vegaChartFor` maps (DF-01 -> V-06,
 * DF-02 -> V-03, DF-03 -> V-05, DF-07 -> V-07, DF-09 -> V-08, DF-13 -> V-02), is rendered by `renderVegaChart` instead
 * of the Rev A engine. One seam for the document render (`figures.ts` buildFigures: HTML/PDF from the SVG, DOCX from
 * the 300 dpi PNG that `prepareFigureStore` rasterizes, the same `rasterizeSvg` call as `rasterizeVegaChart`) and the
 * figure preview route (`src/mcp-host/local-api/routes/figure-preview-figure.ts`).
 *
 * Security (verification/18_row160 §4): the agent never sends Vega. The composed block spec is mapped field by field
 * onto the typed `studio.chart-vega/v1` input (data values, the closed `options`, text); `renderVegaChart` validates it
 * with the family's closed ajv schemas and builds every Vega spec itself. Block fields the family cannot honour
 * (`limit`, intent fields, data hints such as `binEdges`/`targets`) are refused with SCHEMA_INVALID, not dropped.
 */
import type { ResolvedTemplate, StudioChartV1 } from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { isVegaChartCode, renderVegaChart, VEGA_CHART_CODES, type VegaChartCode, type VegaChartResult } from "../../engine/chart/family-v";
import { vegaChartFor } from "../../registry/charts";

export type VegaFigureLang = "ID" | "EN";

/** The Vega code a chart spec `kind` renders with: V-01..V-08 itself, a DF code `vegaChartFor` maps, else null. */
export function vegaCodeOf(kind: unknown): VegaChartCode | null {
  if (isVegaChartCode(kind)) return kind;
  if (typeof kind !== "string" || !/^DF-\d{2}$/.test(kind)) return null;
  const v = vegaChartFor(kind);
  return v !== null && isVegaChartCode(v) ? v : null;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function refuse(field: string, code: VegaChartCode): never {
  throw new StudioEngineError("SCHEMA_INVALID", `chart Vega ${code}: medan ${field} tidak didukung keluarga Vega; hapus medan itu (lihat studio_registry kind=charts meta.vega)`, {
    pointer: `/${field.replace(/\./g, "/")}`,
    supported: [...VEGA_CHART_CODES],
  });
}

/**
 * Block spec (as composed by `services/compose/blocks.ts`) -> `studio.chart-vega/v1` input. Pure; the result is still
 * UNTRUSTED and goes through `validateVegaChartInput` inside `renderVegaChart`.
 */
export function vegaInputFromChartSpec(spec: StudioChartV1, code: VegaChartCode, lang?: VegaFigureLang): Rec {
  const s = spec as unknown as Rec;
  if (s.limit !== undefined || s.limitLabel !== undefined) refuse("limit", code);
  if (s.intent !== undefined) refuse("intent (orientation/sort/topN/labelShort)", code);
  if (s.composite !== undefined) refuse("panels", code);
  if (isRec(s.params) && Object.keys(s.params).length > 0) refuse(`data.${Object.keys(s.params).sort()[0]}`, code);

  const input: Rec = { $schema: "studio.chart-vega/v1", kind: code, title: spec.title, source: spec.source, widthMm: spec.widthMm };
  if (spec.id !== undefined) input.id = spec.id;
  if (spec.heightMm !== undefined) input.heightMm = spec.heightMm;
  if (spec.apparatus !== undefined) input.apparatus = spec.apparatus;
  if (spec.unit !== undefined) input.unit = spec.unit;
  if (spec.dec !== undefined) input.dec = spec.dec;
  if (spec.note !== undefined) input.note = spec.note;
  if (lang !== undefined) input.lang = lang === "EN" ? "en" : "id";
  if (spec.options !== undefined) input.options = { ...spec.options };

  let accent: Rec | undefined = isRec(spec.accent) ? { ...spec.accent } : undefined;
  const data = isRec(spec.data) ? (JSON.parse(JSON.stringify(spec.data)) as Rec) : spec.data;
  // Compose marks a highlighted series with `accent: true` on the series (D-136); the family takes `accent.series`.
  if (isRec(data) && data.shape === "series" && Array.isArray(data.series)) {
    data.series = (data.series as unknown[]).map((x) => {
      if (!isRec(x) || x.accent === undefined) return x;
      const { accent: flag, ...rest } = x;
      if (flag === true && typeof rest.name === "string") accent = { ...(accent ?? {}), series: rest.name };
      return rest;
    });
  }
  input.data = data;
  if (accent !== undefined) input.accent = accent;
  return input;
}

/** Render one block chart through the Vega family (validation, capacity and lint refusals are thrown). */
export async function renderVegaFigure(spec: StudioChartV1, code: VegaChartCode, tpl: ResolvedTemplate, lang?: VegaFigureLang): Promise<VegaChartResult> {
  return renderVegaChart(vegaInputFromChartSpec(spec, code, lang), tpl);
}
