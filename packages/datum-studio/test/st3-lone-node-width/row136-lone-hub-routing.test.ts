// Swarm 1.3.3 row 136 (ST-3 item 7, follow-up of row 47): a lone HUB node (one node on its tier, linked to nodes that
// lie beyond its own outline) takes the default node width too. Row 47 kept it stretched because the router chose the
// link's sides by the centres: from a 32 mm hub the outer children lie more sideways than down, the link left by the
// hub's side and ran down a sibling's outline (GEOM_EDGE_ALONG). The router now links a narrow lone node by its bottom
// or top, fanned across that side. One case keeps the shared width: a link across a tier gap that holds a zone title.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useStudioEnv } from "../ported/_env";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { LATTICE_X, Sheet } from "@/lib/studio/engine/diagram/core";
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build";
import { LONE_NODE_WIDTH_COLS, layoutLayered } from "@/lib/studio/engine/diagram/layout-a/layered";

useStudioEnv();

const DEFAULT_W = LATTICE_X * LONE_NODE_WIDTH_COLS; // 32 mm
const SHARED_1 = LATTICE_X * 10; // 106.67 mm: the stretched one-node tier
type J = Record<string, any>;
type Pt = [number, number];

const node = (id: string, label: string, tier: number) => ({ id, label, class: { tier } });
const link = (from: string, to: string) => ({ from, to, kind: "data", label: "data" });
const spec = (family: string, width: number, body: J): StudioDiagramV1 =>
  ({ $schema: "studio.diagram/v1", id: "2.1", title: "Simpul pusat sendirian di satu tingkat.", classification: "TERBATAS", width_mm: width, sources: ["uji row 136"], family, ...body }) as unknown as StudioDiagramV1;
/** `a` alone on tier 0 feeds `n` nodes on tier 1. */
const fanOut = (family: string, n: number, width: number) =>
  spec(family, width, { nodes: [node("a", "Inti", 0), ...Array.from({ length: n }, (_, i) => node(`k${i}`, `Anak ${i}`, 1))], edges: Array.from({ length: n }, (_, i) => link("a", `k${i}`)) });
/** `n` nodes on tier 0 feed `a` alone on tier 1. */
const fanIn = (family: string, n: number, width: number) =>
  spec(family, width, { nodes: [...Array.from({ length: n }, (_, i) => node(`k${i}`, `Asal ${i}`, 0)), node("a", "Inti", 1)], edges: Array.from({ length: n }, (_, i) => link(`k${i}`, "a")) });
/** Round 1 `p4/18.3` reduced: a hub over three nodes that each sit in their own zone, so the gap under the hub holds zone titles. */
const titledGap = (width: number) =>
  spec("layered", width, {
    zones: [0, 1, 2].map((i) => ({ id: `r${i}`, label: `ZONE R${i + 1}`, members: [`k${i}`] })),
    nodes: [node("a", "Inti", 0), node("k0", "Anak 0", 1), node("k1", "Anak 1", 1), node("k2", "Anak 2", 1)],
    edges: [link("a", "k0"), link("a", "k1"), link("a", "k2")],
  });

const build = (s: StudioDiagramV1) => buildDiagramSvg(s, { release: false } as never) as unknown as { svg: string; report: { geometry?: Array<{ checkId: string }> } };
const geom = (s: StudioDiagramV1): string[] => (build(s).report.geometry ?? []).map((g) => g.checkId).filter((id) => id.startsWith("GEOM_"));
const box = (svg: string, id: string) => {
  const m = svg.match(new RegExp(`<rect x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)" data-node="${id}"`))!;
  return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
};
const links = (svg: string): Pt[][] =>
  [...svg.matchAll(/<path d="M ([^"]+)"[^>]*data-mark="link"/g)].map((m) => m[1].split(" L ").map((p) => p.trim().split(" ").map(Number) as Pt));
const widthOf = (s: StudioDiagramV1, id: string) => layoutLayered(s, new Sheet(Number(s.width_mm))).nodes[id].w;
const fixture = (rel: string): J => {
  const find = (o: any): J | undefined => {
    if (!o || typeof o !== "object") return undefined;
    if (!Array.isArray(o) && typeof o.family === "string" && Array.isArray(o.nodes)) return o;
    for (const v of Array.isArray(o) ? o : Object.values(o)) {
      const r = find(v);
      if (r) return r;
    }
    return undefined;
  };
  return find(JSON.parse(readFileSync(path.join(import.meta.dir, "..", rel), "utf8")))!;
};

describe("row 136: a lone hub takes the default node width and its links fan from its bottom or top", () => {
  for (const family of ["layered", "topology"]) {
    for (const [n, width] of [[2, 166], [2, 128], [3, 166], [3, 128], [4, 166]] as const) {
      test(`${family}: one node over ${n} at ${width} mm: hub = default width, no geometry finding, links leave by the bottom`, () => {
        const s = fanOut(family, n, width);
        expect(widthOf(s, "a")).toBeCloseTo(DEFAULT_W, 6); // row 47 state: 106.67 mm
        const r = build(s);
        expect((r.report.geometry ?? []).map((g) => g.checkId).filter((id) => id.startsWith("GEOM_"))).toEqual([]); // old router: GEOM_EDGE_ALONG
        const a = box(r.svg, "a");
        const starts = links(r.svg).map((p) => p[0]);
        expect(starts).toHaveLength(n);
        for (const p of starts) {
          expect(p[1]).toBeCloseTo(a.y + a.h, 1); // on the bottom side, not the left or right side
          expect(p[0]).toBeGreaterThan(a.x);
          expect(p[0]).toBeLessThan(a.x + a.w);
        }
        expect(new Set(starts.map((p) => p[0].toFixed(2))).size).toBe(n); // one port each
        expect([...starts.map((p) => p[0])].sort((x, y) => x - y)).toEqual(starts.map((p) => p[0])); // ports in the children's order: no crossing
        // every link enters its child from above (ends on the child's top side)
        links(r.svg).forEach((p, i) => {
          const k = box(r.svg, `k${i}`);
          const end = p[p.length - 1];
          expect(end[0]).toBeGreaterThan(k.x);
          expect(end[0]).toBeLessThan(k.x + k.w);
          expect(p[p.length - 2][0]).toBeCloseTo(end[0], 2); // last step is vertical
        });
      });
    }

    test(`${family}: fan-in: three nodes over one lone node: default width, links end on its top, no geometry finding`, () => {
      for (const width of [166, 128]) {
        const s = fanIn(family, 3, width);
        expect(widthOf(s, "a"), String(width)).toBeCloseTo(DEFAULT_W, 6);
        const r = build(s);
        expect((r.report.geometry ?? []).map((g) => g.checkId).filter((id) => id.startsWith("GEOM_")), String(width)).toEqual([]);
        const a = box(r.svg, "a");
        for (const p of links(r.svg)) {
          const end = p[p.length - 1];
          expect(end[0]).toBeGreaterThan(a.x);
          expect(end[0]).toBeLessThan(a.x + a.w);
          expect(end[1]).toBeLessThanOrEqual(a.y + 0.01); // from above (the head trim ends just short of the outline)
        }
      }
    });
  }

  test("fixtures that gained GEOM_EDGE_ALONG under the bare rule are clean with the hub at the default width", () => {
    for (const [rel, hub] of [
      ["engine-rev-a/svg/fixtures/case04.studio.json", "srv"],
      ["engine-rev-a/svg/fixtures/case04_v2.studio.json", "srv"],
    ] as const) {
      for (const width of [166, 128]) {
        const s = spec("layered", width, { ...fixture(rel), id: "2.1", width_mm: width });
        expect(widthOf(s, hub), `${rel}@${width}`).toBeCloseTo(DEFAULT_W, 6);
        expect(geom(s), `${rel}@${width}`).toEqual([]);
      }
    }
  });

  test("a tier gap that holds a zone title: the hub keeps the shared width (no link through the title)", () => {
    for (const width of [166, 128]) {
      const s = titledGap(width);
      expect(widthOf(s, "a"), String(width)).toBeCloseTo(SHARED_1, 6);
      // the stretched figure is the row 47 render, byte for byte; the two findings the narrow hub would add stay away
      expect(geom(s), String(width)).not.toContain("GEOM_EDGE_HEADER");
      expect(geom(s), String(width)).not.toContain("GEOM_EDGE_ALONG");
    }
    // the same figure without zones: the hub narrows
    const plain = spec("layered", 128, { ...titledGap(128), zones: undefined });
    expect(widthOf(plain, "a")).toBeCloseTo(DEFAULT_W, 6);
    expect(geom(plain)).toEqual([]);
  });

  test("a zone that starts on the hub's own tier or below the linked tier does not hold the hub back", () => {
    // zone title in the gap ABOVE the hub (the hub is the zone's top member); its links go down, through an untitled gap
    const s = spec("layered", 166, {
      zones: [{ id: "z", label: "ZONA INTI", members: ["a", "k0", "k1", "k2"] }],
      nodes: [node("a", "Inti", 0), node("k0", "Anak 0", 1), node("k1", "Anak 1", 1), node("k2", "Anak 2", 1)],
      edges: [link("a", "k0"), link("a", "k1"), link("a", "k2")],
    });
    expect(widthOf(s, "a")).toBeCloseTo(DEFAULT_W, 6);
    expect(geom(s)).toEqual([]);
  });
});
