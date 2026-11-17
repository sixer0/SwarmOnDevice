/**
 * Swarm 1.3.3 row 39 (ST-2 write side; register 03 §6): the figure fields of the `studio_write` / `studio_edit` block
 * input that mirror the figure contract, DERIVED from the contract schema (`contract/schema/v2/common.schema.ts`)
 * instead of typed a second time:
 *
 * - `width` on a figure block: the values are `FIGURE_WIDTH_VALUES` of the contract.
 * - W-07 intervals in the chart block: `chart.intervals` (= `data.items`) with the data-level fields beside it
 *   (`statusAt`, `timeUnit`), normalised to `data { shape: "intervals", items, ... }`. The key lists and the
 *   validator are read from the `intervals` variant of `$defs.ChartDataV2`, so a field added to the contract is
 *   accepted here without an edit and a field removed there is refused here.
 *
 * tools/list carries only the compact input shape (`CHART_INTERVALS_INPUT`); the full check runs when the tool
 * runs (`intervalsChart`), with the pointer named in the words of the input (`/intervals/0/float`).
 * Pure: no I/O. Seam for row 77 (studio_write / studio_edit block parity): add figure input fields HERE and spread
 * them into the block schemas; `write-tools.ts`, `write-normalize.ts`, `write-client.ts` only read these names.
 */
import Ajv from "ajv";
import { STUDIO_AJV_OPTIONS } from "../../../src/lib/studio/contract";
import { commonV2Schema, FIGURE_WIDTH_VALUES } from "../../../src/lib/studio/contract/schema/v2/common.schema";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o: Rec, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

// ── width ───────────────────────────────────────────────────────────────

export const FIGURE_WIDTH_KEY = "width";
/** Input schema fragment for a figure block: `{ width: "text" | "full" }`, optional, values from the contract. */
export const FIGURE_WIDTH_INPUT = { [FIGURE_WIDTH_KEY]: { enum: [...FIGURE_WIDTH_VALUES] } } as const;

// ── W-07 intervals ──────────────────────────────────────────────────────

/** The `intervals` variant of the contract's chart data (closed object: shape, items, and the data-level fields). */
function contractIntervals(): { schema: Rec; properties: Rec; items: Rec } {
  const data = (commonV2Schema.$defs as unknown as Rec).ChartDataV2;
  const variants = isRec(data) && Array.isArray(data.oneOf) ? (data.oneOf as unknown[]).filter(isRec) : [];
  const schema = variants.find((v) => isRec(v.properties) && isRec(v.properties.shape) && v.properties.shape.const === "intervals");
  const properties = schema !== undefined && isRec(schema.properties) ? schema.properties : null;
  const items = properties !== null && isRec(properties.items) ? properties.items : null;
  if (schema === undefined || properties === null || items === null || !isRec(items.items)) throw new Error("figure contract: ChartDataV2 has no intervals shape with items");
  return { schema, properties, items };
}
const CONTRACT = contractIntervals();

/** Chart code of an intervals chart when `type` is not a chart code (the only registry code with this data shape). */
export const CHART_INTERVALS_CODE = "W-07";
/** Name of the item list in the chart block (register 03 §6): `chart.intervals` = contract `data.items`. */
export const CHART_INTERVALS_KEY = "intervals";
/** Data-level fields beside the items, read from the contract (today: statusAt, timeUnit). */
export const CHART_INTERVALS_DATA_KEYS: readonly string[] = Object.keys(CONTRACT.properties).filter((k) => k !== "shape" && k !== "items");
/** Every chart-block key that belongs to the intervals shape. */
export const CHART_INTERVALS_INPUT_KEYS: readonly string[] = [CHART_INTERVALS_KEY, ...CHART_INTERVALS_DATA_KEYS];
/** Fields of one interval item, read from the contract (label, start, end, group, milestone, float, critical). */
export const CHART_INTERVALS_ITEM_KEYS: readonly string[] = Object.keys((CONTRACT.items.items as Rec).properties as Rec);

/**
 * Compact input schema fragment for the chart block (tools/list budget): the item list is bounded as in the contract
 * and its items are open objects; the data-level fields are open. `intervalsChart` applies the contract itself.
 */
export const CHART_INTERVALS_INPUT: Readonly<Rec> = {
  [CHART_INTERVALS_KEY]: { type: "array", minItems: CONTRACT.items.minItems, maxItems: CONTRACT.items.maxItems, items: { type: "object" } },
  ...Object.fromEntries(CHART_INTERVALS_DATA_KEYS.map((k) => [k, {}])),
};

const intervalsValid = new Ajv({ ...STUDIO_AJV_OPTIONS, discriminator: false }).compile(CONTRACT.schema);

/** A chart block input that carries the intervals shape (any of its keys present). */
export function isIntervalsChart(c: unknown): boolean {
  return isRec(c) && CHART_INTERVALS_INPUT_KEYS.some((k) => has(c, k));
}

/**
 * Lenient form: `chart.data = { shape: "intervals", items, statusAt?, timeUnit? }` (the contract's own data shape, as
 * sent to the preview) is lifted to `chart.intervals` + the fields beside it. Returns true when lifted. Values are
 * moved, never changed; an unknown key inside `data` is kept under its own name so the contract check refuses it.
 */
export function liftIntervalsData(c: Rec): boolean {
  const d = c.data;
  if (!isRec(d) || d.shape !== "intervals" || has(c, CHART_INTERVALS_KEY)) return false;
  for (const [k, v] of Object.entries(d)) {
    if (k === "shape") continue;
    const to = k === "items" ? CHART_INTERVALS_KEY : k;
    if (!has(c, to)) c[to] = v;
  }
  delete c.data;
  return true;
}

export interface IntervalsChart {
  code: string;
  /** `{ shape: "intervals", items, statusAt?, timeUnit? }`: the input values, unchanged. */
  data: Rec;
  /** Empty = valid against the contract. Each entry names the input field (`/intervals/0/float ...`). */
  issues: string[];
}

const CODE_RE = /^[A-Z]{1,2}-\d{2}$/;
const MAX_ISSUES = 5;

/**
 * Chart block input with intervals -> contract data. Nothing is invented or converted: `items` is the given array.
 * Refused (issues): intervals together with categories/series, and anything the contract's intervals shape refuses
 * (missing label/start/end, negative `float`, non-boolean `critical`, unknown item or data field, more than the cap).
 */
export function intervalsChart(c: Rec): IntervalsChart {
  const data: Rec = { shape: "intervals", items: c[CHART_INTERVALS_KEY] };
  for (const k of CHART_INTERVALS_DATA_KEYS) if (has(c, k)) data[k] = c[k];
  const t = typeof c.type === "string" ? c.type.trim().toUpperCase() : "";
  const code = CODE_RE.test(t) ? t : CHART_INTERVALS_CODE;
  const issues: string[] = [];
  const mixed = ["categories", "series"].filter((k) => has(c, k));
  if (mixed.length > 0) issues.push(`/${mixed[0]} tidak boleh bersama ${CHART_INTERVALS_KEY} (satu grafik = kategori x seri ATAU ${CHART_INTERVALS_KEY})`);
  if (!has(c, CHART_INTERVALS_KEY)) issues.push(`/${CHART_INTERVALS_KEY} wajib bila ${CHART_INTERVALS_DATA_KEYS.join("/")} diberikan`);
  else if (!intervalsValid(data)) {
    const errs = intervalsValid.errors ?? [];
    for (const e of errs.slice(0, MAX_ISSUES)) {
      const extra = e.keyword === "additionalProperties" && isRec(e.params) && typeof e.params.additionalProperty === "string" ? `/${e.params.additionalProperty}` : "";
      const at = `${e.instancePath}${extra}`.replace(/^\/items(?=\/|$)/, `/${CHART_INTERVALS_KEY}`);
      issues.push(`${at || "/"} ${extra !== "" ? "bukan medan interval" : String(e.message ?? "tidak sah")}`.slice(0, 200));
    }
    if (errs.length > MAX_ISSUES) issues.push(`(+${errs.length - MAX_ISSUES} isu lain)`);
  }
  return { code, data, issues };
}

/** Work report (no figures): an intervals chart as a table, one row per item, only the columns that are used. */
export function intervalsRows(c: Rec): Array<Array<string | number>> {
  const items = Array.isArray(c[CHART_INTERVALS_KEY]) ? (c[CHART_INTERVALS_KEY] as unknown[]).filter(isRec) : [];
  const cols = CHART_INTERVALS_ITEM_KEYS.filter((k) => items.some((it) => has(it, k)));
  const cell = (v: unknown): string | number => (typeof v === "number" || typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
  return [cols, ...items.map((it) => cols.map((k) => cell(it[k])))];
}

// ── negative values (Swarm 1.3.3 row 77, ST-10) ─────────────────────────

/**
 * Chart codes whose marks rest on a zero baseline or show a share, so the engine refuses a negative value at render
 * (rule CH-01 in `engine/chart/core/guards.ts` `assertNonNegative` and its family variants; K-07..K-10 and K-12 report
 * their own code; V-02 and V-06 are refused by `family-v`). The write tools refuse the same value before anything is
 * stored. Codes that draw a negative value (lines W-01/W-03/W-06/W-09, lollipop P-04, dumbbell P-06, slope P-08,
 * waterfall P-10, small multiples P-12, P-14, area W-04, diverging K-03) are NOT listed and stay accepted.
 * Pinned to the engine by test/st10-write-edit-parity (every code is rendered with one negative value).
 */
export const NON_NEGATIVE_CHART_CODES: ReadonlySet<string> = new Set([
  "P-01", "P-02", "P-03", "P-09", "P-11",
  "K-01", "K-02", "K-04", "K-05", "K-06", "K-07", "K-08", "K-09", "K-10", "K-12",
  "W-02", "W-05",
  "V-02", "V-06",
]);

export interface NegativeValue {
  /** Index of the series and of the value inside it, as in the input `series[j].values[k]`. */
  series: number;
  index: number;
  value: number;
}

/** Negative values of a categories x series chart that `code` cannot draw (empty for a code that draws them). */
export function negativeChartValues(code: string, series: unknown): NegativeValue[] {
  if (!NON_NEGATIVE_CHART_CODES.has(code) || !Array.isArray(series)) return [];
  const out: NegativeValue[] = [];
  series.forEach((s, j) => {
    const values = isRec(s) && Array.isArray(s.values) ? s.values : [];
    values.forEach((v, k) => {
      if (typeof v === "number" && v < 0) out.push({ series: j, index: k, value: v });
    });
  });
  return out;
}

/** The refusal text of one negative value, in the words of the input (rule id CH-01, the field path and the value). */
export function negativeValueMessage(code: string, n: NegativeValue): string {
  return `CH-01: series/${n.series}/values/${n.index} = ${n.value}; ${code} tidak dapat menggambar nilai negatif (pakai type K-03 diverging, P-10 waterfall, atau garis W-01)`;
}
