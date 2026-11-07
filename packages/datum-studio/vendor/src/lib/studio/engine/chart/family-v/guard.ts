/**
 * Swarm addition (row 163, U24 C). Defence in depth around the Vega sandbox (verification/18_row160 §4):
 *
 * - `assertStudioVegaSpec` (before `vegaSvg`): the compiled Vega spec that Studio built must still use only inline
 *   JSON `values` (C4), no image mark / href / url / cursor (C5), only the C7 transform allow-list, no signal
 *   `bind`, no `$schema` / `usermeta` / projections. Studio's own builders never produce these; this catches a
 *   future builder mistake before Vega runs.
 * - `assertSafeSvg` (after `vegaSvg`, and again on the final DATUM SVG): the C6 output gate. Refuses `<image`,
 *   `<a `, any `href` other than `#...`, `url(` other than `url(#`, `<script`, `<foreignObject`, `@import`, and
 *   `http:` / `https:` / `file:` / `javascript:` / `data:` in markup (text nodes excluded, SVG namespaces excluded).
 */
import { StudioEngineError } from "../../../contract/errors";

/** C7 allow-list (+ Vega's own bookkeeping transforms that the Vega-Lite compiler emits). */
const TRANSFORMS = new Set([
  "aggregate",
  "bin",
  "stack",
  "window",
  "fold",
  "pivot",
  "timeunit",
  "filter",
  "formula",
  "quantile",
  "density",
  "regression",
  "loess",
  "partition",
  "tree",
  "stratify",
  "pie",
  "treelinks",
  "linkpath",
  "collect",
  "extent",
  "identifier",
  "project",
  "impute",
  "joinaggregate",
]);
const BAD_MARKS = new Set(["image"]);
const BAD_KEYS = new Set(["url", "href", "cursor", "usermeta", "projection", "projections", "bind"]);

function refuse(message: string, details: Record<string, unknown>): StudioEngineError {
  return new StudioEngineError("BY_CONSTRUCTION_FAILED", `chart Vega: ${message}`, details);
}

export function assertStudioVegaSpec(spec: unknown): void {
  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > 64) throw refuse("spec Vega terlalu dalam", { path });
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}/${i}`, depth + 1));
    if (v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") throw refuse(`kunci ${k} di spec Vega`, { path });
      if (BAD_KEYS.has(k)) throw refuse(`medan "${k}" di spec Vega (C4/C5)`, { path: `${path}/${k}` });
    }
    if (path.match(/\/data\/\d+$/)) {
      if ("format" in o) {
        const f = o.format as { type?: unknown } | undefined;
        if (f && f.type !== undefined && f.type !== "json") throw refuse(`format data ${String(f.type)} (C4: hanya JSON sebaris)`, { path });
      }
      if ("values" in o && !Array.isArray(o.values)) throw refuse("values data harus larik objek JSON (C4)", { path });
    }
    if (path.match(/\/marks\/\d+$/) && typeof o.type === "string" && BAD_MARKS.has(o.type)) throw refuse(`mark ${o.type} (C5)`, { path });
    if (path.match(/\/transform\/\d+$/) && typeof o.type === "string" && !TRANSFORMS.has(o.type)) throw refuse(`transform ${o.type} di luar daftar C7`, { path });
    for (const k of Object.keys(o)) walk(o[k], `${path}/${k}`, depth + 1);
  };
  walk(spec, "", 0);
}

const SVG_NS_DECL = /\s(?:xmlns|xmlns:xlink)="http:\/\/www\.w3\.org\/[^"]*"/g;

export function assertSafeSvg(svg: string): void {
  // Text nodes are XML-escaped data (a SUMBER line may name a web page); the gate checks markup only.
  const raw = svg.replace(SVG_NS_DECL, "");
  // Studio's chart SVG has no <style> (the raster step adds its own font faces later); refuse one, and @import.
  if (/<style\b/i.test(raw) || /@import/i.test(raw)) throw refuse("keluaran SVG memuat <style>/@import (gerbang C6)", { check: "style" });
  const s = raw.replace(/>[^<]*</g, "><");
  const checks: Array<[RegExp, string]> = [
    [/<image\b/i, "<image>"],
    [/<a\b/i, "<a>"],
    [/<script\b/i, "<script>"],
    [/<foreignObject\b/i, "<foreignObject>"],
    [/\b(?:xlink:)?href\s*=\s*"(?!#)[^"]*"/i, "href ke luar dokumen"],
    [/url\(\s*(?!#)/i, "url() ke luar dokumen"],
    [/\b(?:https?|file|javascript|data):/i, "skema URL"],
    [/\son[a-z]+\s*=/i, "atribut event"],
  ];
  for (const [re, what] of checks) {
    if (re.test(s)) throw refuse(`keluaran SVG memuat ${what} (gerbang C6)`, { check: what });
  }
}
