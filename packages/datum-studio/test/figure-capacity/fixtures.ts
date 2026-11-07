// Row 158 (U24 B) fixtures: over-capacity figures that must be refused FIGURE_OVER_CAPACITY, and
// at-capacity figures whose SVG must stay byte-identical to the pre-row-158 engine (sha recorded
// before the patch, implementation/112_row158_capacity_refusal.md).
const diagram = (family: string, extra: Record<string, unknown>): Record<string, unknown> => ({
  $schema: "studio.diagram/v1",
  family,
  id: "9.1",
  title: "Uji.",
  classification: "BIASA",
  width_mm: 166,
  apparatus: "page",
  labels_verified: true,
  sources: ["Uji"],
  ...extra,
});
const chart = (kind: string, n: number, label: (i: number) => string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  $schema: "studio.chart/v1",
  kind,
  title: "Uji kapasitas.",
  source: "Uji.",
  widthMm: 128,
  data: { shape: "categorical", points: Array.from({ length: n }, (_, i) => ({ label: label(i), value: 10 + i })) },
  unit: "jam",
  dec: 0,
  ...extra,
});

const chain = (n: number, lane: (i: number) => string, label = (i: number) => `Langkah ${i + 1}`) => ({
  nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: label(i), class: { lane: lane(i) } })),
  edges: Array.from({ length: n - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, kind: "data", label: "lanjut" })),
});

export type Fixture = { type: "diagram" | "chart"; spec: Record<string, unknown> };

export const OVER_CAPACITY: Record<string, Fixture> = {
  /** 7 contiguous graph columns at 166 mm (the engine fits at most 5 even with a compacted pitch). */
  graph7: {
    type: "diagram",
    spec: diagram("graph", {
      nodes: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ id: `g${i}`, label: `Simpul ${i}`, class: { col: i, row: 0 } })),
      edges: [0, 1, 2, 3, 4, 5].map((i) => ({ from: `g${i}`, to: `g${i + 1}`, kind: "data", label: "data" })),
    }),
  },
  /** 10 chained tiers: taller than the 247 mm text block. */
  layered10: {
    type: "diagram",
    spec: diagram("layered", {
      nodes: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, label: `T${i}`, class: { tier: i } })),
      edges: Array.from({ length: 9 }, (_, i) => ({ from: `t${i}`, to: `t${i + 1}`, kind: "data", label: String.fromCharCode(97 + i) })),
    }),
  },
  /** 12 steps in one lane: the lane wraps, but the wrapped result is not clean. */
  swimlane12: {
    type: "diagram",
    spec: diagram("swimlane", chain(12, (i) => (i % 2 === 0 ? "Pemohon" : "Teknisi"))),
  },
  /** 5 steps, 4 in lane A: the capacity layout renders with 1 crossing + 1 collinear segment (rendered before row 158). */
  swimlaneMessy: {
    type: "diagram",
    spec: diagram("swimlane", chain(5, (i) => ["A", "C", "A", "A", "A"][i])),
  },
  /** 60 horizontal bars: estimated height far above the text block. */
  bars60: { type: "chart", spec: chart("P-01", 60, (i) => `Kategori ${i}`) },
  /** 20 long column labels forced vertical: the first render overlaps ~100 labels. */
  columns20Vertical: {
    type: "chart",
    spec: chart("P-02", 20, (i) => `Kategori sangat panjang nomor ${i}`, { intent: { orientation: "vertical" } }),
  },
};

export const AT_CAPACITY: Record<string, Fixture> = {
  /** 6 swimlane steps: the clean capacity adaptation (CAPACITY_ADAPT, lint 0) still renders. */
  swimlane6: { type: "diagram", spec: diagram("swimlane", chain(6, (i) => (i < 5 ? "Pemohon" : "Teknisi"))) },
  /** 5 graph columns: compacted pitch, lint 0. */
  graph5: {
    type: "diagram",
    spec: diagram("graph", {
      nodes: [0, 1, 2, 3, 4].map((i) => ({ id: `g${i}`, label: `Simpul ${i}`, class: { col: i, row: 0 } })),
      edges: [0, 1, 2, 3].map((i) => ({ from: `g${i}`, to: `g${i + 1}`, kind: "data", label: "data" })),
    }),
  },
  /** 30 horizontal bars: tall (222 mm) but inside the text block and clean. */
  bars30: { type: "chart", spec: chart("P-01", 30, (i) => `Kategori ${i}`) },
  /** 12 columns: AUTO_FIT turns them horizontal, clean. */
  columns12: { type: "chart", spec: chart("P-02", 12, (i) => `Wilayah ${i}`) },
  /** 20 long column labels, orientation free: AUTO_ORIENT, clean. */
  columns20: { type: "chart", spec: chart("P-02", 20, (i) => `Kategori sangat panjang nomor ${i}`) },
};
