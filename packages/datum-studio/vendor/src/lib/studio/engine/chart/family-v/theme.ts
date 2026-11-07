/**
 * Swarm addition (row 163, U24 C; C6). DATUM tokens -> Vega / Vega-Lite configuration.
 *
 * Vega user units are TENTHS OF A MILLIMETRE (`VEGA_UNITS_PER_MM` = 10): Vega rounds several layout positions to
 * whole units (axis/legend/grid layout, vega-view-transforms layout/*.js Math.round), so a whole unit must be
 * small. `./svg` rescales the SVG back to the Studio canvas unit (mm) after rendering. Font sizes are pt x 25.4/72
 * mm, stroke widths >= 0.18 mm (photocopy floor, Rev A lint 27), all multiplied by the unit factor here. Colours come only from the
 * template palette (`chartPalette`): five roles at most per figure (Rev A lint 25):
 *   text ink900, context ink700 / ink400, background ink200, accent signal. Paper is the ground (not counted).
 * Fonts: IBM Plex Sans Condensed (structure) and IBM Plex Mono (numbers), as the Rev A chart families.
 */
import type { ResolvedTemplate } from "../../../contract";
import { chartPalette } from "../core/palette";
import { MM_PER_PT } from "../core/svg";
import type { VegaChartLang } from "./input";
import { VEGA_FONT_DATA, VEGA_FONT_STRUCT, VEGA_UNITS_PER_MM } from "./sandbox";

export { VEGA_UNITS_PER_MM };

/** mm -> Vega units. */
export const u = (mm: number): number => Math.round(mm * VEGA_UNITS_PER_MM * 1000) / 1000;

export const LABEL_PT = 6.4;
export const SMALL_PT = 6.2;
export const mmOfPt = (pt: number): number => Math.round(pt * MM_PER_PT * 10000) / 10000;
/** pt -> Vega units. */
export const uPt = (pt: number): number => u(mmOfPt(pt));

/** Hairline widths (mm). */
export const STROKE = { axis: 0.2, grid: 0.18, line: 0.35, accentLine: 0.5, sep: 0.25 } as const;

export interface VegaTheme {
  paper: string;
  ink900: string;
  ink700: string;
  ink400: string;
  ink200: string;
  accent: string;
  /** Categorical colours for up to 4 series; the accent series, when named, takes `accent`. */
  series(names: readonly string[], accent?: string): string[];
  lang: VegaChartLang;
}

const hash = (h: string) => `#${h.replace(/^#/, "").toUpperCase()}`;

export function vegaTheme(tpl: ResolvedTemplate, lang: VegaChartLang): VegaTheme {
  const p = chartPalette({ kind: "P-01" } as never, tpl);
  const t = {
    paper: hash(p.paper),
    ink900: hash(p.ink900),
    ink700: hash(p.ink700),
    ink400: hash(p.ink400),
    ink200: hash(p.ink200),
    accent: hash(p.role.accent),
  };
  return {
    ...t,
    lang,
    series(names, accent) {
      // Without an accent: the ink ramp, darkest first. With one: accent + the ramp for context.
      const ramp = [t.ink900, t.ink700, t.ink400, t.ink200];
      if (accent === undefined || !names.includes(accent)) return names.map((_, i) => ramp[i % ramp.length]);
      const ctx = [t.ink700, t.ink400, t.ink200];
      let k = 0;
      return names.map((n) => (n === accent ? t.accent : ctx[k++ % ctx.length]));
    },
  };
}

/** d3-format locale per language (decimal comma for Indonesian, as `engine/bind/format.ts`). */
export function numberLocale(lang: VegaChartLang) {
  return lang === "en"
    ? { decimal: ".", thousands: ",", grouping: [3], currency: ["", ""] }
    : { decimal: ",", thousands: ".", grouping: [3], currency: ["Rp", ""] };
}

/** Vega-Lite `config` built from the theme (agents never send config: input.ts refuses the key). */
export function vlConfig(th: VegaTheme): Record<string, unknown> {
  const L = uPt(LABEL_PT);
  const S = uPt(SMALL_PT);
  return {
    font: VEGA_FONT_STRUCT,
    padding: 0,
    // No ARIA descriptions: Vega-Lite would add description expressions that the headless SVG strips anyway.
    aria: false,
    view: { stroke: null },
    locale: { number: numberLocale(th.lang) },
    axis: {
      labelFont: VEGA_FONT_STRUCT,
      labelFontSize: L,
      labelColor: th.ink900,
      labelPadding: u(0.8),
      labelOverlap: true,
      labelFlush: false,
      labelBound: false,
      labelAngle: 0,
      labelLimit: 0,
      titleFont: VEGA_FONT_STRUCT,
      titleFontSize: L,
      titleFontWeight: "normal",
      titleColor: th.ink700,
      titlePadding: u(1.6),
      domainColor: th.ink400,
      domainWidth: u(STROKE.axis),
      tickColor: th.ink400,
      tickWidth: u(STROKE.axis),
      tickSize: u(1.2),
      grid: false,
      gridColor: th.ink200,
      gridWidth: u(STROKE.grid),
      tickCount: 5,
      tickRound: false,
      aria: false,
      translate: 0,
      minExtent: 0,
      maxExtent: u(40),
    },
    legend: {
      orient: "bottom",
      direction: "horizontal",
      labelFont: VEGA_FONT_STRUCT,
      labelFontSize: S,
      labelColor: th.ink900,
      labelLimit: 0,
      labelOffset: u(1),
      title: null,
      titleFontSize: S,
      titleColor: th.ink700,
      titleFontWeight: "normal",
      symbolType: "square",
      symbolSize: u(2) * u(2),
      symbolStrokeWidth: 0,
      columnPadding: u(3),
      rowPadding: u(0.8),
      padding: 0,
      offset: u(2.4),
      aria: false,
    },
    text: { font: VEGA_FONT_STRUCT, fontSize: L, color: th.ink900 },
    mark: { color: th.ink400, aria: false },
    line: { strokeWidth: u(STROKE.line) },
    rule: { strokeWidth: u(STROKE.axis), color: th.ink400 },
    point: { size: u(1) * u(1), strokeWidth: 0, filled: true },
    arc: { stroke: th.paper, strokeWidth: u(STROKE.sep) },
    rect: { strokeWidth: 0 },
    area: { strokeWidth: 0 },
  };
}

/** Vega `config` for the specs written directly in Vega (./specs V-07, V-08). */
export function vgConfig(th: VegaTheme): Record<string, unknown> {
  return {
    locale: { number: numberLocale(th.lang) },
    text: { font: VEGA_FONT_STRUCT, fontSize: uPt(LABEL_PT), fill: th.ink900 },
  };
}

export { VEGA_FONT_DATA, VEGA_FONT_STRUCT };
