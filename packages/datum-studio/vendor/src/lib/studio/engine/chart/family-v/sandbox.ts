/**
 * Swarm addition (row 163, U24 C). THE ONLY place in Studio that calls Vega's `parse` and `new View`
 * (verification/18_row160_engine_deps_security.md §4 C1, C3, C7, C8, C11 and §3 M1-M5).
 *
 * - C1 interpreter always: `parse(spec, config, { ast: true })` + `new View(runtime, { expr: expressionInterpreter })`.
 *   Both halves are needed: without `ast` the interpreter gets no AST (vega-functions parser.js:39); without `expr`
 *   the runtime falls back to Function codegen (vega-runtime context.js:27).
 * - C3 deny-all loader: every load/file/http rejects with a DATUM message; `sanitize` RESOLVES `{ href: "" }` and
 *   never rejects, so image marks get `src ""` and links never dereference `null` (M5).
 * - Vega's own messages go to a collecting logger (no console); any Vega error refuses the render.
 * - C8 time limit: a render that has not finished within `timeoutMs` is refused RENDER_TIMEOUT, and one that
 *   finished late is refused too (Vega runs synchronously between awaits, so the race alone cannot stop it).
 * - Output: SVG string through vega-scenegraph's SVGStringRenderer (`renderer: "none"` + `toSVG()`), no DOM, no canvas.
 * - Text widths: Studio's measurement (`textfit.measure`, Plex metrics) replaces vega's `0.8 x chars x size`
 *   estimate (research/16 R5). Vega units here are 1/10 mm (see ./theme), so the font size is converted to pt.
 * - C11 `canvas`: vega-canvas's node build does `await import("canvas")` in try/catch; no `canvas` package is
 *   installed (test T9 asserts it does not resolve), the electron-vite alias is filed for the desktop owner.
 */
import { View, Warn, parse, textMetrics } from "vega";
import type { Spec as VgSpec } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { StudioEngineError } from "../../../contract/errors";
import { MM_PER_PT } from "../core/svg";
import { measure } from "../core/textfit";

// vega re-exports vega-scenegraph's `textMetrics` (vega/index.js `export * from 'vega-scenegraph'`), but its
// typings (vega-typings 2.3.0) do not declare it.
declare module "vega" {
  export const textMetrics: { width: unknown; estimateWidth: unknown };
}

export const VEGA_RENDER_TIMEOUT_MS = 10_000;
/** Vega user units per millimetre (./theme header: Vega rounds layout positions to whole units). */
export const VEGA_UNITS_PER_MM = 10;
export const VEGA_OUTPUT_MAX_BYTES = 5 * 1024 * 1024;

/** DATUM fonts as written in the Vega specs (./theme). */
export const VEGA_FONT_STRUCT = "IBM Plex Sans Condensed";
export const VEGA_FONT_DATA = "IBM Plex Mono";

const deny = (what: string) => async (): Promise<never> => {
  throw new Error(`DATUM: ${what} is disabled`);
};

/** C3: the loader every Studio View gets. Never call vega's exported `loader()`. */
export const denyAllLoader = Object.freeze({
  options: Object.freeze({}),
  fileAccess: false,
  load: deny("external data"),
  file: deny("file access"),
  http: deny("network"),
  sanitize: async (): Promise<{ href: string }> => ({ href: "" }),
});

// Text measurement in Vega units (1/10 mm): measure() takes pt and returns mm.
type TextItem = { fontSize?: number; font?: string; fontWeight?: string | number };
function studioTextWidth(item: TextItem, text: unknown): number {
  const s = text == null ? "" : String(text).trim();
  const sizeMm = item.fontSize != null ? (Number(item.fontSize) || 0) / VEGA_UNITS_PER_MM : 2.2578;
  if (!s || sizeMm <= 0) return 0;
  const face = typeof item.font === "string" && item.font.includes("Mono") ? "data" : "struct";
  const bold = item.fontWeight === "bold" || Number(item.fontWeight) >= 600;
  return measure(s, sizeMm / MM_PER_PT, face, { bold }) * VEGA_UNITS_PER_MM;
}
textMetrics.width = studioTextWidth;
textMetrics.estimateWidth = studioTextWidth;

/** Vega log messages of one render. */
export interface VegaLog {
  errors: string[];
  warnings: string[];
}

function collectingLogger(log: VegaLog) {
  let level = Warn;
  const text = (args: unknown[]) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ").slice(0, 300);
  const self = {
    level(l?: number) {
      if (l === undefined) return level;
      level = l;
      return self;
    },
    error(...a: unknown[]) {
      log.errors.push(text(a));
      return self;
    },
    warn(...a: unknown[]) {
      log.warnings.push(text(a));
      return self;
    },
    info() {
      return self;
    },
    debug() {
      return self;
    },
  };
  return self;
}

export interface VegaSvgResult {
  svg: string;
  log: VegaLog;
  ms: number;
}

/**
 * Render a Vega spec BUILT BY STUDIO (./specs) to an SVG string under the C1/C3 configuration.
 * Callers must have run `assertStudioVegaSpec` (./guard) first; this function is the last line, not the first.
 */
export async function vegaSvg(spec: VgSpec, o: { timeoutMs?: number } = {}): Promise<VegaSvgResult> {
  const timeoutMs = o.timeoutMs ?? VEGA_RENDER_TIMEOUT_MS;
  const log: VegaLog = { errors: [], warnings: [] };
  const t0 = performance.now();
  let view: View | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const runtime = parse(spec, undefined, { ast: true });
    view = new View(runtime, {
      expr: expressionInterpreter,
      renderer: "none",
      loader: denyAllLoader as unknown as never,
      logger: collectingLogger(log) as unknown as never,
      logLevel: Warn,
    });
    const work = view.runAsync().then(() => view!.toSVG());
    // Never leave a rejection unobserved, even after the timeout won the race.
    work.catch(() => undefined);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StudioEngineError("RENDER_TIMEOUT", `chart Vega: render > ${timeoutMs} ms`, { limitMs: timeoutMs })), timeoutMs);
    });
    const svg = await Promise.race([work, timeout]);
    const ms = performance.now() - t0;
    if (ms > timeoutMs) throw new StudioEngineError("RENDER_TIMEOUT", `chart Vega: render ${Math.round(ms)} ms > ${timeoutMs} ms`, { limitMs: timeoutMs, measuredMs: Math.round(ms) });
    // Vega reports a failed load as a WARNING and renders without the data; a refused load is a refusal here.
    const refused = [...log.errors, ...log.warnings.filter((w) => w.includes("DATUM:"))];
    if (refused.length > 0) throw new StudioEngineError("RENDER_FAILED", `chart Vega: ${refused[0]}`, { errors: refused.slice(0, 5) });
    if (Buffer.byteLength(svg, "utf8") > VEGA_OUTPUT_MAX_BYTES) {
      throw new StudioEngineError("PAYLOAD_TOO_LARGE", `chart Vega: SVG > ${VEGA_OUTPUT_MAX_BYTES} byte`, { limit: VEGA_OUTPUT_MAX_BYTES });
    }
    return { svg, log, ms };
  } catch (e) {
    if (e instanceof StudioEngineError) throw e;
    throw new StudioEngineError("RENDER_FAILED", `chart Vega: ${e instanceof Error ? e.message.slice(0, 300) : "render gagal"}`, { errors: log.errors.slice(0, 5) });
  } finally {
    if (timer) clearTimeout(timer);
    view?.finalize();
  }
}
