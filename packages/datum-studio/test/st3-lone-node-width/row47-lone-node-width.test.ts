// Swarm 1.3.3 row 47 (ST-3 item 7): a node alone on its tier uses the default node width; it is not stretched to the
// tier cap. Tiers that hold several nodes keep the shared tier width. Families layered and topology, with and without
// an ELK plan; stack keeps its full-width bars. Row 136: a lone node that feeds neighbours beyond its own outline (a
// hub) takes the default width too (row 47 kept it at the shared width; the router now fans its links, see
// row136-lone-hub-routing.test.ts and implementation/136_st3_lone_hub_routing.md).
import { describe, expect, test } from "bun:test";
import { useStudioEnv } from "../ported/_env";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { LATTICE_X, Sheet } from "@/lib/studio/engine/diagram/core";
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build";
import { elkGraphFor, elkLayoutPlan } from "@/lib/studio/engine/diagram/elk/adapter";
import { withElkPlan } from "@/lib/studio/engine/diagram/elk/plan";
import { withDiagramFit } from "@/lib/studio/engine/diagram/fit/state";
import { LONE_NODE_FAMILIES, LONE_NODE_WIDTH_COLS, layoutLayered, tierWidthMm } from "@/lib/studio/engine/diagram/layout-a/layered";

useStudioEnv();

const W = 166;
const DEFAULT_W = LATTICE_X * LONE_NODE_WIDTH_COLS; // the default node width token: 3 lattice columns = 32 mm
const SHARED_1 = LATTICE_X * 10; // what a one-node tier took before row 47 (106.67 mm)
const SHARED_2 = LATTICE_X * 7; // two nodes on a tier at 166 mm (74.67 mm)

type N = { id: string; label: string; shape?: string; class: { tier: number } };
const node = (id: string, label: string, tier: number, shape?: string): N => ({ id, label, class: { tier }, ...(shape ? { shape } : {}) });
const link = (from: string, to: string) => ({ from, to, kind: "data", label: "data" });

const spec = (family: string, nodes: N[], edges: ReturnType<typeof link>[], width = W): StudioDiagramV1 =>
  ({
    $schema: "studio.diagram/v1",
    id: "2.1",
    title: "Simpul sendirian di satu tingkat.",
    classification: "TERBATAS",
    width_mm: width,
    sources: ["uji row 47"],
    family,
    nodes,
    edges,
  }) as unknown as StudioDiagramV1;

/** The smallest spec with one node alone on a tier: `a` alone on tier 0, `b` and `c` on tier 1. */
const smallest = (family: string, shape?: string, label = "Inti") =>
  spec(family, [node("a", label, 0, shape), node("b", "Kiri", 1), node("c", "Kanan", 1)], [link("a", "b"), link("a", "c")]);
/** A chain: every tier holds one node. */
const chain = (family: string) =>
  spec(family, [node("a", "Mulai", 0), node("b", "Sah?", 1, "diamond"), node("c", "Simpan", 2, "hexagon"), node("d", "Selesai", 3)], [link("a", "b"), link("b", "c"), link("c", "d")]);
/** A hub: `a` alone on tier 0 feeds three nodes on tier 1; the outer two lie beyond a default-width `a`. */
const hub = (family: string, width = W) =>
  spec(family, [node("a", "Inti", 0), node("k0", "Kiri", 1), node("k1", "Tengah", 1), node("k2", "Kanan", 1)], [link("a", "k0"), link("a", "k1"), link("a", "k2")], width);

const lay = (s: StudioDiagramV1, fit = false) => {
  const run = () => layoutLayered(s, new Sheet(Number(s.width_mm)));
  return fit ? withDiagramFit({ notes: [] }, run) : run();
};
const snapCentre = (w: number, sheet = W) => Math.round((sheet - w) / 2 / LATTICE_X) * LATTICE_X;
const geometry = (s: StudioDiagramV1): string[] => {
  const r = buildDiagramSvg(s, { release: false } as never) as unknown as { report: { geometry?: Array<{ checkId: string }> } };
  return (r.report.geometry ?? []).map((g) => g.checkId).filter((id) => id.startsWith("GEOM_"));
};

describe("row 47: a node alone on its tier takes the default node width", () => {
  test("the token is the 3-column default, for layered and topology", () => {
    expect(LONE_NODE_WIDTH_COLS).toBe(3);
    expect(DEFAULT_W).toBeCloseTo(32, 6);
    expect([...LONE_NODE_FAMILIES].sort()).toEqual(["layered", "topology"]);
  });

  for (const family of ["layered", "topology"]) {
    for (const fit of [false, true]) {
      test(`${family}${fit ? " (fit)" : ""}: smallest spec: lone node = default width, centred; the two-node tier is unchanged`, () => {
        const r = lay(smallest(family), fit);
        expect(r.nodes.a.w).toBeCloseTo(DEFAULT_W, 6); // was SHARED_1 = 106.67 mm
        expect(r.nodes.a.x).toBeCloseTo(snapCentre(DEFAULT_W), 6); // centred as every tier: snap((W - w) / 2)
        expect(tierWidthMm(2, W, { x: LATTICE_X })).toBeCloseTo(SHARED_2, 6);
        expect(r.nodes.b.w).toBeCloseTo(SHARED_2, 6);
        expect(r.nodes.c.w).toBeCloseTo(SHARED_2, 6);
        expect(r.nodes.b.x).toBeCloseTo(0, 6);
        expect(r.nodes.c.x).toBeCloseTo(SHARED_2 + LATTICE_X, 6);
      });

      test(`${family}${fit ? " (fit)" : ""}: chain: every lone node (box, diamond, hexagon) has the default width on one axis`, () => {
        const r = lay(chain(family), fit);
        for (const id of ["a", "b", "c", "d"]) {
          expect(r.nodes[id].w, id).toBeCloseTo(DEFAULT_W, 6);
          expect(r.nodes[id].x, id).toBeCloseTo(snapCentre(DEFAULT_W), 6);
        }
      });
    }

    test(`${family}: a lone node whose label needs more than the default takes its own text width, not the cap`, () => {
      for (const fit of [false, true]) {
        const r = lay(smallest(family, undefined, "Pusat Kendali Operasi Terpadu"), fit);
        expect(r.nodes.a.w).toBeGreaterThan(DEFAULT_W);
        expect(r.nodes.a.w).toBeLessThan(SHARED_1);
        expect((r.nodes.a.w / LATTICE_X) % 1).toBeCloseTo(0, 6); // on the lattice
      }
    });

    test(`${family}: with an ELK plan the lone node has the default width too (ELK input sizes are unchanged)`, async () => {
      const s = chain(family);
      expect((elkGraphFor(s).graph.children ?? []).map((c) => c.width)).toEqual([SHARED_1, SHARED_1, SHARED_1, SHARED_1]);
      const plan = await elkLayoutPlan(s);
      const r = withElkPlan(plan, () => lay(s));
      for (const id of ["a", "b", "c", "d"]) expect(r.nodes[id].w, id).toBeCloseTo(DEFAULT_W, 6);
      const t = smallest(family);
      const rt = withElkPlan(await elkLayoutPlan(t), () => lay(t));
      expect(rt.nodes.b.w).toBeCloseTo(SHARED_2, 6);
      expect(rt.nodes.c.w).toBeCloseTo(SHARED_2, 6);
    });

    // Row 136: was "a hub keeps the shared width" (SHARED_1); the router fix lets the hub take the default width.
    test(`${family}: a hub takes the default width too (its outer neighbours lie beyond a default-width node)`, () => {
      for (const width of [166, 128]) {
        const r = lay(hub(family, width));
        expect(r.nodes.a.w, String(width)).toBeCloseTo(DEFAULT_W, 6);
      }
    });

    test(`${family}: the figures build without a geometry finding`, () => {
      expect(geometry(smallest(family))).toEqual([]);
      expect(geometry(chain(family))).toEqual([]);
      expect(geometry(hub(family))).toEqual([]);
      const r = buildDiagramSvg(smallest(family), { release: false } as never);
      expect(r.svg).toMatch(/<rect x="64\.0" y="[\d.]+" width="32\.0" height="[\d.]+" data-node="a"/); // centred, default width
      expect(r.svg).toMatch(/<rect x="85\.33" y="[\d.]+" width="74\.67" height="[\d.]+" data-node="c"/); // shared tier width
    });
  }

  test("tierWidthMm: unchanged without a lone node and for every tier of two or more", () => {
    const lat = { x: LATTICE_X };
    expect(tierWidthMm(1, W, lat)).toBeCloseTo(SHARED_1, 6);
    expect(tierWidthMm(1, W, lat, node("a", "Inti", 0) as never)).toBeCloseTo(DEFAULT_W, 6);
    for (const m of [2, 3, 4, 5]) expect(tierWidthMm(m, W, lat, node("a", "Inti", 0) as never)).toBe(tierWidthMm(m, W, lat));
  });

  test("stack keeps its full-width bar for a one-node tier", () => {
    const r = lay(chain("stack"));
    for (const id of ["a", "b", "c", "d"]) expect(r.nodes[id].w, id).toBeCloseTo(SHARED_1, 6);
  });
});
