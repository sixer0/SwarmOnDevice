// Swarm 1.2.6 row 63 (T-07, register N-017 DIAMOND_HEIGHT_FACTOR = 1.25): a diamond node took the plain
// `nodeSize` height (3 baseline units = 9.5 mm) in every family except the flow `per_row` branch, so a
// diamond whose label wraps to two lines was drawn flattened (handoff: 32 x 9.5 mm) and the text ran over
// its points. Fix: `nodeSize` applies DIAMOND_HEIGHT_FACTOR to every diamond (and never returns less than
// the height two label lines need inside the diamond), for every family. Synthetic fixtures.
// Check: parse the diamond `<polygon points>`, take each label `<tspan>` line box (engine font metrics:
// ascent 1.025 em, descent 0.275 em, width by the engine's own glyph table) and require all four corners of
// every line box inside the polygon; the polygon is at least two line heights tall; zero GEOM_TEXT_NODE.
import { describe, expect, it } from "bun:test";
import { useStudioEnv } from "../ported/_env";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { buildDiagramSvg, buildDiagramSvgRaw } from "@/lib/studio/engine/diagram/build";
import { withDiagramFit } from "@/lib/studio/engine/diagram/fit/state";
import { lintDiagramGeometry } from "@/lib/studio/engine/diagram/fit/lint";
import * as geometry from "@/lib/studio/engine/diagram/core/geometry";
import { LATTICE_X, LATTICE_Y } from "@/lib/studio/engine/diagram/core/tokens";
import { FONT_ASCENT_EM, FONT_DESCENT_EM, measure } from "@/lib/studio/engine/chart/core/textfit";

useStudioEnv();

const LABEL = "Data lengkap dan valid?";

const base = (family: string) => ({
  $schema: "studio.diagram/v1",
  family,
  id: "9.1",
  title: "Uji tinggi belah ketupat.",
  classification: "BIASA",
  width_mm: 128,
  apparatus: "page",
  labels_verified: true,
  sources: ["Uji"],
});

const graphSpec = (label: string, sub?: string): StudioDiagramV1 =>
  ({
    ...base("graph"),
    nodes: [
      { id: "a", label: "Masuk", class: { col: 0, row: 0 } },
      { id: "d", label, ...(sub ? { sub } : {}), shape: "diamond", class: { col: 1, row: 0 } },
      { id: "c", label: "Keluar", class: { col: 2, row: 0 } },
    ],
    edges: [
      { from: "a", to: "d", kind: "data", label: "isi" },
      { from: "d", to: "c", kind: "data", label: "ya" },
    ],
  }) as unknown as StudioDiagramV1;

const layeredSpec = (label: string, sub?: string): StudioDiagramV1 =>
  ({
    ...base("layered"),
    nodes: [
      { id: "a", label: "Masuk", class: { tier: 0 } },
      { id: "p", label: "Proses kiri", class: { tier: 1 } },
      { id: "d", label, ...(sub ? { sub } : {}), shape: "diamond", class: { tier: 1 } },
      { id: "q", label: "Proses kanan", class: { tier: 1 } },
      { id: "c", label: "Keluar", class: { tier: 2 } },
    ],
    edges: [
      { from: "a", to: "d", kind: "data", label: "isi" },
      { from: "d", to: "c", kind: "data", label: "ya" },
    ],
  }) as unknown as StudioDiagramV1;

type Pt = [number, number];
const diamondOf = (svg: string, id: string): Pt[] => {
  const m = new RegExp(`<polygon points="([^"]+)"[^>]*data-node="${id}"`).exec(svg);
  if (!m) throw new Error(`no diamond polygon for ${id}`);
  return m[1].split(" ").map((p) => p.split(",").map(Number) as Pt);
};

/** Text lines of the `texts` text elements that follow node `id` (label, then sub; `<tspan>` per line). */
const linesOf = (svg: string, id: string, texts: number): { x: number; y: number; size: number; text: string }[] => {
  const rest = svg.slice(svg.indexOf(`data-node="${id}"`));
  const els = [...rest.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*font-size="([\d.]+)"[^>]*>(.*?)<\/text>/g)].slice(0, texts);
  if (els.length < texts) throw new Error(`no label for ${id}`);
  return els.flatMap((m) => {
    const [x0, y0, size] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const spans = [...m[4].matchAll(/<tspan x="([\d.]+)" dy="([\d.]+)">([^<]*)<\/tspan>/g)];
    if (spans.length === 0) return [{ x: x0, y: y0, size, text: m[4] }];
    let y = y0;
    return spans.map((sp) => {
      y += Number(sp[2]);
      return { x: Number(sp[1]), y, size, text: sp[3] };
    });
  });
};

/** Point inside the diamond |dx|/a + |dy|/b <= 1 (small tolerance for the 2-decimal SVG numbers). */
const inside = (poly: Pt[], [px, py]: Pt): boolean => {
  const cx = poly[0][0];
  const cy = poly[1][1];
  const a = poly[1][0] - cx;
  const b = poly[2][1] - cy;
  return Math.abs(px - cx) / a + Math.abs(py - cy) / b <= 1 + 0.01;
};

const MM_PER_PT = 25.4 / 72;

function check(svg: string, wantLines: number, texts = 1) {
  const poly = diamondOf(svg, "d");
  const h = poly[2][1] - poly[0][1];
  const lines = linesOf(svg, "d", texts);
  expect(lines.length).toBe(wantLines + texts - 1);
  const size = lines[0].size;
  const lineH = size * 1.2;
  if (wantLines >= 2) expect(h).toBeGreaterThanOrEqual(2 * lineH);
  const outside: string[] = [];
  for (const l of lines) {
    const tw = measure(l.text, size / MM_PER_PT, "struct");
    const top = l.y - FONT_ASCENT_EM * size;
    const bot = l.y + FONT_DESCENT_EM * size;
    for (const p of [[l.x - tw / 2, top], [l.x + tw / 2, top], [l.x - tw / 2, bot], [l.x + tw / 2, bot]] as Pt[]) {
      if (!inside(poly, p)) outside.push(`${l.text} @ ${p.map((v) => v.toFixed(2)).join(",")} (diamond h ${h.toFixed(2)})`);
    }
  }
  expect(outside).toEqual([]);
  const lint = lintDiagramGeometry(svg);
  expect(lint.counts.textOverNode).toBe(0);
  expect(lint.counts.textExceedsNode).toBe(0);
}

describe("row 63 T-07: a two-line diamond label lies inside the diamond", () => {
  it("register N-017: DIAMOND_HEIGHT_FACTOR = 1.25", () => {
    expect((geometry as Record<string, unknown>).DIAMOND_HEIGHT_FACTOR).toBe(1.25);
  });

  it("graph (default build, auto-fit): diamond with a two-line label", () => {
    check(buildDiagramSvg(graphSpec(LABEL), { release: false }).svg, 2);
  });

  // A label is wrapped only while the fit pass runs (autofit candidates: with and without node growth).
  // Candidate 2/3 (grow false) keeps the nodeSize height, which is where the flattened diamond came from.
  for (const grow of [true, false]) {
    const fit = (s: StudioDiagramV1) =>
      withDiagramFit({ notes: [], grow, numbered: true, defects: {}, noRoute: true }, () => buildDiagramSvgRaw(s, { release: false }).svg);
    it(`graph (fit, grow ${grow}): diamond with a two-line label`, () => {
      check(fit(graphSpec(LABEL)), 2);
    });
    it(`layered (fit, grow ${grow}): diamond with a two-line label`, () => {
      check(fit(layeredSpec(LABEL)), 2);
    });
    it(`graph (fit, grow ${grow}): diamond with a two-line label and a sub line`, () => {
      check(fit(graphSpec(LABEL, "skema v2")), 2, 2);
    });
    it(`layered (fit, grow ${grow}): diamond with a two-line label and a sub line`, () => {
      check(fit(layeredSpec(LABEL, "skema v2")), 2, 2);
    });
  }

  it("graph: a short one-line diamond label stays one line inside the diamond", () => {
    check(buildDiagramSvg(graphSpec("Ya"), { release: false }).svg, 1);
  });

  it("nodeSize (shared by every family) gives a diamond at least 1.25 x the box height", () => {
    const L = { x: LATTICE_X, y: LATTICE_Y };
    for (const extra of [{}, { sub: "RS-485" }, { tag: "T1" }, { padUnits: 1 }]) {
      const { padUnits, ...fields } = extra as { padUnits?: number };
      const [, hb] = geometry.nodeSize({ id: "b", label: LABEL, ...fields } as never, L, undefined, padUnits);
      const [, hd] = geometry.nodeSize({ id: "d", label: LABEL, shape: "diamond", ...fields } as never, L, undefined, padUnits);
      expect(hd).toBeGreaterThanOrEqual(hb * 1.25 - 1e-9);
      expect(Math.abs(hd / L.y - Math.round(hd / L.y))).toBeLessThan(1e-6);
      // Flow per_row and ranked flow applied snap(h x 1.25) inline before row 63: with the default pad the
      // nodeSize diamond equals that value, so those layouts stay byte-identical.
      if (padUnits === undefined) expect(hd).toBeCloseTo(Math.round((hb * 1.25) / L.y) * L.y, 9);
    }
    for (const fields of [{ sub: "RS-485", tag: "T1" }]) {
      const [, hb] = geometry.nodeSize({ id: "b", label: LABEL, ...fields } as never, L);
      const [, hd] = geometry.nodeSize({ id: "d", label: LABEL, shape: "diamond", ...fields } as never, L);
      expect(hd).toBeCloseTo(geometry.snap(hb * 1.25, L.y), 9);
    }
  });
});
