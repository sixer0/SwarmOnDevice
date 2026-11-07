/**
 * Swarm addition (row 163, U24 C). Vega SVG -> Studio chart markup.
 *
 * Vega renders in 1/10 mm units (./theme header). `vegaInnerMarkup` keeps the inner markup of Vega's root
 * `<svg>`, drops Vega's interaction / ARIA bookkeeping, and rescales every length back to millimetres so the
 * Studio chart lints (font pt, stroke mm, geometry) and the Rev A file lint read real sizes:
 *   x y x1 y1 x2 y2 width height cx cy r rx ry dx dy font-size stroke-width letter-spacing stroke-dasharray,
 *   transform translate()/rotate(a cx cy)/matrix(e f), and path data (arc flags and rotation kept).
 * A zero stroke width is removed together with its stroke (no hairline below the 0.18 mm floor).
 */
import { StudioEngineError } from "../../../contract/errors";
import { VEGA_UNITS_PER_MM } from "./sandbox";

const LENGTH_ATTRS = new Set(["x", "y", "x1", "y1", "x2", "y2", "width", "height", "cx", "cy", "r", "rx", "ry", "dx", "dy", "font-size", "stroke-width", "letter-spacing"]);
const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

const fmt = (v: number): string => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? "0" : String(r);
};

function scaleList(v: string, f: number): string {
  return v.replace(NUM, (n) => fmt(Number(n) * f));
}

function scaleTransform(v: string, f: number): string {
  return v.replace(/(translate|rotate|matrix|scale)\s*\(([^)]*)\)/g, (_, op: string, args: string) => {
    const n = (args.match(NUM) ?? []).map(Number);
    if (op === "translate") return `translate(${n.map((x) => fmt(x * f)).join(",")})`;
    if (op === "rotate") return `rotate(${[fmt(n[0] ?? 0), ...n.slice(1).map((x) => fmt(x * f))].join(",")})`;
    if (op === "matrix" && n.length === 6) return `matrix(${[...n.slice(0, 4).map(fmt), fmt(n[4] * f), fmt(n[5] * f)].join(",")})`;
    return `${op}(${args})`;
  });
}

/** Scale path data; arcs keep rotation and flags. */
export function scalePath(d: string, f: number): string {
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: string[] = [];
  let cmd = "";
  let k = 0;
  for (const t of tokens) {
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t;
      k = 0;
      out.push(t);
      continue;
    }
    const v = Number(t);
    if (cmd === "A" || cmd === "a") {
      const pos = k % 7;
      out.push(pos === 2 || pos === 3 || pos === 4 ? fmt(v) : fmt(v * f));
    } else {
      out.push(fmt(v * f));
    }
    k++;
  }
  // Join: a number after a number needs a separator.
  let s = "";
  for (const t of out) s += /^[A-Za-z]$/.test(t) || s === "" || /[A-Za-z]$/.test(s) ? t : ` ${t}`;
  return s;
}

function rescaleTag(tag: string, f: number): string {
  let t = tag.replace(/\s([a-zA-Z][a-zA-Z0-9:-]*)="([^"]*)"/g, (all, name: string, value: string) => {
    if (LENGTH_ATTRS.has(name)) return ` ${name}="${scaleList(value.replace(/px$/, ""), f)}"`;
    if (name === "stroke-dasharray") return ` ${name}="${scaleList(value, f)}"`;
    if (name === "transform") return ` ${name}="${scaleTransform(value, f)}"`;
    if (name === "d") return ` d="${scalePath(value, f)}"`;
    return all;
  });
  if (/\sstroke-width="0"/.test(t)) t = t.replace(/\sstroke-width="0"/, "").replace(/\sstroke="[^"]*"/, "");
  return t;
}

/** Inner markup of a Vega SVG, cleaned and rescaled from Vega units to mm. */
export function vegaInnerMarkup(svg: string): string {
  const open = /^<svg\b[^>]*>/.exec(svg);
  const end = svg.lastIndexOf("</svg>");
  if (!open || end < 0) throw new StudioEngineError("RENDER_FAILED", "chart Vega: keluaran bukan SVG", {});
  const f = 1 / VEGA_UNITS_PER_MM;
  return svg
    .slice(open[0].length, end)
    .replace(/<path class="(?:background|foreground)"[^>]*\/>/g, "")
    .replace(/\s(?:class|role|aria-[a-z-]+|pointer-events)="[^"]*"/g, "")
    .replace(/\sopacity="1"/g, "")
    .replace(/\sstroke-miterlimit="[^"]*"/g, "")
    .replace(/<[a-zA-Z][^>]*>/g, (tag) => rescaleTag(tag, f))
    .replace(/<g>\s*<\/g>/g, "")
    .replace(/<g>\s*<\/g>/g, "");
}
