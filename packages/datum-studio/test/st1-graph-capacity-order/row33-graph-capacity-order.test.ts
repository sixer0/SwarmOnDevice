// Swarm 1.3.3 row 33 (ST-1 item 2, issue B-02): the graph layout runs the capacity path BEFORE plain
// placement when a plain anchor lands exactly on the right edge. Before the fix the plain path put column c at c x 4 lattice columns, so the fourth column
// (col 3) of a 128 mm graph was anchored at 3 x 42.667 = 128.000 mm, exactly on the right edge, with
// width clamped to 0: `DATUM-37-sheet: simpul g3 keluar lebar lembar (128.000..128.000 dari 128.0 mm)`.
// The compacted pitch only ran on the capacity retry of the full build, never on the first placement
// (`placeDiagram`, `estimate`). Synthetic specs (the smallest that shows it) plus one three-tier case
// shaped like the refusal quoted in packet report p1 (core, four distribution nodes, access).
import { describe, expect, it } from "bun:test";
import { useStudioEnv } from "../ported/_env";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { DIAGRAM_LAYOUTS } from "@/lib/studio/contract/dispatch";
import { buildDiagramSvg, placeDiagram } from "@/lib/studio/engine/diagram/build";
import { DiagramDefect, Sheet, estimate } from "@/lib/studio/engine/diagram/core";
import { graphMaxCols } from "@/lib/studio/engine/diagram/layout-c/graphcap";

useStudioEnv();

const INSET = 2;
const LX128 = 128 / 12;

type N = { id: string; label: string; col: number; row: number };

const spec = (width: number, nodes: N[], edges: Array<[string, string]>): StudioDiagramV1 =>
  ({
    $schema: "studio.diagram/v1",
    family: "graph",
    id: "9.1",
    title: "Uji urutan kapasitas.",
    classification: "BIASA",
    width_mm: width,
    apparatus: "page",
    labels_verified: true,
    sources: ["Uji"],
    nodes: nodes.map((n) => ({ id: n.id, label: n.label, class: { col: n.col, row: n.row } })),
    edges: edges.map(([from, to]) => ({ from, to, kind: "data", label: "data" })),
  }) as unknown as StudioDiagramV1;

/** One row, one node per column, chained left to right. */
const chain = (width: number, cols: number[]): StudioDiagramV1 =>
  spec(
    width,
    cols.map((c) => ({ id: `g${c}`, label: `Simpul ${c}`, col: c, row: 0 })),
    cols.slice(1).map((c, i) => [`g${cols[i]}`, `g${c}`] as [string, string]),
  );

const placed = (s: StudioDiagramV1) => [...placeDiagram(s, new Sheet(Number(s.width_mm)), DIAGRAM_LAYOUTS).sheet.nodes.values()];

const rects = (svg: string) =>
  [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+" data-node=/g)].map((m) => ({ x: Number(m[1]), w: Number(m[2]) }));

const caught = (fn: () => unknown): DiagramDefect => {
  try {
    fn();
  } catch (e) {
    return e as DiagramDefect;
  }
  throw new Error("expected a refusal, the figure was placed");
};

describe("row 33 ST-1: a four-column graph passes at 128 mm on the first placement", () => {
  it("the capacity helper says four columns fit at 128 mm (the number the refusal contradicted)", () => {
    expect(graphMaxCols({ x: LX128, W: 128 })).toBe(4);
  });

  it("placeDiagram: no column on the edge; every node keeps the 2 mm inset and a real width", () => {
    const nodes = placed(chain(128, [0, 1, 2, 3]));
    expect(nodes.length).toBe(4);
    for (const n of nodes) {
      expect(n.w).toBeGreaterThan(0);
      expect(n.x).toBeGreaterThanOrEqual(INSET - 1e-6);
      expect(n.x + n.w).toBeLessThanOrEqual(128 - INSET + 1e-6);
    }
    // compacted pitch: node 2 lattice columns (21.333 mm), gap 1 (10.667 mm), block centred on the lattice
    const xs = nodes.map((n) => n.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(5.333, 2);
    expect(xs[3]).toBeCloseTo(101.333, 2);
    expect(xs[3] + nodes[0].w).toBeCloseTo(122.667, 2);
    for (const n of nodes) expect(n.w).toBeCloseTo(2 * LX128, 6);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeCloseTo(3 * LX128, 6);
  });

  it("estimate (no capacity retry behind it) accepts the figure", () => {
    const s = chain(128, [0, 1, 2, 3]);
    const est = estimate(s, DIAGRAM_LAYOUTS[s.family]) as { widthMm: number; nNodes: number };
    expect(est.widthMm).toBe(128);
    expect(est.nNodes).toBe(4);
  });

  it("buildDiagramSvg: rendered, node outlines inside 2..126 mm, and the first render is not a refusal", () => {
    const r = buildDiagramSvg(chain(128, [0, 1, 2, 3]), { release: true });
    const xs = rects(r.svg);
    expect(xs.length).toBe(4);
    for (const { x, w } of xs) {
      expect(w).toBeGreaterThan(0);
      expect(x).toBeGreaterThanOrEqual(INSET - 1e-6);
      expect(x + w).toBeLessThanOrEqual(128 - INSET + 1e-6);
    }
    const geo = (r.report.geometry ?? []) as Array<{ checkId: string; detail: string }>;
    expect(geo.some((i) => /render pertama ditolak/.test(i.detail))).toBe(false);
  });

  it("three tiers at 128 mm (core, four distribution nodes, access) place and render", () => {
    const s = spec(
      128,
      [
        { id: "core", label: "Core", col: 1, row: 0 },
        { id: "d0", label: "Dist A1", col: 0, row: 1 },
        { id: "d1", label: "Dist A2", col: 1, row: 1 },
        { id: "d2", label: "Dist B1", col: 2, row: 1 },
        { id: "d3", label: "Dist B2", col: 3, row: 1 },
        { id: "acc", label: "Akses", col: 2, row: 2 },
      ],
      [
        ["core", "d0"],
        ["core", "d1"],
        ["core", "d2"],
        ["core", "d3"],
        ["d2", "acc"],
      ],
    );
    const nodes = placed(s);
    const d3 = nodes.find((n) => n.id === "d3")!;
    expect(d3.w).toBeGreaterThan(0);
    expect(d3.x + d3.w).toBeLessThanOrEqual(128 - INSET + 1e-6);
    const xs = rects(buildDiagramSvg(s, { release: true }).svg);
    expect(xs.length).toBe(6);
    for (const { x, w } of xs) expect(x + w).toBeLessThanOrEqual(128 - INSET + 1e-6);
  });
});

describe("row 33 ST-1: what the reordering must not change", () => {
  it("graphs whose plain anchors are inside the sheet keep their geometry (3 columns at 128, 4 at 166)", () => {
    const a = placed(chain(128, [0, 1, 2])).map((n) => [Number(n.x.toFixed(3)), Number(n.w.toFixed(3))]);
    expect(a).toEqual([
      [5.333, 32],
      [48, 32],
      [90.667, 32],
    ]);
    const b = placed(chain(166, [0, 1, 2, 3])).map((n) => [Number(n.x.toFixed(3)), Number(n.w.toFixed(3))]);
    expect(b).toEqual([
      [3, 32],
      [45.667, 32],
      [88.333, 32],
      [131, 32],
    ]);
  });

  it("an anchor beyond the sheet (five columns at 166 mm, 170.667 mm) keeps the capacity retry of the build", () => {
    const s = chain(166, [0, 1, 2, 3, 4]);
    const e = caught(() => placed(s));
    expect(e.checkId).toBe("DATUM-37-sheet");
    expect(e.message).toContain("170.667..170.667");
    const r = buildDiagramSvg(s, { release: true });
    const geo = (r.report.geometry ?? []) as Array<{ checkId: string; detail: string }>;
    expect(String(geo.find((i) => i.checkId === "AUTO_FIT")?.detail)).toMatch(/^render pertama ditolak DATUM-37/);
    expect(geo.filter((i) => i.checkId === "CAPACITY_ADAPT").length).toBe(1);
  });

  it("five columns at 128 mm stay refused DATUM-37-sheet (over the four-column capacity)", () => {
    const s = chain(128, [0, 1, 2, 3, 4]);
    expect(caught(() => placed(s)).checkId).toBe("DATUM-37-sheet");
    const e = caught(() => buildDiagramSvg(s, { release: true }));
    expect(e.message).toContain("maks 4 kolom pada 128 mm");
  });

  it("columns with a gap (0, 1, 3) at 128 mm stay refused: the capacity path needs contiguous columns", () => {
    const s = chain(128, [0, 1, 3]);
    expect(caught(() => placed(s)).checkId).toBe("DATUM-37-sheet");
    expect(caught(() => buildDiagramSvg(s, { release: true })).message).toContain("rapatkan class.col");
  });
});
