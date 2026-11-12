/**
 * Swarm patch (row 158, decision U24 B): figures that exceed the engine's capacity are REFUSED
 * with a concrete suggestion instead of being squeezed into a messy result.
 *
 * One stable error code for diagrams and charts, `FIGURE_OVER_CAPACITY` (HTTP 422, registered in
 * contract/enums.ts and contract/errors.ts like row 69a's TEMPLATE_ARCHIVED). `details` carries the
 * measured value and the limit it broke, so a caller (agent) can act without parsing the message:
 *
 *   { checkId, figure, family, quantity, unit, limit, measured, suggestion, pointer?, furnitureMm? }
 *
 * `checkId` keeps the engine check that measured the overflow (DATUM-33 height, DATUM-37* width,
 * CAPACITY-ADAPT / CAPACITY-LABELS for a capacity layout that would only render with defects), so
 * the existing `details.checkId` contract (D-137) is unchanged. The message keeps the original
 * engine text and appends `; batas: ...` and `; saran: ...`.
 *
 * Diagram errors stay `instanceof DiagramDefect` (ported pin diagram-bad-cases.test.ts:118); chart
 * errors are plain `StudioEngineError`s, like the chart guards' `defect()`.
 */
import { StudioEngineError } from "../contract/errors";
import { DiagramDefect } from "./diagram/core/defect";

export const FIGURE_OVER_CAPACITY = "FIGURE_OVER_CAPACITY" as const;

export interface FigureOverCapacityDetails {
  /** Engine check that measured the overflow (DATUM-33, DATUM-37-lebar, CAPACITY-LABELS, ...). */
  checkId: string;
  /** "table": Swarm row 143a (C177 F143-1 (b)), a table wider than the full span (DT-10a), engine/table-fit.ts. */
  figure: "diagram" | "chart" | "table";
  /** Diagram family or chart code. */
  family: string;
  /** What was measured, in words (e.g. "kolom graph", "tinggi gambar"). */
  quantity: string;
  /** Unit of `limit` and `measured` (e.g. "mm", "kolom", "simpul", "kategori"). */
  unit: string;
  /** Largest value the engine can draw cleanly; null only when the engine reported no number. */
  limit: number | null;
  /** Value the submitted figure needs; null only when the engine reported no number. */
  measured: number | null;
  /** Concrete action: split the figure, fewer nodes/series, shorter labels. */
  suggestion: string;
  pointer?: string;
  /**
   * Swarm 1.2.6 row 67 (T-12, register N-019): height in mm of the apparatus furniture (caption, KUNCI and SUMBER
   * lines) of a diagram height refusal (DATUM-33, DATUM-37-tinggi), reported apart from the content: the agent can
   * tell a drawing that is too tall from one whose key and source lines push it over. Absent for width refusals.
   */
  furnitureMm?: number;
}

const num = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/**
 * `; batas: <quantity> maks <limit> <unit>, terukur <measured> <unit>[, kaki aparatus (KUNCI/SUMBER) <f> mm]; saran:
 * <suggestion>` appended to `base`. Swarm 1.2.6 row 67 (T-12): a number the engine did not report is left out of
 * the text instead of being printed "?" (the 1.2.5 stand-alone preview showed "lebar gambar maks ? mm").
 */
export function overCapacityMessage(base: string, d: Omit<FigureOverCapacityDetails, "figure" | "family" | "checkId">): string {
  const cut = base.indexOf("; saran:");
  const head = cut >= 0 ? base.slice(0, cut) : base;
  const parts: string[] = [];
  if (d.limit !== null) parts.push(`${d.quantity} maks ${num(d.limit)} ${d.unit}`);
  if (d.measured !== null) parts.push(`${d.limit !== null ? "" : `${d.quantity} `}terukur ${num(d.measured)} ${d.unit}`);
  if (d.furnitureMm !== undefined) parts.push(`kaki aparatus (KUNCI/SUMBER) ${num(d.furnitureMm)} mm`);
  const limits = parts.length ? parts.join(", ") : `${d.quantity} tidak terukur`;
  return `${head}; batas: ${limits}; saran: ${d.suggestion}`;
}

/** Diagram refusal: a `DiagramDefect` (class kept) whose code is FIGURE_OVER_CAPACITY. */
export class DiagramOverCapacity extends DiagramDefect {
  declare readonly details: FigureOverCapacityDetails;

  constructor(base: string, d: Omit<FigureOverCapacityDetails, "figure">) {
    super(overCapacityMessage(base, d), { checkId: d.checkId, pointer: d.pointer, code: FIGURE_OVER_CAPACITY });
    (this as { details: unknown }).details = { ...d, figure: "diagram" } satisfies FigureOverCapacityDetails;
  }
}

/** Chart refusal: a `StudioEngineError` with code FIGURE_OVER_CAPACITY. */
export class ChartOverCapacity extends StudioEngineError {
  declare readonly details: FigureOverCapacityDetails;

  constructor(base: string, d: Omit<FigureOverCapacityDetails, "figure">) {
    super(FIGURE_OVER_CAPACITY, overCapacityMessage(base, d), { ...d, figure: "chart" } satisfies FigureOverCapacityDetails);
  }
}

/** Table refusal (Swarm row 143a, C177 F143-1 (b)): a `StudioEngineError` with code FIGURE_OVER_CAPACITY. */
export class TableOverCapacity extends StudioEngineError {
  declare readonly details: FigureOverCapacityDetails;

  constructor(base: string, d: Omit<FigureOverCapacityDetails, "figure">) {
    super(FIGURE_OVER_CAPACITY, overCapacityMessage(base, d), { ...d, figure: "table" } satisfies FigureOverCapacityDetails);
  }
}

/** True for a row-158 refusal (any figure type, and row 143a's table refusal). */
export function isFigureOverCapacity(e: unknown): e is StudioEngineError & { details: FigureOverCapacityDetails } {
  return e instanceof StudioEngineError && e.code === FIGURE_OVER_CAPACITY;
}
