/**
 * Swarm 1.2.6 row 25 (T-03): connector-end geometry checks on diagram SVGs.
 * Kinds `edgeEntryCollision`, `stubSegment`, `arrowTangent` (register N-001..N-006), thresholds
 * N-008..N-010, `ROUTE_DEFECT_KINDS` (N-166). Flow F1: the seven anonymised judge-rejected figures
 * (fixtures anon126/t03_k1..k7) each give at least one new-kind defect from the set mapped from the
 * judge verdict; the negative controls t03_n1 (judge-passed) and t03_n2 (synthetic chain) give none.
 * Gate wiring (FIGURE_FIT FAIL) is row 26.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as lint from "@/lib/studio/engine/diagram/fit/lint";
import { diagramGeometryIssues } from "@/lib/studio/engine/diagram/build/autofit";
import { ROUTE_DEFECT_KINDS } from "@/lib/studio/engine/diagram/elk";

const NEW = ["edgeEntryCollision", "stubSegment", "arrowTangent"] as const;
type NewKind = (typeof NEW)[number];
const CODE: Record<NewKind, string> = {
  edgeEntryCollision: "GEOM_ENTRY_COLLISION",
  stubSegment: "GEOM_STUB_SEGMENT",
  arrowTangent: "GEOM_ARROW_TANGENT",
};

const FIX = path.join(import.meta.dir, "..", "fixtures", "anon126");
const fixture = (name: string) => readFileSync(path.join(FIX, `${name}.svg`), "utf8");
const newKinds = (svg: string) => lint.lintDiagramGeometry(svg).defects.filter((d) => (NEW as readonly string[]).includes(d.kind));

const svgOf = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80">\n<rect x="0" y="0" width="100" height="80" fill="#FCFCFB"/>\n${body}\n</svg>`;
const link = (d: string) => `<path d="${d}" fill="none" stroke="#101418" stroke-width="0.45" marker-end="url(#head-data)" data-mark="link"/>`;
const box = (id: string, x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" data-node="${id}" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>`;

describe("T-03 register names and thresholds", () => {
  test("three new kinds in DIAGRAM_DEFECT_KINDS and counts", () => {
    for (const k of NEW) expect(lint.DIAGRAM_DEFECT_KINDS).toContain(k);
    const g = lint.lintDiagramGeometry(svgOf(""));
    for (const k of NEW) expect(g.counts[k]).toBe(0);
  });
  test("thresholds N-008..N-010", () => {
    expect(lint.ENTRY_COLLISION_MM).toBe(1.5);
    expect(lint.STUB_SEGMENT_MIN_MM).toBe(2.0);
    expect(lint.ARROW_TANGENT_TOL_DEG).toBe(15);
  });
  test("ROUTE_DEFECT_KINDS gains the three kinds (N-166)", () => {
    for (const k of NEW) expect(ROUTE_DEFECT_KINDS as readonly string[]).toContain(k);
  });
});

describe("T-03 synthetic hand-written SVGs, one per kind", () => {
  test("edgeEntryCollision: two connectors end 1 mm apart on one node side", () => {
    const svg = svgOf([link("M 30 10 L 30 50"), link("M 31 10 L 31 50"), box("n1", 20, 50, 30, 10)].join("\n"));
    const g = lint.lintDiagramGeometry(svg);
    expect(g.counts.edgeEntryCollision).toBe(1);
    expect(diagramGeometryIssues(g).map((i) => i.checkId)).toContain("GEOM_ENTRY_COLLISION");
  });
  test("edgeEntryCollision: 5 mm apart is clean", () => {
    const svg = svgOf([link("M 30 10 L 30 50"), link("M 35 10 L 35 50"), box("n1", 20, 50, 30, 10)].join("\n"));
    expect(lint.lintDiagramGeometry(svg).counts.edgeEntryCollision).toBe(0);
  });
  test("stubSegment: a 1 mm jog between two bends", () => {
    const svg = svgOf([box("a", 20, 5, 20, 10), link("M 30 15 L 30 30 L 31 30 L 31 50"), box("b", 21, 50, 20, 10)].join("\n"));
    const g = lint.lintDiagramGeometry(svg);
    expect(g.counts.stubSegment).toBe(1);
    expect(diagramGeometryIssues(g).map((i) => i.checkId)).toContain("GEOM_STUB_SEGMENT");
  });
  test("stubSegment: a straight connector with no jog is clean", () => {
    const svg = svgOf([box("a", 20, 5, 20, 10), link("M 30 15 L 30 50"), box("b", 20, 50, 20, 10)].join("\n"));
    expect(lint.lintDiagramGeometry(svg).counts.stubSegment).toBe(0);
  });
  test("arrowTangent: the last piece runs along the target's left border", () => {
    const svg = svgOf([link("M 40 70 L 40 25"), box("n1", 40, 20, 30, 10)].join("\n"));
    const g = lint.lintDiagramGeometry(svg);
    expect(g.counts.arrowTangent).toBe(1);
    expect(diagramGeometryIssues(g).map((i) => i.checkId)).toContain("GEOM_ARROW_TANGENT");
  });
  test("arrowTangent: a head-on entry is clean", () => {
    const svg = svgOf([link("M 55 70 L 55 30"), box("n1", 40, 20, 30, 10)].join("\n"));
    expect(lint.lintDiagramGeometry(svg).counts.arrowTangent).toBe(0);
  });
  test("T-03 kinds are not part of score (auto-fit path of today's figures unchanged, U3)", () => {
    const svg = svgOf([link("M 40 70 L 40 25"), box("n1", 40, 20, 30, 10)].join("\n"));
    const g = lint.lintDiagramGeometry(svg);
    expect(g.defects.length).toBeGreaterThan(0);
    expect(g.score).toBe(0);
  });
});

/** Expected code set per F1 figure, mapped from the judge verdicts (01g F1 mapping; numbers only). */
const F1: Record<string, NewKind[]> = {
  t03_k1: ["stubSegment", "arrowTangent"],
  t03_k2: ["stubSegment", "edgeEntryCollision"],
  t03_k3: ["stubSegment", "arrowTangent"],
  t03_k4: ["stubSegment"],
  t03_k5: ["stubSegment", "arrowTangent", "edgeEntryCollision"],
  t03_k6: ["stubSegment"],
  t03_k7: ["stubSegment"],
};

describe("F1: judge-rejected figures fail with a matching code", () => {
  for (const [name, expected] of Object.entries(F1)) {
    test(`${name}: at least one ${expected.map((k) => CODE[k]).join(" | ")}`, () => {
      const g = lint.lintDiagramGeometry(fixture(name));
      const got = newKinds(fixture(name)).map((d) => d.kind as NewKind);
      expect(got.some((k) => expected.includes(k))).toBe(true);
      const codes = diagramGeometryIssues(g).map((i) => i.checkId);
      expect(expected.some((k) => codes.includes(CODE[k]))).toBe(true);
    });
  }
});

describe("F1 negative controls", () => {
  for (const name of ["t03_n1", "t03_n2"]) {
    test(`${name}: no new-kind defect`, () => {
      expect(newKinds(fixture(name))).toEqual([]);
    });
  }
});
