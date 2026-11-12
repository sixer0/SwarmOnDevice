// Swarm 1.2.6 row 67 (T-12, register N-019 `furnitureMm`, E-09): an over-capacity refusal carries numeric
// `measured` and `limit` (never null, never printed "?"), and the height of the apparatus furniture (caption,
// KUNCI, SUMBER lines) is reported apart as `furnitureMm`. The rev-198 case: a graph of about 90 mm drawn inline
// (apparatus "page") passed, while the stand-alone preview (apparatus "figure", the SVG carries its own caption and
// SUMBER) was refused `DATUM-37-tinggi` with "batas: lebar gambar maks ? mm": the paper rect, printed to 0.001 mm
// (100.013), was compared with the unrounded sheet height (100.0125) and counted as an element outside the sheet.
// Synthetic rev-198-shaped fixture (the rev-198 spec itself is not in the repo, research/01a_explore_t_family.md):
// 4 rows x 3 columns, labelled connectors, a caption that wraps, 90.5 mm inline.
import { useStudioEnv } from "../ported/_env";
useStudioEnv();
import { describe, expect, it } from "bun:test";
import path from "node:path";
import type { StudioDiagramV1 } from "@/lib/studio/contract";
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build";
import { overCapacityOf } from "@/lib/studio/engine/diagram/build/capacity";
import { DiagramDefect } from "@/lib/studio/engine/diagram/core";
import { FIGURE_OVER_CAPACITY, overCapacityMessage } from "@/lib/studio/engine/figure-capacity";

const PKG = path.resolve(import.meta.dir, "..", "..");
const fig = await import(path.join(PKG, "src", "mcp-host", "local-api", "routes", "figure-preview-figure.ts"));
const compose = await import(path.join(PKG, "vendor", "src", "lib", "studio", "services", "compose", "index.ts"));

const TITLE = "Arsitektur sistem pemantauan iklim ruang simpan arsip yang panjang sekali sehingga caption membungkus ke baris kedua.";
const SOURCE = "Kajian Teknis 012/GSP/KT/XI/2026 §4.1 register ruang Rev A";

const nodesOf = (rows: number, cols: number) => {
  const nodes: Array<Record<string, unknown>> = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) nodes.push({ id: `n${r}_${c}`, label: `Simpul ${r}.${c}`, class: { col: c, row: r } });
  const edges: Array<Record<string, unknown>> = [];
  for (let r = 1; r < rows; r++) for (let c = 0; c < cols; c++) edges.push({ from: `n${r - 1}_${c}`, to: `n${r}_${c}`, kind: c % 2 ? "control" : "data", label: "data" });
  return { nodes, edges };
};

/** Rev-198-shaped engine spec (graph, 4 x 3, about 90 mm inline). */
const rev198 = (apparatus: "page" | "figure"): StudioDiagramV1 =>
  ({
    $schema: "studio.diagram/v1",
    family: "graph",
    id: "4.1",
    title: TITLE,
    classification: "BIASA",
    width_mm: 166,
    apparatus,
    labels_verified: true,
    sources: [SOURCE],
    ...nodesOf(4, 3),
  }) as unknown as StudioDiagramV1;

const caught = (fn: () => unknown): any => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
};

describe("row 67 T-12: DATUM-37-tinggi refusal details are numeric with furnitureMm apart", () => {
  it("the 1.2.5 message (no furniture part) maps to quantity tinggi with numeric measured/limit and a numeric furnitureMm", () => {
    const e = new DiagramDefect("DATUM-37-tinggi: unsur keluar lembar graph (tinggi 100.013 mm): rect bawah=100.513, y=-0.4 (P8, D-290)", { checkId: "DATUM-37-tinggi" });
    const over = overCapacityOf(e, rev198("figure"))!;
    expect(over.code).toBe(FIGURE_OVER_CAPACITY);
    expect(over.details.checkId).toBe("DATUM-37-tinggi");
    expect(over.details.quantity).toContain("tinggi");
    expect(over.details.unit).toBe("mm");
    expect(typeof over.details.limit).toBe("number");
    expect(typeof over.details.measured).toBe("number");
    expect(over.details.limit).toBeCloseTo(100.013, 3);
    // needed height: 0.5 mm below the sheet plus 0.4 mm above it
    expect(over.details.measured).toBeCloseTo(100.913, 3);
    expect(typeof over.details.furnitureMm).toBe("number");
    expect(over.details.furnitureMm).toBeGreaterThan(0);
    expect(over.message).not.toContain("?");
    expect(over.message).not.toContain("lebar gambar");
  });

  it("the engine message names the furniture height and it is reported apart from the content", () => {
    const e = new DiagramDefect("DATUM-37-tinggi: unsur keluar lembar graph (tinggi 120.000 mm, kaki aparatus 14.288 mm): y=121.5 (P8, D-290)", { checkId: "DATUM-37-tinggi" });
    const over = overCapacityOf(e, rev198("figure"))!;
    expect(over.details.limit).toBe(120);
    expect(over.details.measured).toBeCloseTo(121.5, 3);
    expect(over.details.furnitureMm).toBeCloseTo(14.288, 3);
    expect(over.message).toMatch(/kaki aparatus \(KUNCI\/SUMBER\) 14\.3 mm/);
  });

  it("the formatter never prints ? for a missing number", () => {
    const m = overCapacityMessage("DATUM-37: x", { quantity: "lebar gambar", unit: "mm", limit: null, measured: null, suggestion: "pecah" });
    expect(m).not.toContain("?");
  });
});

describe("row 67 T-12: rev-198-shaped figure, stand-alone vs inline parity", () => {
  it("the engine draws the rev-198 shape with apparatus figure (stand-alone) as it does with apparatus page (inline)", () => {
    const page = buildDiagramSvg(rev198("page"), { release: false });
    expect(page.heightMm).toBeGreaterThan(85);
    expect(page.heightMm).toBeLessThan(95);
    const err = caught(() => buildDiagramSvg(rev198("figure"), { release: false }));
    expect(err?.message ?? "").toBe("");
    const figure = buildDiagramSvg(rev198("figure"), { release: false });
    expect(figure.heightMm).toBeGreaterThan(page.heightMm);
  });

  it("the preview route renders the rev-198-shaped block both inline and stand-alone (no refusal, no ?)", async () => {
    // The route draws the block at the template width with a one-line caption: the shape that was refused stand-alone.
    const block = { type: "diagram", caption: { text: "Arsitektur sistem." }, source: { text: SOURCE }, spec: { family: "graph", classification: "BIASA", sources: [SOURCE], ...nodesOf(4, 3) } };
    const content = compose.mapBlock(block, "fig-diagram-41", { glyphs: compose.glyphSet(undefined), params: {}, classification: "TERBATAS", artifactLabel: "Gambar 4.1" });
    const stored = { blockId: "fig-diagram-41", pid: "fig-diagram-41", address: "4.1.1", ordinal: 0, unitKey: "", type: "diagram", content, textPlain: "", contentSha256: "", artifactLabel: "Gambar 4.1" };
    const TPL = { params: {} } as any;
    const render = async (standalone: boolean) => {
      try {
        return await fig.renderFigure(stored, TPL, { inline: false, withSvg: true, lang: "ID", standalone });
      } catch (e) {
        return { refused: String((e as Error).message) };
      }
    };
    const inline: any = await render(false);
    const alone: any = await render(true);
    expect(inline.refused).toBeUndefined();
    expect(alone.refused).toBeUndefined();
    for (const r of [inline, alone]) {
      expect(typeof r.svg).toBe("string");
      expect(JSON.stringify(r)).not.toContain("maks ?");
    }
    expect(alone.svg).toContain("SUMBER");
    expect(inline.svg).toContain("DATUM-APPARATUS-REQUIRED");
  });
});
