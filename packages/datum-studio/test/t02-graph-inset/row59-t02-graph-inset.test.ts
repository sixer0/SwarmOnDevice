// Swarm 1.2.6 row 59 (T-02, register N-016 GRAPH_EDGE_INSET_MM, resolution 01_specs 4.R1): every node
// outline of a `graph` (any `col`, 0 included) and of a ranked `flow` lies at least 2 mm inside both
// canvas sides. The inset is ONE translate of the whole placed content after `snapToLattice` (lattice
// spacing unchanged); content wider than W - 2 x inset is refused `DATUM-37-lebar` naming the column
// (graph) or rank (flow) index with a numeric measured value and limit. Synthetic fixtures: the
// rev-145 specs of the handoff are not in the repo (research/01a_explore_t_family.md).
import { describe, expect, it } from "bun:test";
import { useStudioEnv } from "../ported/_env";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { DIAGRAM_LAYOUTS } from "@/lib/studio/contract/dispatch";
import { buildDiagramSvg, placeDiagram } from "@/lib/studio/engine/diagram/build";
import { overCapacityOf } from "@/lib/studio/engine/diagram/build/capacity";
import { DiagramDefect, Sheet, estimate } from "@/lib/studio/engine/diagram/core";
import { FIGURE_OVER_CAPACITY } from "@/lib/studio/engine/figure-capacity";

useStudioEnv();

const INSET = 2;
const LX = 128 / 12;

const graph = (width: number, cols: number[], label = (c: number) => `Simpul ${c}`): StudioDiagramV1 =>
  ({
    $schema: "studio.diagram/v1",
    family: "graph",
    id: "9.1",
    title: "Uji inset.",
    classification: "BIASA",
    width_mm: width,
    apparatus: "page",
    labels_verified: true,
    sources: ["Uji"],
    nodes: cols.map((c) => ({ id: `g${c}`, label: label(c), class: { col: c, row: 0 } })),
    edges: cols.slice(1).map((c, i) => ({ from: `g${cols[i]}`, to: `g${c}`, kind: "data", label: "data" })),
  }) as unknown as StudioDiagramV1;

const placed = (s: StudioDiagramV1) => [...placeDiagram(s, new Sheet(Number(s.width_mm)), DIAGRAM_LAYOUTS).sheet.nodes.values()];

const caught = (fn: () => unknown): DiagramDefect => {
  try {
    fn();
  } catch (e) {
    return e as DiagramDefect;
  }
  throw new Error("expected a refusal, the figure was placed");
};

describe("row 59 T-02: graph nodes keep a 2 mm inset on both canvas sides", () => {
  it("three columns spanning 11 of 12 lattice columns at 128 mm: col 0 is at least 2 mm inside", () => {
    const nodes = placed(graph(128, [0, 1, 2]));
    const minX = Math.min(...nodes.map((n) => n.x));
    const maxR = Math.max(...nodes.map((n) => n.x + n.w));
    expect(minX).toBeGreaterThanOrEqual(INSET - 1e-6);
    expect(maxR).toBeLessThanOrEqual(128 - INSET + 1e-6);
    // lattice spacing unchanged: the translate is uniform (column pitch stays a lattice multiple)
    const xs = nodes.map((n) => n.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(Math.abs(((xs[i] - xs[i - 1]) / LX) % 1) < 1e-6 || Math.abs((((xs[i] - xs[i - 1]) / LX) % 1) - 1) < 1e-6).toBe(true);
  });

  it("a single column at col 0 does not hug the left edge", () => {
    const nodes = placed(graph(166, [0]));
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(INSET - 1e-6);
      expect(n.x + n.w).toBeLessThanOrEqual(166 - INSET + 1e-6);
    }
  });

  it("the rendered SVG keeps the inset (node rect outlines inside 2..W-2)", () => {
    const svg = buildDiagramSvg(graph(128, [0, 1, 2]), { release: true }).svg;
    const xs = [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+" data-node=/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(xs.length).toBeGreaterThan(0);
    for (const [x, w] of xs) {
      expect(x).toBeGreaterThanOrEqual(INSET - 1e-6);
      expect(x + w).toBeLessThanOrEqual(128 - INSET + 1e-6);
    }
  });
});

describe("row 59 T-02: content wider than W - 4 mm is refused DATUM-37-lebar naming the index and the limit", () => {
  it("graph columns filling all 12 lattice columns at 128 mm (estimate, no capacity retry)", () => {
    // three 4-lattice columns with long labels: 0..128 mm on the lattice, 128 > 124 = 128 - 2 x 2
    const s = graph(128, [0, 1, 2], (c) => `Simpul dengan label panjang ${c}`);
    const e = caught(() => estimate(s, DIAGRAM_LAYOUTS[s.family]));
    expect(e).toBeInstanceOf(DiagramDefect);
    expect(e.checkId).toBe("DATUM-37-lebar");
    expect(e.message).toMatch(/kolom graph 2\b/);
    expect(e.message).toContain("124.000 mm");
    const over = overCapacityOf(e, s);
    expect(over?.code).toBe(FIGURE_OVER_CAPACITY);
    const d = over?.details as { checkId: string; limit: number | null; measured: number | null; unit: string };
    expect(d.checkId).toBe("DATUM-37-lebar");
    expect(d.unit).toBe("mm");
    expect(d.limit).toBe(124);
    expect(d.measured).toBeGreaterThan(124);
  });

  it("a ranked layout (rank groups on the sheet) is translated, and refused naming the rank", () => {
    const mk = (n: number, w: number) => {
      const sh = new Sheet(128);
      for (let i = 0; i < n; i++) {
        const id = `r${i}`;
        sh.placeNode({ id, spec: { id, label: id } as never, x: i * (w + LX), y: 20, w, h: 10 });
      }
      sh.edgeInset = { unit: "rank", groupOf: new Map([...sh.nodes.keys()].map((id) => [id, 1])) };
      return sh;
    };
    // 4 nodes of 2 lx + 1 lx gaps = 11 lx: centred with (128 - 117.33) / 2 = 5.33 mm per side
    const ok = mk(4, 2 * LX);
    ok.snapToLattice();
    const nodes = [...ok.nodes.values()];
    expect(Math.min(...nodes.map((n) => n.x))).toBeCloseTo(5.333, 2);
    expect(128 - Math.max(...nodes.map((n) => n.x + n.w))).toBeCloseTo(5.333, 2);
    // 4 nodes of 2 lx + 1 lx + one more lattice = 12 lx: refused naming rank 1 and limit 124
    const wide = new Sheet(128);
    for (let i = 0; i < 4; i++) wide.placeNode({ id: `r${i}`, spec: { id: `r${i}`, label: "x" } as never, x: i * 3 * LX, y: 20, w: 3 * LX, h: 10 });
    wide.edgeInset = { unit: "rank", groupOf: new Map([...wide.nodes.keys()].map((id) => [id, 1])) };
    const e = caught(() => wide.snapToLattice());
    expect(e.checkId).toBe("DATUM-37-lebar");
    expect(e.message).toMatch(/rank 1\b/);
    expect(e.message).toContain("124.000 mm");
  });

  it("a sheet without edgeInset (other families, legacy flow) is not translated", () => {
    const sh = new Sheet(128);
    sh.placeNode({ id: "a", spec: { id: "a", label: "a" } as never, x: 0, y: 20, w: 3 * LX, h: 10 });
    sh.snapToLattice();
    expect(sh.nodes.get("a")?.x).toBe(0);
  });
});
