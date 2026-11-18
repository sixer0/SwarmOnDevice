// Swarm 1.3.3 row 56 (ST-5: an accepted field is printed or refused). `tiers[] {tier, label}` (contract row 26) is
// printed for the layered and topology families: one label per labelled tier, at the left edge of the sheet in a band
// the layout reserves (nodes start right of it), role `table_header` with the author's letter case, vertically centred
// on the tier's node row. Every other family refuses the field by name; an entry whose tier has no node is refused with
// its index; a figure without `tiers[]` (or with an empty array) is byte-identical (the clean-svg manifest test pins it).
import { describe, expect, test } from "bun:test";
import { useStudioEnv } from "../ported/_env";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build";
import { measure } from "@/lib/studio/engine/chart/core/textfit";
import { pt2mm, role } from "@/lib/studio/engine/diagram/core/tokens";
import {
  TIER_LABEL_CHECK,
  TIER_LABEL_FAMILIES,
  TIER_LABEL_ROLE,
  assertTierLabels,
} from "@/lib/studio/engine/diagram/layout-a/layered";

useStudioEnv();

type J = Record<string, any>;
const node = (id: string, label: string, tier: number) => ({ id, label, class: { tier } });
const link = (from: string, to: string, label = "data") => ({ from, to, kind: "data", label });

const spec = (family: string, width: number, nodes: J[], edges: J[], extra: J = {}): StudioDiagramV1 =>
  ({
    $schema: "studio.diagram/v1",
    id: "2.1",
    title: "Tingkat berlabel.",
    classification: "TERBATAS",
    width_mm: width,
    sources: ["uji row 56"],
    family,
    nodes,
    edges,
    ...extra,
  }) as unknown as StudioDiagramV1;

/** Layered at 166 mm: 1, 2 and 3 nodes per tier, labelled connectors, a container around the third tier. */
const LAYERED_TIERS = [
  { tier: 0, label: "Tier 1 · Mabes" },
  { tier: 1, label: "Tier 2 · Polda" },
  { tier: 2, label: "lapisan Polres" }, // lower case first letter: printed as written
];
const layered = (tiers: J[] | undefined = LAYERED_TIERS) =>
  spec(
    "layered",
    166,
    [node("m", "Mabes Polri", 0), node("p1", "Polda Metro", 1), node("p2", "Polda Jabar", 1), node("r1", "Polres A", 2), node("r2", "Polres B", 2), node("r3", "Polres C", 2)],
    [link("m", "p1", "arahan"), link("m", "p2", "arahan"), link("p1", "r1"), link("p2", "r2"), link("p2", "r3")],
    { zones: [{ id: "z", label: "Wilayah", members: ["r1", "r2", "r3"] }], ...(tiers ? { tiers } : {}) },
  );

/** Topology at 128 mm (text column): a core, two access nodes in a container. */
const TOPO_TIERS = [
  { tier: 0, label: "Inti" },
  { tier: 1, label: "Akses Lapangan" },
];
const topology = (tiers: J[] | undefined = TOPO_TIERS) =>
  spec(
    "topology",
    128,
    [node("c", "Router inti", 0), node("a1", "Sakelar A", 1), node("a2", "Sakelar B", 1)],
    [link("c", "a1", "10 Gb/s"), link("c", "a2", "10 Gb/s")],
    { zones: [{ id: "z", label: "Lokasi", members: ["a1", "a2"] }], ...(tiers ? { tiers } : {}) },
  );

const svgOf = (s: StudioDiagramV1): string => (buildDiagramSvg(s, { release: false } as never) as unknown as { svg: string }).svg;
const refusal = (s: StudioDiagramV1): J => {
  try {
    buildDiagramSvg(s, { release: false } as never);
  } catch (e) {
    return e as J;
  }
  throw new Error("expected a refusal");
};

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  what: string;
}
const attr = (el: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(el)?.[1];
const numAttr = (el: string, name: string): number => Number(attr(el, name));
const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.y0 < b.y1 - 1e-6 && b.y0 < a.y1 - 1e-6;

/** The tier label `<text>` elements: anchor start, role size of `table_header`, x 0. */
function tierLabelBoxes(svg: string): Array<Box & { text: string; lines: string[] }> {
  const r = role(TIER_LABEL_ROLE);
  const size = pt2mm(r.size);
  const font = { bold: true, trackMm: size * (r.track_em ?? 0) };
  const out: Array<Box & { text: string; lines: string[] }> = [];
  for (const m of svg.matchAll(/<text\b[^>]*>(?:(?!<\/text>).)*<\/text>/gs)) {
    const el = m[0];
    if (attr(el, "text-anchor") !== "start" || attr(el, "x") !== "0.0" || Math.abs(numAttr(el, "font-size") - size) > 1e-3) continue;
    const spans = [...el.matchAll(/<tspan\b[^>]*>([^<]*)<\/tspan>/g)].map((s) => s[1]);
    const lines = spans.length ? spans : [/>([^<]*)<\/text>/.exec(el)![1]];
    const dy = spans.length > 1 ? Number(attr([...el.matchAll(/<tspan\b[^>]*>/g)][1][0], "dy")) : 0;
    const y = numAttr(el, "y");
    const w = Math.max(...lines.map((l) => measure(l, r.size, "struct", font)));
    out.push({ x0: 0, x1: w, y0: y - size * 0.72, y1: y + (lines.length - 1) * dy + size * 0.25, what: "tier label", text: lines.join(" "), lines });
  }
  return out;
}

/** Everything else a tier label must not touch: nodes, container frames, edge label grounds and texts. */
function otherBoxes(svg: string): Box[] {
  const out: Box[] = [];
  for (const m of svg.matchAll(/<rect\b[^>]*\/>/g)) {
    const el = m[0];
    const x = numAttr(el, "x");
    const y = numAttr(el, "y");
    const w = numAttr(el, "width");
    const h = numAttr(el, "height");
    if (x === 0 && y === 0) continue; // paper
    const what = attr(el, "data-node") ? `node ${attr(el, "data-node")}` : attr(el, "stroke-dasharray") ? "container" : "edge label ground";
    out.push({ x0: x, y0: y, x1: x + w, y1: y + h, what });
  }
  for (const m of svg.matchAll(/<text\b[^>]*font-family="IBM Plex Mono"[^>]*>([^<]*)<\/text>/g)) {
    const el = m[0];
    const size = numAttr(el, "font-size");
    const w = m[1].length * size * 0.62;
    const x = numAttr(el, "x");
    const y = numAttr(el, "y");
    out.push({ x0: x - w / 2, x1: x + w / 2, y0: y - size * 0.75, y1: y + size * 0.25, what: `edge label ${m[1]}` });
  }
  return out;
}

/** Smallest x of any connector vertex (`<path data-mark="link" d="M x y L ...">`; arrow heads in `<defs>` excluded). */
function minPathX(svg: string): number {
  const xs: number[] = [];
  for (const m of svg.replace(/<defs>[\s\S]*?<\/defs>/g, "").matchAll(/<path\b(?=[^>]*data-mark="link")[^>]*\sd="([^"]*)"/g)) {
    const nums = m[1].match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    for (let i = 0; i < nums.length; i += 2) xs.push(nums[i]);
  }
  return Math.min(...xs);
}

describe("row 56: labelled tiers print for layered and topology", () => {
  test("the families and the role are the stated ones", () => {
    expect([...TIER_LABEL_FAMILIES].sort()).toEqual(["layered", "topology"]);
    expect(TIER_LABEL_ROLE).toBe("table_header");
    expect(TIER_LABEL_CHECK).toBe("P1-tiers");
  });

  for (const [name, make, tiers] of [
    ["layered (166 mm)", layered, LAYERED_TIERS],
    ["topology (128 mm)", topology, TOPO_TIERS],
  ] as const) {
    test(`${name}: each label printed once, letter case as written, in the left band`, () => {
      const svg = svgOf(make());
      const labels = tierLabelBoxes(svg);
      expect(labels.map((l) => l.text).sort()).toEqual(tiers.map((t) => t.label).sort());
      expect(labels.length).toBe(tiers.length);
      // no upper-casing of the author's text
      for (const t of tiers) if (t.label !== t.label.toUpperCase()) expect(svg.includes(t.label.toUpperCase())).toBe(false);
    });

    test(`${name}: no tier label overlaps a node, a container, an edge label or a connector (structural)`, () => {
      const svg = svgOf(make());
      const labels = tierLabelBoxes(svg);
      const others = otherBoxes(svg);
      expect(others.some((o) => o.what.startsWith("node"))).toBe(true);
      expect(others.some((o) => o.what === "container")).toBe(true);
      expect(others.some((o) => o.what.startsWith("edge label"))).toBe(true);
      for (const l of labels) {
        for (const o of others) expect({ label: l.text, other: o.what, overlaps: overlaps(l, o) }).toEqual({ label: l.text, other: o.what, overlaps: false });
        expect(Number.isFinite(minPathX(svg))).toBe(true); // connectors were found
        expect(minPathX(svg)).toBeGreaterThan(l.x1);
      }
      const minNodeX = Math.min(...others.filter((o) => o.what.startsWith("node")).map((o) => o.x0));
      for (const l of labels) expect(l.x1).toBeLessThan(minNodeX);
    });

    test(`${name}: each label sits on its tier's node row`, () => {
      const svg = svgOf(make());
      const s = make() as unknown as J;
      const rowOf = new Map<number, { y0: number; y1: number }>();
      for (const m of svg.matchAll(/<rect\b[^>]*data-node="([^"]+)"[^>]*\/>/g)) {
        const n = (s.nodes as J[]).find((x) => x.id === m[1])!;
        const y = numAttr(m[0], "y");
        const h = numAttr(m[0], "height");
        const r = rowOf.get(n.class.tier);
        rowOf.set(n.class.tier, r ? { y0: Math.min(r.y0, y), y1: Math.max(r.y1, y + h) } : { y0: y, y1: y + h });
      }
      const labels = tierLabelBoxes(svg);
      for (const t of tiers) {
        const l = labels.find((x) => x.text === t.label)!;
        const r = rowOf.get(t.tier)!;
        expect(l.y0).toBeGreaterThanOrEqual(r.y0 - 1e-6);
        expect(l.y1).toBeLessThanOrEqual(r.y1 + 1e-6);
      }
    });

    test(`${name}: without tiers, or with an empty array, the SVG is byte-identical; with tiers the sheet keeps its width`, () => {
      const none = svgOf(make(null as never));
      expect(svgOf(make([] as never))).toBe(none);
      expect(tierLabelBoxes(none)).toEqual([]);
      const head = (svg: string) => /<svg\b[^>]*>/.exec(svg)![0].match(/width="[^"]*"/)![0];
      expect(head(svgOf(make()))).toBe(head(none));
    });
  }

  test("a tier without a label gets none; only the labelled tiers print", () => {
    const svg = svgOf(layered([{ tier: 1, label: "Tier 2 · Polda" }]));
    expect(tierLabelBoxes(svg).map((l) => l.text)).toEqual(["Tier 2 · Polda"]);
  });

  test("a long label wraps inside the band (at most 3 lines) and still clears the nodes", () => {
    const svg = svgOf(layered([{ tier: 2, label: "Kepolisian Resor wilayah hukum" }]));
    const [l] = tierLabelBoxes(svg);
    expect(l.lines.length).toBeGreaterThan(1);
    expect(l.lines.length).toBeLessThanOrEqual(3);
    expect(l.text).toBe("Kepolisian Resor wilayah hukum");
    const minNodeX = Math.min(...otherBoxes(svg).filter((o) => o.what.startsWith("node")).map((o) => o.x0));
    expect(l.x1).toBeLessThan(minNodeX);
  });
});

describe("row 56: refusals (an accepted field is printed or refused)", () => {
  for (const family of ["flow", "stack", "graph", "swimlane"]) {
    test(`${family} refuses tiers by name`, () => {
      const s = spec(family, 128, [node("a", "Satu", 0), node("b", "Dua", 1)], [link("a", "b")], { tiers: [{ tier: 0, label: "Tingkat" }] });
      expect(() => assertTierLabels(s)).toThrow(/tiers/);
      const e = refusal(s);
      expect(e.checkId).toBe(TIER_LABEL_CHECK);
      expect(String(e.message)).toContain("tiers");
      expect(String(e.message)).toContain(`'${family}'`);
    });
  }

  test("an empty tiers array is accepted by every family (nothing to print)", () => {
    for (const family of ["flow", "stack", "layered", "topology"]) {
      expect(() => assertTierLabels(spec(family, 128, [node("a", "Satu", 0)], [], { tiers: [] }))).not.toThrow();
    }
  });

  for (const [name, make] of [
    ["layered", layered],
    ["topology", topology],
  ] as const) {
    test(`${name}: an entry naming a tier with no node is refused with its index and tier`, () => {
      const e = refusal(make([{ tier: 0, label: "Ada" }, { tier: 7, label: "Kosong" }]));
      expect(e.checkId).toBe(TIER_LABEL_CHECK);
      expect(String(e.message)).toContain("tiers[1]");
      expect(String(e.message)).toContain("tingkat 7");
      expect(e.pointer ?? e.details?.pointer).toBe("/tiers/1/tier");
    });

    test(`${name}: a tier named twice is refused`, () => {
      const e = refusal(make([{ tier: 0, label: "Satu" }, { tier: 0, label: "Dua" }]));
      expect(e.checkId).toBe(TIER_LABEL_CHECK);
      expect(String(e.message)).toContain("tiers[1]");
    });
  }

  test("a label that does not fit 3 lines of the band is refused", () => {
    const e = refusal(layered([{ tier: 0, label: "Satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua belas tiga belas empat belas" }]));
    expect(e.checkId).toBe(TIER_LABEL_CHECK);
    expect(String(e.message)).toContain("tiers[0]");
  });
});

describe("row 56: the band counts toward the figure width (capacity)", () => {
  const row = (family: string, width: number, per: number, label?: string) => {
    const nodes = [node("r", "Simpul 0", 0), ...Array.from({ length: per }, (_, i) => node(`n${i}`, `Simpul ${i + 1}`, 1))];
    const edges = Array.from({ length: per }, (_, i) => link("r", `n${i}`));
    return spec(family, width, nodes, edges, label ? { tiers: [{ tier: 0, label }, { tier: 1, label }] } : {});
  };
  const passes = (s: StudioDiagramV1) => {
    try {
      buildDiagramSvg(s, { release: false } as never);
      return true;
    } catch {
      return false;
    }
  };
  for (const family of ["layered", "topology"]) {
    test(`${family}: nodes per tier with a band of 2 or 3 columns: 128 mm 3 -> 2, 166 mm 4 -> 3; a 1-column band keeps 3 at 128 mm`, () => {
      expect(passes(row(family, 128, 3))).toBe(true);
      expect(passes(row(family, 128, 3, "A"))).toBe(true); // 1-column band (label <= ~5 mm)
      expect(passes(row(family, 128, 3, "Tier 2"))).toBe(false);
      expect(passes(row(family, 128, 2, "Tier 2 · Polda"))).toBe(true);
      expect(passes(row(family, 166, 4))).toBe(true);
      expect(passes(row(family, 166, 4, "A"))).toBe(false);
      expect(passes(row(family, 166, 3, "Tier 2 · Polda"))).toBe(true);
      const e = refusal(row(family, 128, 3, "Tier 2 · Polda"));
      expect(e.checkId ?? e.details?.checkId).toBe("DATUM-37-sheet");
    });
  }
});
