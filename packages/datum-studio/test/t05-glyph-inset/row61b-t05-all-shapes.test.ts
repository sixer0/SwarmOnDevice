// Swarm 1.2.6 row 61b (T-05 follow-up, finding F61-1 of row 61): row 61 kept the provenance glyph inside the
// outline of diamond and parallelogram nodes only. The same size sweep (node widths 8..64 mm, heights
// 4.76..19.05 mm, lattice rows) still reported textOverNode (GEOM_TEXT_NODE) for hexagon, cylinder and circle
// nodes with a mark. Fix: markGlyphAnchor places the glyph clear of the outline for every shape the engine
// draws; box glyphs stay byte-identical, diamond/parallelogram keep their row 61 anchor.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useStudioEnv } from "../ported/_env";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { buildDiagramSvgRaw } from "@/lib/studio/engine/diagram/build";
import { lintDiagramGeometry } from "@/lib/studio/engine/diagram/fit/lint";
import { markGlyphAnchor, markGlyphSvg, shapeSvg } from "@/lib/studio/engine/diagram/core/svg";
import { pt2mm, role } from "@/lib/studio/engine/diagram/core/tokens";

useStudioEnv();

const WIDTHS = Array.from({ length: 29 }, (_, i) => 8 + 2 * i); // 8..64 mm
const HEIGHTS = [4.76, 7.14, 9.52, 14.29, 19.05];
const node = (shape: string | undefined, w: number, h: number, mark = "TERUKUR") =>
  ({ id: "a", x: 10, y: 10, w, h, spec: { id: "a", label: "x", ...(shape ? { shape } : {}), mark } }) as never;

const sweepHits = (shape: string | undefined, mark = "TERUKUR"): string[] => {
  const hits: string[] = [];
  for (const w of WIDTHS) {
    for (const h of HEIGHTS) {
      const nd = node(shape, w, h, mark);
      const svg = `<svg viewBox="0 0 100 50">${shapeSvg(nd, "ink700", "none")}${markGlyphSvg(nd)}</svg>`;
      if (lintDiagramGeometry(svg).counts.textOverNode) hits.push(`${w}x${h}`);
    }
  }
  return hits;
};

describe("row 61b T-05: glyph clears the outline for every node shape over the size sweep", () => {
  for (const shape of ["hexagon", "cylinder", "circle", "bus", "stadium", "doubled", "shadowed", "diamond", "parallelogram", undefined]) {
    for (const mark of ["TERUKUR", "ASUMSI"]) {
      it(`${shape ?? "box"} (${mark}): zero textOverNode over w 8..64 x h 4.76..19.05`, () => {
        expect(sweepHits(shape, mark)).toEqual([]);
      });
    }
  }
});

describe("row 61b T-05: unchanged anchors", () => {
  it("box (and unknown shape) anchor is the row 61 box anchor: right edge - 1.5 pt, top + caption size", () => {
    for (const shape of [undefined, "box", "nonsuch"]) {
      for (const w of WIDTHS) {
        for (const h of HEIGHTS) {
          const at = markGlyphAnchor({ x: 10, y: 10, w, h, spec: { id: "a", label: "x", shape, mark: "TERUKUR" } } as never);
          expect(at).toEqual({ x: 10 + w - pt2mm(1.5), y: 10 + pt2mm(role("caption").size) });
        }
      }
    }
  });

  it("box glyph markup is byte-identical to the row 61 output", () => {
    expect(markGlyphSvg(node(undefined, 40, 9.52))).toBe(
      '<text x="49.47" y="12.68" font-family="IBM Plex Mono" font-size="2.187" fill="#101418" text-anchor="end">■</text>',
    );
  });
});

describe("row 61b T-05: parity fixtures with a marked circle / cylinder", () => {
  const fixture = (f: string) =>
    JSON.parse(readFileSync(path.resolve(import.meta.dir, "..", "ported", "_fixtures", "tests", "parity", "fixtures", "diagram", f), "utf8")) as StudioDiagramV1;

  it("dg_graph (cylinder `log` with a mark): zero GEOM_TEXT_NODE", () => {
    const lint = lintDiagramGeometry(buildDiagramSvgRaw(fixture("dg_graph.json"), { release: false }).svg);
    expect(lint.defects.filter((d) => d.kind === "textOverNode")).toEqual([]);
  });

  it("dg_topology (circle `s1` with a mark, already clear): glyph anchor unchanged", () => {
    const svg = buildDiagramSvgRaw(fixture("dg_topology.json"), { release: false }).svg;
    expect(svg).toContain('<text x="74.14" y="64.59" font-family="IBM Plex Mono"');
    expect(lintDiagramGeometry(svg).counts.textOverNode).toBe(0);
  });
});
