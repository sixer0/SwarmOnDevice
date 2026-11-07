/**
 * Swarm addition (row 163, decision U24 C): the Vega chart family `V-01..V-08` for chart types the eleven
 * Rev A families lack (research/16_engine_deps.md §6). Registered in `registry/charts.ts` (`VEGA_CHART_REGISTRY`).
 *
 *   V-01 calendar heatmap   V-02 streamgraph        V-03 parallel coordinates   V-04 ECDF
 *   V-05 polar area (rose)  V-06 radar              V-07 sunburst / icicle      V-08 tree / dendrogram
 *
 * Pipeline of `renderVegaChart(raw, tpl)` (async: Vega's dataflow is promise based):
 *   validateVegaChartInput (C2, C4, C5, C8, C9) -> buildVegaSpec (Studio templates, capacity refusals U24 B)
 *   -> vega-lite compile -> assertStudioVegaSpec (C4, C5, C7) -> vegaSvg (C1 interpreter, C3 deny-all loader,
 *   C8 time/size) -> assertSafeSvg (C6) -> DATUM post-processing into the Studio chart canvas (mm units, paper
 *   ground, Rev A figure apparatus GAMBAR/SUMBER) -> colour gate (token colours only, <= 5 values, Rev A lint 25)
 *   -> chart lint (lintChartSvg: DATUM-25/26/27/28/33/G2/13) + geometry lint (overlap/outside -> FIGURE_OVER_CAPACITY).
 * `rasterizeVegaChart` turns the SVG into the 300 dpi PNG through the render bridge (128 mm -> 1512 px, CP-47).
 *
 * Security: verification/18_row160_engine_deps_security.md §4 (C1-C9, C11) and §6 (tests T1-T7, T9 under
 * test/engine-rev-a/chart-vega/). This module is the only Vega entry point in Studio.
 */
import type { LintIssue, ResolvedTemplate, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import type { NumberLanguage } from "../../bind/format";
import { ChartOverCapacity } from "../../figure-capacity";
import { apparatusMarker, figureApparatus, FIGURE_APPARATUS_BAND_MM, noteLine } from "../core/apparatus";
import { EMPTY_CHART_TEMPLATE } from "../core/composite";
import { CHART_LINT_OPTIONS, lintChartGeometry } from "../core/geometry";
import { allowedWidthsText, defect, figureLimits, figureLimitsReport, isAllowedWidth, lintChartSvg, mergeReports } from "../core/guards";
import { chartPalette, colorFamily } from "../core/palette";
import { SvgDoc } from "../core/svg";
import { compile } from "vega-lite";
import { assertSafeSvg, assertStudioVegaSpec } from "./guard";
import { type VegaChartCode, type VegaChartInput, VEGA_CHART_CODES, validateVegaChartInput } from "./input";
import { VEGA_RENDER_TIMEOUT_MS, vegaSvg } from "./sandbox";
import { buildVegaSpec } from "./specs";
import { vegaInnerMarkup } from "./svg";
import { vegaTheme } from "./theme";

export { VEGA_CHART_CODES, type VegaChartCode, type VegaChartInput, validateVegaChartInput } from "./input";
export { denyAllLoader, vegaSvg, VEGA_RENDER_TIMEOUT_MS } from "./sandbox";
export { assertSafeSvg, assertStudioVegaSpec } from "./guard";
export { vegaInnerMarkup } from "./svg";

const NOTE_BAND_MM = 4.2;
const GROUND = new Set(["#FCFCFB", "#FBFAF7", "#FFFFFF"]);

export interface VegaChartResult extends SvgResult {
  kind: VegaChartCode;
  /** The compiled Vega spec that ran (for audit; Studio-built, contains no agent expression). */
  engine: "vega-lite" | "vega";
  renderMs: number;
}

/** Every fill/stroke must be a template token (or none); returns the counted colour values (ground removed). */
export function tokenColours(svg: string, allowed: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  for (const m of svg.matchAll(/\b(fill|stroke)="([^"]*)"/g)) {
    const v = m[2].trim();
    if (v === "none" || v === "transparent") continue;
    const hex = /^#[0-9A-Fa-f]{6}$/.test(v) ? v.toUpperCase() : null;
    if (!hex || !allowed.has(hex)) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `[DATUM-25] chart Vega: warna ${JSON.stringify(v.slice(0, 40))} bukan token DATUM (C6)`, { checkId: "DATUM-25", value: v.slice(0, 40) });
    }
    if (!GROUND.has(hex)) seen.add(hex);
  }
  return [...seen].sort();
}

const SUGGEST: Record<VegaChartCode, string> = {
  "V-01": "pakai lebar 166 mm atau pisah per semester",
  "V-02": "kurangi titik waktu atau persingkat label periode",
  "V-03": "kurangi dimensi atau persingkat nama dimensi",
  "V-04": "kurangi grup atau persingkat nama grup",
  "V-05": "gabungkan kategori kecil atau persingkat label",
  "V-06": "kurangi sumbu atau persingkat nama sumbu",
  "V-07": "ringkas cabang kecil atau pakai bentuk icicle",
  "V-08": "pisah per cabang atau persingkat label",
};

function langOf(input: VegaChartInput): NumberLanguage {
  return input.lang === "en" ? "EN" : "ID";
}

// Label strings reach Vega/Vega-Lite group maps that are plain objects keyed by the label (vega-transforms,
// vega-dataflow), so the exact label "__proto__" hits the accessor and drops or fails a row (L8). The label is
// carried through Vega as "<U+2063>__proto__" (an ordinary own key, zero width) and restored in the SVG text.
const PROTO_LABEL = "__proto__";
const PROTO_ALIAS = "\u2063__proto__";
function aliasLabels<T>(v: T): T {
  if (typeof v === "string") return (v === PROTO_LABEL ? PROTO_ALIAS : v) as T;
  if (Array.isArray(v)) return v.map(aliasLabels) as T;
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) Object.defineProperty(o, k, { value: aliasLabels((v as Record<string, unknown>)[k]), enumerable: true, writable: true, configurable: true });
    return o as T;
  }
  return v;
}

/** Render one Vega-family chart from UNTRUSTED agent input. Deterministic: same input -> same SVG. */
export async function renderVegaChart(raw: unknown, tpl: ResolvedTemplate = EMPTY_CHART_TEMPLATE, o: { timeoutMs?: number } = {}): Promise<VegaChartResult> {
  const validated = validateVegaChartInput(raw);
  const input = { ...validated, data: aliasLabels(validated.data), accent: aliasLabels(validated.accent) } as typeof validated;
  const limits = figureLimits(tpl.params);
  if (!isAllowedWidth(input.widthMm, limits)) {
    throw defect("G2", `lebar ${String(input.widthMm)} mm bukan ${allowedWidthsText(limits)}`, { widthMm: input.widthMm, allowedWidthsMm: [...limits.widthsMm] });
  }
  const apparatus = input.apparatus ?? "figure";
  const foot = (apparatus === "figure" ? FIGURE_APPARATUS_BAND_MM : 0) + (input.note ? NOTE_BAND_MM : 0);
  const th = vegaTheme(tpl, input.lang ?? "id");
  const built = buildVegaSpec(input, {
    th,
    widthMm: input.widthMm,
    maxPlotMm: limits.maxHeightMm - foot,
    askedPlotMm: input.heightMm !== undefined ? input.heightMm - foot : undefined,
    lang: langOf(input),
  });

  let vg: Record<string, unknown>;
  if (built.engine === "vega-lite") {
    vg = compile(built.spec as never).spec as unknown as Record<string, unknown>;
  } else {
    vg = built.spec;
  }
  delete vg.$schema;
  delete vg.background;
  delete vg.description;
  assertStudioVegaSpec(vg);
  const out = await vegaSvg(vg as never, { timeoutMs: o.timeoutMs ?? VEGA_RENDER_TIMEOUT_MS });
  out.svg = out.svg.split(PROTO_ALIAS).join(PROTO_LABEL);
  assertSafeSvg(out.svg);

  // ── DATUM canvas: plot (Vega, mm units) + note + apparatus ──
  const W = input.widthMm;
  const plotH = built.plotHeightMm;
  const H = Math.round((plotH + foot) * 1000) / 1000;
  const pal = chartPalette({ kind: "P-01" } as never, tpl);
  const doc = new SvgDoc(W, H, `data-chart="${input.kind}" data-engine="vega"`);
  doc.paper(pal.paper);
  doc.raw(`<g data-vega="plot">${vegaInnerMarkup(out.svg)}</g>`);
  if (input.note) noteLine(doc, input.note, W, plotH + 3, pal);
  const chartLike = { $schema: "studio.chart/v1", kind: input.kind, id: input.id, title: input.title, source: input.source, widthMm: W, apparatus } as never;
  if (apparatus === "figure") figureApparatus(doc, chartLike, pal, H);
  else apparatusMarker(doc, chartLike);
  const svg = doc.toString();
  assertSafeSvg(svg);

  const allowed = new Set([th.paper, th.ink900, th.ink700, th.ink400, th.ink200, th.accent, ...GROUND]);
  const colours = tokenColours(svg, allowed);
  if (colours.length > 5) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `[DATUM-25] chart Vega: ${colours.length} nilai warna > 5`, { checkId: "DATUM-25", colours });
  }

  const geo = lintChartGeometry(svg, CHART_LINT_OPTIONS);
  const crowded = (geo.counts.textOverlap ?? 0) + (geo.counts.textOutside ?? 0);
  if (crowded > 0) {
    const which = geo.defects
      .filter((d) => d.kind === "textOverlap" || d.kind === "textOutside")
      .slice(0, 3)
      .map((d) => (d.kind === "textOverlap" ? `"${d.text.slice(0, 30)}" x "${(d.other ?? "").slice(0, 30)}"` : `"${d.text.slice(0, 30)}" keluar ${d.side ?? ""}`))
      .join(", ");
    throw new ChartOverCapacity(`[CAPACITY-LABELS] ${input.id ?? input.kind} — ${geo.counts.textOverlap ?? 0} label bertumpuk dan ${geo.counts.textOutside ?? 0} teks keluar kanvas (${which})`, {
      checkId: "CAPACITY-LABELS",
      family: input.kind,
      quantity: "label bertumpuk/keluar kanvas",
      unit: "label",
      limit: 0,
      measured: crowded,
      suggestion: SUGGEST[input.kind],
    });
  }
  const lint = lintChartSvg(svg, {
    minFontPt: 5.5,
    maxColors: 5,
    family: (h) => colorFamily(h, pal),
    widths: limits.widthsMm,
    maxHeightMm: limits.maxHeightMm,
    accentHex: pal.role.accent,
    maxAccent: 1,
    apparatusPage: apparatus === "page",
  });
  const fails = lint.issues.filter((i) => i.status === "FAIL");
  if (fails.length > 0) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `[${fails[0].checkId}] chart Vega: ${fails[0].detail ?? "lint gagal"}`, { checkId: fails[0].checkId, issues: fails });
  }
  const notes: LintIssue[] = [
    { checkId: "VEGA_ENGINE", status: "REPORT", detail: `${built.engine} (interpreter, loader tertutup), ${Math.round(out.ms)} ms` },
    ...out.log.warnings.slice(0, 5).map((w) => ({ checkId: "VEGA_WARN", status: "REPORT" as const, detail: w })),
  ];
  const report = mergeReports(lint, figureLimitsReport(tpl.params), { checksRun: ["DATUM-25-HEX", "GEOM-CROWDED"], issues: notes });
  return { svg, widthMm: W, heightMm: H, report, kind: input.kind, engine: built.engine, renderMs: out.ms };
}

/** 300 dpi PNG of a rendered Vega chart through the render bridge (CP-47: 128 mm -> 1512 px, 166 mm -> 1961/1962 px). */
export async function rasterizeVegaChart(res: Pick<SvgResult, "svg" | "widthMm" | "heightMm">, tpl?: ResolvedTemplate): Promise<Uint8Array> {
  // Lazy: the browser module (render bridge client) is only needed for the raster.
  const { rasterizeSvg } = await import("../../browser");
  return rasterizeSvg(res.svg, { widthMm: res.widthMm, heightMm: res.heightMm, dpi: 300, tpl });
}

export function isVegaChartCode(code: unknown): code is VegaChartCode {
  return typeof code === "string" && (VEGA_CHART_CODES as readonly string[]).includes(code);
}
