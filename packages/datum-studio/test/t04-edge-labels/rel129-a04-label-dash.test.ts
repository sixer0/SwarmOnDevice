// Swarm 1.2.9 row 27 (AC-A04, N9-103): the FIRST render (auto-fit off) places each edge label with the dash pattern
// of its own connector, so the label's knockout band never leaves a stray dash fragment. dg_layered_good is lint-clean,
// so `buildDiagramSvg` returns its first render as is (no auto-fit re-render: `report.geometry` empty, asserted).
// BASE: `labelPos` (build/svg.ts) called `spotClear(pts, heads, band)` without the 4th `dash` argument that the
// auto-fit path already passes (build/fitlabels.ts), so a band could cut a dash and leave a piece shorter than
// DASH_FRAGMENT_MM beside it. Geometry is read from the SVG only (connector `d`, `stroke-dasharray`, marker size,
// knockout rect), each label paired with its own connector (same colour, the label point on the polyline).
import { describe, expect, it } from "bun:test";
import { useStudioEnv } from "../ported/_env";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build";
import { spotClear } from "@/lib/studio/engine/diagram/fit/labels";
import { clone, parityDiagramSpecs } from "../ported/figures/_helpers";

useStudioEnv();

type Pt = [number, number];
type Box = [number, number, number, number];
type Link = { pts: Pt[]; stroke: string; dash?: number[]; heads: { end?: { L: number; W: number }; start?: { L: number; W: number } } };
type Label = { text: string; fill: string; band: Box; at: Pt };

const PT_MM = 25.4 / 72;
const attr = (tag: string, name: string): string | undefined => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

/** Marker id -> head size: `arrowMarkerSvg` draws markerWidth = L + 2 (1 mm margin each side), W = 0.89 L. */
function markerSizes(svg: string): Map<string, { L: number; W: number }> {
  const out = new Map<string, { L: number; W: number }>();
  for (const m of svg.matchAll(/<marker\b[^>]*>/g)) {
    const id = attr(m[0], "id");
    const mw = Number(attr(m[0], "markerWidth"));
    if (id && Number.isFinite(mw)) out.set(id, { L: mw - 2, W: 0.89 * (mw - 2) });
  }
  return out;
}

function linksOf(svg: string): Link[] {
  const sizes = markerSizes(svg);
  const head = (v: string | undefined) => (v ? sizes.get(v.replace(/^url\(#|\)$/g, "")) : undefined);
  return [...svg.matchAll(/<path\b[^>]*data-mark="link"[^>]*\/>/g)].map((m) => {
    const tag = m[0];
    const nums = (attr(tag, "d") ?? "").match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const pts: Pt[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    const dashAttr = attr(tag, "stroke-dasharray");
    const end = head(attr(tag, "marker-end"));
    const start = head(attr(tag, "marker-start"));
    return {
      pts,
      stroke: attr(tag, "stroke") ?? "",
      ...(dashAttr ? { dash: dashAttr.split(",").map(Number) } : {}),
      heads: { ...(end ? { end } : {}), ...(start ? { start } : {}) },
    };
  });
}

/** Edge labels = a knockout rect directly followed by a centred IBM Plex Mono text (`edgeLabelSvg`). */
function labelsOf(svg: string): Label[] {
  const re = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="[^"]*"\/>\s*<text ([^>]*font-family="IBM Plex Mono"[^>]*text-anchor="middle"[^>]*)>([^<]*)<\/text>/g;
  return [...svg.matchAll(re)].map((m) => {
    const [x, y, w, h] = [m[1], m[2], m[3], m[4]].map(Number);
    const tag = ` ${m[5]}`;
    const tx = Number(attr(tag, "x"));
    const ty = Number(attr(tag, "y"));
    return { text: m[6], fill: attr(tag, "fill") ?? "", band: [x, y, x + w, y + h], at: [tx, ty + 1.2 * PT_MM] };
  });
}

/** Distance from `p` to the polyline `pts`. */
function distTo(pts: Pt[], p: Pt): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]));
  }
  return best;
}

/** Per label: its own connector (same colour, label point within 0.02 mm of the line) and whether its band is clear. */
function ownLinkLabelCheck(svg: string): Array<{ text: string; paired: boolean; dashed: boolean; clear: boolean }> {
  const links = linksOf(svg);
  return labelsOf(svg).map((lb) => {
    const own = links.filter((l) => l.stroke === lb.fill && distTo(l.pts, lb.at) <= 0.02).sort((a, b) => distTo(a.pts, lb.at) - distTo(b.pts, lb.at))[0];
    if (!own) return { text: lb.text, paired: false, dashed: false, clear: false };
    return { text: lb.text, paired: true, dashed: !!own.dash, clear: spotClear(own.pts, own.heads, lb.band, own.dash) };
  });
}

const spec = (): StudioDiagramV1 => clone(parityDiagramSpecs().find((x) => x.file === "dg_layered_good.json")!.spec as unknown as StudioDiagramV1);

describe("AC-A04: first render passes the dash pattern to spotClear (dg_layered_good)", () => {
  for (const release of [true, false]) {
    it(`@${release ? "rel" : "draft"}: every label is paired with its own connector and leaves no dash fragment under its band`, () => {
      const r = buildDiagramSvg(spec(), { release });
      expect(r.report.geometry ?? []).toEqual([]);
      const rows = ownLinkLabelCheck(r.svg);
      expect(rows.length).toBe(3);
      expect(rows.filter((r) => !r.paired).map((r) => r.text)).toEqual([]);
      expect(rows.filter((r) => r.dashed).length).toBeGreaterThan(0);
      expect(rows.filter((r) => !r.clear).map((r) => r.text)).toEqual([]);
    });
  }
});
