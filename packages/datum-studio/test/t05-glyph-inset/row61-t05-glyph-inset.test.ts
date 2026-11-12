// Swarm 1.2.6 row 61 (T-05, 01_specs T-05, rev 183/184 GEOM_TEXT_NODE): the provenance glyph of a node
// that carries a `mark` sits at the top-right corner of the box. On a diamond or a parallelogram that corner
// is cut by a slanted side, so the glyph's text samples hit the node outline and the geometry lint reports
// `textOverNode` (GEOM_TEXT_NODE). Fix: the glyph is inset by node shape so it stays inside the outline.
// A box keeps its glyph byte-identical. Synthetic fixtures (the rev 183/184 specs are not in the repo).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useStudioEnv } from "../ported/_env";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { buildDiagramSvgRaw } from "@/lib/studio/engine/diagram/build";
import { lintDiagramGeometry } from "@/lib/studio/engine/diagram/fit/lint";
import { markGlyphSvg, shapeSvg } from "@/lib/studio/engine/diagram/core/svg";

useStudioEnv();

const spec = (shape: string | undefined, mark = "TERUKUR"): StudioDiagramV1 =>
  ({
    $schema: "studio.diagram/v1",
    family: "graph",
    id: "9.1",
    title: "Uji glif asal.",
    classification: "BIASA",
    width_mm: 128,
    apparatus: "page",
    labels_verified: true,
    sources: ["Uji"],
    legend: [mark],
    nodes: [
      { id: "a", label: "Masuk", class: { col: 0, row: 0 }, ...(shape ? { shape } : {}), mark },
      { id: "b", label: "Proses", class: { col: 1, row: 0 }, ...(shape ? { shape } : {}), mark },
      { id: "c", label: "Keluar", class: { col: 2, row: 0 } },
    ],
    edges: [
      { from: "a", to: "b", kind: "data", label: "data" },
      { from: "b", to: "c", kind: "data", label: "ya" },
    ],
  }) as unknown as StudioDiagramV1;

const svgOf = (s: StudioDiagramV1) => buildDiagramSvgRaw(s, { release: false }).svg;
const glyphTexts = (svg: string) => [...svg.matchAll(/<text\b[^>]*text-anchor="end"[^>]*>■<\/text>/g)].map((m) => m[0]);

describe("row 61 T-05: provenance glyph does not touch a slanted node side", () => {
  for (const shape of ["diamond", "parallelogram"]) {
    for (const mark of ["TERUKUR", "DITURUNKAN", "PEMASOK", "ASUMSI"]) {
      it(`${shape} with mark ${mark}: zero GEOM_TEXT_NODE`, () => {
        const svg = svgOf(spec(shape, mark));
        const lint = lintDiagramGeometry(svg);
        expect(lint.defects.filter((d) => d.kind === "textOverNode")).toEqual([]);
        expect(lint.counts.textOverNode).toBe(0);
      });
    }
  }

  it("box glyph position is unchanged (x = right edge - 1.5 pt, y = top + caption size)", () => {
    const svg = svgOf(spec(undefined));
    const glyphs = glyphTexts(svg);
    expect(glyphs.length).toBe(2);
    const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="[\d.]+" data-node=/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    for (const g of glyphs) {
      const gx = Number(/ x="([\d.]+)"/.exec(g)![1]);
      const gy = Number(/ y="([\d.]+)"/.exec(g)![1]);
      const host = rects.find(([x, , w]) => Math.abs(x + w - 0.53 - gx) < 0.011);
      expect(host).toBeDefined();
      expect(gy).toBeGreaterThan(host![1]);
    }
    expect(lintDiagramGeometry(svg).counts.textOverNode).toBe(0);
  });
});

describe("row 61 T-05: glyph clears the outline for every diamond and parallelogram size", () => {
  // Shape + glyph alone, swept over node widths 8..64 mm and heights 4.76..19.05 mm (lattice rows).
  for (const shape of ["diamond", "parallelogram"]) {
    it(`${shape}: zero textOverNode over the size sweep`, () => {
      const hits: string[] = [];
      for (let w = 8; w <= 64; w += 2) {
        for (const h of [4.76, 7.14, 9.52, 14.29, 19.05]) {
          const nd = { id: "a", x: 10, y: 10, w, h, spec: { id: "a", label: "x", shape, mark: "TERUKUR" } } as never;
          const svg = `<svg viewBox="0 0 100 50">${shapeSvg(nd, "ink700", "none")}${markGlyphSvg(nd)}</svg>`;
          if (lintDiagramGeometry(svg).counts.textOverNode) hits.push(`${w}x${h}`);
        }
      }
      expect(hits).toEqual([]);
    });
  }

  it("parity flow fixture (stadium, parallelogram, diamond) with a mark on every node: zero GEOM_TEXT_NODE", () => {
    const file = path.resolve(import.meta.dir, "..", "ported", "_fixtures", "tests", "parity", "fixtures", "diagram", "dg_flow.json");
    const fx = JSON.parse(readFileSync(file, "utf8"));
    for (const n of fx.nodes) n.mark = "TERUKUR";
    fx.legend = ["TERUKUR"];
    const lint = lintDiagramGeometry(svgOf(fx));
    expect(lint.defects.filter((d) => d.kind === "textOverNode")).toEqual([]);
  });
});
